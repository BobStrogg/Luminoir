import { Soundfont } from 'smplr';
import { parseMIDI, GM_INSTRUMENTS } from './midiParse.js';

/**
 * MIDI playback via Web Audio API with SoundFont-based instruments.
 * Parses Verovio's base64 MIDI output, detects instrument program changes,
 * loads the appropriate SoundFont instruments from a CDN, and schedules
 * notes using real sampled sounds.
 */
export class MIDIPlayer {
  /** @type {AudioContext|null} */
  _ctx = null;
  /** @type {Array<MIDINoteEvent>} */
  _noteEvents = [];
  /** @type {Map<number, number>} channel → GM program number */
  _channelPrograms = new Map();
  /** @type {Map<string, Soundfont>} instrument name → loaded Soundfont */
  _instruments = new Map();
  /**
   * StopFns returned by smplr's `inst.start()`.  Each one cancels its queued
   * scheduler event *and* stops any voices that have already started.  We
   * must call these on pause/stop — smplr's `inst.stop()` alone only affects
   * already-active voices, leaving future-scheduled notes in the queue.
   * @type {Array<(time?: number) => void>}
   */
  _scheduledStopFns = [];

  _startTime = 0;    // AudioContext.currentTime when play() was called
  _pauseOffset = 0;  // accumulated offset when paused
  _isPlaying = false;
  _duration = 0;
  _tempoScale = 1;

  /**
   * iOS Safari won't produce audio from an AudioContext until the page
   * has *actually played a sample* inside a user-gesture handler —
   * calling `resume()` alone is not enough (the context reports
   * `running` but output stays muted).  `_primeAudio()` queues a
   * single silent sample on the destination inside the gesture so
   * iOS flips its "audio allowed" bit; once set, subsequent plays on
   * the same context work normally.
   *
   * Desktop Safari / Chrome / Firefox ignore this, but it's harmless
   * there too: a 1-sample silent buffer ≈ 21 µs at 48 kHz.
   */
  _primed = false;

  /**
   * Hidden `<audio>` element used as a second-layer iOS unlock
   * primitive.  On iOS 17+, even after the AudioContext is resumed
   * inside a user gesture, Safari sometimes still routes Web Audio
   * to a muted output sink until the page has played media through
   * the *native* HTMLMediaElement path.  Triggering `.play()` on a
   * silent `<audio>` element from the gesture handler activates that
   * second layer; subsequent Web Audio output then routes through
   * the same unlocked pipeline.  Created lazily on first
   * `warmUpAudio` / `play` call.
   * @type {HTMLAudioElement | null}
   */
  _audioUnlockElement = null;

  /** @type {(() => void)|null} */
  onPlaybackComplete = null;

  get isPlaying() {
    return this._isPlaying;
  }

  get currentTime() {
    if (!this._ctx || !this._isPlaying) return this._pauseOffset;
    return (this._ctx.currentTime - this._startTime) * this._tempoScale + this._pauseOffset;
  }

  get duration() {
    return this._duration;
  }

  /**
   * Load MIDI from Verovio's base64 string.
   *
   * AudioContext creation is deliberately deferred to `play()` because
   * Safari on iOS refuses to produce any audio from an AudioContext
   * that was instantiated outside a user-gesture handler.  Here, we
   * only decode the MIDI bytes and cache the event list; the
   * AudioContext, Soundfont instruments, and `.resume()` call all
   * happen inside `play()`, which is invoked from a button click.
   *
   * The trade-off is a small first-play latency (AudioContext startup
   * + soundfont download).  Subsequent plays are instant because the
   * context and samples are already cached.
   *
   * @param {string} base64Midi
   */
  async loadMIDI(base64Midi) {
    // Decode base64 → ArrayBuffer
    const binary = atob(base64Midi);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const { noteEvents, channelPrograms } = parseMIDI(bytes.buffer);
    this._noteEvents = noteEvents;
    this._channelPrograms = channelPrograms;
    this._duration =
      noteEvents.length > 0
        ? Math.max(...noteEvents.map((e) => e.time + e.duration))
        : 0;
    this._pauseOffset = 0;

    // NOTE: soundfont loading is deferred to `play()` (which runs in a
    // user-gesture context) because the Soundfont constructor requires
    // an AudioContext.  On desktop this means a ~200 ms delay on the
    // first Play click; on iOS it is the *only* way to get audio at
    // all.  If we want eager loading for already-unlocked contexts we
    // can call _ensureInstruments() from the first touchstart/click
    // listener instead.
    this._instrumentsReady = null;
  }

  /**
   * Set the playback-speed multiplier on top of the score's native
   * tempo map.  1.0 = score-native tempo (parsed from the MIDI tempo
   * meta-events / `<sound tempo="…"/>` in the source MusicXML); 0.5
   * = half speed; 2.0 = double speed.
   *
   * Mid-playback changes are handled cleanly: we capture the music
   * time at the old scale, re-anchor `_startTime` and `_pauseOffset`
   * to that instant, then re-schedule the note tail under the new
   * scale.  The audible result is a smooth tempo change without
   * any "music jumps backward" or "double-trigger" artefacts.
   *
   * @param {number} scale
   */
  setPlaybackSpeed(scale) {
    const newScale = Math.max(0.05, Number.isFinite(scale) ? scale : 1);
    if (newScale === this._tempoScale) return;
    if (this._isPlaying && this._ctx) {
      // Snapshot music time under the old scale, then reset the
      // anchors so `currentTime` reads the same value under the new.
      const t = this.currentTime;
      this._pauseOffset = t;
      this._startTime = this._ctx.currentTime;
      this._tempoScale = newScale;
      this._scheduleNotes();
    } else {
      this._tempoScale = newScale;
    }
  }

  /** Current playback-speed multiplier (1.0 == score-native tempo).
   *  Exposed so the render worker can use it in its local music-time
   *  clock without round-tripping through MIDIPlayer every frame. */
  get tempoScale() {
    return this._tempoScale;
  }

  async play() {
    if (this._isPlaying) return;

    // Create / unlock the AudioContext within the user-gesture
    // handler.  iOS Safari gates every AudioContext on this — if the
    // context was `new`'d before the first tap it will stay in a
    // "running" state that produces no audible output.
    //
    // **Critical sequencing for iOS 17+**: every audio-unlock
    // primitive must be invoked *synchronously* from inside the
    // gesture handler.  In particular we must NOT `await
    // ctx.resume()` here — `await` yields control back to the event
    // loop, which iOS treats as "the user gesture has ended", and
    // anything we try to do with the context afterwards is treated
    // as non-user-initiated audio (i.e. muted).  Instead we kick the
    // resume off as a fire-and-forget promise and let it complete in
    // the background.  By the time the user actually hears audio,
    // the context will have transitioned to `running`.
    if (!this._ctx) this._ctx = new AudioContext();
    this._setPlaybackAudioSession();
    this._primeAudio();
    this._unlockHtmlAudio();
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => { /* iOS may throw */ });
    }

    // Lazily kick off the soundfont load on first play — subsequent
    // plays re-use the cached `_instruments` Map and this is a no-op.
    if (!this._instrumentsReady) {
      this._instrumentsReady = this._loadInstruments();
    }

    // Wait for every SoundFont sample to finish downloading + decoding
    // before we schedule anything.  Previously we scheduled immediately
    // and then re-scheduled when samples arrived — the first fraction
    // of a second of playback was silent (or stuttered) while samples
    // loaded.  On complex scores that silence can stretch for seconds,
    // which the user reads as "the music stuttered at the start".
    try { await this._instrumentsReady; } catch { /* handled below */ }

    // Initialise start time BEFORE flipping _isPlaying so currentTime
    // doesn't briefly return a stale (uninitialised) offset.
    this._startTime = this._ctx.currentTime;
    this._isPlaying = true;

    // Samples are now guaranteed to be ready, so a single schedule
    // pass is enough — no more re-scheduling dance.
    this._scheduleNotes();
  }

  /**
   * Hook for the first user interaction on the page — safe to call
   * multiple times, noop if we already have an unlocked context.
   * Lets the UI eagerly prepare audio so the first click on Play
   * isn't blocked on a round-trip soundfont download.
   */
  warmUpAudio() {
    if (!this._ctx) this._ctx = new AudioContext();
    // Same gesture-window discipline as `play()`: every unlock
    // primitive is synchronous, the resume promise is fire-and-
    // forget.  Do NOT add an `await` to this method.
    this._setPlaybackAudioSession();
    this._primeAudio();
    this._unlockHtmlAudio();
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => { /* iOS may throw */ });
    }
    if (!this._instrumentsReady && this._channelPrograms) {
      this._instrumentsReady = this._loadInstruments();
    }
  }

  /**
   * Play one silent sample on the destination to satisfy iOS Safari's
   * "user gesture must produce audio" requirement.  Idempotent — only
   * runs once per context.  Safe to call before `resume()`: iOS
   * queues the source until the context starts and then plays it,
   * which is exactly the signal iOS needs.
   *
   * The buffer is created at the **context's native sample rate**
   * rather than a hardcoded 22050 — iOS Safari runs at 48 kHz by
   * default, and a 22 kHz buffer triggers an internal resample step
   * that on some iOS versions silently drops the source rather than
   * playing it.
   */
  /**
   * Request the "playback" audio session type so iOS routes Web Audio
   * output through the media pipeline that ignores the hardware
   * ringer/silent switch.  Without this, audio only plays when the
   * ringer is on (the default "ambient" category respects the switch).
   *
   * The `navigator.audioSession` API is a WebKit extension available
   * on Safari 17.4+; other browsers silently ignore this.  Must be
   * called from inside a user-gesture handler, same as the other
   * unlock primitives.
   */
  _setPlaybackAudioSession() {
    try {
      if (navigator.audioSession) {
        navigator.audioSession.type = 'playback';
      }
    } catch {
      // Non-fatal — falls back to ambient (ringer-dependent) behaviour.
    }
  }

  _primeAudio() {
    if (!this._ctx || this._primed) return;
    try {
      const buf = this._ctx.createBuffer(1, 1, this._ctx.sampleRate);
      const src = this._ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this._ctx.destination);
      src.start(0);
      this._primed = true;
    } catch {
      // createBuffer can throw on very old browsers or when the
      // context is already closed.  Nothing we can do here — the
      // user will just hear silence, same as before this primer.
    }
  }

  /**
   * Trigger `.play()` on a hidden, silent `<audio>` element to
   * complete the second layer of iOS audio unlock.  iOS 17+ Safari
   * keeps Web Audio output gated until the page has produced sound
   * through the native HTMLMediaElement path *at least once*; just
   * resuming the AudioContext + queuing a silent buffer is no longer
   * sufficient.  Calling this from inside a user-gesture handler
   * flips the second gate; subsequent Web Audio output then plays
   * normally.
   *
   * The `play()` returns a promise we don't await for the same
   * reason `_ctx.resume()` isn't awaited — yielding out of the
   * gesture handler can invalidate the unlock.  The
   * `.catch(() => {})` swallows the autoplay rejection that fires on
   * the very first call before the gesture validates (the *next*
   * tap will succeed, by which point we're already past this
   * function and the unlock has taken effect).
   *
   * Idempotent: only the very first invocation actually creates the
   * element; subsequent calls just re-trigger `.play()` to keep the
   * unlock fresh after pause/resume cycles.
   */
  _unlockHtmlAudio() {
    if (!this._audioUnlockElement) {
      const el = document.createElement('audio');
      // Tiny silent WAV (44 B header + 0 data) as a data URL.
      // Decoded: RIFF + WAVE + fmt sub-chunk + data sub-chunk with
      // length 0; a valid playable but silent file.
      el.src = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAAAAAA=';
      // Volume must stay > 0 — iOS treats volume-0 media as
      // ambient audio (silenced by the ringer switch).  The data URL
      // is a silent WAV so full volume produces no audible output,
      // but iOS still registers it as an active media playback
      // session, switching the audio category from "ambient" to
      // "playback" which ignores the ringer/silent switch.
      el.volume = 1;
      // Don't add to DOM — keeping it detached avoids any layout
      // impact and the play() call still satisfies iOS's HTMLMedia
      // gate.
      this._audioUnlockElement = el;
    }
    try {
      const p = this._audioUnlockElement.play();
      // play() returns a Promise on modern browsers; older Safari
      // returns undefined.  Handle both without awaiting.
      if (p && typeof p.catch === 'function') p.catch(() => { /* ignored */ });
    } catch {
      // Some browsers throw synchronously instead of returning a
      // rejected promise — same result, swallow it.
    }
  }

  pause() {
    if (!this._isPlaying) return;
    this._pauseOffset = this.currentTime;
    this._isPlaying = false;
    this._stopAllNotes();
  }

  stop() {
    this._isPlaying = false;
    this._pauseOffset = 0;
    this._stopAllNotes();
  }

  /**
   * Re-schedule the remaining note tail from the current playback
   * position.  Called when the page regains visibility after being
   * backgrounded — Chrome and Safari may suspend or throttle the
   * AudioContext while the tab is hidden, causing pre-scheduled
   * AudioBufferSourceNodes to be dropped or to fire in a burst.
   * A fresh schedule pass from "now" corrects any drift.
   *
   * Also resumes a suspended AudioContext if the browser paused it.
   */
  reschedule() {
    if (!this._isPlaying || !this._ctx) return;
    // Capture where we are in music time.
    const t = this.currentTime;
    // Resume the AudioContext if the browser suspended it while
    // the tab was hidden.
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {});
    }
    // Re-anchor and re-schedule from the current position.
    this._pauseOffset = t;
    this._startTime = this._ctx.currentTime;
    this._scheduleNotes();
  }

  /**
   * Poll-style completion check driven by the main render loop.  We
   * previously ran a second rAF loop inside the MIDI player which
   * duplicated frame pacing work (and allocations); folding this into
   * the scene's rAF loop means every frame has a single rAF callback.
   * Returns true on the frame where playback passes its duration.
   */
  checkComplete() {
    if (!this._isPlaying) return false;
    if (this.currentTime < this._duration) return false;
    this.stop();
    if (this.onPlaybackComplete) this.onPlaybackComplete();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /*  SoundFont instrument loading                                       */
  /* ------------------------------------------------------------------ */

  async _loadInstruments() {
    // smplr's Soundfont constructor immediately calls AudioContext.decodeAudioData
    // to decode the downloaded samples.  On Safari (both desktop and iOS) with a
    // remote origin (e.g. GitHub Pages), the AudioContext starts in 'suspended'
    // state and decodeAudioData on a suspended context silently produces empty
    // buffers — the instruments appear to load successfully but play silence.
    //
    // We must wait until the context has transitioned to 'running' (i.e. the
    // resume() promise from play() has resolved) before creating Soundfonts.
    // This is safe: resume() was already fired fire-and-forget inside the
    // gesture handler — we're just waiting for Safari to honour it before
    // handing the context to smplr.
    await this._waitForContextRunning();

    // Collect unique program numbers used across channels
    const programs = new Set(this._channelPrograms.values());
    if (programs.size === 0) programs.add(0); // default to piano

    const loadPromises = [];
    for (const prog of programs) {
      const name = GM_INSTRUMENTS[prog] || GM_INSTRUMENTS[0];
      if (!this._instruments.has(name)) {
        try {
          const inst = new Soundfont(this._ctx, { instrument: name });
          this._instruments.set(name, inst);
          loadPromises.push(inst.load);
        } catch (err) {
          console.warn(`[Luminoir] Failed to create instrument ${name}:`, err);
        }
      }
    }

    // Wait for all instruments to load (with a timeout so we don't block forever)
    try {
      await Promise.all(loadPromises);
    } catch (err) {
      console.warn('[Luminoir] Some instruments failed to load:', err);
    }
  }

  /**
   * Wait until the AudioContext transitions to 'running'.  Safari on remote
   * origins (GitHub Pages etc.) starts the context in 'suspended' and the
   * resume() promise can take up to ~100 ms to resolve.  Polling via
   * statechange event is the cleanest approach; a 2 s timeout prevents
   * hanging forever if the browser refuses the unlock.
   */
  _waitForContextRunning() {
    if (!this._ctx || this._ctx.state === 'running') return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 2000); // give up after 2 s
      const onStateChange = () => {
        if (this._ctx.state === 'running') {
          clearTimeout(timeout);
          this._ctx.removeEventListener('statechange', onStateChange);
          resolve();
        }
      };
      this._ctx.addEventListener('statechange', onStateChange);
    });
  }

  /** Resolve the loaded instrument for a given MIDI channel */
  _getInstrumentForChannel(channel) {
    // Channel 9 is always percussion in GM — skip (not supported by Soundfont)
    if (channel === 9) return null;
    const prog = this._channelPrograms.get(channel) ?? 0;
    const name = GM_INSTRUMENTS[prog] || GM_INSTRUMENTS[0];
    return this._instruments.get(name) || null;
  }

  /* ------------------------------------------------------------------ */
  /*  Scheduling                                                         */
  /* ------------------------------------------------------------------ */

  _scheduleNotes() {
    this._stopAllNotes();
    const now = this._ctx.currentTime;
    const offset = this._pauseOffset;
    const scale = 1 / this._tempoScale;

    for (const evt of this._noteEvents) {
      const noteStart = evt.time;
      if (noteStart < offset - 0.01) continue; // already past

      const when = now + (noteStart - offset) * scale;
      const dur = evt.duration * scale;

      const inst = this._getInstrumentForChannel(evt.channel);
      if (inst) {
        const stopFn = inst.start({
          note: evt.midi,
          velocity: evt.velocity,
          time: when,
          duration: dur,
        });
        if (typeof stopFn === 'function') this._scheduledStopFns.push(stopFn);
      }
    }
  }

  _stopAllNotes() {
    // Call every per-note stopFn — this cancels queued (future-scheduled)
    // events *and* stops any currently playing voices.  Plain `inst.stop()`
    // only stops already-active voices, leaving queued ones intact.
    for (const fn of this._scheduledStopFns) {
      try { fn(); } catch { /* ignore */ }
    }
    this._scheduledStopFns = [];
    // Defensive: also clear anything already playing on every instrument.
    for (const inst of this._instruments.values()) {
      try { inst.stop(); } catch { /* ignore */ }
    }
  }


  dispose() {
    this.stop();
    for (const inst of this._instruments.values()) {
      try { inst.stop(); } catch { /* ignore */ }
    }
    this._instruments.clear();
    if (this._ctx) {
      this._ctx.close();
      this._ctx = null;
    }
    if (this._audioUnlockElement) {
      try { this._audioUnlockElement.pause(); } catch { /* ignore */ }
      this._audioUnlockElement.src = '';
      this._audioUnlockElement = null;
    }
    // Reset the primer flag so a re-init (e.g. after a reload) will
    // queue a fresh silent buffer the next time the user taps.
    this._primed = false;
  }
}
