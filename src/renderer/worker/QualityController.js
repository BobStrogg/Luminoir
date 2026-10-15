import * as THREE from 'three';
import { SceneConfig } from '../../rendering/SceneConfig.js';
import {
  chooseLoadTimeQuality,
  nextQualityStep,
  advancePressure,
  lightIntensityForPressure,
  snapToRefreshInterval,
  choosePresentDecimation,
  detailReachForHeadroom,
  frameHeadroom,
  sharpRatioStillFits,
  TESLA_LOCK60_PROBE_MS,
  TESLA_DPR_MIN,
  LOD_FAR_RADIUS,
} from './qualityPolicy.js';

/**
 * Two-phase GPU quality system.
 *
 * **Phase 1 — load-time probe** (`probeGpuCost`, called during init and
 * score loading):
 *   The init probe renders the empty scene several times to choose the
 *   maximum shadow-map resolution and PCF type the GPU can support.
 *   Safari, mobile, and Tesla then run a second probe with the real score
 *   while the loading overlay is still visible.  That probe may only
 *   downshift shadow quality, so dense geometry is measured without
 *   causing a mid-playback shadow-map flicker.  The framebuffer always
 *   renders at the browser's native `devicePixelRatio` — resolution is
 *   never traded for performance.
 *
 * **Phase 2 — runtime pressure** (`_runtimePressure`, updated each rAF):
 *   A 0→1 float that rises only when recent p95 frame time exceeds
 *   the 60 fps target.  It smoothly scales light-ball intensity,
 *   spaces out static directional-shadow refreshes from 30 Hz toward
 *   ~7 Hz (deeper on constrained devices), suppresses FXAA, and feeds
 *   the LOD gate's pressure-scaled thresholds.  No actuator
 *   reallocates GPU resources.
 *
 *   Shadow map size and PCF type require a dispose / reallocate, so
 *   those settings only change behind the score-loading overlay.
 *   DPR never changes at all — it is always the native value.
 *
 * Calibration:
 *   The baseline rAF interval is measured from the first 30 display-rate
 *   ticks (any frames — idle ticks are valid samples of the same vsync
 *   and feed the camera's quantized dt before the first play).  Two
 *   baselines are derived: `baselineMs` (p95, drives the render budget)
 *   and `displayMs` (median snapped to the nearest standard refresh,
 *   drives `quantizeFrameMs`).  Runtime pressure targets a fixed
 *   16.67 ms frame budget so a 120 Hz display does not degrade quality
 *   merely because an occasional frame takes two refresh intervals.
 */
export class QualityController {
  /**
   * @param {object} ctx Shared worker context — reads `renderer`,
   *   `scene`, `camera`, `keyLightRig`, `antiAliasing` and `markDirty`
   *   lazily so it can be constructed before the renderer exists.
   */
  constructor(ctx) {
    this._ctx = ctx;
  }

  /** Baseline rAF interval (ms) — p95 of the calibration window,
   *  drives `renderBudgetMs`.  Set once by `calibrate()`. */
  _baselineMs = 16.67;
  /** Display refresh interval (ms) — median of the calibration window
   *  snapped to the nearest standard rate, drives `quantizeFrameMs`
   *  so camera/light-ball dt integrates in exact vsync steps. */
  _displayMs = 16.67;
  _calibrated = false;
  _calibCount = 0;
  _calibBuf  = new Float64Array(QualityController._CALIB_TICKS);
  _calibSort = new Float64Array(QualityController._CALIB_TICKS);
  static _CALIB_TICKS = 30;

  /**
   * 0→1 runtime pressure float.  0 = no pressure (lights at full
   * intensity); 1 = maximum pressure (lights fully dimmed).
   * Driven by `updateRuntimePressure()` in the rAF loop.
   */
  _runtimePressure = 0;
  /** Debug-only pressure override set via `updateConfig({ debugPressure })`.
   *  When a number, `pressure` reports it and `updateRuntimePressure`
   *  early-returns so the real pressure signal can't fight the
   *  override; `null` restores normal behaviour. */
  _debugPressure = null;
  /** Whether the auto-dim system is enabled (mirrors the Settings toggle). */
  _autoDimEnabled = true;
  /** Diagnostics: what the load-time probe measured and chose.  Exposed
   *  via `probe()` so the dev overlay / Playwright tests can verify the
   *  quality selection matches the hardware. */
  probeMsMeasured = -1;
  _sceneProbeMsMeasured = -1;
  _chosenShadowMapSize = 0;
  /** Base light intensity saved at init so pressure can scale it. */
  baseLightIntensity = 0;
  _maxShadowMapSize = 0;
  _maxSoftPcf = false;
  sceneGpuBudgetMs = 14;
  runSceneProbe = false;
  allowVeryLowQuality = false;

  /** Pre-allocated scratch for the 4 Hz AQ p95 sample.  Typed array +
   *  in-place sort avoids the `new Array` + `push` allocations that
   *  were triggering minor GC pauses inside the hot rAF loop. */
  _aqScratch = new Float64Array(120);
  _AQ_SAMPLE_INTERVAL_MS = 250;
  _lastAqSampleMs = 0;
  _latestAqP95 = 0;

  get pressure() { return this._debugPressure ?? this._runtimePressure; }
  get baselineMs() { return this._baselineMs; }
  get displayMs() { return this._displayMs; }
  get calibrated() { return this._calibrated; }
  get autoDimEnabled() { return this._autoDimEnabled; }
  get chosenShadowMapSize() { return this._chosenShadowMapSize; }
  get probeMs() { return this.probeMsMeasured; }
  get sceneProbeMs() { return this._sceneProbeMsMeasured; }
  /** GPU scene cost after the idle-fence subtraction, in ms.  This is
   *  the number the Tesla rate lock compares to 16 ms. */
  get sceneGpuMs() { return this._sceneGpuMs; }
  _sceneGpuMs = 0;

  /** Feed one rAF interval sample.  Locks `_baselineMs` / `_displayMs`
   *  after `_CALIB_TICKS` samples.  Samples above 40 ms are rejected:
   *  no real display refreshes slower than ~25 Hz, so anything larger
   *  is a hidden-tab throttle or a stall, not a vsync interval — and
   *  this now runs on EVERY rAF tick (not just play-session ones), so
   *  idle-background intervals must not poison the window.  The p95
   *  keeps the render budget comparable with the live p95 signal; the
   *  snapped median gives `quantizeFrameMs` the true vsync period even
   *  when the window caught a few dropped frames. */
  calibrate(frameMs) {
    if (this._calibrated || frameMs <= 0 || frameMs >= 40) return;
    this._calibBuf[this._calibCount++] = frameMs;
    if (this._calibCount >= QualityController._CALIB_TICKS) {
      this._calibSort.set(this._calibBuf);
      this._calibSort.sort();
      const ticks = QualityController._CALIB_TICKS;
      // Clamp to a sane range in case the tab is throttled, vsync is
      // locked, or the calibration window caught a multi-spike burst
      // (upper bound covers 60 Hz p95 ≈ 17–18 ms with margin).
      this._baselineMs = Math.max(6, Math.min(25,
        this._calibSort[Math.floor(ticks * 0.95)]));
      this._displayMs = snapToRefreshInterval(this._calibSort[ticks >> 1]);
      this._calibrated = true;
      try {
        this._ctx?.eventLog?.note?.(`aq-calibrated: baseline=${this._baselineMs.toFixed(2)} ms, display=${this._displayMs.toFixed(2)} ms`);
      } catch {}
    }
  }

  /** Reset calibration — call when the existing baseline may be stale
   *  (e.g. re-enabling autoDegrade after a disabled period).  NOT on
   *  play-start: the refresh rate doesn't change when music starts,
   *  and discarding a good idle-measured baseline to re-measure during
   *  the heaviest frames of a play session only risks a worse value. */
  resetCalibration() {
    this._calibCount = 0;
    this._calibBuf.fill(0);
    this._baselineMs = 16.67;
    this._displayMs = 16.67;
    this._calibrated = false;
    this._lastAqSampleMs = 0;
    this._latestAqP95 = 0;
  }

  /**
   * Update `_runtimePressure` and apply it to light intensity.
   * Call once per rAF tick after computing `frameP95`.
   * @param {number} dt        Frame duration in seconds.
   * @param {number} frameP95  Recent p95 rAF interval in ms.
   */
  updateRuntimePressure(dt, frameP95) {
    if (!this._autoDimEnabled || !this._calibrated) return;
    // A debug override freezes the real pressure signal so it can't
    // drift away from (or fight) the forced value.
    if (this._debugPressure != null) return;

    this._runtimePressure = advancePressure(this._runtimePressure, dt, frameP95);

    // Apply to light intensity.  LightBallController reads
    // SceneConfig.lightBall.intensity every update() call, so writing
    // here takes effect on the very next frame with no artifacts.
    SceneConfig.lightBall.intensity =
      lightIntensityForPressure(this.baseLightIntensity, this._runtimePressure);
    this._updateFxaaPressure();
  }

  _updateFxaaPressure() {
    this._ctx.antiAliasing.updatePressure(this._runtimePressure);
  }

  /**
   * Block until the GPU has actually finished executing all submitted
   * work.  `renderer.render()` only measures CPU-side command encoding —
   * on Chromium (WebGPU *and* WebGL) submission never waits for the GPU,
   * so timing `render()` alone reads ~0.2 ms regardless of how slow the
   * GPU is.  That made the old probe classify every Chromium machine as
   * "very fast" and hand out 6144² shadows unconditionally —
   * exactly the machines that then couldn't hold a consistent frame rate.
   *
   *   • WebGPU: `device.queue.onSubmittedWorkDone()` resolves when the
   *     queue is drained.
   *   • WebGL: a 1×1 `readPixels` forces a full pipeline flush + sync
   *     (the classic synchronous fence).
   */
  async gpuSync() {
    const { renderer } = this._ctx;
    if (!renderer) return;
    const device = renderer.backend?.device;
    if (device?.queue?.onSubmittedWorkDone) {
      await device.queue.onSubmittedWorkDone();
      return;
    }
    const gl = typeof renderer.getContext === 'function' ? renderer.getContext() : null;
    if (gl && typeof gl.readPixels === 'function') {
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
  }

  /**
   * Cost of the fence itself on an already-idle GPU. A 1×1 readPixels
   * (or a queue drain) after the warmup render has finished is pure
   * sync overhead. The scene probe subtracts it so a slow readback
   * cannot look like a frame that missed 16.7 ms.
   */
  async idleFenceMs() {
    await this.gpuSync();
    const t0 = performance.now();
    await this.gpuSync();
    return Math.max(0, performance.now() - t0);
  }

  /**
   * Probe GPU rendering cost with the current scene by rendering it
   * `count` times and returning wall-clock milliseconds — including GPU
   * execution time (`gpuSync`) and a full shadow-map pass per frame.
   *
   * The shadow pass must be forced explicitly: `KeyLightRig.update`
   * switches the key light to manual shadow updates
   * (`shadow.autoUpdate = false`) during `setupLighting`, so without
   * `needsUpdate = true` per frame the probe would measure frames with
   * no shadow render at all.  Forcing it measures the worst frame in
   * the 30 Hz shadow-refresh cadence.
   *
   * Init uses the minimum sample to classify peak hardware capability;
   * the optional score-aware pass uses the median to make a
   * conservative downshift decision after real geometry is present.
   */
  async probeGpuCost(count = 7, median = false, { forceShadow = true } = {}) {
    const { renderer, scene, camera, antiAliasing, keyLightRig } = this._ctx;
    if (!renderer || !scene || !camera) return 0;
    // Warm-up render — don't measure: first call often stalls on driver
    // JIT / shader cache miss regardless of scene complexity.
    antiAliasing.render(renderer, scene, camera);
    await this.gpuSync();
    let best = Infinity;
    const samples = median ? new Float64Array(count) : null;
    const wantShadow = forceShadow && !!SceneConfig.shadow.enabled;
    for (let i = 0; i < count; i++) {
      if (wantShadow && keyLightRig.light) keyLightRig.light.shadow.needsUpdate = true;
      const t0 = performance.now();
      antiAliasing.render(renderer, scene, camera);
      await this.gpuSync();
      const t = performance.now() - t0;
      if (samples) samples[i] = t;
      if (t < best) best = t;
    }
    if (samples) {
      samples.sort();
      return samples[Math.floor(samples.length / 2)];
    }
    return Number.isFinite(best) ? best : 0;
  }

  /**
   * Choose and apply shadow-map size and PCF type based on the result
   * of `probeGpuCost()`.  Called once from `handleInit`.  Resolution
   * is untouched — the renderer always runs at native `devicePixelRatio`.
   */
  applyLoadTimeQuality(probeMs, isConstrained) {
    const { mapSize, softPcf } = chooseLoadTimeQuality(probeMs, isConstrained);
    this._maxShadowMapSize = mapSize;
    this._maxSoftPcf = softPcf;
    this.setShadowQuality(mapSize, softPcf);
  }

  /** Apply shadow quality settings.  Must be called before
   *  the render loop starts so there is no mid-session dispose. */
  setShadowQuality(mapSize, softPcf) {
    const { renderer, keyLightRig, markDirty } = this._ctx;
    const keyLight = keyLightRig.light;
    if (!renderer || !keyLight) return;
    this._chosenShadowMapSize = mapSize;
    renderer.shadowMap.type = softPcf
      ? THREE.PCFSoftShadowMap
      : THREE.PCFShadowMap;
    if (keyLight.shadow.mapSize.width !== mapSize) {
      keyLight.shadow.mapSize.width  = mapSize;
      keyLight.shadow.mapSize.height = mapSize;
      if (keyLight.shadow.map) {
        keyLight.shadow.map.dispose();
        keyLight.shadow.map = null;
      }
      // Seed one re-render for the new allocation.  Preserve frozen
      // constrained behaviour by keeping autoUpdate=false there.
      keyLight.shadow.autoUpdate = keyLightRig.frozen ? false : true;
      const shadowCam = keyLight.shadow.camera;
      keyLightRig.texelSize.set(
        (shadowCam.right - shadowCam.left) / mapSize,
        (shadowCam.top - shadowCam.bottom) / mapSize,
      );
      // Ensure the new map renders once after allocation
      keyLight.shadow.needsUpdate = true;
    }
    keyLightRig.resetSnap();
    markDirty();
    try { this._ctx.syncShadowDiag?.(); } catch { /* diag is best-effort */ }
    try {
      this._ctx?.eventLog?.note?.(`shadow-quality: mapSize=${mapSize} softPcf=${!!softPcf} frozen=${!!keyLightRig.frozen}`);
      const arr = this._ctx.diagContext;
      if (Array.isArray(arr)) {
        const label = `Quality: shadowMapSize=${mapSize}${keyLightRig.frozen ? ' (frozen frustum)' : ''}`;
        const i = arr.findIndex((s) => typeof s === 'string' && s.startsWith('Quality: shadowMapSize='));
        if (i >= 0) arr[i] = label; else arr.push(label);
      }
    } catch {}
  }

  /**
   * When the full-detail GPU scene is already past 92 % of the budget,
   * hide detail beyond the headroom reach (never the near field) and
   * measure once more while the loading overlay is up.  Keep the shed
   * only when it actually gets cheaper.  Does not touch DPR or the
   * shadow map.
   * @returns {Promise<{ raw: number }|null>}
   */
  async _shedDistantDetail(fullSceneMs, fence, thresholdMs) {
    const lod = this._ctx.lod;
    const camera = this._ctx.camera;
    const controls = this._ctx.controls;
    if (!lod || !camera || !controls || !(fullSceneMs > thresholdMs * 0.92)) return null;
    const displayMs = this.calibrated ? this.displayMs : (1000 / 60);
    const reach = detailReachForHeadroom(frameHeadroom(fullSceneMs, displayMs));
    if (reach >= LOD_FAR_RADIUS - 0.5) return null;
    const pixelRatio = this._ctx.renderer?.getPixelRatio?.() || 1;
    const height = this._ctx.viewportHeightCss || 1;
    lod.snapGovernor(reach);
    lod.apply(camera, controls, pixelRatio, height, 0);
    const raw = await this.probeGpuCost(3, true, { forceShadow: !!SceneConfig.shadow.enabled });
    const shedScene = Math.max(0, raw - fence);
    const saved = fullSceneMs > 0 ? (fullSceneMs - shedScene) / fullSceneMs : 0;
    if (shedScene + 1 < fullSceneMs && saved >= 0.08) {
      lod.capReach(reach);
      lod.setGpuModel(fullSceneMs, shedScene, lod.detailVisibleFraction);
      try {
        this._ctx?.eventLog?.note?.(
          `detail-governor: reach=${reach.toFixed(1)} wu scene ${fullSceneMs.toFixed(1)} → ${shedScene.toFixed(1)} ms`);
      } catch {}
      return { raw };
    }
    lod.snapGovernor(LOD_FAR_RADIUS);
    lod.capReach(LOD_FAR_RADIUS);
    lod.apply(camera, controls, pixelRatio, height, 0);
    try {
      this._ctx?.eventLog?.note?.(
        `detail-governor: shed skipped (scene ${fullSceneMs.toFixed(1)} → ${shedScene.toFixed(1)} ms)`);
    } catch {}
    return null;
  }

  stepDown() {
    const step = nextQualityStep(this._chosenShadowMapSize, {
      allowVeryLowQuality: this.allowVeryLowQuality,
    });
    if (!step) return false;
    this.setShadowQuality(step.mapSize, step.softPcf);
    return true;
  }

  async refineSceneQuality() {
    const shadowsOn = !!SceneConfig.shadow.enabled;
    if (shadowsOn) {
      this.setShadowQuality(this._maxShadowMapSize, this._maxSoftPcf);
    }
    if (!this.runSceneProbe) {
      this._sceneProbeMsMeasured = -1;
      try { this._ctx?.eventLog?.note?.('scene-probe: skipped'); } catch {}
      return;
    }
    // Tesla's rate lock used to read rAF p95 after this probe. The
    // probe's own synchronous readPixels (and a forced shadow pass)
    // inserted ~2× vsync gaps into that ring, so a panel whose real
    // frames were 16.7 ms froze at N=2 (locked 30). The decision is
    // the median below, compared to TESLA_LOCK60_PROBE_MS, and the
    // ring is cleared afterwards.
    const threshold = this._ctx.isTesla ? TESLA_LOCK60_PROBE_MS : this.sceneGpuBudgetMs;
    const fence = this._ctx.isTesla ? await this.idleFenceMs() : 0;
    let measured = await this.probeGpuCost(3, true, { forceShadow: shadowsOn });
    const sceneMs = () => Math.max(0, measured - fence);
    const startMeasured = measured;
    const startDpr = this._ctx.renderer?.getPixelRatio?.() || 0;
    let steps = 0;
    if (shadowsOn) {
      while (measured > this.sceneGpuBudgetMs && this.stepDown()) {
        measured = await this.probeGpuCost(3, true, { forceShadow: true });
        steps++;
      }
    } else if (this._ctx.isTesla) {
      // The first median often includes a one-time program link.
      // Remeasure at the sharp ratio before trading it away: on the
      // v1.1.27 car the cold pass stepped 1.50 → 1.25, and the warm
      // scene cost at 1.25 was 10.10 ms (still inside 16 ms at 1.50
      // if cost scales with pixels).
      const sharpRatio = this._ctx.renderer?.getPixelRatio?.() || 1;
      if (sceneMs() > threshold) {
        measured = await this.probeGpuCost(3, true, { forceShadow: false });
      }
      let guard = 0;
      let keptRatio = this._ctx.renderer?.getPixelRatio?.() || 1;
      let keptScene = sceneMs();
      while (sceneMs() > threshold && guard < 2) {
        const renderer = this._ctx.renderer;
        const ratio = renderer?.getPixelRatio?.() || 1;
        if (ratio <= TESLA_DPR_MIN + 0.02) break;
        const scaled = ratio * Math.sqrt(threshold / Math.max(sceneMs(), 0.01));
        const next = Math.round(Math.max(TESLA_DPR_MIN, Math.min(ratio - 0.01, scaled)) * 100) / 100;
        if (!(next < ratio - 0.01)) break;
        const before = sceneMs();
        this._ctx.applyRenderPixelRatio?.(next);
        measured = await this.probeGpuCost(3, true, { forceShadow: false });
        guard++;
        steps++;
        const saved = before > 0 ? (before - sceneMs()) / before : 0;
        if (sceneMs() <= threshold || saved >= 0.25) {
          keptRatio = next;
          keptScene = sceneMs();
          continue;
        }
        this._ctx.applyRenderPixelRatio?.(keptRatio);
        measured = keptScene + fence;
        steps = Math.max(0, steps - 1);
        try {
          this._ctx?.eventLog?.note?.(
            `pixel-ratio: revert ${next.toFixed(2)} → ${keptRatio.toFixed(2)} (saved ${(saved * 100).toFixed(0)}%)`);
        } catch {}
        break;
      }
      if (keptRatio < sharpRatio - 0.01 && sharpRatioStillFits(keptScene, keptRatio, sharpRatio, threshold)) {
        this._ctx.applyRenderPixelRatio?.(sharpRatio);
        measured = await this.probeGpuCost(3, true, { forceShadow: false });
        if (sceneMs() <= threshold) {
          keptRatio = sharpRatio;
          keptScene = sceneMs();
          steps = 0;
          try {
            this._ctx?.eventLog?.note?.(
              `pixel-ratio: restore ${sharpRatio.toFixed(2)} (scene ${keptScene.toFixed(2)} ms)`);
          } catch {}
        } else {
          this._ctx.applyRenderPixelRatio?.(keptRatio);
          measured = keptScene + fence;
        }
      }
      this._ctx.probePixelRatioCeiling = keptRatio;
    }
    const fullScene = Math.max(0, measured - fence);
    const shed = await this._shedDistantDetail(fullScene, fence, threshold);
    if (shed) measured = shed.raw;
    this._sceneProbeMsMeasured = measured;
    this._sceneGpuMs = Math.max(0, measured - fence);
    let decision = null;
    if (this._ctx.isTesla) {
      const displayMs = this.calibrated ? this.displayMs : (1000 / 60);
      decision = choosePresentDecimation({
        displayMs,
        probeMedianMs: sceneMs(),
        thresholdMs: threshold,
      });
      this._ctx.loop?.applyProbeDecimation?.(decision.n, 'scene-probe');
    }
    this._forgetProbeStalls();
    try {
      const dpr = this._ctx.renderer?.getPixelRatio?.();
      const dprNote = dpr ? ` dpr=${Number(dpr).toFixed(2)}` : '';
      const stepped = steps
        ? ` start=${startMeasured.toFixed(2)} ms at dpr=${Number(startDpr).toFixed(2)} steps=${steps}`
        : '';
      const verdict = decision
        ? ` → ${decision.label} (N=${decision.n})`
        : '';
      const fenceNote = this._ctx.isTesla ? ` fence=${fence.toFixed(2)} ms scene=${sceneMs().toFixed(2)} ms` : '';
      const line = `scene-probe: median=${measured.toFixed(2)} ms${fenceNote} threshold=${threshold.toFixed(2)} ms shadows=${shadowsOn ? 'on' : 'off'}${dprNote}${stepped}${verdict}`;
      this._ctx?.eventLog?.note?.(line);
      const arr = this._ctx.diagContext;
      if (Array.isArray(arr)) {
        const label = `Rate probe: median ${measured.toFixed(2)} ms${this._ctx.isTesla ? ` scene ${sceneMs().toFixed(2)} ms` : ''} threshold ${threshold.toFixed(2)} ms${decision ? ` → ${decision.label} (N=${decision.n})` : ''}`;
        const i = arr.findIndex((s) => typeof s === 'string' && s.startsWith('Rate probe:'));
        if (i >= 0) arr[i] = label;
        else arr.push(label);
      }
    } catch {}
  }

  /** Drop rAF intervals recorded while the probe blocked the worker
   *  on readPixels, and forget the cached p95 so the runtime step-down
   *  cannot treat those stalls as "60 cannot be held". */
  _forgetProbeStalls() {
    const frameStats = this._ctx.frameStats;
    frameStats?.frameMsRing?.reset?.();
    frameStats?.playFrameRing?.reset?.();
    this._latestAqP95 = 0;
    this._lastAqSampleMs = typeof performance !== 'undefined' ? performance.now() : 0;
  }

  /**
   * The 4 Hz AQ p95 sample from the render loop: copies the newest
   * play-session frame intervals into `_aqScratch`, sorts in place,
   * and caches the p95.  Returns the latest p95 (0 until sampled).
   */
  sampleAq(now, playFrameRing) {
    if (now - this._lastAqSampleMs >= this._AQ_SAMPLE_INTERVAL_MS) {
      const wantAq = Math.min(playFrameRing.filled, 60);
      this._latestAqP95 = playFrameRing.percentile(0.95, wantAq, this._aqScratch);
      this._lastAqSampleMs = now;
    }
    return this._latestAqP95;
  }

  /** Debug-only override for `pressure` (number to force, `null` to
   *  release).  Pure-worker state — never touches SceneConfig. */
  setDebugPressure(value) {
    this._debugPressure = typeof value === 'number' && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value)) : null;
  }

  /** Apply the `autoDegrade` settings toggle (the pure-worker flag
   *  branch of `handleUpdateConfig`). */
  setAutoDegrade(enabled) {
    const wasEnabled = this._autoDimEnabled;
    this._autoDimEnabled = enabled;
    if (!wasEnabled && this._autoDimEnabled) {
      // Re-enabling after a manual disable: reset calibration so stale
      // rAF intervals from the disabled period don't seed a misleading
      // baseline.  Also restore full light intensity immediately.
      this.resetCalibration();
      this._runtimePressure = 0;
      SceneConfig.lightBall.intensity = this.baseLightIntensity;
      this._updateFxaaPressure();
    } else if (!this._autoDimEnabled) {
      // Disabling: restore full intensity so lights snap back.
      this._runtimePressure = 0;
      SceneConfig.lightBall.intensity = this.baseLightIntensity;
      this._updateFxaaPressure();
    }
  }
}
