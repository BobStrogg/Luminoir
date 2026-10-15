#!/usr/bin/env node
/**
 * Score-switch leak bench.
 *
 * Loads Jupiter (fresh), Clair de Lune (multi-staff), Albatross, then
 * Jupiter again in one session. The second Jupiter must match the fresh
 * load: renderer.info (geometries, textures, programs, draw calls),
 * scene children, listener counts, audio nodes, JS heap, and the frame
 * cost of a short play.
 *
 *   BASE_URL=http://127.0.0.1:5173 node bench/score-switch-leak.mjs
 *   RENDERER=webgl|default   PLAY_MS=3000   OUT=/tmp/score-switch.json
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const RENDERER = process.env.RENDERER || 'webgl';
const PLAY_MS = Number(process.env.PLAY_MS || 3000);
const OUT = process.env.OUT || '';
const SEQUENCE = ['jupiter', 'clairDeLune', 'albatross', 'jupiter'];

function delta(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return +(b - a).toFixed(3);
  return null;
}

async function listenerCount(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const nodes = [document, window, document.getElementById('scene-canvas')].filter(Boolean);
      let n = 0;
      for (const node of nodes) {
        const map = getEventListeners(node);
        for (const arr of Object.values(map)) n += arr.length;
      }
      return n;
    })()`,
    includeCommandLineAPI: true,
    returnByValue: true,
  });
  return result?.value ?? null;
}

async function heapBytes(cdp, page) {
  const main = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  let worker = null;
  try {
    await cdp.send('HeapProfiler.collectGarbage');
  } catch { /* optional */ }
  const workers = page.workers();
  const workerHeaps = [];
  for (const w of workers) {
    try {
      const session = await page.context().newCDPSession(w);
      try { await session.send('HeapProfiler.collectGarbage'); } catch { /* optional */ }
      const usage = await session.send('Runtime.getHeapUsage');
      workerHeaps.push({ url: w.url(), used: usage.usedSize, total: usage.totalSize });
      await session.detach().catch(() => {});
    } catch (err) {
      workerHeaps.push({ url: w.url(), error: String(err && err.message || err) });
    }
  }
  const renderWorker = workerHeaps.find((h) => /renderWorker|renderer/i.test(h.url || '')) || workerHeaps[0] || null;
  if (renderWorker && typeof renderWorker.used === 'number') worker = renderWorker.used;
  return { main, worker, workerHeaps };
}

async function sample(page, cdp, label) {
  const probe = await page.evaluate(async () => {
    const app = window.__luminoirApp;
    const snap = await app.render.probe();
    const audio = app.midiPlayer.resourceSnapshot();
    return {
      scene: snap.scene,
      frame: snap.frame,
      render: snap.render,
      quality: {
        shadowMapSize: snap.quality?.shadowMapSize,
        pixelRatio: snap.quality?.pixelRatio,
        pressure: snap.quality?.pressure,
      },
      audio,
      compiling: snap.render?.compiling,
    };
  });
  const listeners = await listenerCount(cdp);
  const heap = await heapBytes(cdp, page);
  const mainAfterGc = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  return {
    label,
    ...probe,
    domListeners: listeners,
    heap: { ...heap, main: mainAfterGc ?? heap.main, workerHeaps: heap.workerHeaps },
  };
}

async function waitReady(page) {
  await page.waitForFunction(() => {
    const btn = document.getElementById('btn-settings');
    return btn && !btn.classList.contains('hidden') && window.__luminoirApp;
  }, { timeout: 180000 });
}

async function loadScore(page, id) {
  const t0 = Date.now();
  await page.evaluate(async (scoreId) => {
    const app = window.__luminoirApp;
    await app.loadDemoScore(scoreId);
  }, id);
  // Scene-ready is inside loadDemoScore; give the GPU one beat so
  // info.memory reflects the frame that just landed.
  await page.waitForTimeout(400);
  return Date.now() - t0;
}

async function playWindow(page) {
  await page.evaluate(() => window.__luminoirApp.render.resetFrameWindow());
  const playBtn = page.locator('#btn-play');
  await playBtn.click({ timeout: 10000 });
  await page.waitForTimeout(PLAY_MS);
  const stopBtn = page.locator('#btn-stop');
  await stopBtn.click({ timeout: 10000 });
  await page.waitForTimeout(400);
}

function sceneView(s) {
  const sc = s.scene || {};
  return {
    label: s.label,
    backend: sc.backend,
    geometries: sc.geometries,
    textures: sc.textures,
    programs: sc.programs,
    pipelines: sc.pipelines,
    stagePrograms: sc.stagePrograms,
    drawCalls: sc.drawCalls,
    triangles: sc.triangles,
    meshCount: sc.meshCount,
    instancedMeshCount: sc.instancedMeshCount,
    childCount: sc.childCount,
    contentChildren: sc.contentChildren,
    pointLights: sc.pointLights,
    directionalLights: sc.directionalLights,
    ambientLights: sc.ambientLights,
    spriteCount: sc.spriteCount,
    geometryCache: sc.geometryCache,
    instanceBytes: sc.instanceBytes,
    gpuTrackedMeshes: sc.gpuTrackedMeshes,
    gpuTrackedObjects: sc.gpuTrackedObjects,
    workerListeners: sc.listeners,
    eventLog: sc.eventLog,
    domListeners: s.domListeners,
    audio: s.audio,
    heapMain: s.heap?.main,
    heapWorker: s.heap?.worker,
    workerHeaps: s.heap?.workerHeaps,
    frameP50: s.frame?.p50,
    frameP95: s.frame?.p95,
    renderP95: s.render?.p95,
    frameMean: s.frame?.mean,
    renderMean: s.render?.mean,
    shadowMapSize: s.quality?.shadowMapSize,
    loadMs: s.loadMs,
  };
}

function assertNotSlower(name, fresh, again, { abs = 0, rel = 0 } = {}, failures) {
  if (typeof fresh !== 'number' || typeof again !== 'number') return;
  const limit = fresh + Math.max(abs, Math.abs(fresh) * rel);
  if (again > limit) {
    failures.push(`${name}: fresh ${fresh} vs again ${again} (slower by ${again - fresh}, limit ${limit})`);
  }
}

function assertClose(name, fresh, again, { exact = true, abs = 0, rel = 0 } = {}, failures) {
  if (fresh == null && again == null) return;
  if (typeof fresh !== 'number' || typeof again !== 'number') {
    if (fresh !== again) failures.push(`${name}: ${JSON.stringify(fresh)} → ${JSON.stringify(again)}`);
    return;
  }
  const diff = Math.abs(again - fresh);
  const limit = exact ? 0 : Math.max(abs, Math.abs(fresh) * rel);
  if (diff > limit) {
    failures.push(`${name}: fresh ${fresh} vs again ${again} (Δ ${again - fresh}, limit ${limit})`);
  }
}

function check(fresh, again) {
  const failures = [];
  const exactKeys = [
    'geometries', 'textures', 'programs', 'pipelines', 'stagePrograms',
    'meshCount', 'instancedMeshCount', 'childCount', 'contentChildren',
    'pointLights', 'directionalLights', 'ambientLights', 'spriteCount',
    'geometryCache', 'instanceBytes', 'workerListeners', 'domListeners',
  ];
  for (const k of exactKeys) assertClose(k, fresh[k], again[k], { exact: true }, failures);
  assertClose('audio.contexts', fresh.audio?.contexts, again.audio?.contexts, { exact: true }, failures);
  assertClose('audio.instruments', fresh.audio?.instruments, again.audio?.instruments, { exact: true }, failures);
  assertClose('audio.pendingLoads', fresh.audio?.pendingLoads, again.audio?.pendingLoads, { exact: true }, failures);
  assertClose('audio.scheduled', fresh.audio?.scheduled, again.audio?.scheduled, { exact: true }, failures);
  assertClose('audio.gainNodes', fresh.audio?.gainNodes, again.audio?.gainNodes, { exact: true }, failures);
  if (fresh.audio?.scheduled !== 0) failures.push(`audio.scheduled fresh is ${fresh.audio?.scheduled}, want 0 after stop`);
  if (again.audio?.scheduled !== 0) failures.push(`audio.scheduled again is ${again.audio?.scheduled}, want 0 after stop`);
  // Event log is capped; it must not grow without bound across the session.
  if ((again.eventLog ?? 0) > 80) failures.push(`eventLog ${again.eventLog} exceeded cap 80`);
  assertClose('heapMain', fresh.heapMain, again.heapMain, { exact: false, abs: 12e6, rel: 0.15 }, failures);
  assertClose('heapWorker', fresh.heapWorker, again.heapWorker, { exact: false, abs: 12e6, rel: 0.15 }, failures);
  // Headless rAF intervals wander. Frame cost matches when the second
  // Jupiter is not slower than the fresh load by more than the slack.
  // Headless rAF intervals are scheduling noise (a single stalled
  // tick dominates p95). Submit cost is the scene's frame cost.
  assertNotSlower('renderP95', fresh.renderP95, again.renderP95, { abs: 3, rel: 0.35 }, failures);
  assertNotSlower('renderMean', fresh.renderMean, again.renderMean, { abs: 2, rel: 0.35 }, failures);
  // Draw calls move with the playhead (chunk culling). Same score, same
  // play window, within 15% — a leaked scene would be far outside that.
  assertClose('drawCalls', fresh.drawCalls, again.drawCalls, { exact: false, abs: 40, rel: 0.15 }, failures);
  if ((again.audio?.contexts ?? 0) > 1) failures.push(`audio contexts ${again.audio?.contexts}`);
  return failures;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer',
      '--disable-dev-shm-usage',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const cdp = await page.context().newCDPSession(page);
  page.on('console', (msg) => {
    const t = msg.text();
    if (/error|fail|warn/i.test(t) && !/WebGPU|gpu/i.test(t)) console.log(`[page] ${t}`);
  });
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));

  const rendererQ = RENDERER === 'default' ? '' : `renderer=${encodeURIComponent(RENDERER)}&`;
  const url = `${BASE_URL}/?${rendererQ}score=jupiter&smartCamera=0`;
  console.log(`[leak] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitReady(page);

  const samples = [];
  // The page opened on Jupiter — that is the fresh-load baseline.
  let snap = await sample(page, cdp, 'jupiter:fresh');
  snap.loadMs = null;
  samples.push(snap);
  await playWindow(page);
  snap = await sample(page, cdp, 'jupiter:fresh:played');
  samples.push(snap);

  for (let i = 1; i < SEQUENCE.length; i++) {
    const id = SEQUENCE[i];
    const loadMs = await loadScore(page, id);
    const tag = id === 'jupiter' ? 'jupiter:again' : id;
    snap = await sample(page, cdp, tag);
    snap.loadMs = loadMs;
    samples.push(snap);
    await playWindow(page);
    snap = await sample(page, cdp, `${tag}:played`);
    snap.loadMs = loadMs;
    samples.push(snap);
  }

  const views = samples.map(sceneView);
  const fresh = views.find((v) => v.label === 'jupiter:fresh:played');
  const again = views.find((v) => v.label === 'jupiter:again:played');
  const failures = check(fresh, again);
  const report = {
    renderer: RENDERER,
    playMs: PLAY_MS,
    samples: views,
    delta: {
      geometries: delta(fresh.geometries, again.geometries),
      textures: delta(fresh.textures, again.textures),
      programs: delta(fresh.programs, again.programs),
      pipelines: delta(fresh.pipelines, again.pipelines),
      stagePrograms: delta(fresh.stagePrograms, again.stagePrograms),
      drawCalls: delta(fresh.drawCalls, again.drawCalls),
      geometryCache: delta(fresh.geometryCache, again.geometryCache),
      instanceBytes: delta(fresh.instanceBytes, again.instanceBytes),
      meshCount: delta(fresh.meshCount, again.meshCount),
      domListeners: delta(fresh.domListeners, again.domListeners),
      workerListeners: delta(fresh.workerListeners, again.workerListeners),
      instruments: delta(fresh.audio?.instruments, again.audio?.instruments),
      scheduled: delta(fresh.audio?.scheduled, again.audio?.scheduled),
      heapMain: delta(fresh.heapMain, again.heapMain),
      heapWorker: delta(fresh.heapWorker, again.heapWorker),
      frameP50: delta(fresh.frameP50, again.frameP50),
      frameP95: delta(fresh.frameP95, again.frameP95),
      renderP95: delta(fresh.renderP95, again.renderP95),
    },
    failures,
  };
  console.log('__LEAK_REPORT__' + JSON.stringify(report));
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  await browser.close();
  if (failures.length) {
    console.error('[leak] FAIL');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[leak] PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
