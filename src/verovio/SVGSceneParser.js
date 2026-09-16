import { SceneConfig } from '../rendering/SceneConfig.js';
import { pathBBox } from './svgPathBounds.js';
import {
  getTranslate,
  getAncestorTranslate,
  getAncestorRotation,
  parseLineEndpoints,
  getChildPathD,
} from './svgTransforms.js';
import {
  polygonToLineOrPath,
  polylineToPath,
  ellipseToPath,
  rectToPath,
} from './svgPrimitives.js';
import { computeBounds, computeStaffBounds } from './sceneBounds.js';

/**
 * Classified groups that WRAP real notes — the walker must still
 * descend into them (e.g. beamed eighth notes inside
 * `<g class="beam">`).  All other known classes are pure glyphs and
 * terminate the walk.
 */
const CONTAINER_CLASSES = new Set(['beam', 'tuplet']);

/**
 * Verovio class names the walker recognises.  The bottom-row classes
 * are ones Verovio emits for non-notehead notation (augmentation
 * dots, sustain-pedal markers, dynamic hairpins, fermatas,
 * multi-measure rests, arpeggios, system braces, ottava-spans,
 * tuplet brackets/numbers).  Without explicit handling they fell
 * through to the generic recursion step and their underlying
 * `<ellipse>` / `<rect>` / `<polyline>` / `<use>` / `<path>` nodes
 * were silently dropped — visible as missing dotted-quarter dots,
 * missing 8va lines, missing pedal brackets, etc.  See
 * `_collectGlyphs` for the per-shape extraction.
 */
const KNOWN_CLASSES = [
  'clef', 'meterSig', 'keySig', 'beam', 'tie', 'slur',
  'stem', 'flag', 'tuplet', 'accid', 'artic', 'dynam', 'dir',
  'dots', 'pedal', 'hairpin', 'fermata', 'mRest', 'arpeg',
  'grpSym', 'octave', 'tupletBracket', 'tupletNum',
];

/**
 * Parses Verovio SVG output into structured scene data for 3D
 * construction — the SVG tree is traversed once and every relevant
 * node (notes, staff lines, bar lines, dynamics, slurs, …) is
 * classified and emitted as a plain-data record.
 *
 * **Why is this async?**  On a busy orchestral score the parse can
 * take 300+ ms — a clearly visible main-thread freeze that would
 * prevent the user from dragging the camera while a new score loads.
 * Workers can't help (no `DOMParser` in `DedicatedWorkerGlobalScope`),
 * so instead we keep the parser on the main thread but cooperatively
 * yield to the event loop every few ms.  The user sees the spinner
 * keep spinning, and pointer / wheel events get a chance to flush
 * to the render worker between chunks.
 *
 * Verovio SVG structure (simplified):
 *   <svg>
 *     <defs>  … glyph paths keyed by SMuFL codepoint …  </defs>
 *     <g class="page-margin">
 *       <g class="system">
 *         <g class="grpSym"> … brace / bracket paths … </g>
 *         <g class="measure">
 *           <g class="staff">        ← staff 1 (order determines number)
 *             <path … />             ← staff lines (bare paths)
 *             <g class="clef"> …
 *             <g class="layer"> <g class="note"> … </g> </g>
 *           </g>
 *           <g class="staff"> …      ← staff 2
 *           </g>
 *           <g class="barLine"> … </g>
 *         </g>
 *       </g>
 *     </g>
 *   </svg>
 */
export class SVGSceneParser {
  /** Co-operative yield budget.  When more than this many milliseconds
   *  have elapsed since the last yield we `await setTimeout(0)` so
   *  the main thread can process pointer/wheel events that were
   *  queued during the parse.  Half a frame at 60 fps is short
   *  enough that the user never feels a noticeable hitch. */
  static YIELD_BUDGET_MS = 8;

  /**
   * @param {string} svgString – raw SVG markup from Verovio
   * @returns {Promise<ParsedScene>}
   */
  async parse(svgString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const svg = doc.querySelector('svg');

    const scale = SceneConfig.scale;

    // Snapshot hidden-class config at parse time so toggling it in
    // SceneConfig before a re-parse takes effect immediately, but
    // an in-flight parse stays consistent.
    const hidden = SceneConfig.notation && SceneConfig.notation.hiddenClasses;
    this._hiddenClasses = new Set(Array.isArray(hidden) ? hidden : []);

    // Reset the yield clock so the first chunk gets a full budget
    // before it has to pause.
    this._lastYieldAt = performance.now();

    // Collect <defs> glyph paths for <use> resolution
    const defs = {};
    doc.querySelectorAll('defs > *').forEach((el) => {
      const id = el.getAttribute('id');
      if (id) defs[id] = el;
    });

    // Pre-build a map: staff element id → 1-based staff number.
    const staffNumberMap = this._buildStaffNumberMap(doc);

    const notes = [];
    const staffLines = [];
    const barLines = [];
    const otherElements = [];

    const out = { notes, staffLines, barLines, otherElements };
    await this._walkTree(svg, defs, out, scale, staffNumberMap);

    // Sort notes by x position
    notes.sort((a, b) => a.x - b.x);

    // Compute content bounding box from all parsed elements
    const bounds = computeBounds(out);
    const staffBounds = computeStaffBounds(out);

    // IMPORTANT: do not leak DOM nodes (the original `defs` map and
    // `svgDoc` document) into the return value — this object is
    // postMessage'd to the render Web Worker, which requires it to be
    // structured-clone-safe.  All the useful information has already
    // been baked into the plain-data fields below.
    return {
      scale,
      notes,
      staffLines,
      barLines,
      otherElements,
      // Exact content bounding box — do not add padding here.  Any
      // padding around the score belongs in the renderer (see
      // `addPaper`'s `margin` in PaperAndTitle.js); doing it here once
      // led to asymmetric paper padding because `addPaper` derives
      // the paper centre from `(contentMinY + totalHeight / 2)`,
      // and a pre-padded `totalHeight` shifts that midpoint away
      // from the score's actual centre.
      totalWidth: bounds.maxX - bounds.minX,
      totalHeight: bounds.maxY - bounds.minY,
      contentMinX: bounds.minX,
      contentMinY: bounds.minY,
      // Visible-staff Y-bounds (highest top staff line, lowest bottom
      // staff line — ledger lines and other notation are excluded).
      // Retained as score metadata for diagnostics; paper layout uses
      // the exact full-content bounds above.
      staffMaxY: staffBounds.maxY ?? bounds.maxY,
      staffMinY: staffBounds.minY ?? bounds.minY,
    };
  }

  /**
   * Yield control to the event loop if we've spent too long on this
   * chunk.  Cheap when the budget hasn't elapsed (single
   * `performance.now()` call); only the actual `setTimeout(0)` await
   * is expensive (≈ 1–4 ms event-loop tick latency depending on the
   * browser).
   */
  async _maybeYield() {
    const now = performance.now();
    if (now - this._lastYieldAt > SVGSceneParser.YIELD_BUDGET_MS) {
      await new Promise((res) => setTimeout(res, 0));
      this._lastYieldAt = performance.now();
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Build a map from staff <g> element id to 1-based staff number.
   * Staff number is the 1-based index among sibling staff groups
   * inside each <g class="measure">.
   */
  _buildStaffNumberMap(doc) {
    const map = new Map();
    doc.querySelectorAll('g.measure').forEach((measure) => {
      let staffIdx = 0;
      for (const child of measure.children) {
        const cls = (child.getAttribute('class') || '').split(/\s+/);
        if (cls.includes('staff')) {
          staffIdx++;
          const sid = child.getAttribute('id');
          if (sid) map.set(sid, staffIdx);
        }
      }
    });
    return map;
  }

  /**
   * Recursively walk the SVG DOM, classifying elements.
   *
   * **Measure tagging**: Every parsed entry (note, bar-line, staff
   * line, classified `otherElement`) gets a `.measure` property
   * naming the id of its enclosing `<g class="measure">` group.
   * The repeat-unroller (`RepeatUnroller`) needs this so it can
   * copy *whole measures* worth of geometry to render second/third
   * passes on the page.  We track the boundary by snapshotting the
   * output array lengths on entry to a measure and writing the
   * measure id onto every entry pushed in between on exit — much
   * cheaper than threading an extra parameter through every helper.
   */
  async _walkTree(node, defs, out, scale, staffMap) {
    if (!node || node.nodeType !== 1) return;

    // Co-operative yield: every node is a chance to pause the main
    // thread.  `_maybeYield` is a no-op if the budget hasn't been
    // exhausted, so the overhead per node is one `performance.now()`
    // and one `if`.
    await this._maybeYield();

    const classList = (node.getAttribute('class') || '').split(/\s+/);
    const id = node.getAttribute('id') || '';

    // --- Hidden-class filter: drop entire groups whose Verovio class
    //     is configured as hidden.  Skipped groups don't contribute
    //     to bounds, geometry, or the timeline — see `SceneConfig.
    //     notation.hiddenClasses` for the list and rationale.  Tested
    //     against every class on the node (Verovio sometimes uses
    //     compound class strings like `"section systemMilestone"` so
    //     a single match anywhere in the list is enough).
    if (this._hiddenClasses && this._hiddenClasses.size > 0) {
      for (const cls of classList) {
        if (this._hiddenClasses.has(cls)) return;
      }
    }

    // --- Measure group: every child is associated with this measure
    //     (used by the repeat-unroller to identify duplicable units).
    if (classList.includes('measure')) {
      return await this._walkMeasure(node, id, defs, out, scale, staffMap);
    }

    // --- Staff group: collect bare <path> children as staff lines,
    //     then recurse into child <g> elements ---
    if (classList.includes('staff') && !classList.includes('staffDef')) {
      return await this._walkStaff(node, defs, out, scale, staffMap);
    }

    // --- Ledger lines ---
    // Tagged with `isLedger: true` so visible-staff diagnostics can
    // distinguish them from the five structural staff lines.
    if (classList.includes('ledgerLines')) {
      const before = out.staffLines.length;
      this._collectStaffLinePaths(node, out.staffLines, scale);
      for (let i = before; i < out.staffLines.length; i++) {
        out.staffLines[i].isLedger = true;
      }
      return;
    }

    // --- Notes & rests ---
    if (classList.includes('note')) {
      return await this._walkNoteOrRest(node, id, false, defs, out, scale, staffMap);
    }
    if (classList.includes('rest')) {
      return await this._walkNoteOrRest(node, id, true, defs, out, scale, staffMap);
    }

    // --- Bar lines ---
    if (classList.includes('barLine') || classList.includes('barLineAttr')) {
      this._collectPaths(node, out.barLines, 'barLine', scale);
      return;
    }

    // --- Other classified elements ---
    // Some of these (beam, tuplet) are *containers* — they wrap real notes
    // that we still need to descend into.  Others (clef, meterSig, …) are
    // pure glyphs and can terminate the walk.  See KNOWN_CLASSES for the
    // class list and its rationale.
    for (const cls of KNOWN_CLASSES) {
      if (classList.includes(cls)) {
        this._collectGlyphs(node, defs, out.otherElements, cls, scale);
        if (CONTAINER_CLASSES.has(cls)) {
          // Still walk into children so nested <g class="note"> groups
          // (e.g. beamed eighth notes) get picked up.
          for (const child of node.children) {
            await this._walkTree(child, defs, out, scale, staffMap);
          }
        }
        return;
      }
    }

    // Recurse into children
    for (const child of node.children) {
      await this._walkTree(child, defs, out, scale, staffMap);
    }
  }

  /**
   * `<g class="measure">` — recurse into children, then stamp the
   * measure id onto every entry pushed while inside it.
   */
  async _walkMeasure(node, id, defs, out, scale, staffMap) {
    const startLens = {
      notes: out.notes.length,
      staffLines: out.staffLines.length,
      barLines: out.barLines.length,
      otherElements: out.otherElements.length,
    };
    for (const child of node.children) {
      await this._walkTree(child, defs, out, scale, staffMap);
    }
    // Stamp `measure: id` on everything pushed while inside this
    // measure.  Empty-string id (rare) is skipped — the unroller
    // ignores entries without a measure tag, treating them as
    // page-level decoration that shouldn't be duplicated.
    if (id) {
      for (let i = startLens.notes; i < out.notes.length; i++) out.notes[i].measure = id;
      for (let i = startLens.staffLines; i < out.staffLines.length; i++) out.staffLines[i].measure = id;
      for (let i = startLens.barLines; i < out.barLines.length; i++) out.barLines[i].measure = id;
      for (let i = startLens.otherElements; i < out.otherElements.length; i++) out.otherElements[i].measure = id;
    }
  }

  /**
   * `<g class="staff">` — collect bare <path> children as staff
   * lines, then recurse into child <g> elements.
   */
  async _walkStaff(node, defs, out, scale, staffMap) {
    this._collectStaffLinePaths(node, out.staffLines, scale);
    for (const child of node.children) {
      if (child.nodeType === 1 && child.tagName === 'g') {
        await this._walkTree(child, defs, out, scale, staffMap);
      }
    }
  }

  /**
   * `<g class="note">` / `<g class="rest">` — extract the note entry,
   * then continue recursing to collect stems, flags, etc. inside the
   * note group.
   */
  async _walkNoteOrRest(node, id, isRest, defs, out, scale, staffMap) {
    const noteData = this._extractNote(node, defs, id, scale, staffMap);
    if (noteData) {
      if (isRest) noteData.isRest = true;
      out.notes.push(noteData);
    }
    for (const child of node.children) {
      await this._walkTree(child, defs, out, scale, staffMap);
    }
  }

  /**
   * Collect bare <path> children of a staff or ledgerLines group as staff lines.
   */
  _collectStaffLinePaths(container, outArray, scale) {
    for (const child of container.children) {
      if (child.tagName !== 'path') continue;
      const d = child.getAttribute('d');
      if (!d) continue;
      const endpoints = parseLineEndpoints(d);
      if (endpoints) {
        const tx = getAncestorTranslate(container);
        outArray.push({
          type: 'staffLine',
          isLine: true,
          x1: (endpoints.x1 + tx.rawX) * scale,
          y1: -(endpoints.y1 + tx.rawY) * scale,
          x2: (endpoints.x2 + tx.rawX) * scale,
          y2: -(endpoints.y2 + tx.rawY) * scale,
        });
      } else {
        const pos = this._pathStartPosition(d, container, scale);
        outArray.push({ type: 'staffLine', d, ...pos });
      }
    }
  }

  /**
   * Extract note position and glyph path data.
   */
  _extractNote(noteGroup, defs, noteId, scale, staffMap) {
    let useEl = noteGroup.querySelector('.notehead use') || noteGroup.querySelector('use');
    const pos = this._resolvePosition(noteGroup, useEl, scale);
    if (!pos) return null;

    let pathData = null;
    if (useEl) {
      const href = useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '';
      const defId = href.replace('#', '');
      const defEl = defs[defId];
      if (defEl) {
        pathData = defEl.getAttribute('d') || getChildPathD(defEl);
      }
    }

    // Collect only paths that have NO known classifier on their
    // ancestor chain within the note group.  Stems / flags / accidentals
    // / articulations / dots each have their own `.stem`, `.flag`, …
    // wrapper; the walker later recurses into those and collects them
    // into `otherElements` with the correct `type`.  If we also threw
    // them into `childPaths` here every stem would render twice —
    // once through the note (at Z = noteElevation) and once through
    // `otherElements` (at Z = 0) — visible as a pair of parallel
    // lines at different distances from the paper.
    //
    // We deliberately leave "anonymous" paths (paths whose ancestor
    // chain only has `<g>` with no class, or the note group itself)
    // in `childPaths`, because a few note sub-elements in Verovio's
    // output — e.g. nested `<path>`s for alternate noteheads, or
    // ledger-extension bits — aren't wrapped in a classified `<g>`
    // and wouldn't be rendered at all if we dropped them here.
    const excludedClasses = new Set(['stem', 'flag', 'accid', 'artic', 'dots']);
    const isInExcluded = (el) => {
      let p = el.parentElement;
      while (p && p !== noteGroup) {
        const cls = (p.getAttribute('class') || '').split(/\s+/);
        for (const c of cls) if (excludedClasses.has(c)) return true;
        p = p.parentElement;
      }
      return false;
    };

    const childPaths = [];
    noteGroup.querySelectorAll('path').forEach((p) => {
      if (isInExcluded(p)) return;
      const d = p.getAttribute('d');
      if (d) childPaths.push(d);
    });

    const staffN = this._findStaffNumber(noteGroup, staffMap);

    // Ancestor translate of the note group (WITHOUT the <use> x/y offset).
    // Stem/flag paths inside a note group are expressed in the page-margin's
    // coordinate frame, not the note's local frame, so we need this to place
    // them correctly in world space (see the childPaths handling in
    // SVG3DBuilder).
    const ancestor = getAncestorTranslate(noteGroup);

    // Glyph path `<use>` x/y places the path's local (0, 0) — which is the
    // *left edge* of a SMuFL notehead, not its visual centre.  For light
    // balls we want the centre, so pre-compute a centre offset per glyph
    // (world units) and expose it as `cxOffset`.  The 3D mesh builder
    // keeps using `x`/`y` directly so noteheads still render where they
    // should on the page.
    let cxOffset = 0;
    if (pathData) {
      const bbox = pathBBox(pathData);
      if (bbox) {
        cxOffset = ((bbox.minX + bbox.maxX) * 0.5)
          * scale
          * SceneConfig.glyphUseScale;
      }
    }

    return {
      id: noteId,
      x: pos.x,
      y: pos.y,
      cxOffset,
      ancestorX: ancestor.rawX * scale,
      ancestorY: -ancestor.rawY * scale,
      glyphPath: pathData,
      childPaths,
      staff: staffN,
      isRest: false,
    };
  }

  /**
   * Resolve world position of an element (handling transforms + <use>
   * x/y).  Y is negated to convert from SVG (Y-down) to Three.js
   * (Y-up).
   *
   * Has to handle two distinct Verovio output flavours:
   *
   *   • **Verovio ≤ 4.x** placed glyph instances with explicit `x`
   *     and `y` attributes:
   *         <use xlink:href="#G" x="2677" y="2628" width="480" />
   *
   *   • **Verovio ≥ 5.x** moved positioning into a `transform`:
   *         <use xlink:href="#G" transform="translate(2677, 3478) scale(0.48, 0.48)" />
   *
   * The 4.x format is read via `getAttribute('x'/'y')`; the 5.x format
   * is read by including the `<use>` element itself in the
   * translate-walk (it used to start one level up at `groupEl`,
   * which is the `<g class="note">` wrapper, missing the
   * `<use>`-local translate that's where 5.x stashes the position).
   * Both branches are kept active so the parser still works if
   * we downgrade for any reason.
   */
  _resolvePosition(groupEl, useEl, scale) {
    let x = 0;
    let y = 0;

    // Walk from the use element (inclusive) — or, for synthetic
    // path-line entries that don't have a `<use>`, from groupEl —
    // up to the `<svg>` root, summing every `translate(...)` we
    // hit.  This picks up the page / system / measure / staff /
    // layer transforms that Verovio nests around every glyph and
    // (in the 5.x case) the `<use>`-local translate.
    let el = useEl || groupEl;
    while (el && el.tagName !== 'svg') {
      const tx = getTranslate(el);
      x += tx.x;
      y += tx.y;
      el = el.parentElement;
    }

    if (useEl) {
      // 4.x positioning attributes — no-ops in 5.x where these
      // attributes don't exist.
      x += parseFloat(useEl.getAttribute('x') || '0');
      y += parseFloat(useEl.getAttribute('y') || '0');
    }

    return {
      x: x * scale,
      y: -y * scale,
    };
  }

  _collectPaths(container, outArray, type, scale) {
    container.querySelectorAll('path').forEach((pathEl) => {
      const d = pathEl.getAttribute('d');
      if (!d) return;
      // Verovio ≥ 5.x renders bar lines (and several other thin
      // axis-aligned strokes) as `<path d="M x1 y1 L x2 y2" />`
      // instead of the `<line x1="..." y1="..." …>` it used in 4.x.
      // If the d-string is exactly such a single line segment,
      // record it as an `isLine` entry so callers (bbox computation,
      // SVG3DBuilder's box bucket) treat it as a line — otherwise
      // we'd lose the endpoint information and `_pathStartPosition`
      // would return only the container's translate, which makes
      // every bar line in the score collapse to the same point and
      // breaks the score's vertical bbox calculation.
      const endpoints = parseLineEndpoints(d);
      if (endpoints) {
        const tx = getAncestorTranslate(pathEl.parentElement || container);
        outArray.push({
          type,
          isLine: true,
          x1: (endpoints.x1 + tx.rawX) * scale,
          y1: -(endpoints.y1 + tx.rawY) * scale,
          x2: (endpoints.x2 + tx.rawX) * scale,
          y2: -(endpoints.y2 + tx.rawY) * scale,
        });
        return;
      }
      const pos = this._pathStartPosition(d, container, scale);
      outArray.push({ type, d, ...pos });
    });
    container.querySelectorAll('line').forEach((lineEl) => {
      const x1 = parseFloat(lineEl.getAttribute('x1') || '0');
      const y1 = parseFloat(lineEl.getAttribute('y1') || '0');
      const x2 = parseFloat(lineEl.getAttribute('x2') || '0');
      const y2 = parseFloat(lineEl.getAttribute('y2') || '0');
      const tx = getAncestorTranslate(lineEl);
      outArray.push({
        type,
        isLine: true,
        x1: (x1 + tx.rawX) * scale,
        y1: -(y1 + tx.rawY) * scale,
        x2: (x2 + tx.rawX) * scale,
        y2: -(y2 + tx.rawY) * scale,
      });
    });
  }

  /**
   * True when `el`'s ancestor chain (up to `container`) passes
   * through a `.note` or `.rest` group — used to skip nested-note
   * primitives inside container classes like beam/tuplet.
   */
  _inNestedNoteOrRest(el, container) {
    let p = el.parentElement;
    while (p && p !== container) {
      const cls = (p.getAttribute('class') || '').split(/\s+/);
      if (cls.includes('note') || cls.includes('rest')) return true;
      p = p.parentElement;
    }
    return false;
  }

  /**
   * Dispatch a classified container's drawable children to the
   * per-shape collectors.
   *
   * Container classes (beam, tuplet, …) WRAP nested <g class="note">
   * groups rather than substituting for them.  The walker recurses
   * into those notes separately, so the container's own
   * `_collectGlyphs` must NOT re-collect the nested notehead glyphs
   * or stem paths — otherwise every beamed notehead renders twice:
   * once via `_extractNote` with the white-base notehead material at
   * Z = noteElevation, and once via the beam's `_collectGlyphs`
   * with the dark `_otherMat` at Z = 0.  On a cream paper the two
   * overlapping disks at different Z levels read as "two noteheads
   * stacked at different distances from the page" — exactly the
   * artefact a user would first notice when they start paying
   * attention to shadows.
   *
   * For those containers we walk `<use>` / `<path>` / `<polygon>`
   * manually, rejecting any element whose ancestor chain (up to
   * `container`) passes through a `.note` or `.rest` group.
   */
  _collectGlyphs(container, defs, outArray, type, scale) {
    const isContainer = CONTAINER_CLASSES.has(type);
    this._collectUseGlyphs(container, defs, outArray, type, scale, isContainer);
    this._collectPathGlyphs(container, outArray, type, scale, isContainer);
    if (isContainer) this._collectPolygons(container, outArray, type, scale);
    this._collectPrimitives(container, outArray, type, scale, isContainer);
  }

  _collectUseGlyphs(container, defs, outArray, type, scale, isContainer) {
    container.querySelectorAll('use').forEach((useEl) => {
      if (isContainer && this._inNestedNoteOrRest(useEl, container)) return;
      const href = useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '';
      const defId = href.replace('#', '');
      const defEl = defs[defId];
      const pathData = defEl ? (defEl.getAttribute('d') || getChildPathD(defEl)) : null;
      const pos = this._resolvePosition(container, useEl, scale);
      if (pos) {
        // Pick up any `rotate(...)` transforms on the ancestor chain
        // (most relevant for `<g class="arpeg" transform="rotate(...)">`
        // which flips the arpeggio symbol to vertical).  Skipped if
        // zero so unrotated glyphs don't pay the per-instance matrix
        // composition cost.
        const rot = getAncestorRotation(useEl);
        const entry = { type, glyphPath: pathData, ...pos };
        if (rot !== 0) entry.rotation = rot;
        outArray.push(entry);
      }
    });
  }

  _collectPathGlyphs(container, outArray, type, scale, isContainer) {
    container.querySelectorAll(':scope > path, :scope > g > path').forEach((pathEl) => {
      if (isContainer && this._inNestedNoteOrRest(pathEl, container)) return;
      const d = pathEl.getAttribute('d');
      if (!d) return;
      const pos = this._pathStartPosition(d, container, scale);
      outArray.push({ type, d, ...pos });
    });
  }

  _collectPolygons(container, outArray, type, scale) {
    // Only reached for container classes (beam, tuplet) — see
    // `svgPrimitives.js` for why beam polygons collapse to
    // centre-line + thickness entries.
    container.querySelectorAll(':scope > polygon').forEach((polyEl) => {
      const tx = getAncestorTranslate(polyEl);
      const entry = polygonToLineOrPath(
        polyEl.getAttribute('points'), tx, scale,
        this._pathStartPosition('', container, scale),
      );
      if (entry) outArray.push({ type, ...entry });
    });
  }

  // ----------------------------------------------------------------
  // Non-glyph primitives Verovio uses for misc. notation symbols.
  //
  // Augmentation dots (`<g class="dots"><ellipse cx cy rx ry/></g>`),
  // sustain-pedal markers (`<rect>`), dynamic hairpins / ottava-line
  // endcaps (`<polyline>`).  Each is converted to a path-d string and
  // emitted as a `{type, d, x, y}` entry, which routes through the
  // builder's `kind === 'path'` path (no 0.48 glyph-use scaling, Y
  // flipped) — same treatment as bar-line and stem paths.
  //
  // **Performance note** (this is the reason for the awkward shape
  // below): the path-d string is the bucket key in
  // `InstanceBucketer.addGlyph`, so every entry that shares an
  // identical d-string folds into a single shared `ExtrudeGeometry`
  // and `InstancedMesh` — even with hundreds of instances spread
  // across the page.  We therefore emit *glyph-local* path data
  // (anchored at (0, 0)) and use the absolute SVG coords for the
  // entry's `x`/`y` placement, so e.g. all 460 of Perfect's pedal
  // rects (which are visually identical 60×12 rectangles) collapse
  // into one bucket → one InstancedMesh → one draw call, instead of
  // 460 unique geometries / 460 draw calls (which dropped the
  // worker frame rate by ~25 % when first added).
  //
  // The selector pattern matches the existing one for `<path>` to
  // avoid recursing into nested note groups (which shouldn't ever
  // happen for these classes, but keeps the extraction symmetrical).
  // ----------------------------------------------------------------
  _collectPrimitives(container, outArray, type, scale, isContainer) {
    container.querySelectorAll(':scope > polyline, :scope > g > polyline').forEach((polyEl) => {
      if (isContainer && this._inNestedNoteOrRest(polyEl, container)) return;
      const entry = polylineToPath(
        polyEl.getAttribute('points'),
        getAncestorTranslate(polyEl), scale);
      if (entry) outArray.push({ type, ...entry });
    });

    container.querySelectorAll(':scope > ellipse, :scope > g > ellipse').forEach((el) => {
      if (isContainer && this._inNestedNoteOrRest(el, container)) return;
      const entry = ellipseToPath(
        parseFloat(el.getAttribute('cx') || '0'),
        parseFloat(el.getAttribute('cy') || '0'),
        parseFloat(el.getAttribute('rx') || '0'),
        parseFloat(el.getAttribute('ry') || '0'),
        getAncestorTranslate(el), scale);
      if (entry) outArray.push({ type, ...entry });
    });

    container.querySelectorAll(':scope > rect, :scope > g > rect').forEach((el) => {
      if (isContainer && this._inNestedNoteOrRest(el, container)) return;
      const entry = rectToPath(
        parseFloat(el.getAttribute('x') || '0'),
        parseFloat(el.getAttribute('y') || '0'),
        parseFloat(el.getAttribute('width') || '0'),
        parseFloat(el.getAttribute('height') || '0'),
        getAncestorTranslate(el), scale);
      if (entry) outArray.push({ type, ...entry });
    });
  }

  /**
   * Ancestor-transform offset for path mesh positioning.
   * Y is negated to convert from SVG (Y-down) to Three.js (Y-up).
   */
  _pathStartPosition(d, contextEl, scale) {
    const tx = getAncestorTranslate(contextEl);
    return {
      x: tx.rawX * scale,
      y: -tx.rawY * scale,
    };
  }

  _findStaffNumber(el, staffMap) {
    let cur = el;
    while (cur && cur.tagName !== 'svg') {
      const cls = (cur.getAttribute('class') || '').split(/\s+/);
      if (cls.includes('staff')) {
        const sid = cur.getAttribute('id');
        if (sid && staffMap.has(sid)) return staffMap.get(sid);
      }
      cur = cur.parentElement;
    }
    return 1;
  }
}
