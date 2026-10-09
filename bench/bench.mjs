#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_PORT = process.env.PORT || 4173;
const BASE_URL = `http://localhost:${PREVIEW_PORT}`;

function startPreview() {
  const child = spawn('pnpm', ['preview', `--port=${PREVIEW_PORT}`], {
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  child.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  const ready = new Promise((res) => {
    const onData = (d) => {
      const s = d.toString();
      if (s.includes('Local:')) res();
    };
    child.stdout.on('data', onData);
  });
  return { child, ready };
}

async function runOne({ score, durationSec = 30, cpuThrottle = 4, headless = true }) {
  const launch = await chromium.launch({
    headless,
    args: [
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const context = await launch.newContext();
  const page = await context.newPage();
  // CPU throttling via CDP
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });

  const url = `${BASE_URL}/?renderer=webgl&bench=1&score=${encodeURIComponent(score)}&durationSec=${durationSec}&auto=play`;
  let result = null;
  page.on('console', (msg) => {
    const text = msg.text();
    // Mirror all console for debugging in CI/local
    console.log(`[page] ${text}`);
    const k = '__BENCH_RESULT__';
    const i = text.indexOf(k);
    if (i >= 0) {
      try { result = JSON.parse(text.slice(i + k.length)); } catch {}
    }
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  // Allow a small grace period for bench result to print
  const t0 = Date.now();
  while (!result && Date.now() - t0 < (durationSec + 10) * 1000) {
    await delay(500);
  }
  if (!result) {
    // Fallback: ask the page to return the benchmark result directly
    try {
      result = await page.evaluate(async () => {
        const app = window.__luminoirApp;
        if (app?.render?.awaitBenchmarkResult) {
          return await app.render.awaitBenchmarkResult();
        }
        return null;
      });
    } catch {}
  }
  await context.close();
  await launch.close();
  if (!result) throw new Error(`No bench result for score ${score}`);
  return result;
}

function summarize(label, r) {
  const { p50, p95, p99, max, over8_3, over16_7, over33_3, samples } = r.result ?? {};
  return {
    label,
    samples,
    p50, p95, p99, max,
    over8_3, over16_7, over33_3,
  };
}

async function main() {
  const { child, ready } = startPreview();
  await ready;
  try {
    const durationSec = Number(process.env.BENCH_DURATION || 30);
    const cpuThrottle = Number(process.env.BENCH_CPU || 4);
    const headless = process.env.BENCH_HEADLESS !== 'false';
    const scores = (process.env.BENCH_SCORES || 'jupiter,starTrekFirstContact').split(',').map((s) => s.trim());
    const results = [];
    for (const score of scores) {
      const r = await runOne({ score, durationSec, cpuThrottle, headless });
      results.push(summarize(score, r));
    }
    const outDir = path.resolve('bench', 'results');
    fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `baseline-${ts}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ durationSec, cpuThrottle, results }, null, 2));
    console.log('BENCH_RESULTS_JSON=' + JSON.stringify({ durationSec, cpuThrottle, results }));
    console.table(results.map((x) => ({
      score: x.label,
      samples: x.samples,
      p50: x.p50?.toFixed(2),
      p95: x.p95?.toFixed(2),
      p99: x.p99?.toFixed(2),
      max: x.max?.toFixed(2),
      '>8.3ms': x.over8_3,
      '>16.7ms': x.over16_7,
      '>33.3ms': x.over33_3,
    })));
  } finally {
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});

