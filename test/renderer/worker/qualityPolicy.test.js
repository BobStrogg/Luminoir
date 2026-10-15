import { describe, it, expect } from 'vitest';
import {
  chooseLoadTimeQuality,
  nextQualityStep,
  advancePressure,
  lightIntensityForPressure,
  shadowIntervalMs,
  fxaaSuppressedFor,
  castersSuppressedFor,
  quantizeFrameMs,
  snapToRefreshInterval,
  dampingFactorForDt,
  lodDetailThreshold,
  lodSubPixelFactor,
  renderBudgetMs,
  frameHeadroom,
  detailReachForHeadroom,
  stepDetailGovernor,
  estimateDetailGpuMs,
  LOD_NEAR_RADIUS,
  LOD_FAR_RADIUS,
  chooseTeslaPixelRatio,
  choosePresentDecimation,
  rateLabelFor,
  presentLocked60,
  nextTeslaDecimation,
  countCadenceMisses,
  sharpRatioStillFits,
  TESLA_LOCK60_PROBE_MS,
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

describe('quantizeFrameMs', () => {
  it('snaps to refresh multiples at 60 Hz and 120 Hz', () => {
    expect(quantizeFrameMs(16.5, 16.67)).toBeCloseTo(16.67);
    expect(quantizeFrameMs(17.0, 16.67)).toBeCloseTo(16.67);
    expect(quantizeFrameMs(8.2, 8.33)).toBeCloseTo(8.33);
    // A dropped frame still counts its full two-step cost.
    expect(quantizeFrameMs(33.4, 16.67)).toBeCloseTo(33.34);
  });

  it('keeps the raw interval when it is not near a multiple', () => {
    expect(quantizeFrameMs(12, 16.67)).toBe(12);      // 25 % tolerance
    expect(quantizeFrameMs(80, 16.67)).toBe(80);      // beyond maxSteps
  });

  it('passes through degenerate inputs', () => {
    expect(quantizeFrameMs(0, 16.67)).toBe(0);
    expect(quantizeFrameMs(16.7, 0)).toBe(16.7);
    expect(quantizeFrameMs(NaN, 16.67)).toBeNaN();
  });
});

describe('snapToRefreshInterval', () => {
  it('snaps near-standard medians to exact refresh periods', () => {
    expect(snapToRefreshInterval(16.9)).toBeCloseTo(1000 / 60);
    expect(snapToRefreshInterval(8.4)).toBeCloseTo(1000 / 120);
    expect(snapToRefreshInterval(33.2)).toBeCloseTo(1000 / 30);
    expect(snapToRefreshInterval(6.8)).toBeCloseTo(1000 / 144);
  });

  it('passes through non-standard rates and degenerate inputs', () => {
    expect(snapToRefreshInterval(39)).toBe(39);   // ~26 Hz — outside every band
    expect(snapToRefreshInterval(0)).toBe(0);
    expect(snapToRefreshInterval(NaN)).toBeNaN();
  });
});

describe('dampingFactorForDt', () => {
  it('returns the base factor at exactly 60 Hz', () => {
    expect(dampingFactorForDt(0.12, 1 / 60)).toBeCloseTo(0.12);
  });

  it('gives equal wall-clock decay at any refresh rate', () => {
    // Two 120 Hz frames must decay the same residual delta as one 60 Hz
    // frame: (1 - f120)² ≈ (1 - f60).
    const f60 = dampingFactorForDt(0.12, 1 / 60);
    const f120 = dampingFactorForDt(0.12, 1 / 120);
    expect((1 - f120) * (1 - f120)).toBeCloseTo(1 - f60, 5);
    // A dropped frame (33 ms) decays more per frame, matching elapsed time.
    expect(dampingFactorForDt(0.12, 1 / 30)).toBeGreaterThan(f60);
  });

  it('passes through degenerate inputs', () => {
    expect(dampingFactorForDt(0.12, 0)).toBe(0.12);
    expect(dampingFactorForDt(0, 1 / 60)).toBe(0);
    expect(dampingFactorForDt(1, 1 / 60)).toBe(1);
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

describe('chooseTeslaPixelRatio', () => {
  it('replaces the DPR 1.0 cap with 1.5 on an 804×638 @ 1.96 Tesla panel', () => {
    // Owner overlay: native DPR 1.96, buffer stuck at the CSS size.
    expect(chooseTeslaPixelRatio(1.96, 804, 638)).toBe(1.5);
  });

  it('does not upscale when the native ratio is already 1', () => {
    expect(chooseTeslaPixelRatio(1, 804, 638)).toBe(1);
  });

  it('keeps a large viewport at the 1.25 floor instead of the pixel-budget fraction', () => {
    expect(chooseTeslaPixelRatio(2, 1920, 1200)).toBe(1.25);
  });

  it('respects an explicit pixel budget when it lands inside the band', () => {
    // 804*638 = 512952; budget 1.0e6 → ratio ≈ 1.40, under the 1.5 cap.
    expect(chooseTeslaPixelRatio(1.96, 804, 638, { pixelBudget: 1_000_000 })).toBe(1.4);
  });
});

describe('choosePresentDecimation', () => {
  const threshold = TESLA_LOCK60_PROBE_MS;

  it('prefers 60 on a 60 Hz panel when the probe median fits', () => {
    expect(choosePresentDecimation({
      displayMs: 1000 / 60,
      probeMedianMs: 12.4,
      thresholdMs: threshold,
    })).toEqual({ n: 1, label: 'locked60' });
  });

  it('steps a 60 Hz panel to locked 30 only when the median misses the threshold', () => {
    expect(choosePresentDecimation({
      displayMs: 1000 / 59.9,
      probeMedianMs: 18.2,
      thresholdMs: threshold,
    })).toEqual({ n: 2, label: 'locked30' });
  });

  it('locks 60 (N=2) on a 120 Hz panel when the median fits one 60 Hz present', () => {
    expect(choosePresentDecimation({
      displayMs: 1000 / 120,
      probeMedianMs: 12,
      thresholdMs: threshold,
    })).toEqual({ n: 2, label: 'locked60' });
    expect(choosePresentDecimation({
      displayMs: 1000 / 120,
      probeMedianMs: 20,
      thresholdMs: threshold,
    })).toEqual({ n: 4, label: 'locked30' });
  });
});

describe('present cadence verdict', () => {
  it('labels N=1 on 60 Hz as locked60 and N=2 as locked30', () => {
    expect(rateLabelFor(1, 1000 / 59.9)).toBe('locked60');
    expect(rateLabelFor(2, 1000 / 59.9)).toBe('locked30');
    expect(rateLabelFor(1, 1000 / 120)).toBe('native');
    expect(rateLabelFor(2, 1000 / 120)).toBe('locked60');
  });

  it('does not call a 60 Hz main rAF locked-60 when decimation presents at 30', () => {
    expect(presentLocked60(59.9, 1)).toBe(true);
    expect(presentLocked60(59.9, 2)).toBe(false);
    expect(presentLocked60(120, 2)).toBe(true);
    expect(presentLocked60(120, 4)).toBe(false);
    expect(presentLocked60(0, 1)).toBe(false);
  });
});

describe('countCadenceMisses', () => {
  it('ignores one 366 ms outlier in an otherwise steady 60 Hz window', () => {
    const frames = Array.from({ length: 59 }, () => 16.7);
    frames.push(366.6);
    expect(countCadenceMisses(frames, 1000 / 60)).toEqual({
      samples: 59, misses: 0, outliers: 1,
    });
  });

  it('counts intervals that miss 1.5× the vsync interval', () => {
    const frames = Array.from({ length: 52 }, () => 16.7);
    for (let i = 0; i < 8; i++) frames.push(33.4);
    const c = countCadenceMisses(frames, 1000 / 60);
    expect(c.samples).toBe(60);
    expect(c.misses).toBe(8);
    expect(c.outliers).toBe(0);
  });

  it('scores ~33 ms rAF ticks as misses so N=2 cannot look clean', () => {
    // The ring is rAF-to-rAF. Budgeting missAt = vsync × N treated
    // these as on-time (33 < 1.5 × 33.3) and nextTeslaDecimation
    // stepped back up to the probe choice.
    const late = Array.from({ length: 60 }, () => 33.3);
    const lateStats = countCadenceMisses(late, 1000 / 60);
    expect(lateStats.samples).toBe(60);
    expect(lateStats.misses).toBe(60);
    const held = nextTeslaDecimation(
      2, 1000 / 60, lateStats, { consecutiveClean: 7 }, { minN: 1 },
    );
    expect(held.step).toBe(false);
    expect(held.n).toBe(2);
    expect(held.consecutiveClean).toBe(0);

    const steady = Array.from({ length: 60 }, () => 16.7);
    const steadyStats = countCadenceMisses(steady, 1000 / 60);
    expect(steadyStats.misses).toBe(0);
    const up = nextTeslaDecimation(
      2, 1000 / 60, steadyStats, { consecutiveClean: 7 }, { minN: 1 },
    );
    expect(up.step).toBe(true);
    expect(up.direction).toBe('up');
    expect(up.n).toBe(1);
  });
});

describe('sharpRatioStillFits', () => {
  it('keeps 1.50 when 10.10 ms at 1.25 still estimates under 16 ms', () => {
    expect(sharpRatioStillFits(10.10, 1.25, 1.5, 16)).toBe(true);
  });

  it('keeps the lower ratio when the sharp estimate misses the threshold', () => {
    expect(sharpRatioStillFits(14, 1.25, 1.5, 16)).toBe(false);
  });
});

describe('nextTeslaDecimation', () => {
  const steady = { samples: 60, misses: 0 };
  const overloaded = { samples: 60, misses: 8 };

  it('does not step down on a short window or a single outlier', () => {
    const early = nextTeslaDecimation(1, 1000 / 60, { samples: 12, misses: 1 }, {});
    expect(early.step).toBe(false);
    expect(early.n).toBe(1);
    const one = nextTeslaDecimation(1, 1000 / 60, steady, {});
    expect(one.step).toBe(false);
  });

  it('steps to 30 only after several windows of sustained misses', () => {
    let state = {};
    let result = { n: 1, step: false };
    for (let i = 0; i < 3; i++) {
      result = nextTeslaDecimation(1, 1000 / 60, overloaded, state);
      state = result;
      expect(result.step).toBe(false);
    }
    result = nextTeslaDecimation(1, 1000 / 60, overloaded, state);
    expect(result.step).toBe(true);
    expect(result.direction).toBe('down');
    expect(result.n).toBe(2);
  });

  it('steps back up to the probe choice after a clean run', () => {
    let state = {};
    let result = { n: 2, step: false };
    for (let i = 0; i < 7; i++) {
      result = nextTeslaDecimation(2, 1000 / 60, steady, state, { minN: 1 });
      state = result;
      expect(result.step).toBe(false);
    }
    result = nextTeslaDecimation(2, 1000 / 60, steady, state, { minN: 1 });
    expect(result.step).toBe(true);
    expect(result.direction).toBe('up');
    expect(result.n).toBe(1);
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

describe('frameHeadroom', () => {
  const display = 1000 / 60;

  it('is full until cost reaches 55 % of a vsync and empty at 92 %', () => {
    expect(frameHeadroom(0, display)).toBe(1);
    expect(frameHeadroom(display * 0.55, display)).toBe(1);
    expect(frameHeadroom(display * 0.92, display)).toBe(0);
    expect(frameHeadroom(display, display)).toBe(0);
    expect(frameHeadroom(5, 0)).toBe(1);
  });

  it('is halfway between the two knees', () => {
    const mid = display * (0.55 + 0.92) / 2;
    expect(frameHeadroom(mid, display)).toBeCloseTo(0.5);
  });
});

describe('detail reach governor', () => {
  const display = 1000 / 60;

  it('never pulls the reach inside the near radius', () => {
    expect(detailReachForHeadroom(0)).toBe(LOD_NEAR_RADIUS);
    expect(detailReachForHeadroom(1)).toBe(LOD_FAR_RADIUS);
    expect(detailReachForHeadroom(0.5)).toBeCloseTo((LOD_NEAR_RADIUS + LOD_FAR_RADIUS) / 2);
  });

  it('stays open while headroom is healthy and tightens before a miss', () => {
    const open = stepDetailGovernor(
      { mode: 'open', reach: LOD_FAR_RADIUS, headroom: 1 },
      display * 0.5, display, 0.5, true);
    expect(open.mode).toBe('open');
    expect(open.reach).toBeCloseTo(LOD_FAR_RADIUS);

    const tight = stepDetailGovernor(
      { mode: 'open', reach: LOD_FAR_RADIUS, headroom: 1 },
      display, display, 0.5, true);
    expect(tight.mode).toBe('tight');
    expect(tight.reach).toBeLessThan(LOD_FAR_RADIUS);
    expect(tight.reach).toBeGreaterThanOrEqual(LOD_NEAR_RADIUS);
  });

  it('holds a tight reach across the hysteresis band and while idle', () => {
    const held = stepDetailGovernor(
      { mode: 'tight', reach: 12, headroom: 0.2 },
      display * 0.75, display, 0.5, true);
    expect(held.mode).toBe('tight');

    const idle = stepDetailGovernor(
      { mode: 'tight', reach: 12, headroom: 0.2 },
      0, display, 1, false);
    expect(idle.mode).toBe('tight');
    expect(idle.reach).toBe(12);
  });

  it('does not reopen past the load-time cap', () => {
    const capped = stepDetailGovernor(
      { mode: 'tight', reach: 8, headroom: 0 },
      display * 0.4, display, 2, true, 8);
    expect(capped.mode).toBe('open');
    expect(capped.reach).toBeLessThanOrEqual(8);
    expect(capped.reach).toBeGreaterThanOrEqual(LOD_NEAR_RADIUS);
  });

  it('ignores a tightened probe that did not get cheaper', () => {
    expect(estimateDetailGpuMs(20, 19, 0.4, 0.3)).toBe(0);
    expect(estimateDetailGpuMs(20, 10, 1, 0.25)).toBeCloseTo(20);
    expect(estimateDetailGpuMs(20, 10, 0.25, 0.25)).toBeCloseTo(10);
  });
});
