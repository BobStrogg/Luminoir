import { ScoreClient } from './verovio/ScoreClient.js';
import { SVGSceneParser } from './verovio/SVGSceneParser.js';
import { unrollRepeats } from './verovio/RepeatUnroller.js';
import { RenderClient } from './renderer/RenderClient.js';
import { MIDIPlayer } from './playback/MIDIPlayer.js';
import { DemoScores } from './data/DemoScores.js';
import { SceneConfig } from './rendering/SceneConfig.js';

/**
 * Main application controller.
 *
 * Orchestrates the moving parts of Luminoir:
 *   - ScoreClient (spawns a score Web Worker): hosts Verovio's WASM
 *     toolkit so the 200–500 ms `renderToSVG()` doesn't freeze the
 *     main thread on each score change.  Returns SVG / MIDI /
 *     timemap; the SVG parser still runs on the main thread because
 *     `DOMParser` isn't exposed in worker globals.
 *   - SVGSceneParser (main): SVG text → JSON scene graph (uses
 *     DOMParser, hence main-thread).  Internally co-operative: the
 *     walker yields to the event loop every ~8 ms so pointer / wheel
 *     events keep flushing to the render worker while the parse runs,
 *     and the compositor-driven spinner keeps animating.
 *   - MIDIPlayer (main): audio via smplr + Web Audio (must stay on
 *     main, AudioContext requires it).
 *   - RenderClient (spawns a render Web Worker): all Three.js
 *     rendering + per-frame animation, isolated from main-thread GC.
 *
 * The main thread is effectively idle during playback — no rAF, no
 * per-frame work.  The only postMessages we send during play are
 * state changes (play / pause / stop / tempo), so the worker can
 * derive its own music time locally.
 */
export class LuminoirApp {
  /** @type {ScoreClient} */
  scoreClient = new ScoreClient();
  /** @type {SVGSceneParser} */
  parser = new SVGSceneParser();
  /** @type {RenderClient} */
  render = new RenderClient();
  /** @type {MIDIPlayer} */
  midiPlayer = new MIDIPlayer();

  _isPlaying = false;
  _timemap = [];
  _noteTimeline = []; // { time, x, y, id, staff }
  /** Set to true once a score has been loaded successfully — gates
   *  `reloadCurrentScore` so the settings panel doesn't try to
   *  reparse before the user has picked anything. */
  _hasScoreLoaded = false;
  /**
   * Title / composer for the currently-loading or currently-loaded
   * score.  Set by `loadDemoScore` / `loadFile` before the score
   * worker even sees the bytes; `_consumeScoreResult` reads them
   * to render the title block on the paper and (if it would
   * overlap notation) to compute the matching notation offset.
   */
  _currentTitle = null;
  _currentComposer = null;

  /** Callbacks for UI */
  onStateChange = null; // (isPlaying: boolean) => void
  onTimeUpdate = null;  // (time: number) => void
  onReady = null;       // () => void
  /**
   * Fired right before a score-load (or reparse) starts and right
   * after it finishes.  The controls bar subscribes to these to show
   * / hide the loading indicator and disable the score-select
   * dropdown for the duration.  `onLoadEnd` fires regardless of
   * success or failure so the UI never gets stuck in a loading
   * state.
   */
  onLoadStart = null;   // () => void
  onLoadEnd = null;     // () => void

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {(msg: string) => void} setStatus – loading status callback
   */
  async init(canvas, setStatus) {
    setStatus('Loading music engine...');
    await this.scoreClient.init();

    setStatus('Initialising 3D renderer...');
    await this.render.init(canvas);

    // Apply any persisted playback-speed value before the first score
    // loads.  SettingsPanel hydrates SceneConfig from localStorage in
    // its constructor (which runs before `init()` in main.js), so by
    // this point SceneConfig.playbackSpeed reflects the user's saved
    // preference.  Without this seed the MIDI player would default to
    // tempoScale=1 and the saved speed would only take effect on the
    // user's next slider move.
    if (typeof SceneConfig.playbackSpeed === 'number') {
      this.midiPlayer.setPlaybackSpeed(SceneConfig.playbackSpeed);
    }

    // Audio-playback-finished hook: fold into stop() so UI + worker
    // both learn about it.
    this.midiPlayer.onPlaybackComplete = () => this.stop();

    // Lightweight main-thread ticker that polls the MIDI player for
    // end-of-playback + feeds the optional UI time callback.  All the
    // heavy animation / rendering happens in the worker, but we still
    // need a place to notice "playback reached the end".
    this._startMainTicker();

    // iOS Safari refuses to produce audio from any AudioContext that
    // wasn't instantiated inside a user-gesture handler, so we defer
    // creation until the first tap anywhere on the page.  MIDIPlayer
    // is written so `play()` and `warmUpAudio()` both work correctly
    // as that first gesture; this listener just covers the case where
    // the user taps the canvas (to pan/zoom) before pressing Play.
    const unlockAudio = () => {
      this.midiPlayer.warmUpAudio?.();
      window.removeEventListener('touchstart', unlockAudio);
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
    window.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    setStatus('Loading demo score...');
    await this.loadDemoScore('albatross');

    if (this.onReady) this.onReady();
  }

  /* ------------------------------------------------------------------ */
  /*  Score loading                                                      */
  /* ------------------------------------------------------------------ */

  async loadDemoScore(name) {
    const entry = DemoScores[name];
    if (!entry) {
      console.warn(`[Luminoir] Unknown demo score: ${name}`);
      return;
    }
    this._currentTitle = entry.title || null;
    this._currentComposer = entry.composer || null;
    // Fetch compressed MusicXML from `public/scores/` (first time)
    // and hand the ArrayBuffer to the worker.  Browser HTTP cache
    // handles subsequent picks of the same score.
    try {
      const response = await fetch(entry.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      await this._loadMXL(buffer);
    } catch (err) {
      console.error(`[Luminoir] Failed to load ${entry.url}:`, err);
    }
  }

  async loadFile(file) {
    // Imported file: take the filename minus extension as the title,
    // leave the composer blank.  Users can rename their file before
    // import if they want richer metadata on the paper.
    this._currentTitle = (file.name || 'Imported file').replace(/\.[^.]+$/, '');
    this._currentComposer = null;
    const isMXL = file.name.toLowerCase().endsWith('.mxl');
    if (isMXL) {
      const buffer = await file.arrayBuffer();
      await this._loadMXL(buffer);
    } else {
      const text = await file.text();
      await this._loadMusicXML(text);
    }
  }

  async _loadMXL(buffer) {
    this.stop();
    if (this.onLoadStart) this.onLoadStart();
    try {
      const result = await this.scoreClient.loadMXL(buffer);
      await this._consumeScoreResult(result);
    } catch (err) {
      console.error('[Luminoir] Failed to load compressed MusicXML:', err);
    } finally {
      if (this.onLoadEnd) this.onLoadEnd();
    }
  }

  async _loadMusicXML(xml) {
    this.stop();
    if (this.onLoadStart) this.onLoadStart();
    try {
      const result = await this.scoreClient.loadXML(xml);
      await this._consumeScoreResult(result);
    } catch (err) {
      console.error('[Luminoir] Failed to load MusicXML:', err);
    } finally {
      if (this.onLoadEnd) this.onLoadEnd();
    }
  }

  /**
   * Re-parse the score worker's cached SVG with the current
   * `SceneConfig` values.  Used by the settings panel after a
   * reparse-required change (toggling a notation class).  Cheap on
   * the order of 50–200 ms because Verovio is skipped inside the
   * worker — the slow part of a fresh load.  No-op if a score
   * hasn't been loaded yet.
   */
  async reloadCurrentScore() {
    if (!this._hasScoreLoaded) return;
    this.stop();
    if (this.onLoadStart) this.onLoadStart();
    try {
      const result = await this.scoreClient.reparse();
      await this._consumeScoreResult(result);
    } catch (err) {
      console.error('[Luminoir] Reparse failed:', err);
    } finally {
      if (this.onLoadEnd) this.onLoadEnd();
    }
  }

  /**
   * Consume the payload returned by the score worker — parse the
   * SVG, unroll repeats, push the parsed scene + timeline to the
   * render worker, and load the MIDI for playback.  This runs on the
   * main thread because `DOMParser` isn't available in
   * `DedicatedWorkerGlobalScope`; it's the only main-thread step on
   * the score-load critical path that's measurable on a real piano
   * score (the parser is 100–300 ms, the rest sub-30 ms).
   *
   * The leading `setTimeout(0)` yield is deliberate — it gives the
   * browser one repaint cycle BEFORE the parse blocks, so the
   * loading spinner that just appeared in `onLoadStart` actually
   * paints.  Without it, the worker's `loaded` message and the
   * synchronous parse run inside the same microtask and the user
   * never sees the spinner appear before the freeze.
   */
  async _consumeScoreResult(result) {
    if (!result || !result.svg) return;
    const { svg, midi, timemap } = result;
    this._timemap = timemap || [];

    // Yield once so the spinner gets a chance to paint before the
    // 100–300 ms parser kicks in.
    await new Promise((res) => setTimeout(res, 0));

    let parsed;
    try {
      parsed = await this.parser.parse(svg);
    } catch (err) {
      console.error('[Luminoir] SVG parsing failed:', err);
      return;
    }

    // Unfold repeats into linear measures.  Verovio's MIDI/timemap
    // already unfolds repeats internally; this brings the rendered
    // geometry along for the ride so a piece like Für Elise's
    // `|: A B C :|` plays as `A B C A B C` left-to-right with no
    // visual playhead jump-back.  No-op for scores without repeats.
    parsed = unrollRepeats(parsed, this._timemap);

    // Title block.  We just stash the title + composer strings on the
    // parsed scene so the worker (which actually rasterises the
    // CanvasTexture) and the paper-margin sizer (which grows the
    // far margin to fit the block) can read them out.  The paper's
    // far margin is sized DYNAMICALLY in `SVG3DBuilder._addPaper`
    // based on the title's measured world-unit height, so the music
    // never has to slide to make room for a long title — the paper
    // just grows upwards instead.  See `TitleBlock.computePaperFarMargin`
    // for the formula.
    parsed.title = this._currentTitle || null;
    parsed.composer = this._currentComposer || null;

    const contentMinY = parsed.contentMinY ?? -1;
    const contentMaxY = contentMinY + (parsed.totalHeight ?? 1);

    // Arm the render-worker readiness listener BEFORE we send the
    // buildScene message, so we can't miss the `sceneReady` ack on
    // a very fast machine where precompile finishes before the
    // listener is attached.
    const sceneReady = this._whenSceneReady();

    // Push the parsed scene + animation timeline to the render worker.
    this.render.buildScene(parsed);

    this._noteTimeline = this._buildNoteTimeline(parsed, this._timemap);
    const firstNote = this._noteTimeline[0] || null;
    this.render.setTimeline(this._noteTimeline, contentMinY, contentMaxY, firstNote);

    if (midi) {
      await this.midiPlayer.loadMIDI(midi);
    }

    // Fresh score, fresh clock.
    this.render.setClock('stopped', 0, this.midiPlayer.tempoScale);

    // Don't fire onLoadEnd / hide the spinner until the worker
    // confirms the new score's first frame has hit the canvas.  The
    // gap between "buildScene posted" and "first frame on canvas"
    // covers the worker-side mesh build (50-200 ms), shader
    // precompile (50-200 ms), and the first GPU frame — without
    // this wait the spinner would disappear and leave the user
    // looking at empty paper for ≈ 100-300 ms while the GPU caught
    // up.
    await sceneReady;
    this._hasScoreLoaded = true;
  }

  /**
   * Promise that resolves the next time the render worker finishes
   * its scene-build → setTimeline → precompile → first-frame-rendered
   * cycle.  See `RenderClient._onWorkerMessage` for where the
   * `sceneReady` postMessage gets dispatched.
   */
  _whenSceneReady() {
    return new Promise((resolve) => {
      this.render.onSceneReady = () => {
        this.render.onSceneReady = null;
        resolve();
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Playback                                                           */
  /* ------------------------------------------------------------------ */

  async play() {
    if (this._isPlaying) return;
    await this.midiPlayer.play();
    this._isPlaying = true;
    // The worker tracks music time locally from this anchor.
    this.render.setClock('playing', this.midiPlayer.currentTime, this.midiPlayer.tempoScale);
    if (this.onStateChange) this.onStateChange(true);
  }

  pause() {
    if (!this._isPlaying) return;
    this._isPlaying = false;
    const t = this.midiPlayer.currentTime;
    this.midiPlayer.pause();
    this.render.setClock('paused', t, this.midiPlayer.tempoScale);
    if (this.onStateChange) this.onStateChange(false);
  }

  togglePlayPause() {
    if (this._isPlaying) this.pause();
    else this.play();
  }

  stop() {
    this._isPlaying = false;
    this.midiPlayer.stop();
    this.render.setClock('stopped', 0, this.midiPlayer.tempoScale);
    if (this._noteTimeline.length > 0) {
      const first = this._noteTimeline[0];
      this.render.snapCameraTo(first.x, first.y);
    }
    if (this.onStateChange) this.onStateChange(false);
  }

  /**
   * Live playback-speed change from the settings panel.  1.0 =
   * score-native tempo; 0.5 = half speed; 2.0 = double speed.  We
   * route through MIDIPlayer (which re-schedules the note tail) and
   * re-anchor the render worker's clock so the on-screen playhead +
   * camera adopt the new pace at the same instant the audio does.
   *
   * @param {number} scale
   */
  setPlaybackSpeed(scale) {
    this.midiPlayer.setPlaybackSpeed(scale);
    // If we're playing, re-anchor so the worker's clock uses the new scale.
    if (this._isPlaying) {
      this.render.setClock('playing', this.midiPlayer.currentTime, this.midiPlayer.tempoScale);
    }
  }

  get isPlaying() { return this._isPlaying; }

  /* ------------------------------------------------------------------ */
  /*  Main-thread ticker (completion detection + optional UI time)       */
  /* ------------------------------------------------------------------ */

  _startMainTicker() {
    const tick = () => {
      this._tickRAF = requestAnimationFrame(tick);
      if (!this._isPlaying) return;
      const t = this.midiPlayer.currentTime;
      if (this.onTimeUpdate) this.onTimeUpdate(t);
      this.midiPlayer.checkComplete();
    };
    tick();
  }

  /* ------------------------------------------------------------------ */
  /*  Timeline construction                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Build a chronological note timeline by correlating Verovio timemap
   * entries with parsed note positions.
   *
   * **Repeat handling**: Verovio's MIDI export and timemap unfold
   * repeat barlines, so a piece like Für Elise that has `|: ... :|`
   * sections plays through every measure twice in the audio output.
   * The timemap reflects this — the second pass of every repeated
   * note appears with a `-rend2` (rendition 2) suffix on its xml:id
   * (`-rend3` for the third pass of a `:||:` D.C., etc.).  But the
   * **rendered SVG** only contains the original IDs (one notehead
   * per visible note), because that's what's actually drawn on the
   * page.  Without translation, the rendition-suffixed entries fail
   * `posById.get(id)` and silently drop out of the timeline.  The
   * resulting timeline has multi-second gaps during every repeat
   * section, which the worker reads as "no playing notes / camera
   * doesn't advance" — visible to the user as "the light balls
   * suddenly stop while the music keeps going".
   *
   * Stripping the `-rend\d+` suffix maps the rendition-pass entries
   * back onto the original notehead's position.  The light balls
   * (and camera spring) then snap back to the start of the repeat
   * each time the music re-enters the section, which is the
   * expected visual repeat behaviour: same notes light up the same
   * noteheads on every pass.
   */
  _buildNoteTimeline(parsed, timemap) {
    const timeline = [];
    const posById = new Map();
    for (const note of parsed.notes) {
      if (note.id) posById.set(note.id, note);
    }

    // Verovio convention for unfolded repeats: every Nth-rendition
    // copy of an existing note carries the same xml:id with a
    // `-rend{N}` suffix.  The base id (no suffix) is the one in the
    // rendered SVG and therefore in `posById`.
    const RENDITION_SUFFIX = /-rend\d+$/;

    for (const entry of timemap) {
      const timeSec = (entry.tstamp || 0) / 1000;
      const ids = entry.on || [];
      for (const id of ids) {
        let note = posById.get(id);
        if (!note && RENDITION_SUFFIX.test(id)) {
          note = posById.get(id.replace(RENDITION_SUFFIX, ''));
        }
        if (note) {
          timeline.push({
            time: timeSec,
            // `note.x` is the SMuFL <use> x, which places the glyph's
            // local (0, 0) — the left edge of the notehead — at the
            // page position.  Add the parser-supplied `cxOffset` so
            // the light ball lands on the centre of the notehead
            // rather than against its left side.
            x: note.x + (note.cxOffset ?? 0),
            y: note.y,
            id: note.id,
            staff: note.staff,
          });
        }
      }
    }

    // If no timemap correlation succeeded, fall back to equal spacing
    if (timeline.length === 0 && parsed.notes.length > 0) {
      const duration = this.midiPlayer.duration || parsed.notes.length * 0.5;
      const step = duration / parsed.notes.length;
      for (let i = 0; i < parsed.notes.length; i++) {
        const n = parsed.notes[i];
        timeline.push({
          time: i * step,
          x: n.x,
          y: n.y,
          id: n.id || `note_${i}`,
          staff: n.staff,
        });
      }
    }

    timeline.sort((a, b) => a.time - b.time);
    return timeline;
  }

  dispose() {
    if (this._tickRAF) cancelAnimationFrame(this._tickRAF);
    this.render.dispose();
    this.midiPlayer.dispose();
    this.scoreClient.dispose();
  }
}
