#!/usr/bin/env node
/**
 * Minimal WebKit bench runner that launches Vite preview, opens the page
 * in Playwright WebKit with an iPhone-like viewport, and collects the
 * worker-side aggregated bench result printed by the app.
 */
import { webkit, devices } from 'playwright';
import { spawn } from 'node:child_process';

const PREVIEW_PORT = process.env.PORT || 4174;
const BASE_URL = `http://localhost:${PREVIEW_PORT}`;

function startPreview() {
  const child = spawn('pnpm', ['preview', `--port=${PREVIEW_PORT}`], {
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const ready = new Promise((res) => {
    const onData = (d) => {
      const s = String(d || '');
      process.stdout.write(`[preview] ${s}`);
      if (s.includes('Local:')) res();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => process.stderr.write(`[preview-err] ${d}`));
  });
  return { child, ready };
}

async function runOne({ score = 'albatross', durationSec = 20 }) {
  const iPhone = devices['iPhone 14 Pro'];
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({
    ...iPhone,
  });
  const page = await context.newPage();
  let result = null;
  page.on('console', (msg) => {
    const text = msg.text();
    console.log(`[page] ${text}`);
    const k = '__BENCH_RESULT__';
    const i = text.indexOf(k);
    if (i >= 0) {
      try { result = JSON.parse(text.slice(i + k.length)); } catch {}
    }
  });
  const url = `${BASE_URL}/?bench=1&score=${encodeURIComponent(score)}&durationSec=${durationSec}&auto=play`;
  await page.goto(url, { waitUntil: 'networkidle' });
  // Wait for the result or timeout after duration + 10s
  const t0 = Date.now();
  while (!result && Date.now() - t0 < (durationSec + 10) * 1000) {
    await page.waitForTimeout(500);
  }
  await context.close();
  await browser.close();
  if (!result) throw new Error('No WebKit bench result captured');
  return result;
}

async function main() {
  const { child, ready } = startPreview();
  await ready;
  try {
    const durationSec = Number(process.env.BENCH_DURATION || 20);
    const score = process.env.BENCH_SCORE || 'albatross';
    const r = await runOne({ score, durationSec });
    console.log('WEBKIT_BENCH_RESULT=' + JSON.stringify(r));
  } finally {
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('WebKit bench failed:', err);
  process.exit(1);
});

