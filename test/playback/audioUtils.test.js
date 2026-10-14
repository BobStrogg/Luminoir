import { describe, it, expect } from 'vitest';
import { audioClockTrim, clampMasterVolume, computeSampleRateComp } from '../../src/playback/audioUtils.js';

describe('computeSampleRateComp', () => {
  it('returns 1.0 when disabled', () => {
    expect(computeSampleRateComp(48000, false)).toBe(1);
  });
  it('returns 1.0 near 44100 when enabled', () => {
    expect(computeSampleRateComp(44100, true)).toBe(1);
    expect(computeSampleRateComp(44250, true)).toBe(1);
  });
  it('returns sr/44100 when far from 44100 and enabled', () => {
    const f = computeSampleRateComp(48000, true);
    expect(f).toBeCloseTo(48000 / 44100, 6);
  });
});

describe('audioClockTrim', () => {
  it('treats a short 1.019 slice as unreliable noise', () => {
    const r = audioClockTrim(0.5095, 0.5);
    expect(r.reliable).toBe(false);
    expect(r.correct).toBe(false);
    expect(r.trim).toBe(1);
  });

  it('does not correct a 2 s window that settles near 1', () => {
    const r = audioClockTrim(2.004, 2);
    expect(r.reliable).toBe(true);
    expect(r.correct).toBe(false);
    expect(r.trim).toBe(1);
  });

  it('corrects a sustained 1.019 clock', () => {
    const r = audioClockTrim(5.095, 5);
    expect(r.reliable).toBe(true);
    expect(r.correct).toBe(true);
    expect(r.rate).toBeCloseTo(1.019, 6);
    expect(r.trim).toBeCloseTo(1 / 1.019, 6);
  });

  it('reads a 22 ms output-latency offset over 2 s as 0.989', () => {
    // currentTime lags performance.now() by a constant ~22 ms.
    // From the first sample that is (2.000 - 0.022) / 2.000 = 0.989,
    // which the old origin window treated as drift. The slope between
    // two later samples cancels the offset.
    const lag = 0.022;
    const fromOrigin = audioClockTrim(2 - lag, 2);
    expect(fromOrigin.rate).toBeCloseTo(0.989, 3);
    expect(fromOrigin.correct).toBe(true);
    const slope = audioClockTrim((4 - lag) - (2 - lag), 2);
    expect(slope.rate).toBeCloseTo(1, 6);
    expect(slope.correct).toBe(false);
    expect(slope.trim).toBe(1);
  });

  it('rejects an implausible rate from a suspended context', () => {
    const r = audioClockTrim(0.05, 5);
    expect(r.reliable).toBe(false);
    expect(r.correct).toBe(false);
  });
});

describe('clampMasterVolume', () => {
  it('clamps to [0, 1] and falls back when the stored value is junk', () => {
    expect(clampMasterVolume(0.4)).toBe(0.4);
    expect(clampMasterVolume('1.4')).toBe(1);
    expect(clampMasterVolume(-0.2)).toBe(0);
    expect(clampMasterVolume('nope', 1)).toBe(1);
    expect(clampMasterVolume(null, 1)).toBe(1);
  });
});

