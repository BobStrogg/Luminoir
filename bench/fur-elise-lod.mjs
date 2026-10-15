/**
 * Für Elise frame-cost bench under Tesla-like throttling.
 *
 * WebGL, ?platform=tesla, CDP CPU throttle, 804×638 CSS at device
 * scale 2 (native DPR 2 → Tesla pixel ratio inside 1.25–1.5).
 * Also profiles Jupiter, Clair de Lune and Albatross, and zooms
 * Für Elise out under forced pressure to check that stems at the
 * playhead stay visible.
 *
 *   BASE_URL=http://127.0.0.1:5173 CPU=4 PLAY_MS=6000 node bench/fur-elise-lod.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const PLAY_MS = Number(process.env.PLAY_MS || 6000);
const CPU = Number(process.env.CPU || 4);
const OUT = process.env.OUT || '';
const SCORES = (process.env.SCORES || 'furElise,jupiter,clairDeLune,albatross').split(',');

async function profileScore(browser, score) {
  const context = await browser.newContext({
    viewport: { width: 804, height: 638 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(180000);
  page.setDefaultNavigationTimeout(180000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const url = `${BASE_URL}/?renderer=webgl&platform=tesla&score=${encodeURIComponent(score)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const btn = document.getElementById('btn-settings');
    return btn && !btn.classList.contains('hidden') && window.__luminoirApp;
  }, null, { timeout: 180000 });
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const app = window.__luminoirApp;
    window.__statsLog = [];
    app.render.onStats = (s) => {
      window.__statsLog.push({
        frameMsRecentP95: s.frameMsRecentP95,
        frameMsRecentP99: s.frameMsRecentP99,
        renderMsP95: s.renderMsP95,
        renderMsMax: s.renderMsMax,
        over16: s.longFramesOver16_7_total,
        over33: s.longFramesOver33_3_total,
        recentOver33: s.longFramesOver33_3,
        pressure: s.gpuPressure,
        rateMode: s.rateMode,
        rateN: s.rateDecimationN,
        present1x: s.present1x,
        present2x: s.present2x,
        present3x: s.present3x,
        presentFps: s.presentFps,
        mainP95: s.mainFrameMsRecentP95,
        mainP99: s.mainFrameMsRecentP99,
        context: s.context,
      });
    };
    window.__heapLog = [];
    window.__heapTimer = setInterval(() => {
      window.__heapLog.push(performance.memory?.usedJSHeapSize ?? null);
    }, 250);
  });

  await page.locator('#btn-play').click({ timeout: 20000, force: true });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const app = window.__luminoirApp;
    app.render.resetStatsCounters();
    app.render.resetFrameWindow();
    window.__statsLog = [];
    window.__heapLog = [];
  });
  await page.waitForTimeout(PLAY_MS);

  const played = await page.evaluate(async () => {
    const app = window.__luminoirApp;
    const snap = await app.render.probe();
    clearInterval(window.__heapTimer);
    const heaps = (window.__heapLog || []).filter((n) => typeof n === 'number');
    let maxStep = 0;
    for (let i = 1; i < heaps.length; i++) maxStep = Math.max(maxStep, heaps[i] - heaps[i - 1]);
    const stats = window.__statsLog || [];
    return {
      notes: app._noteTimeline?.length ?? null,
      scene: snap.scene,
      lod: snap.lod,
      quality: snap.quality,
      cameraDistance: snap.cameraDistance,
      frame: snap.frame,
      render: snap.render,
      jitterCpu: snap.jitter?.all ? {
        cpuMean: snap.jitter.all.cpuMean,
        cpuMax: snap.jitter.all.cpuMax,
      } : null,
      lastStats: stats[stats.length - 1] || null,
      heap: { samples: heaps.length, maxStep, start: heaps[0] ?? null, end: heaps[heaps.length - 1] ?? null },
    };
  });

  let stressed = null;
  if (score === 'furElise') {
    await page.evaluate(() => window.__luminoirApp.render.updateConfig({ debugPressure: 1 }));
    const canvas = page.locator('#scene-canvas');
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(80);
      }
    }
    await page.waitForTimeout(500);
    stressed = await page.evaluate(async () => {
      const snap = await window.__luminoirApp.render.probe();
      return {
        lod: snap.lod,
        cameraDistance: snap.cameraDistance,
        drawCalls: snap.scene?.drawCalls,
        triangles: snap.scene?.triangles,
        quality: { pressure: snap.quality?.pressure, sceneGpuMs: snap.quality?.sceneGpuMs },
      };
    });
  }

  await page.locator('#btn-stop').click({ timeout: 5000, force: true }).catch(() => {});
  await context.close();
  return { score, errors, played, stressed };
}

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--disable-background-timer-throttling'],
});
const results = [];
for (const score of SCORES) {
  process.stderr.write(`profiling ${score}\n`);
  const row = await profileScore(browser, score);
  results.push(row);
  const p = row.played;
  process.stderr.write(JSON.stringify({
    score,
    notes: p.notes,
    draw: p.scene?.drawCalls,
    tris: p.scene?.triangles,
    instances: p.scene?.totalInstances,
    frameP95: p.frame?.p95,
    frameP99: p.frame?.p99,
    renderP95: p.render?.p95,
    renderP99: p.render?.p99,
    over33: p.lastStats?.over33,
    present3x: p.lastStats?.present3x,
    rate: p.lastStats?.rateMode,
    n: p.lastStats?.rateN,
    sceneProbe: p.quality?.sceneProbeMs,
    sceneGpu: p.quality?.sceneGpuMs,
    dpr: p.quality?.pixelRatio,
    reach: p.lod?.reach,
    reachCap: p.lod?.reachCap,
    hidden: p.lod?.hidden,
    nearHidden: p.lod?.nearHidden,
    mode: p.lod?.mode,
    cam: p.cameraDistance,
    cpu: p.jitterCpu?.cpuMean,
    stressedDist: row.stressed?.cameraDistance,
    stressedHidden: row.stressed?.lod?.hidden,
    stressedNearHidden: row.stressed?.lod?.nearHidden,
    stressedReach: row.stressed?.lod?.reach,
    errors: row.errors,
  }) + '\n');
}
await browser.close();
const payload = { cpu: CPU, playMs: PLAY_MS, when: new Date().toISOString(), results };
if (OUT) writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload));
