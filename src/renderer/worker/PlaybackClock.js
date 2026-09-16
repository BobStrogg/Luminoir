import { SceneConfig } from '../../rendering/SceneConfig.js';

/**
 * Playback clock anchor.  Main thread sends state changes; the worker
 * computes current music time locally from its own performance.now().
 */
export class PlaybackClock {
  /** @type {'stopped' | 'playing' | 'paused'} */
  state = 'stopped';
  musicAnchor = 0;
  perfAnchor = 0;
  tempoScale = 1;

  get playing() { return this.state === 'playing'; }

  /**
   * Main thread calls this on every state change (play / pause / stop /
   * setTempo).  We record the music time at this instant and our own
   * perf-clock reference so later frames can compute the current music
   * time locally without any main-thread round-trip.
   */
  set(state, musicTime, tempoScale) {
    this.state = state;
    this.musicAnchor = musicTime;
    this.perfAnchor = performance.now();
    this.tempoScale = tempoScale ?? 1;
  }

  /**
   * `audioVisualOffsetMs` is added unconditionally to the music time
   * the visual side reads each frame.  Anchored on `SceneConfig` so a
   * settings-panel slider can move it live; the rAF loop calls into
   * here every frame, so a new value lights up on the very next
   * tick.  See the property's JSDoc in `SceneConfig.js` for sign
   * convention (+N = visuals lead audio by N ms).
   */
  musicTimeAt(frameNow = performance.now()) {
    const offsetSec = (SceneConfig.audioVisualOffsetMs || 0) / 1000;
    if (this.state === 'playing') {
      const elapsed = (frameNow - this.perfAnchor) / 1000;
      return this.musicAnchor + elapsed * this.tempoScale + offsetSec;
    }
    return this.musicAnchor + offsetSec;
  }
}
