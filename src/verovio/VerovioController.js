import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';

/**
 * Wraps the Verovio WASM toolkit for MusicXML → SVG + MIDI + timemap.
 * Continuous-scroll configuration: a single super-wide page so the
 * downstream 3D builder gets one long horizontal layout instead of
 * a paginated one.
 */
export class VerovioController {
  /** @type {VerovioToolkit|null} */
  toolkit = null;
  totalWidth = 0;
  totalHeight = 0;

  async init() {
    const Module = await createVerovioModule();
    this.toolkit = new VerovioToolkit(Module);

    this.toolkit.setOptions({
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
  }

  /**
   * Load a MusicXML string into the toolkit.
   * @param {string} musicXML
   * @returns {boolean}
   */
  loadData(musicXML) {
    if (!this.toolkit) throw new Error('Verovio not initialised');
    const ok = this.toolkit.loadData(musicXML);
    // Dimensions are extracted from the rendered SVG (no getPageWidth API in v4)
    return ok;
  }

  /**
   * Load a compressed MusicXML (.mxl) ArrayBuffer into the toolkit.
   * @param {ArrayBuffer} buffer
   * @returns {boolean}
   */
  loadZipData(buffer) {
    if (!this.toolkit) throw new Error('Verovio not initialised');
    return this.toolkit.loadZipDataBuffer(buffer);
  }

  /** Render current page to SVG string */
  renderToSVG() {
    if (!this.toolkit) throw new Error('Verovio not initialised');
    return this.toolkit.renderToSVG(1);
  }

  /** Get MIDI as base64-encoded string */
  renderToMIDI() {
    if (!this.toolkit) throw new Error('Verovio not initialised');
    return this.toolkit.renderToMIDI();
  }

  /**
   * Get the timemap for synchronisation (onset → element ID mapping).
   * @returns {Array<{tstamp: number, on?: string[], off?: string[], tempo?: number}>}
   */
  getTimemap() {
    if (!this.toolkit) throw new Error('Verovio not initialised');
    const result = this.toolkit.renderToTimemap();
    // v4 returns an array directly; earlier versions returned a JSON string
    if (typeof result === 'string') return JSON.parse(result);
    return result;
  }

  /** Number of measures in the loaded score */
  getMeasureCount() {
    if (!this.toolkit) return 0;
    // Verovio exposes measure count via MEI element count
    return this.toolkit.getPageCount(); // rough proxy; 1 page in continuous mode
  }
}
