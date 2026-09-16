import { describe, it, expect } from 'vitest';
import { tokenizePathD, parseSimpleLineD, parsePathDToShapePath } from '../../src/rendering/pathD.js';

describe('tokenizePathD', () => {
  it('splits commands and numbers', () => {
    expect(tokenizePathD('M 1 2 L 3 4')).toEqual(['M', 1, 2, 'L', 3, 4]);
  });

  it('handles scientific notation', () => {
    expect(tokenizePathD('M1e-3 2E+2')).toEqual(['M', 1e-3, 2e2]);
  });

  it('handles a glued minus sign (M10-5)', () => {
    expect(tokenizePathD('M10-5')).toEqual(['M', 10, -5]);
  });

  it('handles comma separators', () => {
    expect(tokenizePathD('M10,20L30,40')).toEqual(['M', 10, 20, 'L', 30, 40]);
  });
});

describe('parseSimpleLineD', () => {
  it('detects M x y L x y', () => {
    expect(parseSimpleLineD('M 1 2 L 3 4')).toEqual({ x1: 1, y1: 2, x2: 3, y2: 4 });
  });

  it('accepts a trailing Z', () => {
    expect(parseSimpleLineD('M 1 2 L 3 4 Z')).toEqual({ x1: 1, y1: 2, x2: 3, y2: 4 });
  });

  it('resolves relative l against the start point', () => {
    expect(parseSimpleLineD('M 1 2 l 3 4')).toEqual({ x1: 1, y1: 2, x2: 4, y2: 6 });
  });

  it('rejects curves', () => {
    expect(parseSimpleLineD('M 1 2 C 3 4 5 6 7 8')).toBeNull();
    expect(parseSimpleLineD('M 1 2 Q 3 4 5 6')).toBeNull();
  });

  it('rejects H and V', () => {
    expect(parseSimpleLineD('M 1 2 H 3')).toBeNull();
    expect(parseSimpleLineD('M 1 2 V 3')).toBeNull();
  });

  it('rejects more than 7 tokens', () => {
    expect(parseSimpleLineD('M 1 2 L 3 4 L 5 6')).toBeNull();
  });

  it('rejects non-strings and non-M paths', () => {
    expect(parseSimpleLineD(null)).toBeNull();
    expect(parseSimpleLineD('L 1 2')).toBeNull();
  });
});

describe('parsePathDToShapePath', () => {
  it('produces a sub-path with expected points for M/L/Z', () => {
    const sp = parsePathDToShapePath('M 0 0 L 10 0 L 10 10 Z');
    expect(sp.subPaths).toHaveLength(1);
    const pts = sp.subPaths[0].getPoints();
    // closePath() adds the closing point back to the start
    expect(pts.length).toBe(4);
    expect(pts[0].x).toBe(0);
    expect(pts[2].x).toBe(10);
    expect(pts[2].y).toBe(10);
  });

  it('produces points for a cubic curve', () => {
    const sp = parsePathDToShapePath('M 0 0 C 10 0 10 10 20 10');
    expect(sp.subPaths).toHaveLength(1);
    const pts = sp.subPaths[0].getPoints();
    expect(pts.length).toBeGreaterThan(2);
    const last = pts[pts.length - 1];
    expect(last.x).toBeCloseTo(20);
    expect(last.y).toBeCloseTo(10);
  });
});
