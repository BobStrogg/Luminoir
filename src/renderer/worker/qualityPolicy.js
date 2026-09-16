/**
 * Pure decision functions for the GPU quality system (see the
 * "GPU quality" comment block in `renderWorker.js`).  Extracted so
 * the thresholds and pressure arithmetic can be unit-tested without
 * a renderer; the worker keeps the state and side effects.
 */

/**
 * Choose shadow-map size, DPR cap, and PCF type based on the result
 * of `_probeGpuCost()`.
 *
 * Probe cost reference, GPU-synced via `_gpuSync` (empty scene with a
 * forced 6144² PCFSoft shadow pass at DPR ≤ 2 — see `_probeGpuCost`):
 *   Apple M-series / discrete GPU   ≈ 1.5–2 ms/frame  → keep 6144²
 *   recent integrated GPU           ≈ 2–5 ms/frame    → 4096²
 *   older / budget integrated GPU   ≈ 5 ms+           → 2048²
 * (The pre-GPU-sync numbers that used to live here were submit-time
 * only and read ~0.25 ms on every Chromium machine, which routed all
 * of them into the top tier regardless of actual GPU speed.)
 *
 * @param {number} probeMs
 * @param {boolean} isConstrained  Mobile / Tesla profile.
 * @returns {{ mapSize: number, softPcf: boolean, dprCap: number }}
 */
export function chooseLoadTimeQuality(probeMs, isConstrained) {
  // On mobile the rAF rate halves permanently the first time a frame
  // exceeds budget, so we are extremely conservative.
  if (isConstrained) {
    return { mapSize: 2048, softPcf: false, dprCap: 1.5 };
  }
  if (probeMs < 2) {
    // Very fast GPU (M3/M4, dedicated GPU) — full quality.
    return { mapSize: 6144, softPcf: true, dprCap: 2.0 };
  }
  if (probeMs < 5) {
    // Typical Apple Silicon or recent integrated GPU.
    return { mapSize: 4096, softPcf: true, dprCap: 1.75 };
  }
  // Slower integrated GPU — drop to 2048 with plain PCF.
  return { mapSize: 2048, softPcf: false, dprCap: 1.5 };
}

/**
 * Next rung down the shadow-quality ladder, or `null` when already
 * at the bottom.  Used by `_refineSceneQuality`'s step-down loop.
 *
 * @param {number} currentMapSize
 * @param {{ maxDprCap: number, allowVeryLowQuality: boolean }} opts
 * @returns {{ mapSize: number, softPcf: boolean, dprCap: number } | null}
 */
export function nextQualityStep(currentMapSize, { maxDprCap, allowVeryLowQuality }) {
  if (currentMapSize > 4096) {
    return { mapSize: 4096, softPcf: true, dprCap: Math.min(maxDprCap, 1.75) };
  }
  if (currentMapSize > 2048) {
    return { mapSize: 2048, softPcf: false, dprCap: Math.min(maxDprCap, 1.5) };
  }
  if (allowVeryLowQuality && currentMapSize > 1024) {
    return { mapSize: 1024, softPcf: false, dprCap: Math.min(maxDprCap, 1.25) };
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
