import { describe, it, expect } from 'vitest';
import {
  chooseLoadTimeQuality,
  nextQualityStep,
  advancePressure,
  lightIntensityForPressure,
  shadowIntervalMs,
  fxaaSuppressedFor,
  castersSuppressedFor,
  lodDetailThreshold,
  lodSubPixelFactor,
  renderBudgetMs,
} from '../../../src/renderer/worker/qualityPolicy.js';

describe('chooseLoadTimeQuality', () => {
  it('constrained devices always get the conservative profile', () => {
    expect(chooseLoadTimeQuality(0.5, true)).toEqual({ mapSize: 2048, softPcf: false });
    expect(chooseLoadTimeQuality(50, true)).toEqual({ mapSize: 2048, softPcf: false });
  });

  it('maps probe tiers', () => {
    expect(chooseLoadTimeQuality(1.99, false)).toEqual({ mapSize: 6144, softPcf: true });
    expect(chooseLoadTimeQuality(2, false)).toEqual({ mapSize: 4096, softPcf: true });
    expect(chooseLoadTimeQuality(4.99, false)).toEqual({ mapSize: 4096, softPcf: true });
    expect(chooseLoadTimeQuality(5, false)).toEqual({ mapSize: 2048, softPcf: false });
  });

  it('never returns a resolution cap — rendering stays at native DPR', () => {
    for (const constrained of [true, false]) {
      for (const probeMs of [0.5, 2, 5, 50]) {
        expect(chooseLoadTimeQuality(probeMs, constrained)).not.toHaveProperty('dprCap');
      }
    }
  });
});

describe('nextQualityStep', () => {
  const opts = { allowVeryLowQuality: false };

  it('steps 6144 → 4096 → 2048 then stops', () => {
    expect(nextQualityStep(6144, opts)).toEqual({ mapSize: 4096, softPcf: true });
    expect(nextQualityStep(4096, opts)).toEqual({ mapSize: 2048, softPcf: false });
    expect(nextQualityStep(2048, opts)).toBeNull();
  });

  it('adds a 1024 rung only when very-low quality is allowed', () => {
    expect(nextQualityStep(2048, { allowVeryLowQuality: true }))
      .toEqual({ mapSize: 1024, softPcf: false });
    expect(nextQualityStep(1024, { allowVeryLowQuality: true })).toBeNull();
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

describe('castersSuppressedFor', () => {
  it('suppresses at 0.55 and restores at 0.30 with hysteresis between', () => {
    expect(castersSuppressedFor(false, 0.55)).toBe(true);
    expect(castersSuppressedFor(false, 0.45)).toBe(false);
    expect(castersSuppressedFor(true, 0.45)).toBe(true);
    expect(castersSuppressedFor(true, 0.30)).toBe(false);
  });
});

describe('lodDetailThreshold', () => {
  it('scales the base threshold down to 30 % at full pressure', () => {
    expect(lodDetailThreshold(12, 0)).toBe(12);
    expect(lodDetailThreshold(12, 0.5)).toBeCloseTo(12 * 0.65);
    expect(lodDetailThreshold(12, 1)).toBeCloseTo(3.6);
  });

  it('clamps out-of-range pressure', () => {
    expect(lodDetailThreshold(12, 2)).toBeCloseTo(3.6);
    expect(lodDetailThreshold(12, -1)).toBe(12);
  });
});

describe('lodSubPixelFactor', () => {
  it('rises from 0.7 to 2.0 device px', () => {
    expect(lodSubPixelFactor(0)).toBeCloseTo(0.7);
    expect(lodSubPixelFactor(0.5)).toBeCloseTo(1.35);
    expect(lodSubPixelFactor(1)).toBeCloseTo(2.0);
  });

  it('clamps out-of-range pressure', () => {
    expect(lodSubPixelFactor(5)).toBeCloseTo(2.0);
    expect(lodSubPixelFactor(-2)).toBeCloseTo(0.7);
  });
});

describe('renderBudgetMs', () => {
  it('returns the fixed fallback until calibrated', () => {
    expect(renderBudgetMs(16.67, false)).toBe(12);
    expect(renderBudgetMs(8.33, false, 10)).toBe(10);
  });

  it('returns 75 % of the calibrated baseline', () => {
    expect(renderBudgetMs(16.67, true)).toBeCloseTo(12.5);
    expect(renderBudgetMs(8.33, true)).toBeCloseTo(6.25);
  });
});
