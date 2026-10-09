#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_PORT = process.env.PORT || 5174;
const BASE_URL = `http://localhost:${PREVIEW_PORT}`;

function startPreview() {
  const child = spawn('pnpm', ['preview', `--port=${PREVIEW_PORT}`], {
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const ready = new Promise((res) => {
    const onData = (d) => {
      const s = String(d || '');
      if (s.includes('Local:')) res();
    };
    child.stdout.on('data', onData);
  });
  return { child, ready };
}

async function exportOne(scoreKey) {
  // eslint-disable-next-line no-console
  console.log('[export] starting preview');
  const { child, ready } = startPreview();
  await ready;
  // eslint-disable-next-line no-console
  console.log('[export] preview ready');
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      // eslint-disable-next-line no-console
      console.log('[page]', msg.text());
    });
    const url = `${BASE_URL}/?bench=1&score=${encodeURIComponent(scoreKey)}&exportTimeline=1`;
    // eslint-disable-next-line no-console
    console.log('[export] goto', url);
    await page.goto(url, { waitUntil: 'networkidle' });
    // eslint-disable-next-line no-console
    console.log('[export] page loaded, waiting for timeline...');
    // Poll for timeline attachment
    const result = await page.waitForFunction(() => {
      const tl = window.__luminoirLastTimeline;
      const fr = window.__luminoirLastFraming;
      if (tl && tl.length && fr) return { timeline: tl, framing: fr };
      return null;
    }, { timeout: 60000 });
    // Prefer console-export (large JSON), fallback to scraping window vars
    let exported = null;
    page.on('console', (msg) => {
      const t = msg.text();
      const k = '__TIMELINE_EXPORT__';
      const i = t.indexOf(k);
      if (i >= 0) {
        try { exported = JSON.parse(t.slice(i + k.length)); } catch {}
      }
    });
    let { timeline, framing } = (await result.jsonValue()) || {};
    if (exported) {
      timeline = exported.timeline;
      framing = { contentMinY: exported.contentMinY, contentMaxY: exported.contentMaxY };
    }
    if (!timeline || !timeline.length || !framing) {
      // eslint-disable-next-line no-console
      console.log('[export] timeline not available yet, failing');
      throw new Error('Timeline not available');
    }
    const firstNote = { x: timeline[0].x, y: timeline[0].y };
    const outDir = path.resolve('bench', 'timelines');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${scoreKey}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      timeline,
      contentMinY: framing.contentMinY,
      contentMaxY: framing.contentMaxY,
      firstNote,
    }, null, 2));
    // eslint-disable-next-line no-console
    console.log('EXPORTED_TIMELINE_JSON=' + outPath);
  } finally {
    // eslint-disable-next-line no-console
    console.log('[export] shutting down');
    await browser.close();
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

async function main() {
  const score = (process.argv.find((a) => a.startsWith('--score=')) || '').split('=')[1] || 'jupiter';
  await exportOne(score);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Timeline export failed:', err);
  process.exit(1);
});

