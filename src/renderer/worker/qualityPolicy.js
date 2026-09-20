/**
 * Pure decision functions for the GPU quality system (see the
 * "GPU quality" comment block in `renderWorker.js`).  Extracted so
 * the thresholds and pressure arithmetic can be unit-tested without
 * a renderer; the worker keeps the state and side effects.
 */

/**
 * Choose shadow-map size and PCF type based on the result of
 * `_probeGpuCost()`.  Resolution is deliberately NOT part of this
 * decision — the renderer always runs at the browser's native
 * `devicePixelRatio`; performance is recovered through shadow-map
 * size, shadow refresh rate, LOD gating, FXAA suppression and light
 * dimming instead of lowering the framebuffer resolution.
 *
 * Probe cost reference, GPU-synced via `_gpuSync` (empty scene with a
 * forced 6144² PCFSoft shadow pass at native DPR — see `_probeGpuCost`):
 *   Apple M-series / discrete GPU   ≈ 1.5–2 ms/frame  → keep 6144²
 *   recent integrated GPU           ≈ 2–5 ms/frame    → 4096²
 *   older / budget integrated GPU   ≈ 5 ms+           → 2048²
 * (The pre-GPU-sync numbers that used to live here were submit-time
 * only and read ~0.25 ms on every Chromium machine, which routed all
 * of them into the top tier regardless of actual GPU speed.)
 *
 * @param {number} probeMs
 * @param {boolean} isConstrained  Mobile / Tesla profile.
 * @returns {{ mapSize: number, softPcf: boolean }}
 */
export function chooseLoadTimeQuality(probeMs, isConstrained) {
  // On mobile the rAF rate halves permanently the first time a frame
  // exceeds budget, so we are extremely conservative.
  if (isConstrained) {
    return { mapSize: 2048, softPcf: false };
  }
  if (probeMs < 2) {
    // Very fast GPU (M3/M4, dedicated GPU) — full quality.
    return { mapSize: 6144, softPcf: true };
  }
  if (probeMs < 5) {
    // Typical Apple Silicon or recent integrated GPU.
    return { mapSize: 4096, softPcf: true };
  }
  // Slower integrated GPU — drop to 2048 with plain PCF.
  return { mapSize: 2048, softPcf: false };
}

/**
 * Next rung down the shadow-quality ladder, or `null` when already
 * at the bottom.  Used by `_refineSceneQuality`'s step-down loop.
 * Only the shadow map steps down — the framebuffer always stays at
 * native resolution.
 *
 * @param {number} currentMapSize
 * @param {{ allowVeryLowQuality: boolean }} [opts]
 * @returns {{ mapSize: number, softPcf: boolean } | null}
 */
export function nextQualityStep(currentMapSize, { allowVeryLowQuality = false } = {}) {
  if (currentMapSize > 4096) {
    return { mapSize: 4096, softPcf: true };
  }
  if (currentMapSize > 2048) {
    return { mapSize: 2048, softPcf: false };
  }
  if (allowVeryLowQuality && currentMapSize > 1024) {
    return { mapSize: 1024, softPcf: false };
  }
  return null;
}

/**
 * Advance the 0→1 runtime pressure float one rAF tick.
 * Rises toward 1 over ~1 s of sustained overrun (p95 ≥ 1.15× target),
 * falls toward 0 over ~3 s of sustained headroom (p95 ≤ 1.05× target),
 * and decays slowly in between so a mix of good/bad frames doesn't
 * cause visible light flutter.
 *
 * @param {number} pressure   Current pressure, 0..1.
 * @param {number} dt         Frame duration in seconds.
 * @param {number} frameP95   Recent p95 rAF interval in ms.
 * @param {number} [targetMs] Frame-time target (60 fps default).
 * @returns {number} New pressure, clamped 0..1.
 */
export function advancePressure(pressure, dt, frameP95, targetMs = 1000 / 60) {
  const highMs = targetMs * 1.15;
  const lowMs = targetMs * 1.05;

  if (frameP95 >= highMs) {
    // Rise toward 1 over ~1 s of sustained overrun.
    return Math.min(1, pressure + dt);
  }
  if (frameP95 <= lowMs) {
    // Fall back toward 0 over ~3 s of sustained headroom.
    return Math.max(0, pressure - dt / 3);
  }
  // In-budget but not strongly under — decay slowly so a mix of
  // good/bad frames doesn't cause visible light flutter.
  return Math.max(0, pressure - dt * 0.15);
}

/** Light intensity for a given pressure: full at 0, 15 % at 1. */
export function lightIntensityForPressure(base, pressure) {
  return base * (1 - pressure * 0.85);
}

/**
 * Minimum wall-clock interval between shadow-map refreshes for a
 * given pressure: `minMs` (≈30 Hz) at zero pressure stretching
 * toward `maxMs` (≈7 Hz) at full pressure.
 */
export function shadowIntervalMs(pressure, minMs = 1000 / 30, maxMs = 150) {
  return minMs + pressure * (maxMs - minMs);
}

/**
 * FXAA suppression hysteresis: suppress once pressure reaches 0.7,
 * restore only when it falls back to 0.25, so it cannot flutter on
 * a borderline slowdown.
 */
export function fxaaSuppressedFor(prevSuppressed, pressure) {
  if (pressure >= 0.7) return true;
  if (pressure <= 0.25) return false;
  return prevSuppressed;
}

/**
 * Detail-caster suppression hysteresis for the shadow pass: stems,
 * flags and ledger lines (the `lodDetail` buckets — the most numerous
 * instances in the scene) stop casting shadows once pressure reaches
 * 0.55 and cast again below 0.30.  Toggling `mesh.castShadow` only
 * filters the shadow render list — no pipeline recompile — so this is
 * a free, reversible way to shrink the single heaviest periodic GPU
 * event (a shadow-map re-render) roughly in half on dense scores.
 * Engages earlier than FXAA suppression because it is the bigger lever.
 */
export function castersSuppressedFor(prevSuppressed, pressure) {
  if (pressure >= 0.55) return true;
  if (pressure <= 0.30) return false;
  return prevSuppressed;
}

/**
 * Snap a measured rAF interval to the nearest whole multiple of the
 * calibrated refresh interval (`baselineMs`).  Displays present on
 * vsync boundaries, so true frame intervals ARE integer multiples of
 * the refresh period; sub-millisecond jitter around that cadence is
 * timer noise.  Feeding snapped intervals to the camera/light-ball
 * springs makes their integration perfectly uniform — 16.67 ms steps
 * on 60 Hz, 8.33 ms on 120 Hz — while a dropped frame still counts as
 * its real 2-step cost.  Returns `frameMs` unchanged when the measured
 * interval isn't within 25 % of a multiple (protects against a bad
 * baseline estimate or a genuinely irregular frame).
 */
export function quantizeFrameMs(frameMs, baselineMs, maxSteps = 4) {
  if (!(baselineMs > 0) || !(frameMs > 0)) return frameMs;
  const k = Math.min(Math.max(Math.round(frameMs / baselineMs), 1), maxSteps);
  const snapped = k * baselineMs;
  return Math.abs(frameMs - snapped) < baselineMs * 0.25 ? snapped : frameMs;
}

/**
 * Snap a measured refresh interval (the median of the calibration
 * window) to the nearest standard display rate when it's within
 * `tolerance` (relative) of one.  The p95 baseline used for the render
 * budget intentionally tracks worst-case pacing; for *timing* the
 * modal interval is the right target — a median of 16.9 ms on a 60 Hz
 * display quantizes correctly against 16.667, whereas the raw value
 * would leave every frame just outside the snap window.  Returns the
 * input unchanged when nothing matches closely (unusual displays fall
 * back to their measured rate).
 */
const STANDARD_REFRESH_MS = [
  1000 / 240, 1000 / 144, 1000 / 120, 1000 / 100, 1000 / 90,
  1000 / 75, 1000 / 60, 1000 / 50, 1000 / 40, 1000 / 30,
];
export function snapToRefreshInterval(ms, tolerance = 0.12) {
  if (!(ms > 0)) return ms;
  let best = ms;
  let bestErr = tolerance;
  for (const interval of STANDARD_REFRESH_MS) {
    const err = Math.abs(ms - interval) / interval;
    if (err < bestErr) {
      bestErr = err;
      best = interval;
    }
  }
  return best;
}

/**
 * OrbitControls damping is a per-update-call exponential decay
 * (`sphericalDelta *= 1 - dampingFactor`), so a fixed factor decays
 * twice as fast at 120 Hz as at 60 Hz — identical drags would have
 * half the inertia on a ProMotion display.  Rescale the factor per
 * frame so the decay is a fixed wall-clock time-constant:
 * `f(dt) = 1 - (1 - base)^(dt / (1/60))`, i.e. `base` retains its
 * exact meaning at 60 Hz and halves correctly at 120 Hz.
 */
export function dampingFactorForDt(baseFactor, dtSeconds) {
  if (!(baseFactor > 0) || baseFactor >= 1 || !(dtSeconds > 0)) {
    return baseFactor;
  }
  return 1 - Math.pow(1 - baseFactor, dtSeconds * 60);
}

const _clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Pressure-driven LOD detail threshold: at zero pressure the
 * configured base distance applies (stems/flags/ledger lines hide
 * beyond ~12 wu); at full pressure it shrinks to 30 % of the base
 * (≈ 3.6 wu) so only nearby detail survives.
 */
export function lodDetailThreshold(baseThreshold, pressure) {
  return baseThreshold * (1 - 0.7 * _clamp01(pressure));
}

/**
 * Pressure-driven sub-pixel culling factor: at zero pressure a
 * glyph bucket hides once its footprint projects below ~0.7 device
 * px; at full pressure the cutoff rises to ~2.0 device px.
 */
export function lodSubPixelFactor(pressure) {
  return 0.7 + 1.3 * _clamp01(pressure);
}

/**
 * Per-frame render-submit budget.  Fixed `fallbackMs` until the
 * baseline is calibrated, then 75 % of the display's measured rAF
 * interval so a submit that would have fit the refresh isn't
 * needlessly skipped (a 13 ms submit on a 60 Hz device must render,
 * not fall into a render/skip cadence that halves picture rate).
 */
export function renderBudgetMs(baselineMs, calibrated, fallbackMs = 12) {
  return calibrated ? baselineMs * 0.75 : fallbackMs;
}
