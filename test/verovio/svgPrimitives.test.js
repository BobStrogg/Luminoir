import { describe, it, expect } from 'vitest';
import {
  polygonToLineOrPath,
  polylineToPath,
  ellipseToPath,
  rectToPath,
} from '../../src/verovio/svgPrimitives.js';

const noTx = { rawX: 0, rawY: 0 };
const SCALE = 0.01;

describe('ellipseToPath', () => {
  it('produces 4 cubic segments and a close', () => {
    const e = ellipseToPath(100, 50, 10, 5, noTx, SCALE);
    expect(e.d.match(/C /g)).toHaveLength(4);
    expect(e.d.endsWith('Z')).toBe(true);
    expect(e.d.startsWith('M -10 0')).toBe(true);
    // Placement is the ellipse centre in world coords.
    expect(e.x).toBeCloseTo(1);
    expect(e.y).toBeCloseTo(-0.5);
  });

  it('returns null for degenerate radii', () => {
    expect(ellipseToPath(0, 0, 0, 5, noTx, SCALE)).toBeNull();
    expect(ellipseToPath(0, 0, 5, -1, noTx, SCALE)).toBeNull();
  });
});

describe('polygonToLineOrPath', () => {
  it('8-token polygon → centre-line + thickness', () => {
    // Parallelogram: left edge from (0,0) to (0,10), right edge
    // (20,5) to (20,15) — a sloping beam.
    const pts = '0 0 20 5 20 15 0 10';
    const e = polygonToLineOrPath(pts, noTx, SCALE, { x: 0, y: 0 });
    expect(e.isLine).toBe(true);
    // Left-edge midpoint (0,5), right-edge midpoint (20,10), flipped Y.
    expect(e.x1).toBeCloseTo(0);
    expect(e.y1).toBeCloseTo(-0.05);
    expect(e.x2).toBeCloseTo(0.2);
    expect(e.y2).toBeCloseTo(-0.1);
    expect(e.thickness).toBeCloseTo(Math.hypot(0, 10) * SCALE);
  });

  it('non-quad polygon falls back to a closed path-d at fallbackPos', () => {
    const pts = '0 0 10 0 5 8';
    const e = polygonToLineOrPath(pts, noTx, SCALE, { x: 7, y: -3 });
    expect(e.isLine).toBeUndefined();
    expect(e.d).toBe('M 0 0 L 10 0 L 5 8 Z');
    expect(e.x).toBe(7);
    expect(e.y).toBe(-3);
  });

  it('returns null when points are missing or too few', () => {
    expect(polygonToLineOrPath(null, noTx, SCALE, { x: 0, y: 0 })).toBeNull();
    expect(polygonToLineOrPath('1 2', noTx, SCALE, { x: 0, y: 0 })).toBeNull();
  });
});

describe('polylineToPath', () => {
  it('anchors the path at the first point', () => {
    const e = polylineToPath('100 50 120 60 140 40', noTx, SCALE);
    expect(e.d).toBe('M 0 0 L 20 10 L 40 -10');
    expect(e.x).toBeCloseTo(1);
    expect(e.y).toBeCloseTo(-0.5);
  });

  it('returns null for too few points', () => {
    expect(polylineToPath('5 5', noTx, SCALE)).toBeNull();
    expect(polylineToPath(null, noTx, SCALE)).toBeNull();
  });
});

describe('rectToPath', () => {
  it('produces a unit-square-relative closed path', () => {
    const e = rectToPath(10, 20, 60, 12, noTx, SCALE);
    expect(e.d).toBe('M 0 0 L 60 0 L 60 12 L 0 12 Z');
    expect(e.x).toBeCloseTo(0.1);
    expect(e.y).toBeCloseTo(-0.2);
  });

  it('returns null for degenerate size', () => {
    expect(rectToPath(0, 0, 0, 5, noTx, SCALE)).toBeNull();
  });
});
