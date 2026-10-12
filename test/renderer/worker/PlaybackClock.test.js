import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlaybackClock } from '../../../src/renderer/worker/PlaybackClock.js';

describe('PlaybackClock transport speed', () => {
  const realNow = performance.now.bind(performance);
  beforeEach(() => {
    let t = 1000.0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    // helper to advance ms
    // @ts-ignore
    performance._advance = (ms) => { t += ms; };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advances 1.0s per 1.0s wall time at tempoScale 1.0', () => {
    const clock = new PlaybackClock();
    clock.set('playing', 0, 1.0);
    // @ts-ignore
    performance._advance(2000); // 2s
    const mt = clock.musicTimeAt();
    expect(mt).toBeGreaterThanOrEqual(1.999);
    expect(mt).toBeLessThanOrEqual(2.001);
  });

  it('advances 2.0s per 1.0s wall time at tempoScale 2.0', () => {
    const clock = new PlaybackClock();
    clock.set('playing', 0, 2.0);
    // @ts-ignore
    performance._advance(1000); // 1s
    const mt = clock.musicTimeAt();
    expect(mt).toBeGreaterThanOrEqual(1.999);
    expect(mt).toBeLessThanOrEqual(2.001);
  });

  it('paused holds time constant', () => {
    const clock = new PlaybackClock();
    clock.set('playing', 1.5, 1.0);
    // @ts-ignore
    performance._advance(1000);
    expect(clock.musicTimeAt()).toBeCloseTo(2.5, 3);
    clock.set('paused', clock.musicTimeAt(), 1.0);
    // @ts-ignore
    performance._advance(5000);
    expect(clock.musicTimeAt()).toBeCloseTo(2.5, 3);
  });
});

