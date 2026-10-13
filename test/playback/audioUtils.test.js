import { describe, it, expect } from 'vitest';
import { computeSampleRateComp } from '../../src/playback/audioUtils.js';

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

