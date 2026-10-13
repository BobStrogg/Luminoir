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

