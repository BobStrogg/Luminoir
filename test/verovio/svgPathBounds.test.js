import { describe, it, expect } from 'vitest';
import { pathBBox } from '../../src/verovio/svgPathBounds.js';

describe('pathBBox', () => {
  it('bounds a simple line', () => {
    expect(pathBBox('M 1 2 L 5 8')).toEqual({ minX: 1, maxX: 5, minY: 2, maxY: 8 });
  });

  it('bounds relative commands in absolute space', () => {
    expect(pathBBox('m 1 2 l 4 6')).toEqual({ minX: 1, maxX: 5, minY: 2, maxY: 8 });
  });

  it('cubic bbox is tighter than the control-point hull (slur case)', () => {
    // Control points at y=100 but the curve apex only reaches 75.
    const bb = pathBBox('M 0 0 C 0 100 100 100 100 0');
    expect(bb.minX).toBe(0);
    expect(bb.maxX).toBe(100);
    expect(bb.minY).toBe(0);
    expect(bb.maxY).toBeCloseTo(75, 6);
    expect(bb.maxY).toBeLessThan(100);
  });

  it('solves the quadratic extremum analytically', () => {
    // Q apex at t=0.5 is 0.5 * control = 50, not 100.
    const bb = pathBBox('M 0 0 Q 50 100 100 0');
    expect(bb.maxY).toBeCloseTo(50, 6);
  });

  it('returns null for empty input', () => {
    expect(pathBBox('')).toBeNull();
    expect(pathBBox(null)).toBeNull();
  });
});
