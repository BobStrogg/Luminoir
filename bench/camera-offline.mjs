#!/usr/bin/env node
/**
 * Deterministic offline camera-follow harness (Node only).
 * - Loads MXL with Verovio (wasm) and renders SVG + timemap
 * - Parses SVG with SVGSceneParser under linkedom's DOMParser
 * - Builds the same { time, x } timeline used in-app
 * - Drives CameraController at fixed 60/120 Hz and with injected stalls/jitter
 * - Records target X and camera position each step
 * - Computes velocity / acceleration / jerk statistics
 * - Emits PNG plots for position / velocity / acceleration
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { performance as nodePerformance } from 'node:perf_hooks';
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';
import * as THREE from 'three';
import { SceneConfig } from '../src/rendering/SceneConfig.js';
import { SVGSceneParser } from '../src/verovio/SVGSceneParser.js';
import { CameraController } from '../src/animation/CameraController.js';
import { plotSeries } from './lib/plot.js';

// Minimal DOM for SVGSceneParser
import { DOMParser as LinkeDOMParser } from 'linkedom';
globalThis.DOMParser = LinkeDOMParser;
// Ensure performance.now() exists for code paths that read it
if (!globalThis.performance) {
  globalThis.performance = {
    now: () => nodePerformance.now(),
  };
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SCORES = {
  jupiter: 'public/scores/jupiter-the-bringer-of-jollity-gustav-holst-advanced-solo-piano.mxl',
  starTrekFirstContact: 'public/scores/star-trek-first-contact-jerry-goldsmith.mxl',
};

async function loadScore(verovio, absPath) {
  const buf = fs.readFileSync(absPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ok = verovio.loadZipDataBuffer(ab);
  if (!ok) throw new Error(`Verovio failed to load ${absPath}`);
  const svg = verovio.renderToSVG(1);
  const tm = verovio.renderToTimemap();
  const timemap = typeof tm === 'string' ? JSON.parse(tm) : tm;
  return { svg, timemap };
}

function tryLoadExported(scoreKey) {
  const p = path.resolve('bench', 'timelines', `${scoreKey}.json`);
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      timeline: j.timeline || [],
      contentMinY: j.contentMinY ?? 0,
      contentMaxY: j.contentMaxY ?? 0,
      firstNote: j.firstNote || null,
    };
  }
  return null;
}

function buildTimeline(parsed, timemap) {
  // Copied from LuminoirApp._buildNoteTimeline (kept in sync)
  const timeline = [];
  const posById = new Map();
  for (const note of parsed.notes) {
    if (note.id) posById.set(note.id, note);
  }
  const RENDITION_SUFFIX = /-rend\d+$/;
  for (const entry of timemap) {
    const timeSec = (entry.tstamp || 0) / 1000;
    const ids = entry.on || [];
    for (const id of ids) {
      let note = posById.get(id);
      if (!note && RENDITION_SUFFIX.test(id)) {
        note = posById.get(id.replace(RENDITION_SUFFIX, ''));
      }
      if (note) {
        timeline.push({
          time: timeSec,
          x: note.x + (note.cxOffset ?? 0),
          y: note.y,
          id: note.id,
          staff: note.staff,
        });
      }
    }
  }
  if (timeline.length === 0 && parsed.notes.length > 0) {
    const duration = 0.5 * parsed.notes.length;
    const step = duration / parsed.notes.length;
    for (let i = 0; i < parsed.notes.length; i++) {
      const n = parsed.notes[i];
      timeline.push({ time: i * step, x: n.x, y: n.y, id: n.id || `note_${i}`, staff: n.staff });
    }
  }
  timeline.sort((a, b) => a.time - b.time);
  return timeline;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i];
}

function diffSeries(values, dts) {
  const out = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i++) {
    const dt = Math.max(1e-6, dts[i]);
    out[i] = (values[i] - values[i - 1]) / dt;
  }
  return out;
}

function summarize(name, values) {
  const mags = values.map((v) => Math.abs(v)).filter(Number.isFinite);
  const p50 = percentile(mags, 50);
  const p95 = percentile(mags, 95);
  const p99 = percentile(mags, 99);
  const max = Math.max(...mags, 0);
  return { name, p50, p95, p99, max };
}

function buildFrameSchedule(mode, totalSeconds, baseHz) {
  const frameMs = 1000 / baseHz;
  const timesMs = [];
  if (mode === 'fixed') {
    for (let t = 0; t < totalSeconds * 1000; t += frameMs) timesMs.push(t);
    return timesMs;
  }
  if (mode.startsWith('stalls')) {
    const stallMs = Number(mode.split(':')[1] || 50);
    let t = 0;
    let count = 0;
    while (t < totalSeconds * 1000) {
      timesMs.push(t);
      count++;
      // Every ~2 seconds, inject one long frame
      if (count % Math.round((2000 / frameMs)) === 0) {
        t += stallMs;
      }
      t += frameMs;
    }
    return timesMs;
  }
  if (mode === 'jitter') {
    let t = 0;
    while (t < totalSeconds * 1000) {
      const jitter = (Math.random() - 0.5) * frameMs * 0.4; // ±20%
      timesMs.push(t + jitter);
      t += frameMs;
    }
    return timesMs;
  }
  throw new Error(`Unknown mode ${mode}`);
}

async function runOne({ scoreKey, outDir, hz, mode, durationSec }) {
  // Verovio setup (match scoreWorker options)
  const Module = await createVerovioModule();
  const verovio = new VerovioToolkit(Module);
  verovio.setOptions({
    pageWidth: 100000,
    pageHeight: 10000,
    adjustPageWidth: true,
    adjustPageHeight: true,
    breaks: 'none',
    noJustification: true,
    scale: 100,
    spacingStaff: 12,
    spacingSystem: 12,
    unit: 6.0,
    staffLineWidth: 0.3,
    stemWidth: 0.5,
    barLineWidth: 0.8,
    xmlIdSeed: 1,
  });

  const exported = tryLoadExported(scoreKey);
  let timeline, contentMinY = 0, contentMaxY = 0, firstNote = null;
  if (exported) {
    timeline = exported.timeline;
    contentMinY = exported.contentMinY;
    contentMaxY = exported.contentMaxY;
    firstNote = exported.firstNote;
  } else {
    const mxlPath = path.resolve(__dirname, '..', SCORES[scoreKey]);
    const { svg, timemap } = await loadScore(verovio, mxlPath);
    // Parse SVG to structured scene
    const parsed = await new SVGSceneParser().parse(svg);
    timeline = buildTimeline(parsed, timemap);
    contentMinY = parsed.contentMinY;
    contentMaxY = parsed.contentMaxY;
    firstNote = timeline.length ? { x: timeline[0].x, y: timeline[0].y } : null;
  }
  // Prepare camera and controller (stub controls)
  const camera = new THREE.PerspectiveCamera(SceneConfig.camera.fov, 16 / 9, SceneConfig.camera.near, SceneConfig.camera.far);
  const controls = {
    target: new THREE.Vector3(),
    enableDamping: false,
    dampingFactor: 0.12,
    syncUpdate: () => {},
    update: () => {},
  };
  const ctrl = new CameraController(camera, controls);
  ctrl.configureForScore(contentMinY, contentMaxY);
  ctrl.setTimeTrack(timeline);
  if (firstNote) ctrl.snapToTarget(new THREE.Vector3(firstNote.x, 0, 0), firstNote.x);

  // Disable smart camera for pure follow metrics
  if (SceneConfig.smartCamera) SceneConfig.smartCamera.enabled = false;
  const lookAhead = Math.max(0, SceneConfig.camera.lookAheadSeconds ?? 0);

  // Build deterministic frame times
  const schedule = buildFrameSchedule(mode, durationSec, hz);
  const dtList = [];
  const nowList = [];
  for (let i = 0; i < schedule.length; i++) {
    const now = schedule[i];
    const prev = i > 0 ? schedule[i - 1] : schedule[0];
    nowList.push(now);
    dtList.push(Math.min(Math.max((now - prev) / 1000, 0.0001), 0.1));
  }

  // Simulate playback
  const camX = [];
  const targetX = [];
  const timesSec = [];
  for (let i = 0; i < dtList.length; i++) {
    const nowMs = nowList[i];
    const dt = dtList[i];
    const tSec = nowMs / 1000;
    // Music time == wall time here (tempoScale 1.0)
    const xTime = ctrl.xAtTime(tSec);
    if (xTime != null) {
      const xLook = lookAhead > 0 ? ctrl.xAtTime(tSec + lookAhead, 'lookAhead') ?? xTime : xTime;
      ctrl.setTarget(new THREE.Vector3(xTime, 0, 0), xLook);
    }
    ctrl.update(dt, nowMs);
    camX.push(camera.position.x);
    targetX.push(controls.target.x);
    timesSec.push(tSec);
  }

  // Derivatives
  const v = diffSeries(camX, dtList);
  const a = diffSeries(v, dtList);
  const j = diffSeries(a, dtList);

  // Metrics
  const metrics = {
    score: scoreKey,
    mode,
    hz,
    durationSec,
    velocity: summarize('velocity', v),
    acceleration: summarize('acceleration', a),
    jerk: summarize('jerk', j),
    velocityDeltaPeaks: (() => {
      const deltas = [];
      for (let i = 1; i < v.length; i++) deltas.push(Math.abs(v[i] - v[i - 1]));
      deltas.sort((x, y) => y - x);
      return {
        count: deltas.length,
        top5: deltas.slice(0, 5),
        p95: percentile(deltas, 95),
        max: deltas[0] || 0,
      };
    })(),
  };

  // Plots
  const plotDir = path.join(outDir, 'plots');
  fs.mkdirSync(plotDir, { recursive: true });
  const prefix = `${scoreKey}-${hz}hz-${mode}`;
  plotSeries({ width: 1400, height: 450 }, [
    { name: 'targetX', data: timesSec.map((t, i) => ({ t, y: targetX[i] })), color: { r: 180, g: 180, b: 180, a: 255 } },
    { name: 'cameraX', data: timesSec.map((t, i) => ({ t, y: camX[i] })), color: { r: 30, g: 120, b: 220, a: 255 } },
  ], path.join(plotDir, `${prefix}-position.png`));
  plotSeries({ width: 1400, height: 450 }, [
    { name: 'velocity', data: timesSec.map((t, i) => ({ t, y: v[i] })), color: { r: 10, g: 150, b: 10, a: 255 } },
  ], path.join(plotDir, `${prefix}-velocity.png`));
  plotSeries({ width: 1400, height: 450 }, [
    { name: 'acceleration', data: timesSec.map((t, i) => ({ t, y: a[i] })), color: { r: 200, g: 120, b: 10, a: 255 } },
  ], path.join(plotDir, `${prefix}-acceleration.png`));

  // Persist JSON
  const jsonPath = path.join(outDir, `${prefix}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ metrics, artifacts: {
    position: path.relative(process.cwd(), path.join(plotDir, `${prefix}-position.png`)),
    velocity: path.relative(process.cwd(), path.join(plotDir, `${prefix}-velocity.png`)),
    acceleration: path.relative(process.cwd(), path.join(plotDir, `${prefix}-acceleration.png`)),
  } }, null, 2));

  return { metrics, artifacts: { position: jsonPath.replace('.json', '-position.png'), velocity: jsonPath.replace('.json', '-velocity.png'), acceleration: jsonPath.replace('.json', '-acceleration.png') } };
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const score = (args.find((a) => a.startsWith('--score=')) || '').split('=')[1] || 'jupiter';
  const durationSec = Number((args.find((a) => a.startsWith('--duration=')) || '').split('=')[1] || 30);
  const smoothArg = (args.find((a) => a.startsWith('--smooth=')) || '').split('=')[1];
  const modesArg = (args.find((a) => a.startsWith('--modes=')) || '').split('=')[1];
  const modes = modesArg ? modesArg.split(',').map((s) => s.trim()) : ['fixed', 'stalls:50', 'stalls:100', 'jitter'];
  const hzArg = (args.find((a) => a.startsWith('--hz=')) || '').split('=')[1];
  const hzList = hzArg ? hzArg.split(',').map((s) => Number(s.trim())).filter(Boolean) : [60, 120];
  if (smoothArg === 'false') {
    if (SceneConfig.camera) SceneConfig.camera.smoothTargetTrack = false;
  } else if (smoothArg === 'true') {
    if (SceneConfig.camera) SceneConfig.camera.smoothTargetTrack = true;
  }
  const outDir = path.resolve('bench', 'camera-offline-results');
  fs.mkdirSync(outDir, { recursive: true });

  const runs = [];
  const scoreKeys = all ? Object.keys(SCORES) : [score];
  for (const s of scoreKeys) {
    for (const hz of hzList) {
      for (const mode of modes) {
        // eslint-disable-next-line no-console
        console.log(`Running ${s} @ ${hz}Hz (${mode})...`);
        runs.push(await runOne({ scoreKey: s, outDir, hz, mode, durationSec }));
      }
    }
  }
  const summary = runs.map((r) => r.metrics);
  const sumPath = path.join(outDir, `summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  // eslint-disable-next-line no-console
  console.log('OFFLINE_CAMERA_SUMMARY_JSON=' + JSON.stringify(summary));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Camera offline harness failed:', err);
  process.exit(1);
});

