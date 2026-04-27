/**
 * Main-thread wrapper for `scoreWorker.js`.
 *
 * Mirrors the slim public surface of the old `VerovioController` (init,
 * loadData, loadZipData, …) but every method is async because the
 * actual Verovio render happens off-thread.  The wrapper keeps a
 * `Map` of pending promises keyed by message id so multiple
 * in-flight requests resolve to the right caller.
 *
 * **Why ScoreClient and not just call postMessage directly?**
 *   • Hides the message protocol from `LuminoirApp` — callers see a
 *     normal promise-returning API.
 *   • Gives one place to plug in error handling, logging,
 *     cancellation, timeouts later if the load gets even slower.
 */
export class ScoreClient {
  /** @type {Worker | null} */
  _worker = null;
  /** Map<requestId, { resolve, reject }>  */
  _pending = new Map();
  _idCounter = 0;
  _readyPromise = null;

  /**
   * Spin up the score worker and wait for Verovio's WASM module to
   * finish loading inside it.  Resolves when the worker is ready to
   * receive a `loadXML` / `loadMXL` request — typically ~150–250 ms
   * after construction (one-off cost; subsequent score loads don't
   * pay it again).
   */
  async init() {
    if (this._readyPromise) return this._readyPromise;
    this._worker = new Worker(new URL('./scoreWorker.js', import.meta.url), {
      type: 'module',
    });
    this._worker.onmessage = (e) => this._onMessage(e.data);
    this._worker.onerror = (err) => {
      console.error('[ScoreClient] worker error:', err);
      // Reject any in-flight requests so the UI can recover instead of
      // hanging forever.
      for (const { reject } of this._pending.values()) {
        reject(new Error(err.message || 'score worker crashed'));
      }
      this._pending.clear();
    };
    this._readyPromise = this._send('init');
    return this._readyPromise;
  }

  /**
   * Load a MusicXML string and return `{ svg, midi, timemap }`.
   * The worker caches the SVG so a subsequent `reparse()` skips the
   * Verovio render entirely.
   */
  async loadXML(xml) {
    return this._send('loadXML', { payload: xml });
  }

  /**
   * Load a compressed `.mxl` `ArrayBuffer`.  We transfer the buffer
   * (instead of copying it) so a 1–2 MB Sylvia-Suite zip doesn't pay
   * a structured-clone tax on the way into the worker.  The buffer
   * is consumed by Verovio inside the worker; the main thread
   * shouldn't read it after this call returns.
   */
  async loadMXL(buffer) {
    return this._send('loadMXL', { payload: buffer }, [buffer]);
  }

  /**
   * Return the worker-cached SVG / MIDI / timemap without re-running
   * Verovio.  Used by the settings panel when a notation toggle
   * changes — the parser then re-runs on the main thread with the
   * new `notation.hiddenClasses` set.
   */
  async reparse() {
    return this._send('reparse');
  }

  dispose() {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
    this._pending.clear();
    this._readyPromise = null;
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                          */
  /* ------------------------------------------------------------------ */

  _send(type, body = {}, transfer = []) {
    const id = ++this._idCounter;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ type, id, ...body }, transfer);
    });
  }

  _onMessage(msg) {
    const handler = this._pending.get(msg.id);
    if (!handler) return;
    this._pending.delete(msg.id);
    if (msg.type === 'loadError') {
      handler.reject(new Error(msg.error || 'score worker error'));
    } else {
      handler.resolve(msg);
    }
  }
}
