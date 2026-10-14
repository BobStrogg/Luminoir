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
 * after `minSec` of running context. Rates inside `deadband` of 1 are
 * left uncorrected. Rates outside [minRate, maxRate] are treated as a
 * bad sample (suspended context, clock jump) and not applied.
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

