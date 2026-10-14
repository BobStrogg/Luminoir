import { describe, it, expect } from 'vitest';
import {
  audioClockTrim,
  avOffsetFromSearch,
  avOffsetToPersist,
  clampAvOffsetMs,
  clampMasterVolume,
  computeSampleRateComp,
  outputDelaySec,
  resolveAvOffsetMs,
} from '../../src/playback/audioUtils.js';

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

describe('outputDelaySec', () => {
  it('uses outputLatency + baseLatency when the timestamp has not started', () => {
    // Tesla overlay: baseLatency 43 ms, outputLatency 264–280 ms.
    const early = {
      currentTime: 1,
      baseLatency: 0.043,
      outputLatency: 0.264,
      getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    };
    expect(outputDelaySec(early, 1000)).toBeCloseTo(0.307, 5);
    expect(outputDelaySec({
      currentTime: 1,
      baseLatency: 0.043,
      outputLatency: 0.280,
    }, 1000)).toBeCloseTo(0.323, 5);
  });

  it('prefers the getOutputTimestamp mapping over the latency sum', () => {
    // contextTime 10.000 was at the speaker at performance 5000 ms.
    // At 5020 ms the audible context time is 10.020. currentTime 10.320
    // is 300 ms ahead — that is the delay, not the 307 ms sum.
    const ctx = {
      currentTime: 10.320,
      baseLatency: 0.043,
      outputLatency: 0.264,
      getOutputTimestamp: () => ({ contextTime: 10.000, performanceTime: 5000 }),
    };
    expect(outputDelaySec(ctx, 5020)).toBeCloseTo(0.300, 5);
  });

  it('falls back when the timestamp delay is implausible', () => {
    const ctx = {
      currentTime: 8,
      baseLatency: 0.043,
      outputLatency: 0.264,
      getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 0 }),
    };
    expect(outputDelaySec(ctx, 1000)).toBeCloseTo(0.307, 5);
  });

  it('returns 0 without a context', () => {
    expect(outputDelaySec(null, 0)).toBe(0);
  });
});

describe('A/V sync offset', () => {
  it('clamps the user nudge to ±300 ms', () => {
    expect(clampAvOffsetMs(120)).toBe(120);
    expect(clampAvOffsetMs(-300)).toBe(-300);
    expect(clampAvOffsetMs(450)).toBe(300);
    expect(clampAvOffsetMs(-900)).toBe(-300);
    expect(clampAvOffsetMs('nope', 0)).toBe(0);
    expect(clampAvOffsetMs(null, 0)).toBe(0);
  });

  it('reads ?avoffset= and lets it override a stored value', () => {
    expect(avOffsetFromSearch('')).toBeNull();
    expect(avOffsetFromSearch('?stats=1')).toBeNull();
    expect(avOffsetFromSearch('?avoffset=120')).toBe(120);
    expect(avOffsetFromSearch('?avoffset=-450')).toBe(-300);
    expect(resolveAvOffsetMs(40, '?avoffset=-20')).toBe(-20);
    expect(resolveAvOffsetMs(500, '')).toBe(300);
    expect(resolveAvOffsetMs(undefined, '')).toBeNull();
  });

  it('does not store a ?avoffset= session value over a saved slider position', () => {
    expect(avOffsetToPersist(120, { fromUrl: true, savedMs: 40 })).toBe(40);
    expect(avOffsetToPersist(-20, { fromUrl: true, savedMs: 0 })).toBe(0);
    expect(avOffsetToPersist(120, { fromUrl: true, savedMs: null })).toBeUndefined();
    expect(avOffsetToPersist(120, { fromUrl: true })).toBeUndefined();
    expect(avOffsetToPersist(80, { fromUrl: false, savedMs: 40 })).toBe(80);
    expect(avOffsetToPersist(450, { fromUrl: true, savedMs: 900 })).toBe(300);
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

