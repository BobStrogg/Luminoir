import { describe, it, expect } from 'vitest';
import { computeBounds, computeStaffBounds } from '../../src/verovio/sceneBounds.js';

describe('computeBounds', () => {
  it('covers a note glyph and a staff line', () => {
    const out = {
      notes: [{
        x: 1, y: 0,
        glyphPath: 'M 0 0 L 10 0 L 10 20 L 0 20 Z', // 10×20 path
      }],
      staffLines: [{ isLine: true, x1: 0, y1: -0.5, x2: 5, y2: -0.5 }],
      barLines: [],
      otherElements: [],
    };
    const b = computeBounds(out);
    const gws = 0.001 * 0.48; // SceneConfig.scale × glyphUseScale
    expect(b.minX).toBe(0);                       // staff line x1
    expect(b.minY).toBe(-0.5);                    // staff line y
    expect(b.maxX).toBeCloseTo(5);                // staff line x2 (past note)
    expect(b.maxY).toBeCloseTo(20 * gws);         // note glyph top at y=0
  });

  it('falls back to a unit box when empty', () => {
    const b = computeBounds({ notes: [], staffLines: [], barLines: [], otherElements: [] });
    expect(b).toEqual({ minX: 0, maxX: 1, minY: 0, maxY: 1 });
  });
});

describe('computeStaffBounds', () => {
  it('uses non-ledger staff lines only', () => {
    const out = {
      staffLines: [
        { isLine: true, y1: 0, y2: 0 },
        { isLine: true, y1: -1, y2: -1 },
        { isLine: true, y1: -9, y2: -9, isLedger: true },
      ],
    };
    const b = computeStaffBounds(out);
    expect(b).toEqual({ minY: -1, maxY: 0 });
  });

  it('returns nulls when there are no staff lines', () => {
    expect(computeStaffBounds({ staffLines: [] })).toEqual({ minY: null, maxY: null });
  });
});
