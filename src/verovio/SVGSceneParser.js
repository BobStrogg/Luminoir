import { SceneConfig } from '../rendering/SceneConfig.js';

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
    const bounds = this._computeBounds(out);
    const staffBounds = this._computeStaffBounds(out);

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
      // `SVG3DBuilder._addPaper`'s `margin`); doing it here once
      // led to asymmetric paper padding because `_addPaper` derives
      // the paper centre from `(contentMinY + totalHeight / 2)`,
      // and a pre-padded `totalHeight` shifts that midpoint away
      // from the score's actual centre.
      totalWidth: bounds.maxX - bounds.minX,
      totalHeight: bounds.maxY - bounds.minY,
      contentMinX: bounds.minX,
      contentMinY: bounds.minY,
      // Visible-staff Y-bounds (highest top staff line, lowest bottom
      // staff line — ledger lines and otherElements like pedals or
      // octave brackets are excluded).  The page-margin sizer in
      // `TitleBlock.computePageMargins` uses these so the title sits
      // a fixed distance above the staff itself instead of above
      // wherever the highest stray ledger line happened to land.
      // Falls back to the full content bounds for scores with no
      // staff lines at all (the parser hasn't seen one yet, but it's
      // the safe default).
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
      return;
    }

    // --- Staff group: collect bare <path> children as staff lines,
    //     then recurse into child <g> elements ---
    if (classList.includes('staff') && !classList.includes('staffDef')) {
      this._collectStaffLinePaths(node, out.staffLines, scale);
      for (const child of node.children) {
        if (child.nodeType === 1 && child.tagName === 'g') {
          await this._walkTree(child, defs, out, scale, staffMap);
        }
      }
      return;
    }

    // --- Ledger lines ---
    // Tagged with `isLedger: true` so the page-margin sizer can
    // exclude them when computing the visible staff Y-bounds.
    // (Ledger lines for notes far above / below the staff would
    // otherwise pull `staffMaxY` / `staffMinY` toward `contentMaxY`
    // / `contentMinY` and defeat the whole point of the staff
    // bounds existing — see `computePageMargins` in TitleBlock.)
    if (classList.includes('ledgerLines')) {
      const before = out.staffLines.length;
      this._collectStaffLinePaths(node, out.staffLines, scale);
      for (let i = before; i < out.staffLines.length; i++) {
        out.staffLines[i].isLedger = true;
      }
      return;
    }

    // --- Notes ---
    if (classList.includes('note')) {
      const noteData = this._extractNote(node, defs, id, scale, staffMap);
      if (noteData) out.notes.push(noteData);
      // Continue recursing to collect stems, flags, etc. inside the note group
      for (const child of node.children) {
        await this._walkTree(child, defs, out, scale, staffMap);
      }
      return;
    }

    // --- Rests ---
    if (classList.includes('rest')) {
      const noteData = this._extractNote(node, defs, id, scale, staffMap);
      if (noteData) {
        noteData.isRest = true;
        out.notes.push(noteData);
      }
      // Recurse for child elements
      for (const child of node.children) {
        await this._walkTree(child, defs, out, scale, staffMap);
      }
      return;
    }

    // --- Bar lines ---
    if (classList.includes('barLine') || classList.includes('barLineAttr')) {
      this._collectPaths(node, out.barLines, 'barLine', scale);
      return;
    }

    // --- Other classified elements ---
    // Some of these (beam, tuplet) are *containers* — they wrap real notes
    // that we still need to descend into.  Others (clef, meterSig, …) are
    // pure glyphs and can terminate the walk.
    //
    // The bottom row classes are ones Verovio emits for non-notehead
    // notation (augmentation dots, sustain-pedal markers, dynamic
    // hairpins, fermatas, multi-measure rests, arpeggios, system
    // braces, ottava-spans, tuplet brackets/numbers).  Without
    // explicit handling they fell through to the generic recursion
    // step and their underlying `<ellipse>` / `<rect>` / `<polyline>`
    // / `<use>` / `<path>` nodes were silently dropped — visible as
    // missing dotted-quarter dots, missing 8va lines, missing pedal
    // brackets, etc.  See `_collectGlyphs` for the per-shape extraction.
    const containerClasses = new Set(['beam', 'tuplet']);
    const knownClasses = [
      'clef', 'meterSig', 'keySig', 'beam', 'tie', 'slur',
      'stem', 'flag', 'tuplet', 'accid', 'artic', 'dynam', 'dir',
      'dots', 'pedal', 'hairpin', 'fermata', 'mRest', 'arpeg',
      'grpSym', 'octave', 'tupletBracket', 'tupletNum',
    ];
    for (const cls of knownClasses) {
      if (classList.includes(cls)) {
        this._collectGlyphs(node, defs, out.otherElements, cls, scale);
        if (containerClasses.has(cls)) {
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
   * Collect bare <path> children of a staff or ledgerLines group as staff lines.
   */
  _collectStaffLinePaths(container, outArray, scale) {
    for (const child of container.children) {
      if (child.tagName !== 'path') continue;
      const d = child.getAttribute('d');
      if (!d) continue;
      const endpoints = this._parseLineEndpoints(d);
      if (endpoints) {
        const tx = this._getAncestorTranslate(container);
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

  _parseLineEndpoints(d) {
    const m = d.match(/^M\s*([-\d.]+)[\s,]+([-\d.]+)\s*L\s*([-\d.]+)[\s,]+([-\d.]+)/);
    if (!m) return null;
    return {
      x1: parseFloat(m[1]),
      y1: parseFloat(m[2]),
      x2: parseFloat(m[3]),
      y2: parseFloat(m[4]),
    };
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
        pathData = defEl.getAttribute('d') || this._getChildPathD(defEl);
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
    // them correctly in world space (see SVG3DBuilder._buildNote).
    const ancestor = this._getAncestorTranslate(noteGroup);

    // Glyph path `<use>` x/y places the path's local (0, 0) — which is the
    // *left edge* of a SMuFL notehead, not its visual centre.  For light
    // balls we want the centre, so pre-compute a centre offset per glyph
    // (world units) and expose it as `cxOffset`.  The 3D mesh builder
    // keeps using `x`/`y` directly so noteheads still render where they
    // should on the page.
    let cxOffset = 0;
    if (pathData) {
      const bbox = _pathBBox(pathData);
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
      const tx = this._getTranslate(el);
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

  _getTranslate(el) {
    const t = el.getAttribute('transform') || '';
    const match = t.match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/);
    if (match) return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
    return { x: 0, y: 0 };
  }

  /**
   * Sum every `rotate(...)` transform on the ancestor chain from `el`
   * up to the `<svg>` root, returning the total rotation angle that
   * should be baked into the rendered glyph.
   *
   * Verovio uses `<g class="arpeg" transform="rotate(-90 cx,cy)">`
   * to flip the otherwise-horizontal arpeggio symbol vertical, with
   * the pivot point coinciding with the inner `<use>`'s
   * `translate(cx, cy)`.  Without this, every arpeggio came out
   * lying flat across the staff instead of standing upright next
   * to its chord — visible on Perfect (3 arpeg groups) and Jupiter
   * (31 arpeg groups).
   *
   * **Conversion**: SVG rotate is expressed in degrees, with positive
   * angles going counterclockwise mathematically (which is clockwise
   * visually because SVG's Y axis points down).  The 3D builder Y-
   * flips the extruded geometry to undo that convention, so a
   * world-space rotation that *visually matches* the SVG rotate
   * needs the opposite sign.  We return radians so the caller can
   * pass it straight to `Matrix4.makeRotationZ`.
   *
   * **Pivot**: this implementation only sums the rotation *angle*,
   * not the pivot.  When rotate's pivot coincides with the rotated
   * element's translate (the common case Verovio emits — see
   * arpeggios above), no pivot correction is needed because rotating
   * around a point that's already the element's local origin leaves
   * the position unchanged.  For non-coincident pivots the
   * positional offset is approximate; we can revisit if real-world
   * scores hit that path.
   */
  _getAncestorRotation(el) {
    let totalAngleRad = 0;
    let cur = el;
    while (cur && cur.tagName !== 'svg') {
      const t = cur.getAttribute('transform') || '';
      // `rotate(angle)` or `rotate(angle cx cy)`.  We capture only
      // the angle here; pivot handling is documented above.
      const re = /rotate\(\s*(-?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;
      let m;
      while ((m = re.exec(t)) !== null) {
        const deg = parseFloat(m[1]);
        // Negate to convert SVG-Y-down rotation into world-local
        // rotation (after the geometry's Y flip).  Result is in
        // radians.
        totalAngleRad += -deg * Math.PI / 180;
      }
      cur = cur.parentElement;
    }
    return totalAngleRad;
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
      const endpoints = this._parseLineEndpoints(d);
      if (endpoints) {
        const tx = this._getAncestorTranslate(pathEl.parentElement || container);
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
      const tx = this._getAncestorTranslate(lineEl);
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

  _collectGlyphs(container, defs, outArray, type, scale) {
    // Container classes (beam, tuplet, …) WRAP nested <g class="note">
    // groups rather than substituting for them.  The walker recurses
    // into those notes separately, so the container's own
    // `_collectGlyphs` must NOT re-collect the nested notehead glyphs
    // or stem paths — otherwise every beamed notehead renders twice:
    // once via `_extractNote` with the white-base notehead material at
    // Z = noteElevation, and once via the beam's `_collectGlyphs`
    // with the dark `_otherMat` at Z = 0.  On a cream paper the two
    // overlapping disks at different Z levels read as "two noteheads
    // stacked at different distances from the page" — exactly the
    // artefact a user would first notice when they start paying
    // attention to shadows.
    //
    // For those containers we walk `<use>` / `<path>` / `<polygon>`
    // manually, rejecting any element whose ancestor chain (up to
    // `container`) passes through a `.note` or `.rest` group.
    const isContainer = type === 'beam' || type === 'tuplet';

    const inNestedNoteOrRest = (el) => {
      let p = el.parentElement;
      while (p && p !== container) {
        const cls = (p.getAttribute('class') || '').split(/\s+/);
        if (cls.includes('note') || cls.includes('rest')) return true;
        p = p.parentElement;
      }
      return false;
    };

    container.querySelectorAll('use').forEach((useEl) => {
      if (isContainer && inNestedNoteOrRest(useEl)) return;
      const href = useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '';
      const defId = href.replace('#', '');
      const defEl = defs[defId];
      const pathData = defEl ? (defEl.getAttribute('d') || this._getChildPathD(defEl)) : null;
      const pos = this._resolvePosition(container, useEl, scale);
      if (pos) {
        // Pick up any `rotate(...)` transforms on the ancestor chain
        // (most relevant for `<g class="arpeg" transform="rotate(...)">`
        // which flips the arpeggio symbol to vertical).  Skipped if
        // zero so unrotated glyphs don't pay the per-instance matrix
        // composition cost.
        const rot = this._getAncestorRotation(useEl);
        const entry = { type, glyphPath: pathData, ...pos };
        if (rot !== 0) entry.rotation = rot;
        outArray.push(entry);
      }
    });
    container.querySelectorAll(':scope > path, :scope > g > path').forEach((pathEl) => {
      if (isContainer && inNestedNoteOrRest(pathEl)) return;
      const d = pathEl.getAttribute('d');
      if (!d) return;
      const pos = this._pathStartPosition(d, container, scale);
      outArray.push({ type, d, ...pos });
    });
    // Beam bars are `<polygon>` in Verovio output.  Each one has a
    // unique set of points (because coordinates differ per beam), so
    // routing them through the glyph bucket would produce one plain
    // `THREE.Mesh` per beam — hundreds of extra draw calls on scores
    // like Sylvia Suite.  Instead, detect the 4-point rectangle /
    // parallelogram case, compute a centre-line + thickness, and emit
    // as an `isLine` entry so the builder can aggregate every beam in
    // the piece into a single box-bucket `InstancedMesh`.
    //
    // Any polygon that isn't a 4-point shape falls back to a path-d
    // string (correct but unshared); polygons are rare enough outside
    // of beams that this edge-case cost is negligible.
    if (isContainer) {
      container.querySelectorAll(':scope > polygon').forEach((polyEl) => {
        const points = polyEl.getAttribute('points');
        if (!points) return;
        const tokens = points.trim().split(/[\s,]+/).map(parseFloat).filter((n) => !isNaN(n));
        if (tokens.length < 4) return;
        const tx = this._getAncestorTranslate(polyEl);
        if (tokens.length === 8) {
          // Assume the 4 points are in order top-left, top-right,
          // bottom-right, bottom-left (Verovio's convention for beam
          // parallelograms).  Centre-line runs between the midpoint
          // of the left edge and the midpoint of the right edge;
          // thickness is the length of the left edge, so it still
          // works for beams that slope.
          const [x1r, y1r, x2r, y2r, x3r, y3r, x4r, y4r] = tokens;
          const midLX = (x1r + x4r) / 2;
          const midLY = (y1r + y4r) / 2;
          const midRX = (x2r + x3r) / 2;
          const midRY = (y2r + y3r) / 2;
          const thick = Math.hypot(x1r - x4r, y1r - y4r) * scale;
          outArray.push({
            type,
            isLine: true,
            x1: (midLX + tx.rawX) * scale,
            y1: -(midLY + tx.rawY) * scale,
            x2: (midRX + tx.rawX) * scale,
            y2: -(midRY + tx.rawY) * scale,
            thickness: thick,
          });
          return;
        }
        // Fallback: emit as path-d so it still renders.
        let d = 'M ' + tokens[0] + ' ' + tokens[1];
        for (let i = 2; i < tokens.length; i += 2) {
          d += ' L ' + tokens[i] + ' ' + tokens[i + 1];
        }
        d += ' Z';
        const pos = this._pathStartPosition(d, container, scale);
        outArray.push({ type, d, ...pos });
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
    // `SVG3DBuilder._bucketGlyph`, so every entry that shares an
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
    container.querySelectorAll(':scope > polyline, :scope > g > polyline').forEach((polyEl) => {
      if (isContainer && inNestedNoteOrRest(polyEl)) return;
      const points = polyEl.getAttribute('points');
      if (!points) return;
      const tokens = points.trim().split(/[\s,]+/).map(parseFloat).filter((n) => !isNaN(n));
      if (tokens.length < 4) return;
      // Anchor the path at the first point so every polyline with the
      // same *shape* (relative offsets) shares a geometry bucket.
      // Polylines with different point counts or different relative
      // offsets still get their own bucket — that's correct.
      const ax = tokens[0];
      const ay = tokens[1];
      let d = 'M 0 0';
      for (let i = 2; i + 1 < tokens.length; i += 2) {
        d += ' L ' + (tokens[i] - ax) + ' ' + (tokens[i + 1] - ay);
      }
      const tx = this._getAncestorTranslate(polyEl);
      outArray.push({
        type, d,
        x: (ax + tx.rawX) * scale,
        y: -(ay + tx.rawY) * scale,
      });
    });

    container.querySelectorAll(':scope > ellipse, :scope > g > ellipse').forEach((el) => {
      if (isContainer && inNestedNoteOrRest(el)) return;
      const cx = parseFloat(el.getAttribute('cx') || '0');
      const cy = parseFloat(el.getAttribute('cy') || '0');
      const rx = parseFloat(el.getAttribute('rx') || '0');
      const ry = parseFloat(el.getAttribute('ry') || '0');
      if (rx <= 0 || ry <= 0) return;
      // Cubic-Bezier circle approximation: 4 quadrants × control
      // distance kappa = (4/3)·tan(π/8) ≈ 0.5523.  Produces a closed
      // loop that's visually indistinguishable from a true ellipse at
      // our extrusion resolution.  Glyph-local coords centred at
      // (0, 0) so all dots with the same (rx, ry) share one geometry.
      const k = 0.5522847498307933;
      const kx = rx * k, ky = ry * k;
      const d =
        `M ${-rx} 0 ` +
        `C ${-rx} ${-ky}, ${-kx} ${-ry}, 0 ${-ry} ` +
        `C ${kx} ${-ry}, ${rx} ${-ky}, ${rx} 0 ` +
        `C ${rx} ${ky}, ${kx} ${ry}, 0 ${ry} ` +
        `C ${-kx} ${ry}, ${-rx} ${ky}, ${-rx} 0 Z`;
      const tx = this._getAncestorTranslate(el);
      outArray.push({
        type, d,
        x: (cx + tx.rawX) * scale,
        y: -(cy + tx.rawY) * scale,
      });
    });

    container.querySelectorAll(':scope > rect, :scope > g > rect').forEach((el) => {
      if (isContainer && inNestedNoteOrRest(el)) return;
      const x = parseFloat(el.getAttribute('x') || '0');
      const y = parseFloat(el.getAttribute('y') || '0');
      const w = parseFloat(el.getAttribute('width') || '0');
      const h = parseFloat(el.getAttribute('height') || '0');
      if (w <= 0 || h <= 0) return;
      // Glyph-local rect anchored at (0, 0).  Every pedal-bracket rect
      // with the same (w, h) shares one geometry bucket.
      const d = `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
      const tx = this._getAncestorTranslate(el);
      outArray.push({
        type, d,
        x: (x + tx.rawX) * scale,
        y: -(y + tx.rawY) * scale,
      });
    });
  }

  /**
   * Ancestor-transform offset for path mesh positioning.
   * Y is negated to convert from SVG (Y-down) to Three.js (Y-up).
   */
  _pathStartPosition(d, contextEl, scale) {
    const tx = this._getAncestorTranslate(contextEl);
    return {
      x: tx.rawX * scale,
      y: -tx.rawY * scale,
    };
  }

  _getAncestorTranslate(el) {
    let x = 0, y = 0;
    let cur = el;
    while (cur && cur.tagName !== 'svg') {
      const t = this._getTranslate(cur);
      x += t.x;
      y += t.y;
      cur = cur.parentElement;
    }
    return { rawX: x, rawY: y };
  }

  _getChildPathD(defEl) {
    const child = defEl.querySelector('path');
    return child ? child.getAttribute('d') : null;
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

  /**
   * Compute bounding box from all parsed element positions.
   *
   * Bounds cover the full musical content the renderer will draw:
   * notes + staff lines + bar lines + every classified
   * `otherElement` we extract (clefs, accidentals, beams, dynamics,
   * **pedal brackets, dotted-rhythm dots, hairpins, octave lines,
   * fermatas, tuplet brackets, …**).  Including `otherElements` is
   * what guarantees the paper backdrop is tall enough to contain
   * everything the renderer emits — without it, sustain-pedal
   * rectangles that sit just below the bass staff (or 8va lines
   * above the treble staff) hung off the edge of the paper
   * because the bounds were derived only from the staff lines
   * themselves.
   *
   * Title / tempo / copyright / page-number `<text>` elements are
   * the historical reason the original code excluded `otherElements`
   * from bounds — those sat far outside the staff Y-extent and pulled
   * the apparent score centre off.  We don't currently parse any of
   * those (the walker recurses past unclassified groups and ignores
   * raw `<text>` nodes), so they never enter `otherElements` and
   * including the bucket here is safe.  If text rendering is added
   * later, exclude the relevant types here.
   */
  _computeBounds(out) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    const track = (x, y) => {
      if (typeof x !== 'number' || typeof y !== 'number') return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    // Path-form entries (`{ d, x, y }`) describe an extruded shape
    // whose vertices are *added* to the entry's `(x, y)` position
    // by the 3D builder.  Some emit paths use **absolute** SVG
    // coords (stems, grpSym braces — `(x, y)` is just the
    // page-margin translate) and some use **glyph-local** coords
    // anchored at the origin (the new pedal/dot/hairpin emits —
    // `(x, y)` is the element's actual on-page position).  Either
    // way the actual world bounds = `(x, y) + pathBBox(d) × scale`
    // with Y flipped (because `geo.scale(s, -s, s)` flips the
    // extruded vertex Y).  Computing this once per entry recovers
    // the correct visual extent for both representations and stops
    // the page-margin (0.5, -0.5) from being mistaken for the
    // score's actual top edge — the bug that left Perfect's pedal
    // markers hanging off the bottom of an off-centred page.
    const pathScale = SceneConfig.scale;
    const trackPath = (d, x, y) => {
      const bb = _pathBBox(d);
      if (!bb) { track(x, y); return; }
      track(x + bb.minX * pathScale, y - bb.maxY * pathScale);
      track(x + bb.maxX * pathScale, y - bb.minY * pathScale);
    };

    // Notes: `x`/`y` is the SMuFL <use>'s absolute position — trustworthy.
    for (const n of out.notes) track(n.x, n.y);

    for (const sl of out.staffLines) {
      if (sl.isLine) {
        track(sl.x1, sl.y1);
        track(sl.x2, sl.y2);
      } else if (sl.d) {
        trackPath(sl.d, sl.x, sl.y);
      }
    }
    for (const bl of out.barLines) {
      if (bl.isLine) {
        track(bl.x1, bl.y1);
        track(bl.x2, bl.y2);
      } else if (bl.d) {
        trackPath(bl.d, bl.x, bl.y);
      }
    }

    // Other elements: glyph (<use>) entries have a tight bbox that's
    // close to their position — including just `(x, y)` is good
    // enough.  Path entries go through `trackPath` so their full
    // visual extent contributes (pedal markers below the bass staff,
    // octave brackets above the treble, system braces spanning all
    // staves, etc.) without polluting the bounds with the (0.5, -0.5)
    // ancestor translate carried by stem-like absolute-coord paths.
    for (const el of out.otherElements) {
      if (el.isLine) {
        track(el.x1, el.y1);
        track(el.x2, el.y2);
      } else if (el.glyphPath) {
        track(el.x, el.y);
      } else if (el.d) {
        trackPath(el.d, el.x, el.y);
      }
    }
    if (minX === Infinity) {
      minX = 0; maxX = 1; minY = 0; maxY = 1;
    }
    return { minX, maxX, minY, maxY };
  }

  /**
   * Compute the Y-bounds of the visible 5-line staves only — i.e.
   * the topmost staff line of the highest staff and the bottommost
   * staff line of the lowest staff.  Excludes:
   *
   *   • Ledger lines (tagged `isLedger: true` by `_walkTree`'s
   *     ledger-lines branch).
   *   • Notes (notes can sit far above / below the staff via ledger
   *     lines; their Y is irrelevant for the visible staff bounds).
   *   • `otherElements` (pedals below the bass staff, 8va lines
   *     above the treble, slurs / hairpins / dynamics — these are
   *     the very things `staffMaxY` / `staffMinY` exist to ignore).
   *
   * The page-margin sizer in `TitleBlock.computePageMargins` reads
   * these bounds so the title sits a constant gap above the actual
   * 5-line staff regardless of how far the music's ledger lines or
   * pedal markings extend.
   *
   * Returns `{ minY: null, maxY: null }` if no non-ledger staff
   * lines were collected (the parser handles unknown markup
   * gracefully — fallback in `parse()` reuses the full content
   * bounds).
   *
   * @returns {{ minY: number|null, maxY: number|null }}
   */
  _computeStaffBounds(out) {
    let minY = Infinity, maxY = -Infinity;
    for (const sl of out.staffLines) {
      if (sl.isLedger) continue;
      if (sl.isLine) {
        if (typeof sl.y1 === 'number') {
          if (sl.y1 < minY) minY = sl.y1;
          if (sl.y1 > maxY) maxY = sl.y1;
        }
        if (typeof sl.y2 === 'number') {
          if (sl.y2 < minY) minY = sl.y2;
          if (sl.y2 > maxY) maxY = sl.y2;
        }
      } else if (typeof sl.y === 'number') {
        if (sl.y < minY) minY = sl.y;
        if (sl.y > maxY) maxY = sl.y;
      }
    }
    if (minY === Infinity) return { minY: null, maxY: null };
    return { minY, maxY };
  }
}

/* --------------------------------------------------------------- */
/*  Glyph-path bbox helper                                          */
/* --------------------------------------------------------------- */

/**
 * Approximate bounding box of a path-d string in local glyph
 * coordinates.  Tracks current-position / relative-vs-absolute
 * commands so relative path strings (lower-case `c`, `l`, `m`, …)
 * produce the correct absolute extents — a regex over raw numbers
 * would otherwise union a bunch of deltas with a couple of real
 * coordinates and return nonsense.
 *
 * Quadratic / cubic Béziers can curve outside the polygon of their
 * control points, so the box is a slight over-estimate of the
 * rendered outline; good enough to recover a notehead's horizontal
 * centre for light-ball placement.
 *
 * Cached by `d`-string so we pay the parse cost once per unique
 * glyph, not once per note instance (Sylvia Suite has 6 881 notes
 * and only 7 unique notehead glyphs).
 *
 * @param {string} d
 * @returns {{minX:number,maxX:number,minY:number,maxY:number}|null}
 */
const _bboxCache = new Map();
const _pathTokRe = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;
function _pathBBox(d) {
  if (!d) return null;
  const cached = _bboxCache.get(d);
  if (cached !== undefined) return cached;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let x = 0, y = 0;
  let startX = 0, startY = 0;
  let cmd = '';
  // Gather the tokens once — the regex is the same format used by
  // SVG3DBuilder.tokenizePathD, but we don't bother importing that
  // to keep the parser module self-contained.
  const toks = [];
  let m;
  while ((m = _pathTokRe.exec(d)) !== null) {
    if (m[1]) toks.push(m[1]);
    else if (m[2]) toks.push(parseFloat(m[2]));
  }
  const track = (px, py) => {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  };
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (typeof t === 'string') { cmd = t; i++; }
    const rel = cmd >= 'a' && cmd <= 'z';
    const up = cmd.toUpperCase();
    const rx = (v) => (rel ? x + v : v);
    const ry = (v) => (rel ? y + v : v);
    switch (up) {
      case 'M': {
        const nx = rx(toks[i++]);
        const ny = ry(toks[i++]);
        x = nx; y = ny; startX = nx; startY = ny;
        track(x, y);
        cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit lineTo's
        break;
      }
      case 'L': {
        x = rx(toks[i++]); y = ry(toks[i++]); track(x, y);
        break;
      }
      case 'H': {
        x = rx(toks[i++]); track(x, y);
        break;
      }
      case 'V': {
        y = ry(toks[i++]); track(x, y);
        break;
      }
      case 'C': {
        const c1x = rx(toks[i++]); const c1y = ry(toks[i++]);
        const c2x = rx(toks[i++]); const c2y = ry(toks[i++]);
        const nx = rx(toks[i++]); const ny = ry(toks[i++]);
        track(c1x, c1y); track(c2x, c2y); track(nx, ny);
        x = nx; y = ny;
        break;
      }
      case 'S': {
        const c2x = rx(toks[i++]); const c2y = ry(toks[i++]);
        const nx = rx(toks[i++]); const ny = ry(toks[i++]);
        track(c2x, c2y); track(nx, ny);
        x = nx; y = ny;
        break;
      }
      case 'Q': {
        const c1x = rx(toks[i++]); const c1y = ry(toks[i++]);
        const nx = rx(toks[i++]); const ny = ry(toks[i++]);
        track(c1x, c1y); track(nx, ny);
        x = nx; y = ny;
        break;
      }
      case 'T': {
        const nx = rx(toks[i++]); const ny = ry(toks[i++]);
        track(nx, ny);
        x = nx; y = ny;
        break;
      }
      case 'A': {
        // rx ry x-axis-rotation large-arc sweep x y — we just track
        // the endpoint and skip the flags / radii (arcs are very
        // rare in music glyphs).
        i += 5;
        const nx = rx(toks[i++]); const ny = ry(toks[i++]);
        track(nx, ny);
        x = nx; y = ny;
        break;
      }
      case 'Z': {
        x = startX; y = startY;
        break;
      }
      default:
        i++;
    }
  }
  if (minX === Infinity) { _bboxCache.set(d, null); return null; }
  const box = { minX, maxX, minY, maxY };
  _bboxCache.set(d, box);
  return box;
}
