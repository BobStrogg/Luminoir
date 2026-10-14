/**
 * Compute a scheduling compensation factor for sample-rate mismatches.
 * Many GM SoundFont sets are authored at 44.1 kHz; on some embedded
 * Chromium environments (e.g., in-car browsers) playback can run fast
 * when the AudioContext runs at 48 kHz if the synth layer assumes 44.1.
 * Apply a conservative correction only when the environment is flagged.
 *
 * @param {number} sampleRate
 * @param {boolean} enableCompensation  Gate (e.g., Tesla-only or via override)
 * @returns {number} factor ≥ 0 (1.0 = no compensation)
 */
export function computeSampleRateComp(sampleRate, enableCompensation) {
  if (!enableCompensation) return 1.0;
  const sr = Number(sampleRate) || 44100;
  // Only compensate when clearly not 44.1k (±200 Hz guard).
  if (Math.abs(sr - 44100) > 200) {
    return sr / 44100;
  }
  return 1.0;
}

/**
 * Seconds of AudioContext time by which `currentTime` leads the sample
 * that is actually leaving the speakers. Visual music time subtracts
 * this so the playhead matches what is heard.
 *
 * Preferred mapping is `getOutputTimestamp()`: `contextTime` is the
 * sample at the output device and `performanceTime` is when that
 * sample was rendered, so the context time audible at `nowMs` is
 * `contextTime + (nowMs - performanceTime) / 1000`. The spec warns
 * that `currentTime - contextTime` alone is not a stable latency
 * reading; extrapolating to `nowMs` is the mapping, and values
 * outside [0, 2) s fall through.
 *
 * Fallback, including the all-zero timestamp returned before the
 * first rendered block, is `outputLatency + baseLatency`. On the
 * Tesla overlay that sum is 43 ms + 264–280 ms = 307–323 ms.
 *
 * @param {{ currentTime?: number, baseLatency?: number, outputLatency?: number, getOutputTimestamp?: Function } | null | undefined} ctx
 * @param {number} nowMs  `performance.now()`
 * @returns {number} delay in seconds, ≥ 0
 */
export function outputDelaySec(ctx, nowMs) {
  const fallback = latencySumSec(ctx?.outputLatency, ctx?.baseLatency);
  if (!ctx || typeof ctx.getOutputTimestamp !== 'function') return fallback;
  let ts;
  try { ts = ctx.getOutputTimestamp(); } catch { return fallback; }
  if (!ts) return fallback;
  const contextTime = Number(ts.contextTime);
  const performanceTime = Number(ts.performanceTime);
  const currentTime = Number(ctx.currentTime);
  // Both members are zero until the graph has rendered a block.
  if (!(contextTime > 0) && !(performanceTime > 0)) return fallback;
  if (!Number.isFinite(contextTime) || !Number.isFinite(performanceTime) || !Number.isFinite(currentTime)) {
    return fallback;
  }
  const heard = contextTime + (Number(nowMs) - performanceTime) / 1000;
  const delay = currentTime - heard;
  if (delay >= -0.02 && delay < 2) return Math.max(0, delay);
  return fallback;
}

function latencySumSec(outputLatency, baseLatency) {
  const out = Number(outputLatency);
  const base = Number(baseLatency);
  const sum = (Number.isFinite(out) && out > 0 ? out : 0) + (Number.isFinite(base) && base > 0 ? base : 0);
  return sum < 2 ? sum : 0;
}

/** How fast the visual clock eases toward a new output-delay estimate. */
export const OUTPUT_DELAY_SMOOTH_SEC = 0.35;

/** User A/V sync nudge, milliseconds of music time. */
export const AV_OFFSET_MIN_MS = -300;
export const AV_OFFSET_MAX_MS = 300;

/** Clamp the user A/V sync offset to [-300, +300] ms. */
export function clampAvOffsetMs(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(AV_OFFSET_MAX_MS, Math.max(AV_OFFSET_MIN_MS, n));
}

/**
 * `?avoffset=` override. `null` when the param is absent so a stored
 * setting is left alone.
 * @param {string} search  `location.search`, with or without '?'
 * @returns {number | null}
 */
export function avOffsetFromSearch(search) {
  let q;
  try {
    q = new URLSearchParams(search || '');
  } catch {
    return null;
  }
  if (!q.has('avoffset')) return null;
  return clampAvOffsetMs(q.get('avoffset'), 0);
}

/**
 * Effective user offset: the URL param wins, otherwise the stored
 * value clamped into range. `null` when neither is set.
 * @param {number | string | null | undefined} stored
 * @param {string} search
 * @returns {number | null}
 */
export function resolveAvOffsetMs(stored, search) {
  const override = avOffsetFromSearch(search);
  if (override != null) return override;
  if (stored == null || stored === '') return null;
  return clampAvOffsetMs(stored, 0);
}

/** localStorage key for the master-volume slider. */
export const MASTER_VOLUME_KEY = 'luminoir.masterVolume';

/** Clamp a master volume to the GainNode range [0, 1]. */
export function clampMasterVolume(value, fallback = 1) {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * Compare AudioContext time to wall-clock time.
 *
 * A single ~0.5 s stats slice is noisy by about ±2% (message jitter
 * plus the audio render quantum), so a reading of 1.019 from that
 * slice is not evidence of drift. This only reports a reliable rate
 * after `minSec` of running context. Feed it a slope between two
 * samples taken after the context is already running: a constant
 * output-latency offset (about 22 ms) over a 2 s window that starts
 * at the first currentTime reads 0.989 and is not a clock rate.
 * Rates inside `deadband` of 1 are left uncorrected. Rates outside
 * [minRate, maxRate] are treated as a bad sample (suspended context,
 * clock jump) and not applied.
 *
 * `trim` is the factor that converts a wall-clock delay into an
 * AudioContext delay: schedule notes at `audioDelay = wallDelay * rate`
 * and advance music time by `audioElapsed / rate`.
 *
 * @param {number} dAudioSec
 * @param {number} dWallSec
 * @param {{ minSec?: number, deadband?: number, minRate?: number, maxRate?: number }} [opts]
 * @returns {{ rate: number, trim: number, reliable: boolean, correct: boolean }}
 */
export function audioClockTrim(dAudioSec, dWallSec, {
  minSec = 2,
  deadband = 0.008,
  minRate = 0.9,
  maxRate = 1.1,
} = {}) {
  if (!(dWallSec >= minSec) || !(dAudioSec > 0)) {
    return { rate: 1, trim: 1, reliable: false, correct: false };
  }
  const rate = dAudioSec / dWallSec;
  if (rate < minRate || rate > maxRate) {
    return { rate, trim: 1, reliable: false, correct: false };
  }
  if (Math.abs(rate - 1) <= deadband) {
    return { rate, trim: 1, reliable: true, correct: false };
  }
  return { rate, trim: 1 / rate, reliable: true, correct: true };
}

