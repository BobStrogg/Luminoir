import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';

/**
 * Score-loading worker.
 *
 * Hosts the Verovio WASM toolkit — the heaviest single step on the
 * score-load critical path (200–500 ms `renderToSVG()` on a busy
 * piano score).  Moving it here lets the main thread keep painting
 * (CSS-spinner stays smooth) and stay interactive while Verovio
 * crunches through the MEI tree.
 *
 * **Why isn't the SVG parser also in here?**  `DOMParser` isn't
 * exposed in `DedicatedWorkerGlobalScope` in current Chromium /
 * WebKit, so a worker-side `parseFromString(svgString, 'image/svg+xml')`
 * throws `ReferenceError: DOMParser is not defined` at the top of the
 * call.  The SVG parser stays on the main thread; thanks to its
 * shorter time budget (100–300 ms) and compositor-driven spinner,
 * the user-visible freeze stays under the perception threshold.
 *
 * **Message protocol**
 *
 *   Main → Worker:
 *     • `init`     — wait for the Verovio WASM module to load
 *     • `loadXML`  — load a MusicXML string and produce SVG / MIDI /
 *                    timemap.  Caches the SVG inside the worker so a
 *                    later `reparse` doesn't have to round-trip the
 *                    string again.
 *     • `loadMXL`  — same, from a compressed `.mxl` `ArrayBuffer`
 *     • `reparse`  — return the cached SVG / MIDI / timemap without
 *                    re-running Verovio.  Used by the settings panel
 *                    when only parser-affecting config changes; the
 *                    main thread re-parses the same bytes with the
 *                    new `notation.hiddenClasses` set.
 *
 *   Worker → Main:
 *     • `ready`    — Verovio finished loading
 *     • `loaded`   — `{ svg, midi, timemap }` ready for the parser
 *     • `loadError` — `{ error }`; settings UI never gets stuck
 *
 * Every request carries an `id`; the response with the matching `id`
 * resolves the corresponding promise on the main thread (see
 * `ScoreClient.js`).
 */

/** @type {VerovioToolkit | null} */
let toolkit = null;

/**
 * Cached output of the most recent Verovio render.  `reparse` returns
 * these without re-running Verovio so a settings-panel reparse that
 * only affects parsing (e.g. flipping a class in
 * `notation.hiddenClasses`) skips the 200–500 ms render.
 */
let _cachedSVG = null;
let _cachedMIDI = null;
let _cachedTimemap = null;

self.onmessage = async (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':         return await handleInit(msg);
    case 'loadXML':      return await handleLoad(msg, 'xml');
    case 'loadMXL':      return await handleLoad(msg, 'mxl');
    case 'reparse':      return handleReparse(msg);
    default:
      console.warn('[scoreWorker] unknown message:', msg.type);
  }
};

async function handleInit({ id }) {
  try {
    const Module = await createVerovioModule();
    toolkit = new VerovioToolkit(Module);
    toolkit.setOptions({
      pageWidth: 100000,
      pageHeight: 10000,
      adjustPageWidth: true,
      adjustPageHeight: true,
      breaks: 'none',
      noJustification: true,
      scale: 100,
      spacingStaff: 12,
      spacingSystem: 12,
      unit: 6.0,
      staffLineWidth: 0.3,
      stemWidth: 0.5,
      barLineWidth: 0.8,
      xmlIdSeed: 1,
    });
    self.postMessage({ type: 'ready', id });
  } catch (err) {
    self.postMessage({ type: 'loadError', id, error: String(err && err.message || err) });
  }
}

async function handleLoad({ id, payload }, kind) {
  if (!toolkit) {
    self.postMessage({ type: 'loadError', id, error: 'Music engine not initialised' });
    return;
  }
  try {
    const ok = (kind === 'mxl')
      ? toolkit.loadZipDataBuffer(payload)
      : toolkit.loadData(payload);
    if (!ok) {
      self.postMessage({ type: 'loadError', id, error: 'Music engine failed to load score data' });
      return;
    }
    _cachedSVG = toolkit.renderToSVG(1);
    _cachedMIDI = toolkit.renderToMIDI();
    const tm = toolkit.renderToTimemap();
    _cachedTimemap = (typeof tm === 'string') ? JSON.parse(tm) : tm;

    self.postMessage({
      type: 'loaded',
      id,
      svg: _cachedSVG,
      midi: _cachedMIDI,
      timemap: _cachedTimemap,
    });
  } catch (err) {
    self.postMessage({ type: 'loadError', id, error: String(err && err.message || err) });
  }
}

function handleReparse({ id }) {
  if (!_cachedSVG) {
    self.postMessage({ type: 'loadError', id, error: 'No score cached for reparse' });
    return;
  }
  self.postMessage({
    type: 'loaded',
    id,
    svg: _cachedSVG,
    midi: _cachedMIDI,
    timemap: _cachedTimemap,
  });
}

