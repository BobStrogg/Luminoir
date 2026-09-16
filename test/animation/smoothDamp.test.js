import { describe, it, expect } from 'vitest';
import { smoothDamp } from '../../src/animation/smoothDamp.js';

describe('smoothDamp', () => {
  it('converges to the target', () => {
    const s = { x: 0, v: 0 };
    for (let i = 0; i < 600; i++) smoothDamp(s, 10, 1.0, 1 / 60);
    expect(s.x).toBeCloseTo(10, 3);
    expect(s.v).toBeCloseTo(0, 2);
  });

  it('does not overshoot a step input', () => {
    const s = { x: 0, v: 0 };
    for (let i = 0; i < 600; i++) {
      smoothDamp(s, 5, 1.0, 1 / 60);
      expect(s.x).toBeLessThanOrEqual(5 + 1e-9);
    }
  });

  it('is stable for a 0.1 s dt', () => {
    const s = { x: 0, v: 0 };
    for (let i = 0; i < 200; i++) smoothDamp(s, 3, 0.5, 0.1);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(s.x).toBeCloseTo(3, 2);
  });

  it('mutates and returns the same state object', () => {
    const s = { x: 0, v: 0 };
    expect(smoothDamp(s, 1, 1, 0.016)).toBe(s);
  });
});
