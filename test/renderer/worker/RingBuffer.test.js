import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../../src/renderer/worker/RingBuffer.js';

describe('RingBuffer', () => {
  it('tracks filled count up to capacity', () => {
    const r = new RingBuffer(4);
    expect(r.length).toBe(4);
    expect(r.filled).toBe(0);
    r.push(1); r.push(2);
    expect(r.filled).toBe(2);
    r.push(3); r.push(4); r.push(5);
    expect(r.filled).toBe(4);
  });

  it('wraps around and returns latest in reverse-chronological order', () => {
    const r = new RingBuffer(3);
    for (const v of [1, 2, 3, 4, 5]) r.push(v);
    const scratch = new Float64Array(3);
    const latest = r.latest(3, scratch);
    expect(Array.from(latest)).toEqual([5, 4, 3]);
  });

  it('latest() clamps n to filled', () => {
    const r = new RingBuffer(8);
    r.push(10); r.push(20);
    const scratch = new Float64Array(8);
    expect(Array.from(r.latest(5, scratch))).toEqual([20, 10]);
  });

  it('computes percentile on a partial fill', () => {
    const r = new RingBuffer(120);
    for (const v of [30, 10, 20]) r.push(v);
    const scratch = new Float64Array(120);
    // sorted: [10, 20, 30]; index = min(2, floor(3 * q))
    expect(r.percentile(0.5, 3, scratch)).toBe(20);
    expect(r.percentile(0.95, 3, scratch)).toBe(30);
    expect(r.percentile(0, 3, scratch)).toBe(10);
  });

  it('percentile defaults to the whole filled window', () => {
    const r = new RingBuffer(4);
    for (const v of [4, 1, 3, 2]) r.push(v);
    const scratch = new Float64Array(4);
    expect(r.percentile(0.95, undefined, scratch)).toBe(4);
  });

  it('computes mean and max over the most recent n', () => {
    const r = new RingBuffer(8);
    for (const v of [1, 2, 3, 4]) r.push(v);
    expect(r.mean(2)).toBe(3.5);
    expect(r.max(3)).toBe(4);
    expect(r.mean(0)).toBe(0);
  });

  it('reset() clears the window', () => {
    const r = new RingBuffer(4);
    r.push(1); r.push(2);
    r.reset();
    expect(r.filled).toBe(0);
    r.push(9);
    const scratch = new Float64Array(4);
    expect(Array.from(r.latest(4, scratch))).toEqual([9]);
  });

  it('forEach visits every filled slot', () => {
    const r = new RingBuffer(3);
    for (const v of [7, 8, 9, 10]) r.push(v);
    const seen = [];
    r.forEach((v) => seen.push(v));
    expect(seen.sort((a, b) => a - b)).toEqual([8, 9, 10]);
  });
});
