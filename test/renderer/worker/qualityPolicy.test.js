import { describe, it, expect } from 'vitest';
import {
  chooseLoadTimeQuality,
  nextQualityStep,
  advancePressure,
  lightIntensityForPressure,
  shadowIntervalMs,
  fxaaSuppressedFor,
} from '../../../src/renderer/worker/qualityPolicy.js';

describe('chooseLoadTimeQuality', () => {
  it('constrained devices always get the conservative profile', () => {
    expect(chooseLoadTimeQuality(0.5, true)).toEqual({ mapSize: 2048, softPcf: false, dprCap: 1.5 });
    expect(chooseLoadTimeQuality(50, true)).toEqual({ mapSize: 2048, softPcf: false, dprCap: 1.5 });
  });

  it('maps probe tiers', () => {
    expect(chooseLoadTimeQuality(1.99, false)).toEqual({ mapSize: 6144, softPcf: true, dprCap: 2.0 });
    expect(chooseLoadTimeQuality(2, false)).toEqual({ mapSize: 4096, softPcf: true, dprCap: 1.75 });
    expect(chooseLoadTimeQuality(4.99, false)).toEqual({ mapSize: 4096, softPcf: true, dprCap: 1.75 });
    expect(chooseLoadTimeQuality(5, false)).toEqual({ mapSize: 2048, softPcf: false, dprCap: 1.5 });
  });
});

describe('nextQualityStep', () => {
  const opts = { maxDprCap: 2.0, allowVeryLowQuality: false };

  it('steps 6144 → 4096 → 2048 then stops', () => {
    expect(nextQualityStep(6144, opts)).toEqual({ mapSize: 4096, softPcf: true, dprCap: 1.75 });
    expect(nextQualityStep(4096, opts)).toEqual({ mapSize: 2048, softPcf: false, dprCap: 1.5 });
    expect(nextQualityStep(2048, opts)).toBeNull();
  });

  it('clamps dprCap to maxDprCap', () => {
    expect(nextQualityStep(6144, { maxDprCap: 1.5, allowVeryLowQuality: false }).dprCap).toBe(1.5);
  });

  it('adds a 1024 rung only when very-low quality is allowed', () => {
    expect(nextQualityStep(2048, { maxDprCap: 2.0, allowVeryLowQuality: true }))
      .toEqual({ mapSize: 1024, softPcf: false, dprCap: 1.25 });
    expect(nextQualityStep(1024, { maxDprCap: 2.0, allowVeryLowQuality: true })).toBeNull();
  });
});

describe('advancePressure', () => {
  const target = 1000 / 60;

  it('rises by dt when p95 ≥ 1.15× target', () => {
    expect(advancePressure(0, 0.1, target * 1.15)).toBeCloseTo(0.1);
    expect(advancePressure(0.5, 0.1, 30)).toBeCloseTo(0.6);
  });

  it('clamps at 1', () => {
    expect(advancePressure(0.95, 0.1, 30)).toBe(1);
  });

  it('falls by dt/3 when p95 ≤ 1.05× target', () => {
    expect(advancePressure(0.5, 0.3, target * 1.05)).toBeCloseTo(0.4);
    expect(advancePressure(0.5, 0.3, 10)).toBeCloseTo(0.4);
  });

  it('decays slowly between the thresholds', () => {
    expect(advancePressure(0.5, 0.1, target * 1.1)).toBeCloseTo(0.5 - 0.015);
  });

  it('clamps at 0', () => {
    expect(advancePressure(0.01, 1, 10)).toBe(0);
  });
});

describe('lightIntensityForPressure', () => {
  it('scales base by (1 - pressure × 0.85)', () => {
    expect(lightIntensityForPressure(2, 0)).toBe(2);
    expect(lightIntensityForPressure(2, 1)).toBeCloseTo(0.3);
  });
});

describe('shadowIntervalMs', () => {
  it('interpolates between min and max', () => {
    expect(shadowIntervalMs(0)).toBeCloseTo(1000 / 30);
    expect(shadowIntervalMs(1)).toBeCloseTo(150);
    expect(shadowIntervalMs(0.5)).toBeCloseTo((1000 / 30 + 150) / 2);
  });
});

describe('fxaaSuppressedFor', () => {
  it('suppresses at 0.7 and restores at 0.25 with hysteresis between', () => {
    expect(fxaaSuppressedFor(false, 0.7)).toBe(true);
    expect(fxaaSuppressedFor(false, 0.5)).toBe(false);
    expect(fxaaSuppressedFor(true, 0.5)).toBe(true);
    expect(fxaaSuppressedFor(true, 0.25)).toBe(false);
  });
});
