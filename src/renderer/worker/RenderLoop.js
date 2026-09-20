import * as THREE from 'three';
import { SceneConfig } from '../../rendering/SceneConfig.js';
import { setPlayheadX } from '../../rendering/Materials.js';
import { OPTIMIZATIONS } from '../../rendering/Optimizations.js';
import { FRAME_SHADOW, FRAME_COLORS, FRAME_STATS, FRAME_BUDGET_SKIP } from './FrameStats.js';
import { renderBudgetMs } from './qualityPolicy.js';

/**
 * Frame-budget rendering.
 *
 * Every rAF tick we *always* advance the animation (camera + light
 * balls) so the user-visible motion never stutters — even on scores
 * that push the GPU beyond its per-frame budget.  Rendering itself,
 * however, can skip frames when the previous `renderer.render()` call
 * took longer than the target budget; on the next tick we render
 * again.  The effect is: motion remains smooth, the visible image
 * simply updates at a lower rate on overloaded scenes.
 *
 * We measure submission wall time only — WebGPU/WebGL don't block
 * until a fence, so this under-counts GPU time on some drivers, but
 * it's enough to detect catastrophic rendering slowdowns (e.g.
 * `renderer.render()` taking > 12 ms is a clear signal to throttle).
 *
 * The budget is relative to the display's measured refresh interval
 * once the baseline is calibrated (75 % of `quality.baselineMs`), not
 * a fixed absolute value: on a 60 Hz device a 13 ms submit that would
 * have fit the 16.67 ms interval must still render, otherwise the
 * loop falls into a render/skip/render cadence that halves the picture
 * rate while animation runs at full speed — visible judder.
 */
const RENDER_BUDGET_MS = 12;

/** Wall-clock millisecond between consecutive `stats` messages.  500 ms
 *  is fast enough that a sudden slowdown is visible within a beat or
 *  two but slow enough that postMessage cost itself is negligible
 *  (≈ 2 messages/sec). */
const STATS_POST_INTERVAL_MS = 500;

export class RenderLoop {
  /** Idle-render gate.  When the user isn't interacting and the music
   *  isn't playing, every frame's image is identical to the previous
   *  one — submitting `renderer.render()` to the GPU 60 times a second
   *  for the same pixels is pure waste, especially with the 6144²
   *  shadow map (≈ 38 M depth-buffer texels redrawn every frame).
   *
   *  We start the flag at `true` so the first frame after init lands a
   *  rendered image on screen, then set it back to `false` after each
   *  successful `renderer.render()`.  Anything that could change the
   *  picture flips it back to `true`:
   *
   *    • OrbitControls's `change` event (user drag, scroll-zoom, or
   *      damping settle frame).
   *    • Pointer events (in case the user does something the controls
   *      don't fire `change` for, e.g. touch-end).
   *    • Resize.
   *    • Scene rebuild / timeline load / camera snap.
   *    • Clock state transitions (play / pause / stop / scrub).
   *    • While the music clock is `playing`, the loop forces it `true`
   *      every frame because notation colours, light-ball positions,
   *      and the camera spring are all advancing.
   *
   *  When idle, the rAF loop still runs (the animation-phase work below
   *  is sub-millisecond when there's nothing animating), but
   *  `renderer.render()` is skipped — GPU drops to ~0 % utilisation
   *  until the user interacts again. */
  _dirty = true;

  /** Smoothed `dt` used for camera / light-ball integration so rAF
   *  jitter doesn't feed directly into the springs and smart-camera
   *  phase. */
  _dtSmoothed = 0;

  /** Scratch Vector3 for setTarget — allocating one per frame would
   *  defeat the whole point of running in a worker. */
  _camTarget = new THREE.Vector3();

  _rafId = 0;
  _lastFrameTime = 0;
  _lastStatsPostMs = 0;

  /**
   * @param {object} ctx Shared worker context — `clock`, `host`,
   *   `frameStats`, `quality`, `keyLightRig`, `lod`, `colorizer`,
   *   `antiAliasing`, `cameraCtrl`, `camera`, `controls`, `renderer`,
   *   `viewportHeightCss`, `post` are all read lazily per tick.
   */
  constructor(ctx) {
    this._ctx = ctx;
  }

  markDirty() { this._dirty = true; }
  get dirty() { return this._dirty; }

  start() {
    this._lastFrameTime = performance.now();
    const loop = (frameNow) => {
      this._rafId = requestAnimationFrame(loop);
      this._tick(frameNow);
    };
    loop();
  }

  stop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  _tick(frameNow) {
    const now = Number.isFinite(frameNow) ? frameNow : performance.now();
    const cpuStart = performance.now();
    const dt = this._advanceTiming(now);

    let frameFlags = 0;

    // --- Animation phase (always runs) -------------------------------
    const musicTime = this._ctx.clock.musicTimeAt(now);
    this._animate(dt, now, musicTime);
    frameFlags |= this._updateWorld(now, musicTime);

    // --- Render phase (can be skipped when idle or under pressure) ----
    frameFlags |= this._render();

    // --- Runtime pressure (light dimming) ----------------------------
    this._updatePressure(dt, now, this._frameMs);

    // --- Stats heartbeat ---------------------------------------------
    frameFlags = this._heartbeat(now, frameFlags);
    this._ctx.frameStats.endFrame(frameFlags, performance.now() - cpuStart);
  }

  /** Raw rAF-to-rAF interval in ms, stored per tick so `_advanceTiming`
   *  doesn't allocate a `{ dt, frameMs }` result object every frame. */
  _frameMs = 0;

  /**
   * Frame timing: record the rAF-to-rAF interval and smooth the
   * integration dt.  Returns the smoothed dt (seconds); the raw
   * frameMs for the pressure/calibration step is stored on
   * `this._frameMs`.
   */
  _advanceTiming(now) {
    const { clock, frameStats } = this._ctx;
    const rawDt = Math.min(Math.max((now - this._lastFrameTime) / 1000, 0), 0.1);
    const frameMs = now - this._lastFrameTime;
    this._frameMs = frameMs;
    this._lastFrameTime = now;

    // Record actual rAF interval so `probe()` can distinguish
    // submit-time from real GPU-bound frame time.
    if (frameMs > 0 && frameMs < 2000) {
      frameStats.recordFrame(frameMs, clock.playing);

      // Smooth rAF jitter out of the integration dt that drives camera
      // motion.  Alpha 0.2 keeps the signal responsive while suppressing
      // the ±0.5 ms vsync noise we see on Safari.
      const alpha = Math.max(0, Math.min(1, SceneConfig.dtSmoothAlpha ?? 0.2));
      if (alpha <= 0 || this._dtSmoothed === 0) {
        this._dtSmoothed = rawDt;
      } else {
        this._dtSmoothed = this._dtSmoothed * (1 - alpha) + rawDt * alpha;
      }
      // Enforce a non-zero minimum so the integration formulas never
      // see an exact zero dt on the first frame or a long pause.
      if (this._dtSmoothed < 0.0001) this._dtSmoothed = 0.0001;
    }
    return this._dtSmoothed;
  }

  /** Light balls + camera chase/lookahead + camera-jitter record. */
  _animate(dt, now, musicTime) {
    const { host, clock, cameraCtrl, camera, frameStats } = this._ctx;
    const lightBalls = host.lightBalls;
    if (lightBalls) {
      lightBalls.setTime(musicTime);
      lightBalls.update(dt, camera);
    }
    if (cameraCtrl) {
      const xTime = cameraCtrl.xAtTime(musicTime);
      if (xTime != null) {
        const lookAheadSeconds = clock.playing
          ? Math.max(0, SceneConfig.camera.lookAheadSeconds ?? 0)
          : 0;
        const xLook = lookAheadSeconds > 0
          ? cameraCtrl.xAtTime(musicTime + lookAheadSeconds, 'lookAhead')
          : xTime;
        this._camTarget.set(xTime, 0, 0);
        cameraCtrl.setTarget(this._camTarget, xLook ?? xTime);
      }
      cameraCtrl.update(dt, now);
    }

    if (camera && clock.playing) {
      frameStats.recordCameraDelta(camera.position);
    }
  }

  /** World-space per-frame updates: key-light slide, LOD gating,
   *  playhead uniform, played-note colour sync.  Returns frame flags. */
  _updateWorld(now, musicTime) {
    const { host, controls, camera, renderer, keyLightRig, lod, colorizer, quality } = this._ctx;
    let frameFlags = 0;

    // Slide the key light's shadow camera to straddle whatever the
    // scene camera is currently looking at.  The orbit controls'
    // target tracks the music during playback and the user's pan
    // gestures when paused — using it here means the shadow frustum
    // is automatically "focused" wherever the user's attention is,
    // so notation anywhere in the view always casts a visible
    // shadow rather than only the chunk near the world origin.
    keyLightRig.update(controls.target.x, controls.target.z, now, quality.pressure);
    // Distance-LOD visibility gating (LOD_DISTANT_ELEMENTS /
    // DISTANCE_CLIP_GLYPHS).  Skipped while a precompile is in flight
    // — precompilePipelines temporarily toggles hidden meshes visible
    // and restores them afterwards, and a concurrent LOD pass would
    // corrupt that bookkeeping.
    if (!host.compiling) {
      const pixelRatio = renderer && typeof renderer.getPixelRatio === 'function'
        ? renderer.getPixelRatio()
        : 1;
      if (lod.apply(camera, controls, pixelRatio, this._ctx.viewportHeightCss,
        quality.pressure)) {
        this.markDirty();
      }
      // Pressure-gated shadow-caster suppression (no-op on constrained
      // platforms — detail casters are already permanently off there).
      lod.updateCasters(quality.pressure);
    }
    // Feed the current playhead X into the glow-falloff uniform so the
    // noteHead shader can fade out emissive glow on distant played notes.
    setPlayheadX(this._camTarget.x);
    // Advance / rewind the played-note cursor and apply per-staff
    // instanceColor updates.  Runs every frame so playback keeps the
    // coloured-note state exactly in sync with the current music
    // time — a scrub-back to 0 automatically reverts every played
    // note to the default dark colour in a single frame.
    const colorUploadCount = colorizer.sync(musicTime);
    if (colorUploadCount > 0) frameFlags |= FRAME_COLORS;
    return frameFlags;
  }

  /**
   * The render-budget gate: when a previous submit blew past the
   * budget we skip *one* frame to give the GPU time to drain, but
   * only one in a row, so the picture doesn't go stale on a
   * sustained slowdown.  Also skips while `_compiling` (a mid-compile
   * render would trigger the slow inline pipeline creation the
   * precompile exists to avoid) and while idle (`!_dirty`).  Returns
   * frame flags.
   */
  _render() {
    const { host, clock, renderer, camera, keyLightRig, antiAliasing, frameStats, quality, post } = this._ctx;
    let frameFlags = 0;
    if (clock.playing) this._dirty = true;
    const budgetMs = renderBudgetMs(quality.baselineMs, quality.calibrated, RENDER_BUDGET_MS);
    const budgetGate = !OPTIMIZATIONS.RENDER_BUDGET_SKIP
      || frameStats.lastRenderMs <= budgetMs
      || frameStats.framesSinceRender >= 1;
    const shouldRender = !host.compiling && this._dirty && budgetGate;
    if (shouldRender) {
      if (keyLightRig.needsShadowUpdate) frameFlags |= FRAME_SHADOW;
      const t0 = performance.now();
      antiAliasing.render(renderer, host.scene, camera);
      frameStats.recordRender(performance.now() - t0);
      this._dirty = false;

      // Tell the main thread the new score is now on screen so it
      // can hide the loading spinner.  Post exactly once per build,
      // after the very first successful render that follows
      // precompile completion.  Doing it from inside `restore()`
      // (synchronously after `_compiling = false`) would fire the
      // message before any frame has actually reached the canvas
      // and give the user a brief flash of empty paper.
      if (host.consumeSceneReady()) {
        post({ type: 'sceneReady' });
      }
    } else {
      if (!host.compiling && this._dirty && !budgetGate) frameFlags |= FRAME_BUDGET_SKIP;
      frameStats.recordSkip();
    }
    return frameFlags;
  }

  /**
   * Runtime pressure uses rAF-to-rAF interval as the GPU pressure
   * signal; only fires once the baseline has been calibrated from
   * play-session frames.  Also feeds the calibration window while
   * playing.
   *
   * Unlike the old tier system this does NOT change shadow map size,
   * DPR, or PCF type during playback.  Runtime pressure only scales
   * light-ball intensity, increases the shadow refresh interval,
   * shrinks LOD distances, suppresses FXAA, and gates detail shadow
   * casters — none of those paths reallocates GPU resources or
   * recompiles pipelines.
   */
  _updatePressure(dt, now, frameMs) {
    const { clock, quality, frameStats } = this._ctx;
    const playFrameRing = frameStats.playFrameRing;
    if (playFrameRing.filled > 0) {
      // Calibration: only feeds play-session rAF intervals.
      if (clock.playing) quality.calibrate(frameMs);
      const latestP95 = quality.sampleAq(now, playFrameRing);
      if (latestP95 > 0) quality.updateRuntimePressure(dt, latestP95);
    }
  }

  /**
   * Post a small stats summary every ~0.5 s so the main-thread FPS
   * badge has fresh numbers without flooding postMessage every
   * frame.  Numbers are derived from the same ring buffers
   * `handleProbe` reads, so the badge agrees with what `probe()`
   * would report on demand.  Returns the updated frame flags.
   */
  _heartbeat(now, frameFlags) {
    const { clock, quality, antiAliasing, frameStats, post } = this._ctx;
    if (now - this._lastStatsPostMs >= STATS_POST_INTERVAL_MS) {
      frameFlags |= FRAME_STATS;
      const msg = frameStats.buildStatsMessage({
        rendering: this._dirty || clock.playing,
        autoDegrade: quality.autoDimEnabled,
        gpuPressure: quality.pressure,
        aqBaselineMs: quality.baselineMs,
        aqCalibrated: quality.calibrated,
        antiAliasing: antiAliasing.mode,
        msaaSamples: antiAliasing.msaaSamples,
        fxaaSuppressed: antiAliasing.suppressed,
      });
      if (msg) post(msg);
      this._lastStatsPostMs = now;
    }
    return frameFlags;
  }
}
