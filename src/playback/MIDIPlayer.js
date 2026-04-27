import { Soundfont } from 'smplr';

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

    const { noteEvents, channelPrograms } = this._parseMIDI(bytes.buffer);
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

  /* ------------------------------------------------------------------ */
  /*  Minimal MIDI parser (Standard MIDI File format 0/1)                */
  /* ------------------------------------------------------------------ */

  /**
   * Parse a MIDI ArrayBuffer into note events and program changes.
   * Handles format 0 and format 1 (merges all tracks).
   * For format 1, extracts the tempo map from track 0 first and applies it
   * to all tracks so that timing is consistent across the entire file.
   * @returns {{ noteEvents: Array<MIDINoteEvent>, channelPrograms: Map<number, number> }}
   */
  _parseMIDI(buffer) {
    const view = new DataView(buffer);
    let pos = 0;

    const readUint32 = () => {
      const v = view.getUint32(pos);
      pos += 4;
      return v;
    };
    const readUint16 = () => {
      const v = view.getUint16(pos);
      pos += 2;
      return v;
    };
    const readVarLen = () => {
      let value = 0;
      let byte;
      do {
        byte = view.getUint8(pos++);
        value = (value << 7) | (byte & 0x7f);
      } while (byte & 0x80);
      return value;
    };

    // Header chunk
    const headerTag = readUint32();
    if (headerTag !== 0x4d546864) return { noteEvents: [], channelPrograms: new Map() }; // "MThd"
    const headerLen = readUint32();
    const format = readUint16();
    const numTracks = readUint16();
    const division = readUint16();
    pos = 8 + headerLen;

    const ticksPerBeat = division & 0x7fff;
    if (ticksPerBeat === 0) return { noteEvents: [], channelPrograms: new Map() };

    // --- First pass: extract global tempo map from all tracks ---
    const tempoMap = [];
    let scanPos = pos;
    for (let t = 0; t < numTracks; t++) {
      if (scanPos + 8 > buffer.byteLength) break;
      const tag = view.getUint32(scanPos);
      scanPos += 4;
      if (tag !== 0x4d54726b) break; // "MTrk"
      const trackLen = view.getUint32(scanPos);
      scanPos += 4;
      const trackEnd = scanPos + trackLen;

      let scanTick = 0;
      let scanRunning = 0;
      while (scanPos < trackEnd) {
        let delta = 0;
        let b;
        do {
          b = view.getUint8(scanPos++);
          delta = (delta << 7) | (b & 0x7f);
        } while (b & 0x80);
        scanTick += delta;

        let status = view.getUint8(scanPos);
        if (status & 0x80) {
          scanRunning = status;
          scanPos++;
        } else {
          status = scanRunning;
        }

        const type = status & 0xf0;
        if (type === 0x90 || type === 0x80 || type === 0xa0 || type === 0xb0 || type === 0xe0) {
          scanPos += 2;
        } else if (type === 0xc0 || type === 0xd0) {
          scanPos += 1;
        } else if (status === 0xff) {
          const metaType = view.getUint8(scanPos++);
          let metaLen = 0;
          do {
            b = view.getUint8(scanPos++);
            metaLen = (metaLen << 7) | (b & 0x7f);
          } while (b & 0x80);
          if (metaType === 0x51 && metaLen === 3) {
            const uspb =
              (view.getUint8(scanPos) << 16) |
              (view.getUint8(scanPos + 1) << 8) |
              view.getUint8(scanPos + 2);
            tempoMap.push({ tick: scanTick, microsecondsPerBeat: uspb });
          }
          scanPos += metaLen;
        } else if (status === 0xf0 || status === 0xf7) {
          let sysLen = 0;
          do {
            b = view.getUint8(scanPos++);
            sysLen = (sysLen << 7) | (b & 0x7f);
          } while (b & 0x80);
          scanPos += sysLen;
        } else {
          break;
        }
      }
      scanPos = trackEnd;
    }

    tempoMap.sort((a, b) => a.tick - b.tick);
    if (tempoMap.length === 0 || tempoMap[0].tick > 0) {
      tempoMap.unshift({ tick: 0, microsecondsPerBeat: 500000 }); // 120 BPM default
    }

    const tickToSeconds = (tick) => {
      let seconds = 0;
      let prevTick = 0;
      let tickToSec = tempoMap[0].microsecondsPerBeat / 1e6 / ticksPerBeat;
      for (const entry of tempoMap) {
        if (entry.tick >= tick) break;
        if (entry.tick > prevTick) {
          seconds += (entry.tick - prevTick) * tickToSec;
        }
        prevTick = entry.tick;
        tickToSec = entry.microsecondsPerBeat / 1e6 / ticksPerBeat;
      }
      seconds += (tick - prevTick) * tickToSec;
      return seconds;
    };

    // --- Second pass: extract note events + program changes ---
    const allEvents = [];
    const channelPrograms = new Map();
    pos = 8 + headerLen;

    for (let t = 0; t < numTracks; t++) {
      const trackTag = readUint32();
      if (trackTag !== 0x4d54726b) break; // "MTrk"
      const trackLen = readUint32();
      const trackEnd = pos + trackLen;

      let tick = 0;
      let runningStatus = 0;
      const pending = new Map();

      while (pos < trackEnd) {
        const delta = readVarLen();
        tick += delta;
        const timeInSeconds = tickToSeconds(tick);

        let status = view.getUint8(pos);
        if (status & 0x80) {
          runningStatus = status;
          pos++;
        } else {
          status = runningStatus;
        }

        const type = status & 0xf0;
        const channel = status & 0x0f;

        if (type === 0x90) {
          // Note On
          const note = view.getUint8(pos++);
          const vel = view.getUint8(pos++);
          if (vel > 0) {
            pending.set(note + channel * 128, { time: timeInSeconds, velocity: vel });
          } else {
            const on = pending.get(note + channel * 128);
            if (on) {
              allEvents.push({
                midi: note,
                time: on.time,
                duration: Math.max(0.05, timeInSeconds - on.time),
                velocity: on.velocity,
                channel,
              });
              pending.delete(note + channel * 128);
            }
          }
        } else if (type === 0x80) {
          // Note Off
          const note = view.getUint8(pos++);
          pos++; // velocity (unused)
          const on = pending.get(note + channel * 128);
          if (on) {
            allEvents.push({
              midi: note,
              time: on.time,
              duration: Math.max(0.05, timeInSeconds - on.time),
              velocity: on.velocity,
              channel,
            });
            pending.delete(note + channel * 128);
          }
        } else if (type === 0xc0) {
          // Program Change — capture channel → instrument mapping
          const program = view.getUint8(pos++);
          channelPrograms.set(channel, program);
        } else if (type === 0xd0) {
          pos += 1; // channel pressure — one data byte
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
          pos += 2; // two data bytes
        } else if (status === 0xff) {
          // Meta event
          const metaType = view.getUint8(pos++);
          const metaLen = readVarLen();
          pos += metaLen;
        } else if (status === 0xf0 || status === 0xf7) {
          // SysEx
          const sysLen = readVarLen();
          pos += sysLen;
        } else {
          break;
        }
      }

      pos = trackEnd;
    }

    allEvents.sort((a, b) => a.time - b.time);
    return { noteEvents: allEvents, channelPrograms };
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

/* ------------------------------------------------------------------ */
/*  General MIDI instrument name table                                 */
/* ------------------------------------------------------------------ */

/** @type {string[]} 128 GM instrument names matching MIDI.js SoundFont naming */
const GM_INSTRUMENTS = [
  // Piano (0–7)
  'acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano',
  'honkytonk_piano', 'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet',
  // Chromatic Percussion (8–15)
  'celesta', 'glockenspiel', 'music_box', 'vibraphone',
  'marimba', 'xylophone', 'tubular_bells', 'dulcimer',
  // Organ (16–23)
  'drawbar_organ', 'percussive_organ', 'rock_organ', 'church_organ',
  'reed_organ', 'accordion', 'harmonica', 'tango_accordion',
  // Guitar (24–31)
  'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_jazz',
  'electric_guitar_clean', 'electric_guitar_muted', 'overdriven_guitar',
  'distortion_guitar', 'guitar_harmonics',
  // Bass (32–39)
  'acoustic_bass', 'electric_bass_finger', 'electric_bass_pick', 'fretless_bass',
  'slap_bass_1', 'slap_bass_2', 'synth_bass_1', 'synth_bass_2',
  // Strings (40–47)
  'violin', 'viola', 'cello', 'contrabass',
  'tremolo_strings', 'pizzicato_strings', 'orchestral_harp', 'timpani',
  // Ensemble (48–55)
  'string_ensemble_1', 'string_ensemble_2', 'synth_strings_1', 'synth_strings_2',
  'choir_aahs', 'voice_oohs', 'synth_choir', 'orchestra_hit',
  // Brass (56–63)
  'trumpet', 'trombone', 'tuba', 'muted_trumpet',
  'french_horn', 'brass_section', 'synth_brass_1', 'synth_brass_2',
  // Reed (64–71)
  'soprano_sax', 'alto_sax', 'tenor_sax', 'baritone_sax',
  'oboe', 'english_horn', 'bassoon', 'clarinet',
  // Pipe (72–79)
  'piccolo', 'flute', 'recorder', 'pan_flute',
  'blown_bottle', 'shakuhachi', 'whistle', 'ocarina',
  // Synth Lead (80–87)
  'lead_1_square', 'lead_2_sawtooth', 'lead_3_calliope', 'lead_4_chiff',
  'lead_5_charang', 'lead_6_voice', 'lead_7_fifths', 'lead_8_bass_lead',
  // Synth Pad (88–95)
  'pad_1_new_age', 'pad_2_warm', 'pad_3_polysynth', 'pad_4_choir',
  'pad_5_bowed', 'pad_6_metallic', 'pad_7_halo', 'pad_8_sweep',
  // Synth Effects (96–103)
  'fx_1_rain', 'fx_2_soundtrack', 'fx_3_crystal', 'fx_4_atmosphere',
  'fx_5_brightness', 'fx_6_goblins', 'fx_7_echoes', 'fx_8_scifi',
  // Ethnic (104–111)
  'sitar', 'banjo', 'shamisen', 'koto',
  'kalimba', 'bagpipe', 'fiddle', 'shanai',
  // Percussive (112–119)
  'tinkle_bell', 'agogo', 'steel_drums', 'woodblock',
  'taiko_drum', 'melodic_tom', 'synth_drum', 'reverse_cymbal',
  // Sound Effects (120–127)
  'guitar_fret_noise', 'breath_noise', 'seashore', 'bird_tweet',
  'telephone_ring', 'helicopter', 'applause', 'gunshot',
];
