#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_PORT = process.env.PORT || 5176;
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

async function exportTimeline(scoreKey) {
  const { child, ready } = startPreview();
  await ready;
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      console.log(`[page] ${text}`);
    });
    const url = `${BASE_URL}/?renderer=webgl&bench=1&score=${encodeURIComponent(scoreKey)}&durationSec=0`;
    await page.goto(url, { waitUntil: 'networkidle' });
    // Force explicit load to ensure the right score is active.
    try {
      await page.evaluate(async (id) => {
        if (window.__luminoirApp && typeof window.__luminoirApp.loadDemoScore === 'function') {
          await window.__luminoirApp.loadDemoScore(id);
        }
        return true;
      }, scoreKey);
    } catch {}
    // Wait until the app has posted the timeline to the worker (setTimeline hook)
    const res = await page.waitForFunction(() => {
      const tl = window.__luminoirLastTimeline;
      const fr = window.__luminoirLastFraming;
      if (tl && tl.length && fr) return { timeline: tl, framing: fr };
      return null;
    }, { timeout: 60000 });
    const { timeline, framing } = await res.jsonValue();
    const outDir = path.resolve('bench', 'timelines');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${scoreKey}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      timeline,
      contentMinY: framing.contentMinY,
      contentMaxY: framing.contentMaxY,
      firstNote: timeline.length ? { x: timeline[0].x, y: timeline[0].y } : null,
    }, null, 2));
    console.log('EXPORTED_TIMELINE_JSON=' + outPath);
  } finally {
    await browser.close();
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

async function main() {
  const score = (process.argv.find((a) => a.startsWith('--score=')) || '').split('=')[1] || 'jupiter';
  await exportTimeline(score);
}

main().catch((err) => {
  console.error('Export-from-page failed:', err);
  process.exit(1);
});

