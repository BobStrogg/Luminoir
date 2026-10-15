/**
 * Pure decision functions for the GPU quality system (see the
 * "GPU quality" comment block in `renderWorker.js`).  Extracted so
 * the thresholds and pressure arithmetic can be unit-tested without
 * a renderer; the worker keeps the state and side effects.
 */

import { LOD_FAR_RADIUS, LOD_NEAR_RADIUS } from '../../rendering/lodDistances.js';

export { LOD_FAR_RADIUS, LOD_NEAR_RADIUS, LOD_FADE_WIDTH } from '../../rendering/lodDistances.js';

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
 * Headroom of a frame-cost sample against the display interval.
 * 1 means the recent cost is at or under 55 % of a vsync (plenty of
 * room).  0 means the cost has reached 92 % of a vsync — still before
 * a missed frame, which is the point the governor must already be
 * shedding distant detail.  An empty or non-positive cost reads as
 * full headroom so idle gaps and an unfilled render ring cannot
 * tighten the reach.
 *
 * @param {number} costP95  Recent render-submit or GPU-scene p95, ms.
 * @param {number} displayMs  Calibrated refresh interval, ms.
 * @returns {number} 0..1
 */
export function frameHeadroom(costP95, displayMs) {
  if (!(costP95 > 0) || !(displayMs > 0)) return 1;
  const full = displayMs * 0.55;
  const empty = displayMs * 0.92;
  if (costP95 <= full) return 1;
  if (costP95 >= empty) return 0;
  return (empty - costP95) / (empty - full);
}

/**
 * Detail reach (wu along score X) for a headroom sample.  Full
 * headroom keeps `far`.  No headroom pulls in to `near` and stops
 * there — the near field is never a cull target.
 */
export function detailReachForHeadroom(headroom, near = LOD_NEAR_RADIUS, far = LOD_FAR_RADIUS) {
  const span = Math.max(0, far - near);
  return near + span * _clamp01(headroom);
}

/**
 * Glide the detail-reach governor one tick.
 *
 * Hysteresis: leave `open` only when headroom drops below 0.35, and
 * return to `open` only after it climbs past 0.62, so a noisy p95
 * cannot pump the cutoff.  Tightening uses a ~0.45 s time constant;
 * relaxing uses ~1.4 s.  `cap` is a load-time ceiling (the widest
 * reach that still fit the GPU probe); the glide never reopens past
 * it.  When `active` is false the reach holds — idle rAF gaps must
 * not restore a score's worth of stems and then hitch on the next play.
 *
 * @param {{ mode?: string, reach?: number, headroom?: number }} state
 * @param {number} costP95
 * @param {number} displayMs
 * @param {number} dt Seconds.
 * @param {boolean} [active]
 * @param {number} [cap]
 * @returns {{ mode: 'open'|'tight', reach: number, headroom: number }}
 */
export function stepDetailGovernor(state, costP95, displayMs, dt, active = true, cap = LOD_FAR_RADIUS) {
  const far = Math.max(LOD_NEAR_RADIUS, Math.min(LOD_FAR_RADIUS, cap > 0 ? cap : LOD_FAR_RADIUS));
  const prevReach = Number.isFinite(state?.reach) ? state.reach : far;
  const prevMode = state?.mode === 'tight' ? 'tight' : 'open';
  if (!active) {
    return {
      mode: prevMode,
      reach: Math.max(LOD_NEAR_RADIUS, Math.min(far, prevReach)),
      headroom: Number.isFinite(state?.headroom) ? state.headroom : 1,
    };
  }
  const headroom = frameHeadroom(costP95, displayMs);
  let mode = prevMode;
  if (mode === 'open' && headroom < 0.35) mode = 'tight';
  else if (mode === 'tight' && headroom > 0.62) mode = 'open';
  const target = mode === 'open' ? far : Math.min(far, detailReachForHeadroom(headroom, LOD_NEAR_RADIUS, far));
  const clamped = Math.max(LOD_NEAR_RADIUS, Math.min(far, target));
  const held = Math.max(LOD_NEAR_RADIUS, Math.min(far, prevReach));
  const tightening = clamped < held - 0.01;
  const tau = tightening ? 0.45 : 1.4;
  const dtS = dt > 0 ? dt : 0;
  const k = 1 - Math.exp(-dtS / tau);
  const reach = Math.max(LOD_NEAR_RADIUS, Math.min(far, held + (clamped - held) * k));
  return { mode, reach, headroom };
}

/**
 * Interpolate a GPU-scene cost between the full-detail probe and the
 * tightened-reach probe.  `visibleFraction` is 1 when every detail
 * instance is drawn and equals `tightFraction` at the tightened probe.
 * Returns 0 when the tightened probe did not actually get cheaper, so
 * the governor will not shed stems that do not buy frame time.
 */
export function estimateDetailGpuMs(fullMs, tightMs, visibleFraction, tightFraction) {
  if (!(fullMs > 0) || !(tightMs > 0) || tightMs >= fullMs * 0.92) return 0;
  const span = 1 - tightFraction;
  const f = _clamp01(visibleFraction);
  if (!(span > 0.02)) return tightMs;
  const t = _clamp01((f - tightFraction) / span);
  return tightMs + (fullMs - tightMs) * t;
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

/**
 * GPU-synced scene cost (ms), after subtracting an idle readback
 * fence, at or under which a Tesla panel can hold a steady 60.
 * Sits just under one 60 Hz vsync (16.67 ms). 30 fps is chosen only
 * when that scene cost is still above this. A lower pixel ratio is
 * kept only when the remeasure actually lands under this threshold
 * or cuts the cost by at least 25%.
 */
export const TESLA_LOCK60_PROBE_MS = 16;

/** Tesla framebuffer ratio band. A hard cap of 1.0 on a ~2× panel
 *  (804×638 CSS at DPR 1.96 → 804×638 buffer) was visibly soft.
 *  Stay inside this band, and also under `TESLA_PIXEL_BUDGET`. */
export const TESLA_DPR_MIN = 1.25;
export const TESLA_DPR_MAX = 1.5;
/** Drawing-buffer pixel ceiling used to pick the load-time ratio.
 *  1.6e6 is about 1206×957 — 1.5× an 804×638 CSS viewport — and
 *  roughly 2.25× the old DPR-1 buffer without returning to a full
 *  ~2× native framebuffer (~2.0e6 px at 1.96). */
export const TESLA_PIXEL_BUDGET = 1_600_000;

/**
 * Load-time Tesla pixel ratio. Never upscales past the native DPR,
 * never uses the old 1.0 cap when the native ratio is higher, and
 * keeps the result inside [minRatio, maxRatio] ∩ pixel budget.
 * Chosen once at load (and possibly stepped down by the scene probe
 * while the loading overlay is up). It is not a runtime actuator.
 *
 * @param {number} nativeDpr
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {{ minRatio?: number, maxRatio?: number, pixelBudget?: number }} [opts]
 * @returns {number}
 */
export function chooseTeslaPixelRatio(nativeDpr, cssWidth, cssHeight, {
  minRatio = TESLA_DPR_MIN,
  maxRatio = TESLA_DPR_MAX,
  pixelBudget = TESLA_PIXEL_BUDGET,
} = {}) {
  const native = Number.isFinite(nativeDpr) && nativeDpr > 0 ? nativeDpr : 1;
  const area = Math.max(1, Number(cssWidth) || 1) * Math.max(1, Number(cssHeight) || 1);
  const budgetRatio = Math.sqrt(Math.max(1, pixelBudget) / area);
  const ceiling = Math.min(native, maxRatio, budgetRatio);
  const floor = Math.min(minRatio, native);
  const chosen = Math.max(floor, ceiling);
  return Math.round(chosen * 100) / 100;
}

/**
 * Present decimation from the load-time scene probe.
 * On a 60 Hz panel, N=1 presents every vsync (60) and N=2 is locked 30.
 * On a 120 Hz panel, N=2 is locked 60 and N=4 is locked 30.
 * 60 is preferred whenever the probe median fits in `thresholdMs`.
 *
 * @param {{ displayMs: number, probeMedianMs: number, thresholdMs?: number }} args
 * @returns {{ n: 1|2|4, label: 'locked60'|'locked30' }}
 */
export function choosePresentDecimation({
  displayMs,
  probeMedianMs,
  thresholdMs = TESLA_LOCK60_PROBE_MS,
}) {
  const vsync = displayMs > 0 ? displayMs : 1000 / 60;
  const is120 = vsync <= 8.5;
  const hold60 = !(probeMedianMs > thresholdMs);
  if (is120) {
    return hold60 ? { n: 2, label: 'locked60' } : { n: 4, label: 'locked30' };
  }
  return hold60 ? { n: 1, label: 'locked60' } : { n: 2, label: 'locked30' };
}

/**
 * Overlay rate label from the decimation the loop is actually using.
 * N=1 on a 60 Hz panel is `locked60` (every vsync), not a separate
 * "main rAF looks like 60" claim.
 *
 * @param {number} decimationN
 * @param {number} displayMs
 * @returns {string}
 */
export function rateLabelFor(decimationN, displayMs) {
  const n = decimationN === 2 || decimationN === 4 ? decimationN : 1;
  const baseHz = displayMs > 0 ? 1000 / displayMs : 0;
  if (n === 1) {
    if (baseHz > 58 && baseHz < 62) return 'locked60';
    return 'native';
  }
  const locked = baseHz > 0 ? Math.round(baseHz / n) : (n === 2 ? 60 : 30);
  return `locked${locked}`;
}

/**
 * True when the presented cadence (display refresh ÷ decimation N)
 * is 60 Hz. Main-thread rAF staying at 16.7 ms is not sufficient:
 * N=2 on a 60 Hz panel presents at 30.
 *
 * @param {number} displayHz
 * @param {number} decimationN
 * @returns {boolean}
 */
export function presentLocked60(displayHz, decimationN) {
  const hz = Number(displayHz);
  const n = decimationN === 2 || decimationN === 4 ? decimationN : 1;
  if (!(hz > 0)) return false;
  return Math.abs(hz / n - 60) < 1.5;
}

/**
 * Count rAF-to-rAF intervals that missed the display vsync.
 * `frameMs` is the raw tick ring, not the gap between rendered
 * frames, so the budget is one vsync — multiplying by decimation N
 * made a 33 ms tick at N=2 look on-time and let the rate step up.
 * A gap at or above `outlierMs` (a GC, a shader link, a decode hitch)
 * is dropped entirely: one 366 ms sample must not fill the miss
 * budget. A miss is an interval above `missFactor` × vsync and below
 * that outlier cap.
 *
 * @param {ArrayLike<number>} frameMs
 * @param {number} displayMs
 * @param {{ missFactor?: number, outlierMs?: number }} [opts]
 * @returns {{ samples: number, misses: number, outliers: number }}
 */
export function countCadenceMisses(frameMs, displayMs, {
  missFactor = 1.5,
  outlierMs = 100,
} = {}) {
  const vsync = displayMs > 0 ? displayMs : 1000 / 60;
  const missAt = vsync * missFactor;
  const outlierAt = Math.max(outlierMs, vsync * 4);
  let samples = 0;
  let misses = 0;
  let outliers = 0;
  const len = frameMs?.length || 0;
  for (let i = 0; i < len; i++) {
    const v = frameMs[i];
    if (!(v > 0)) continue;
    if (v >= outlierAt) { outliers++; continue; }
    samples++;
    if (v > missAt) misses++;
  }
  return { samples, misses, outliers };
}

/**
 * True when a scene that already fits in `thresholdMs` at `lowRatio`
 * would still fit at `sharpRatio` if cost scaled with pixel count.
 * Used to undo a cold-probe step from 1.50 to 1.25: 10.10 ms at
 * 1.25 estimates 14.5 ms at 1.50, which is still inside 16 ms.
 *
 * @param {number} sceneAtLow
 * @param {number} lowRatio
 * @param {number} sharpRatio
 * @param {number} thresholdMs
 * @returns {boolean}
 */
export function sharpRatioStillFits(sceneAtLow, lowRatio, sharpRatio, thresholdMs) {
  if (!(sceneAtLow >= 0) || !(lowRatio > 0) || !(sharpRatio > lowRatio)) return false;
  const scale = (sharpRatio / lowRatio) ** 2;
  return sceneAtLow * scale <= thresholdMs;
}

/**
 * Runtime Tesla present-rate decision, sampled once per window rather
 * than once per frame.
 *
 * Step down only after several windows each contain at least
 * `missesNeeded` in-budget misses, and only once the window itself
 * has `minSamples` frames. A single outlier cannot satisfy that.
 * Step back up toward `minN` (the load-time probe choice, usually
 * locked 60) after several clean windows, so a bad step does not
 * last the rest of the song.
 *
 * @param {number} currentN
 * @param {number} displayMs
 * @param {{ samples?: number, misses?: number }} stats
 * @param {{ consecutiveMiss?: number, consecutiveClean?: number }} [state]
 * @param {{ minSamples?: number, missesNeeded?: number, windowsNeeded?: number, cleanWindowsNeeded?: number, minN?: number }} [opts]
 * @returns {{ n: number, consecutiveMiss: number, consecutiveClean: number, step: boolean, direction: 'down'|'up'|null }}
 */
export function nextTeslaDecimation(currentN, displayMs, stats, state = {}, {
  minSamples = 45,
  missesNeeded = 8,
  windowsNeeded = 4,
  cleanWindowsNeeded = 8,
  minN = 1,
} = {}) {
  const n0 = currentN === 2 || currentN === 4 ? currentN : 1;
  const vsync = displayMs > 0 ? displayMs : 1000 / 60;
  const is120 = vsync <= 8.5;
  const maxN = is120 ? 4 : 2;
  const floorN = minN === 2 || minN === 4 ? minN : 1;
  const samples = stats?.samples || 0;
  const misses = stats?.misses || 0;
  let consecutiveMiss = state?.consecutiveMiss || 0;
  let consecutiveClean = state?.consecutiveClean || 0;
  if (samples < minSamples) {
    return { n: n0, consecutiveMiss, consecutiveClean, step: false, direction: null };
  }
  if (misses >= missesNeeded) {
    consecutiveMiss += 1;
    consecutiveClean = 0;
  } else if (misses === 0) {
    consecutiveClean += 1;
    consecutiveMiss = 0;
  } else {
    consecutiveMiss = 0;
    consecutiveClean = 0;
  }
  if (n0 < maxN && consecutiveMiss >= windowsNeeded) {
    const n = is120 ? Math.min(maxN, n0 * 2) : 2;
    return { n, consecutiveMiss: 0, consecutiveClean: 0, step: true, direction: 'down' };
  }
  if (n0 > floorN && consecutiveClean >= cleanWindowsNeeded) {
    const n = is120 ? Math.max(floorN, n0 / 2) : floorN;
    return { n, consecutiveMiss: 0, consecutiveClean: 0, step: true, direction: 'up' };
  }
  return { n: n0, consecutiveMiss, consecutiveClean, step: false, direction: null };
}
