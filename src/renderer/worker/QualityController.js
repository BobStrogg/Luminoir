import * as THREE from 'three';
import { SceneConfig } from '../../rendering/SceneConfig.js';
import {
  chooseLoadTimeQuality,
  nextQualityStep,
  advancePressure,
  lightIntensityForPressure,
} from './qualityPolicy.js';

/**
 * Two-phase GPU quality system.
 *
 * **Phase 1 — load-time probe** (`probeGpuCost`, called during init and
 * score loading):
 *   The init probe renders the empty scene several times to choose the
 *   maximum shadow-map resolution, DPR, and PCF type the GPU can support.
 *   Safari, mobile, and Tesla then run a second probe with the real score
 *   while the loading overlay is still visible.  That probe may only
 *   downshift quality, so dense geometry is measured without causing a
 *   mid-playback resolution pop or shadow-map flicker.
 *
 * **Phase 2 — runtime pressure** (`_runtimePressure`, updated each rAF):
 *   A 0→1 float that rises only when recent p95 frame time exceeds
 *   the 60 fps target.  It smoothly scales light-ball intensity and
 *   spaces out static directional-shadow refreshes from 30 Hz toward
 *   ~7 Hz.  Neither actuator reallocates GPU resources.
 *
 *   Shadow map size, DPR, and PCF type require a dispose / reallocate,
 *   so those settings only change behind the score-loading overlay.
 *
 * Calibration:
 *   The baseline rAF interval is measured from the first 30 play-session
 *   ticks for diagnostics.  Runtime pressure itself targets a fixed
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

  /** Baseline rAF interval (ms) learned from the first play session.
   *  Set once by `calibrate()` and exposed for diagnostics. */
  _baselineMs = 16.67;
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
  /** Whether the auto-dim system is enabled (mirrors the Settings toggle). */
  _autoDimEnabled = true;
  /** Diagnostics: what the load-time probe measured and chose.  Exposed
   *  via `probe()` so the dev overlay / Playwright tests can verify the
   *  quality selection matches the hardware. */
  probeMsMeasured = -1;
  _sceneProbeMsMeasured = -1;
  _chosenShadowMapSize = 0;
  _chosenDprCap = 0;
  /** Base light intensity saved at init so pressure can scale it. */
  baseLightIntensity = 0;
  baseDevicePixelRatio = 1;
  _maxShadowMapSize = 0;
  _maxDprCap = 0;
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

  get pressure() { return this._runtimePressure; }
  get baselineMs() { return this._baselineMs; }
  get calibrated() { return this._calibrated; }
  get autoDimEnabled() { return this._autoDimEnabled; }
  get chosenShadowMapSize() { return this._chosenShadowMapSize; }
  get chosenDprCap() { return this._chosenDprCap; }
  get probeMs() { return this.probeMsMeasured; }
  get sceneProbeMs() { return this._sceneProbeMsMeasured; }

  /** Feed one rAF interval sample.  Locks `_baselineMs` after
   *  `_CALIB_TICKS` samples using the p95 of the collected window.  The
   *  value is diagnostic; runtime pressure uses a fixed 60 fps target.
   *  Keeping p95 here makes the diagnostic directly comparable with the
   *  live p95 signal and ignores one isolated maximum-value stall. */
  calibrate(frameMs) {
    if (this._calibrated || frameMs <= 0 || frameMs >= 2000) return;
    this._calibBuf[this._calibCount++] = frameMs;
    if (this._calibCount >= QualityController._CALIB_TICKS) {
      this._calibSort.set(this._calibBuf);
      this._calibSort.sort();
      // Clamp to a sane range in case the tab is throttled, vsync is
      // locked, or the calibration window caught a multi-spike burst
      // (upper bound covers 60 Hz p95 ≈ 17–18 ms with margin).
      this._baselineMs = Math.max(6, Math.min(25,
        this._calibSort[Math.floor(QualityController._CALIB_TICKS * 0.95)]));
      this._calibrated = true;
    }
  }

  /** Reset calibration — call on play-start so baseline re-measures
   *  from the fresh play context, not stale idle intervals. */
  resetCalibration() {
    this._calibCount = 0;
    this._calibBuf.fill(0);
    this._baselineMs = 16.67;
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
   * "very fast" and hand out 6144² shadows + DPR 2.0 unconditionally —
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
  async probeGpuCost(count = 7, median = false) {
    const { renderer, scene, camera, antiAliasing, keyLightRig } = this._ctx;
    if (!renderer || !scene || !camera) return 0;
    // Warm-up render — don't measure: first call often stalls on driver
    // JIT / shader cache miss regardless of scene complexity.
    antiAliasing.render(renderer, scene, camera);
    await this.gpuSync();
    let best = Infinity;
    const samples = median ? new Float64Array(count) : null;
    for (let i = 0; i < count; i++) {
      if (keyLightRig.light) keyLightRig.light.shadow.needsUpdate = true;
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
   * Choose and apply shadow-map size, DPR cap, and PCF type based on
   * the result of `probeGpuCost()`.  Called once from `handleInit`.
   */
  applyLoadTimeQuality(probeMs, baseDpr, isConstrained) {
    const { mapSize, softPcf, dprCap } = chooseLoadTimeQuality(probeMs, isConstrained);
    this._maxShadowMapSize = mapSize;
    this._maxSoftPcf = softPcf;
    this._maxDprCap = dprCap;
    this.setShadowQuality(mapSize, softPcf, baseDpr, dprCap);
  }

  /** Apply shadow quality and DPR settings.  Must be called before
   *  the render loop starts so there is no mid-session dispose. */
  setShadowQuality(mapSize, softPcf, baseDpr, dprCap) {
    const { renderer, keyLightRig, antiAliasing, markDirty } = this._ctx;
    const keyLight = keyLightRig.light;
    if (!renderer || !keyLight) return;
    this._chosenShadowMapSize = mapSize;
    this._chosenDprCap = dprCap;
    renderer.shadowMap.type = softPcf
      ? THREE.PCFSoftShadowMap
      : THREE.PCFShadowMap;
    renderer.setPixelRatio(Math.min(baseDpr, dprCap));
    antiAliasing.resizeToRenderer(renderer);
    if (keyLight.shadow.mapSize.width !== mapSize) {
      keyLight.shadow.mapSize.width  = mapSize;
      keyLight.shadow.mapSize.height = mapSize;
      if (keyLight.shadow.map) {
        keyLight.shadow.map.dispose();
        keyLight.shadow.map = null;
      }
      keyLight.shadow.autoUpdate = true;
      const shadowCam = keyLight.shadow.camera;
      keyLightRig.texelSize.set(
        (shadowCam.right - shadowCam.left) / mapSize,
        (shadowCam.top - shadowCam.bottom) / mapSize,
      );
    }
    keyLightRig.resetSnap();
    markDirty();
  }

  stepDown() {
    const step = nextQualityStep(this._chosenShadowMapSize, {
      maxDprCap: this._maxDprCap,
      allowVeryLowQuality: this.allowVeryLowQuality,
    });
    if (!step) return false;
    this.setShadowQuality(step.mapSize, step.softPcf, this.baseDevicePixelRatio, step.dprCap);
    return true;
  }

  async refineSceneQuality() {
    this.setShadowQuality(
      this._maxShadowMapSize, this._maxSoftPcf, this.baseDevicePixelRatio, this._maxDprCap);
    if (!this.runSceneProbe) {
      this._sceneProbeMsMeasured = -1;
      return;
    }
    let measured = await this.probeGpuCost(3, true);
    while (measured > this.sceneGpuBudgetMs && this.stepDown()) {
      measured = await this.probeGpuCost(3, true);
    }
    this._sceneProbeMsMeasured = measured;
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
