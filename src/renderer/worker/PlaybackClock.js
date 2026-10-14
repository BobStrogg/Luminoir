import { smoothDamp } from '../../animation/smoothDamp.js';
import { OUTPUT_DELAY_SMOOTH_SEC } from '../../playback/audioUtils.js';
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
  /** Smoothed speaker delay, seconds of AudioContext time. */
  _delay = { x: 0, v: 0 };
  _delayAt = 0;
  /** Snap the delay when playback starts so the first frame is already aligned. */
  _snapDelay = false;

  get playing() { return this.state === 'playing'; }

  /**
   * Main thread calls this on every state change (play / pause / stop /
   * setTempo).  We record the music time at this instant and our own
   * perf-clock reference so later frames can compute the current music
   * time locally without any main-thread round-trip.
   */
  set(state, musicTime, tempoScale) {
    const entering = state === 'playing' && this.state !== 'playing';
    this.state = state;
    this.musicAnchor = musicTime;
    this.perfAnchor = performance.now();
    this.tempoScale = tempoScale ?? 1;
    // The first playing frame snaps to the delay carried on this
    // clock message. Later estimates ease, so a 264→280 ms update
    // cannot yank the camera.
    if (entering) this._snapDelay = true;
  }

  /**
   * Ease the applied speaker delay toward `audioOutputDelayMs`.
   * Stopped and paused clocks snap: nothing is chasing the playhead.
   * @param {number} frameNow
   */
  _syncDelay(frameNow) {
    const raw = Number(SceneConfig.audioOutputDelayMs);
    const target = Math.max(0, Number.isFinite(raw) ? raw : 0) / 1000;
    const dt = this._delayAt > 0 ? (frameNow - this._delayAt) / 1000 : 0;
    this._delayAt = frameNow;
    if (this._snapDelay || this.state !== 'playing') {
      this._delay.x = target;
      this._delay.v = 0;
      this._snapDelay = false;
      return;
    }
    const step = Math.min(Math.max(dt, 0), 0.05);
    if (step > 0) smoothDamp(this._delay, target, OUTPUT_DELAY_SMOOTH_SEC, step);
  }

  /** Smoothed speaker delay in milliseconds of audio time. */
  outputDelayMs() {
    return this._delay.x * 1000;
  }

  /**
   * Net milliseconds added to audio music time. The user nudge is
   * music time; the speaker delay is audio time scaled by tempo so
   * a 300 ms output delay at 2× is 600 ms of score.
   */
  appliedOffsetMs() {
    const user = Number(SceneConfig.audioVisualOffsetMs);
    const userMs = Number.isFinite(user) ? user : 0;
    const tempo = this.tempoScale > 0 ? this.tempoScale : 1;
    return userMs - this._delay.x * 1000 * tempo;
  }

  /**
   * Visual music time. `audioVisualOffsetMs` is the user nudge
   * (+N moves visuals earlier). The smoothed output delay is
   * subtracted so the playhead matches the sample at the speaker.
   */
  musicTimeAt(frameNow = performance.now()) {
    this._syncDelay(frameNow);
    const shift = this.appliedOffsetMs() / 1000;
    if (this.state === 'playing') {
      const elapsed = (frameNow - this.perfAnchor) / 1000;
      return this.musicAnchor + elapsed * this.tempoScale + shift;
    }
    return this.musicAnchor + shift;
  }
}
