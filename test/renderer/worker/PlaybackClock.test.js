import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneConfig } from '../../../src/rendering/SceneConfig.js';
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
    SceneConfig.audioOutputDelayMs = 0;
    SceneConfig.audioVisualOffsetMs = 0;
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

  it('snaps visual time back by the speaker delay when playback starts', () => {
    SceneConfig.audioOutputDelayMs = 307;
    const clock = new PlaybackClock();
    clock.set('playing', 1, 1);
    expect(clock.musicTimeAt()).toBeCloseTo(1 - 0.307, 3);
    expect(clock.appliedOffsetMs()).toBeCloseTo(-307, 3);
    expect(clock.outputDelayMs()).toBeCloseTo(307, 3);
  });

  it('scales the speaker delay by tempo and adds the user offset', () => {
    SceneConfig.audioOutputDelayMs = 300;
    SceneConfig.audioVisualOffsetMs = 40;
    const clock = new PlaybackClock();
    clock.set('playing', 0, 2);
    // 300 ms of audio at 2× is 600 ms of score, then the user nudge.
    expect(clock.musicTimeAt()).toBeCloseTo(-0.6 + 0.04, 3);
    expect(clock.appliedOffsetMs()).toBeCloseTo(-560, 3);
  });

  it('eases a later latency update instead of jumping the playhead', () => {
    SceneConfig.audioOutputDelayMs = 264;
    const clock = new PlaybackClock();
    clock.set('playing', 2, 1);
    const start = clock.musicTimeAt();
    expect(start).toBeCloseTo(2 - 0.264, 3);

    SceneConfig.audioOutputDelayMs = 464;
    performance._advance(16);
    const stepped = clock.musicTimeAt();
    // One 16 ms frame must not swallow a 200 ms estimate change.
    expect(stepped - start).toBeGreaterThan(0.010);
    expect(stepped - start).toBeLessThan(0.030);

    for (let i = 0; i < 90; i++) {
      performance._advance(16);
      clock.musicTimeAt();
    }
    expect(clock.outputDelayMs()).toBeGreaterThan(450);
    expect(clock.musicTimeAt()).toBeCloseTo(2 - 0.464 + (16 * 91) / 1000, 2);
  });
});

