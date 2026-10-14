import * as THREE from 'three';
import { SceneConfig } from '../../rendering/SceneConfig.js';
import { setPlayheadX } from '../../rendering/Materials.js';
import { OPTIMIZATIONS } from '../../rendering/Optimizations.js';
import { FRAME_SHADOW, FRAME_COLORS, FRAME_STATS, FRAME_BUDGET_SKIP } from './FrameStats.js';
import { countCadenceMisses, nextTeslaDecimation, quantizeFrameMs, rateLabelFor, renderBudgetMs } from './qualityPolicy.js';

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
  // Frame-rate decimation (present on every Nth vsync): 1 = native, 2 = locked60 on 120 Hz, 4 = locked30.
  _decimationN = 1;
  _rateFrozen = false;
  _rateSwitches = 0;
  _phaseAnchorTick = 0;
  _useExternalTicks = false;
  _tickSeq = 0;
  /** Consecutive over-budget p95 samples for the Tesla last-resort step. */
  /** Load-time probe choice. Runtime step-up never goes below this. */
  _probeN = 1;
  _teslaMissWindows = 0;
  _teslaCleanWindows = 0;
  _teslaRateSampleMs = 0;
  _missScratch = new Float64Array(60);

  /**
   * @param {object} ctx Shared worker context — `clock`, `host`,
   *   `frameStats`, `quality`, `keyLightRig`, `lod`, `colorizer`,
   *   `antiAliasing`, `cameraCtrl`, `camera`, `controls`, `renderer`,
   *   `viewportHeightCss`, `post` are all read lazily per tick.
   */
  constructor(ctx) {
    this._ctx = ctx;
  }

  setExternalDrive(enabled) {
    this._useExternalTicks = !!enabled;
  }

  markDirty() { this._dirty = true; }
  get dirty() { return this._dirty; }

  start() {
    this._lastFrameTime = performance.now();
    if (!this._useExternalTicks) {
      const loop = (frameNow) => {
        this._rafId = requestAnimationFrame(loop);
        this._tick(frameNow);
      };
      loop();
    }
  }

  stop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  /** Optional main-thread vsync driver entry. */
  externalTick(now) {
    if (!this._useExternalTicks) return;
    this._tick(Number.isFinite(now) ? now : performance.now());
  }

  _tick(frameNow) {
    const now = Number.isFinite(frameNow) ? frameNow : performance.now();
    const cpuStart = performance.now();
    const dt = this._advanceTiming(now);
    this._tickSeq++;

    let frameFlags = 0;

    // --- Animation phase (always runs) -------------------------------
    // Derive music time from the worker's own high-resolution clock,
    // never from rAF timestamps (main or worker). This keeps transport
    // speed tied to the AudioContext-anchored time the main thread
    // sends to `PlaybackClock.set(...)`, independent of vsync/decimation.
    const musicTime = this._ctx.clock.musicTimeAt();
    // Tie animation to the presented cadence when a decimation is active:
    // integrate exactly N×displayMs per presented frame; skip on non-present ticks.
    const quality = this._ctx.quality;
    const presentByCadence = this._decimationN <= 1
      || (!this._ctx.host.compiling && ((this._tickSeq - this._phaseAnchorTick) % this._decimationN === 0));
    const useLockedCadence = this._decimationN > 1 && quality?.calibrated && quality.displayMs > 0;
    const dtForAnim = useLockedCadence
      ? (presentByCadence ? (quality.displayMs * this._decimationN) / 1000 : 0)
      : dt;
    if (dtForAnim > 0) {
      this._animate(dtForAnim, now, musicTime);
      frameFlags |= this._updateWorld(now, musicTime);
    }

    // --- Render phase (can be skipped when idle or under pressure) ----
    frameFlags |= this._render();

    // --- Runtime pressure (light dimming) ----------------------------
    this._updatePressure(dt, now);

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
    // Always record an event for very long intervals so multi-second stalls
    // are visible in the log, even though stats exclude them.
    if (frameMs > 100) {
      // Correlate with previous frame's work flags (the cost that preceded this interval)
      const flags = frameStats.lastFrameFlags || 0;
      const causes = [];
      if (flags & FRAME_SHADOW) causes.push('shadow');
      if (flags & FRAME_COLORS) causes.push('colorUpload');
      if (flags & FRAME_STATS) causes.push('statsHeartbeat');
      if (flags & FRAME_BUDGET_SKIP) causes.push('budgetSkip');
      if (causes.length === 0) causes.push('none');
      const cpu = frameStats.lastFrameCpuMs || 0;
      const p = this._ctx.quality?.pressure ?? 0;
      // Label background-tab gaps distinctly so screenshots aren't misleading.
      const recentlyBecameVisible = (this._ctx._visibleAt || 0) > 0 && (now - this._ctx._visibleAt) < 1000;
      const hiddenGapMs = this._ctx._lastHiddenDurationMs || 0;
      const isBackgroundGap = frameMs >= 2000 && recentlyBecameVisible && hiddenGapMs >= 500;
      try {
        if (isBackgroundGap) {
          this._ctx.eventLog?.note?.(`Background interval ${frameMs.toFixed(0)} ms (page hidden for ~${hiddenGapMs.toFixed(0)} ms)`);
        } else if (frameMs >= 2000) {
          this._ctx.eventLog?.note?.(`Stall ${frameMs.toFixed(0)} ms after [${causes.join('+')}] (CPU ${cpu.toFixed(1)} ms, pressure ${p.toFixed(2)})`);
        } else {
          this._ctx.eventLog?.note?.(`Long frame ${frameMs.toFixed(1)} ms after [${causes.join('+')}] (CPU ${cpu.toFixed(1)} ms, pressure ${p.toFixed(2)})`);
        }
      } catch {}
    }
    // Skip the rings while a scene probe is blocking the worker on
    // readPixels. Those gaps are the probe's own fence, not the
    // steady present interval, and they used to freeze Tesla at
    // locked 30.
    if (frameMs > 0 && frameMs < 2000 && !this._ctx.host?.compiling) {
      frameStats.recordFrame(frameMs, clock.playing);
      // Optional benchmark aggregation (only records while playing)
      const bench = this._ctx.benchmark;
      if (bench?.enabled && clock.playing) {
        bench.frames.push(frameMs);
        if (frameMs > 8.34) bench.over8++;
        if (frameMs > 16.67) bench.over16++;
        if (frameMs > 33.34) bench.over33++;
      }

      const { quality } = this._ctx;
      // Feed the refresh-rate calibration on every tick, not just while
      // playing: idle foreground rAF ticks are clean samples of the same
      // vsync, and locking early means camera drags get the quantized
      // dt before the user ever presses Play.  `calibrate()` ignores
      // stall/hidden-tab intervals itself.
      quality.calibrate(frameMs);
      if (quality.calibrated) {
        // Calibrated: displays present on vsync boundaries, so the true
        // interval is an integer multiple of the refresh period.  Snap
        // to it — perfectly uniform spring integration (16.67 ms at
        // 60 Hz, 8.33 ms at 120 Hz) with dropped frames still costing
        // their real step count.  See quantizeFrameMs().
        this._dtSmoothed = quantizeFrameMs(frameMs, quality.displayMs) / 1000;
      } else {
        // Smooth rAF jitter out of the integration dt that drives camera
        // motion.  Alpha 0.2 keeps the signal responsive while suppressing
        // the ±0.5 ms vsync noise we see on Safari.
        const alpha = Math.max(0, Math.min(1, SceneConfig.dtSmoothAlpha ?? 0.2));
        if (alpha <= 0 || this._dtSmoothed === 0) {
          this._dtSmoothed = rawDt;
        } else {
          this._dtSmoothed = this._dtSmoothed * (1 - alpha) + rawDt * alpha;
        }
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
      const pixelRatio = this._ctx.renderer?.getPixelRatio ? this._ctx.renderer.getPixelRatio() : 1;
      frameStats.recordCameraDelta(
        camera.position,
        this._ctx.controls?.target || this._camTarget,
        this._dtSmoothed,
        camera,
        pixelRatio,
        this._ctx.viewportHeightCss,
      );
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
    // Strict cadence: present exactly on every Nth vsync tick, phase-anchored.
    const cadenceGate = this._decimationN <= 1
      || (!host.compiling && ((this._tickSeq - this._phaseAnchorTick) % this._decimationN === 0));
    const shouldRender = !host.compiling && this._dirty && budgetGate && cadenceGate;
    if (shouldRender) {
      if (keyLightRig.needsShadowUpdate) frameFlags |= FRAME_SHADOW;
      const t0 = performance.now();
      antiAliasing.render(renderer, host.scene, camera);
      frameStats.recordRender(performance.now() - t0);
      // WebGPU GPU-drain timing (approximate): measure time until queue is idle.
      try {
        const device = renderer?.backend?.device;
        const q = device?.queue;
        if (q?.onSubmittedWorkDone) {
          const start = performance.now();
          q.onSubmittedWorkDone().then(() => {
            try { frameStats.recordGpuQueueDrain(performance.now() - start); } catch {}
          }).catch(() => {});
        }
      } catch {}
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
   * signal; only fires once the baseline has been calibrated.
   * Calibration itself is fed unconditionally in `_advanceTiming`.
   *
   * Unlike the old tier system this does NOT change shadow map size,
   * DPR, or PCF type during playback.  Runtime pressure only scales
   * light-ball intensity, increases the shadow refresh interval,
   * shrinks LOD distances, suppresses FXAA, and gates detail shadow
   * casters — none of those paths reallocates GPU resources or
   * recompiles pipelines.
   */
  _updatePressure(dt, now) {
    const { quality, frameStats } = this._ctx;
    // Sample ALL frames, not just play-session ones: a paused camera
    // drag submits the same heavy render every dirty frame, and on a
    // saturated GPU that's exactly when the pressure actuators (LOD
    // shrink, FXAA suppression, caster gating) must engage.  Idle ticks
    // are ~16.7 ms because nothing renders — they only lower the p95
    // when there is genuinely nothing to degrade.
    const frameRing = frameStats.frameMsRing;
    if (frameRing.filled > 0) {
      const latestP95 = quality.sampleAq(now, frameRing);
        if (latestP95 > 0) {
        quality.updateRuntimePressure(dt, latestP95);
        // Decide initial decimation before playback, behind the overlay.
        // Tesla does not use this path: its lock comes from the
        // load-time scene probe (see QualityController.refineSceneQuality).
        // rAF p95 here includes the probe's own GPU fences.
        if (!this._ctx.isTesla && !this._rateFrozen && quality.calibrated && !this._ctx.host.compiling) {
          const is120 = quality.displayMs <= 8.5;
          if (is120) {
            let n = 1;
            if (latestP95 >= 10.0) n = 2;
            if (latestP95 >= 21.0) n = 4;
            this._applyDecimation(n, 'initial');
          } else {
            this._applyDecimation(1, 'initial');
          }
        }
        // One-way step-down during playback when sustained overload occurs.
        // Tesla samples once per window and can step back up to the
        // probe choice; a single stalled timestamp is not a miss.
        if (this._rateFrozen && quality.calibrated && quality.displayMs > 0) {
          const is120 = quality.displayMs <= 8.5;
          if (this._ctx.isTesla) {
            if (now - this._teslaRateSampleMs >= 250) {
              this._teslaRateSampleMs = now;
              const ring = frameStats.frameMsRing;
              const recent = ring.latest(Math.min(ring.filled, 60), this._missScratch);
              const stats = countCadenceMisses(recent, quality.displayMs, this._decimationN);
              const step = nextTeslaDecimation(
                this._decimationN, quality.displayMs, stats, {
                  consecutiveMiss: this._teslaMissWindows,
                  consecutiveClean: this._teslaCleanWindows,
                }, { minN: this._probeN });
              this._teslaMissWindows = step.consecutiveMiss;
              this._teslaCleanWindows = step.consecutiveClean;
              if (step.step) {
                this._applyDecimation(step.n, step.direction === 'up' ? 'stepup' : 'stepdown');
              }
            }
          } else if (is120) {
            if (this._decimationN === 1 && latestP95 >= 10.8) {
              // Engage locked60 after sustained evidence
              this._applyDecimation(2, 'stepdown');
            } else if (this._decimationN === 2 && latestP95 >= 20.5) {
              this._applyDecimation(4, 'stepdown');
            }
          }
        }
      }
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
      // Build a present-interval histogram across recently RENDERED frames.
      let h1 = 0, h2 = 0, h3 = 0, presentFps = 0;
      const wantH = Math.min(frameStats.presentRing.filled, 60);
      if (wantH > 0 && quality.displayMs > 0) {
        const arr = frameStats.presentRing.latest(wantH, frameStats._statsScratch);
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
          sum += arr[i];
          const k = Math.max(1, Math.round(arr[i] / quality.displayMs));
          if (k <= 1) h1++; else if (k === 2) h2++; else h3++;
        }
        if (sum > 0) presentFps = (arr.length * 1000) / sum;
      }
      // Dynamic rate label based on measured refresh, not hardcoded 120→60 mapping.
      // N=1 on a 60 Hz panel is locked60 — the verdict must follow this
      // decimation, not the main-thread rAF interval.
      const rateLabel = rateLabelFor(this._decimationN, quality.displayMs);
      const renderer = this._ctx.renderer;
      const msg = frameStats.buildStatsMessage({
        rendering: this._dirty || clock.playing,
        autoDegrade: quality.autoDimEnabled,
        gpuPressure: quality.pressure,
        aqBaselineMs: quality.baselineMs,
        aqCalibrated: quality.calibrated,
        antiAliasing: antiAliasing.mode,
        msaaSamples: antiAliasing.msaaSamples,
        fxaaSuppressed: antiAliasing.suppressed,
        rateMode: rateLabel,
        rateDecimationN: this._decimationN,
        presentFps,
        rateSwitches: this._rateSwitches,
        present1x: h1, present2x: h2, present3x: h3,
        renderPixelRatio: renderer?.getPixelRatio?.() || 0,
        bufferWidth: renderer?.domElement?.width || 0,
        bufferHeight: renderer?.domElement?.height || 0,
        events: this._ctx.eventLog?.latest?.(12) || [],
        context: Array.isArray(this._ctx.diagContext) ? this._ctx.diagContext : [],
      });
      if (msg) post(msg);
      this._lastStatsPostMs = now;
    }
    return frameFlags;
  }

  /** Scene-probe authority for the initial lock. May select 60 even
   *  if a transient sample had already frozen a lower rate. */
  applyProbeDecimation(n, reason) {
    this._rateFrozen = false;
    this._teslaMissWindows = 0;
    this._teslaCleanWindows = 0;
    this._probeN = (n === 2 || n === 4) ? n : 1;
    this._applyDecimation(this._probeN, reason || 'scene-probe');
  }

  _applyDecimation(n, reason) {
    const newN = (n === 1 || n === 2 || n === 4) ? n : 1;
    // Step up only on an explicit clean-window recovery, and never
    // past the load-time probe choice.
    if (this._rateFrozen && newN < this._decimationN && reason !== 'stepup') return;
    if (this._decimationN !== newN) {
      this._rateSwitches++;
    }
    this._decimationN = newN;
    this._phaseAnchorTick = this._tickSeq;
    this._rateFrozen = true;
    try {
      const label = `Rate: ${rateLabelFor(this._decimationN, this._ctx.quality?.displayMs || 0)}`;
      const arr = this._ctx.diagContext;
      if (Array.isArray(arr)) {
        const i = arr.findIndex((s) => typeof s === 'string' && s.startsWith('Rate:'));
        if (i >= 0) arr[i] = label; else arr.push(label);
      }
      this._ctx.eventLog?.note?.(`rate-apply(${reason}): decimationN=${this._decimationN}`);
    } catch {}
  }
}
