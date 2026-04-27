/**
 * Linearise repeated sections of a parsed Verovio scene so the
 * rendered 3D layout shows every measure in actual playback order —
 * a `|: A B C :| D` piece becomes `A B C A B C D` laid out left-to-
 * right, with the second pass of A/B/C rendered as duplicate measures
 * to the right of the original ones.
 *
 * Why this exists
 * ---------------
 * Verovio is a layout engine for *engraved* music: it draws every
 * measure exactly once and uses a `|:` / `:|` repeat barline to
 * indicate the re-pass.  But its MIDI export and its timemap **do**
 * unfold the repeats — they emit two passes through the bar, with
 * the rendition-2 notes carrying a `-rend2` xml:id suffix
 * (`-rend3` for D.C. / D.S. third-pass; etc.).  Without unrolling,
 * the visual playhead has nowhere to go during the second pass: it
 * either jumps back to the start of the repeat (which the user
 * called out as confusing) or freezes at the end of the first pass
 * (which looks like "the audio kept going but the balls stopped").
 *
 * This module takes the parsed scene + Verovio's timemap and produces
 * a new parsed scene where every rendition is a *physical* copy of
 * the source measure's geometry, translated to its slot in the
 * unfolded sequence.  The 3D builder sees a longer linear score with
 * unique ids on every notehead; nothing else has to change.
 *
 * Algorithm
 * ---------
 *  1. Build a `noteId → measureId` map from the parsed notes (the
 *     parser tags each note with `measure: <enclosing measure id>`).
 *  2. Walk the timemap once to derive the *measure playback order* —
 *     for each `on` event, classify it by base id + rendition suffix
 *     (`-rend\d+`) and push the measure id when it changes.
 *  3. For each parsed measure, compute its X bounds (min/max x across
 *     every note + element + line endpoint).
 *  4. Iterate the measure playback order, laying out each rendition
 *     at the next slot:
 *       • original (no suffix) → place at the measure's natural X
 *         (existing entries reused, no duplication needed)
 *       • repeat (e.g. `-rend2`) → clone every parsed entry tagged
 *         with that measure, shift its x/x1/x2/ancestorX by the
 *         delta from the original, and append `-rend2` to its id
 *         so it has its own slot in the note-mesh map.
 *  5. Emit the bar-line that originally sat at the end of the
 *     measure with its X also shifted.
 *  6. Carry over staff lines, bar lines, and `otherElements`
 *     (clefs/dynamics/dots/pedal brackets/…) tagged with the
 *     duplicated measure — same shift treatment as the notes.
 *
 * Edge cases
 * ----------
 *   • Voltas / 1st & 2nd endings are encoded by Verovio in the
 *     timemap order itself (the 1st-ending bar simply doesn't
 *     appear in the second-pass entries).  We don't need to detect
 *     them explicitly — whichever measures the timemap visits in
 *     pass 2 are the ones we duplicate.
 *
 *   • Some entries have no measure tag (page-level title / system
 *     bracket / staff lines that span before the first measure
 *     starts).  We pass them through unchanged.
 *
 *   • If the timemap has no `-rend\d+` suffixes anywhere, the score
 *     has no repeats and we bail out early returning the input
 *     scene untouched.
 */

const RENDITION_SUFFIX = /-rend\d+$/;

/**
 * @typedef {Object} ParsedScene
 * @property {Array<any>} notes
 * @property {Array<any>} staffLines
 * @property {Array<any>} barLines
 * @property {Array<any>} otherElements
 * @property {number} totalWidth
 * @property {number} totalHeight
 * @property {number} contentMinX
 * @property {number} contentMinY
 * @property {number} scale
 *
 * @typedef {Object} TimemapEntry
 * @property {number} [tstamp]
 * @property {string[]} [on]
 * @property {string[]} [off]
 */

/**
 * @param {ParsedScene} parsed
 * @param {TimemapEntry[]} timemap
 * @returns {ParsedScene}
 */
export function unrollRepeats(parsed, timemap) {
  if (!parsed || !timemap || timemap.length === 0) return parsed;

  // Quick exit: if no `-rend\d+` ids appear anywhere in the timemap,
  // the score has no repeats; skip all the bookkeeping.
  if (!_hasAnyRenditions(timemap)) return parsed;

  // 1. noteId -> measureId
  const noteIdToMeasure = new Map();
  for (const n of parsed.notes) {
    if (n.id && n.measure) noteIdToMeasure.set(n.id, n.measure);
  }
  if (noteIdToMeasure.size === 0) return parsed;

  // 2. measure playback order (measure ids in the order they're
  //    actually played, with rendition suffix on repeated visits)
  const measureOrder = _measureOrderFromTimemap(timemap, noteIdToMeasure);
  if (measureOrder.length === 0) return parsed;

  // 3. group parsed entries by measure + compute X bounds per measure
  const elementsByMeasure = _groupByMeasure(parsed);
  const measureBounds = _measureBounds(elementsByMeasure);

  // Pre-bucket the orphaned entries (no measure tag) — they pass
  // through unchanged.  Common case: page-level title / tempo / system
  // brackets attached to the score header rather than any single bar.
  const orphan = {
    notes: parsed.notes.filter((n) => !n.measure),
    staffLines: parsed.staffLines.filter((s) => !s.measure),
    barLines: parsed.barLines.filter((b) => !b.measure),
    otherElements: parsed.otherElements.filter((e) => !e.measure),
  };

  // 4. lay out renditions
  /** @type {ParsedScene} */
  const out = {
    notes: [...orphan.notes],
    staffLines: [...orphan.staffLines],
    barLines: [...orphan.barLines],
    otherElements: [...orphan.otherElements],
    scale: parsed.scale,
    contentMinX: parsed.contentMinX,
    contentMinY: parsed.contentMinY,
    totalWidth: parsed.totalWidth,
    totalHeight: parsed.totalHeight,
    // Y-bounds are unaffected by repeat unrolling — we only fan
    // measures out along X — so the parser-computed staff bounds
    // pass through unchanged.
    staffMaxY: parsed.staffMaxY,
    staffMinY: parsed.staffMinY,
  };

  // Walk the measure playback order, placing each measure's elements
  // at successive X positions.  `cursorX` is where the *next* measure
  // starts.  The first iteration seeds the cursor from the original
  // first-played measure's minX so we don't shift the score sideways.
  let cursorX = null;
  for (const item of measureOrder) {
    const { measureId, suffix } = item;
    const bounds = measureBounds.get(measureId);
    if (!bounds) continue; // measure parsed nothing useful (mid-rest etc.)
    if (cursorX === null) cursorX = bounds.minX;

    const offset = cursorX - bounds.minX;
    _appendMeasure(out, elementsByMeasure.get(measureId), offset, suffix);

    cursorX += bounds.maxX - bounds.minX;
  }

  // 5. update bbox for the now-wider score (parser uses contentMinX
  //    as the paper's left edge; we keep that anchored at the
  //    original min and just expand totalWidth to cover the new
  //    right edge.)
  if (cursorX !== null) {
    const newRightEdge = cursorX;
    const left = Math.min(parsed.contentMinX, _minX(out));
    out.contentMinX = left;
    out.totalWidth = newRightEdge - left;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

function _hasAnyRenditions(timemap) {
  for (const entry of timemap) {
    if (!entry.on) continue;
    for (const id of entry.on) {
      if (RENDITION_SUFFIX.test(id)) return true;
    }
  }
  return false;
}

/**
 * Walk the timemap and emit one entry per measure-change in playback
 * order.  Suffix is `''` for the original pass, `-rend2` (etc.) for
 * subsequent passes — preserved verbatim so the unroller can append
 * it to every cloned id and the timeline build then matches the
 * cloned ids without further mangling.
 *
 * @returns {Array<{ measureId: string, suffix: string, time: number }>}
 */
function _measureOrderFromTimemap(timemap, noteIdToMeasure) {
  const out = [];
  let lastKey = null;
  for (const entry of timemap) {
    const ons = entry.on;
    if (!ons || ons.length === 0) continue;
    const tSec = (entry.tstamp || 0) / 1000;
    for (const id of ons) {
      const sufMatch = id.match(RENDITION_SUFFIX);
      const suffix = sufMatch ? sufMatch[0] : '';
      const baseId = suffix ? id.slice(0, -suffix.length) : id;
      const measureId = noteIdToMeasure.get(baseId);
      if (!measureId) continue;
      const key = measureId + suffix;
      if (key !== lastKey) {
        out.push({ measureId, suffix, time: tSec });
        lastKey = key;
      }
    }
  }
  return out;
}

function _groupByMeasure(parsed) {
  /** @type {Map<string, { notes: any[], staffLines: any[], barLines: any[], otherElements: any[] }>} */
  const map = new Map();
  const ensure = (mid) => {
    let g = map.get(mid);
    if (!g) {
      g = { notes: [], staffLines: [], barLines: [], otherElements: [] };
      map.set(mid, g);
    }
    return g;
  };
  for (const n of parsed.notes) if (n.measure) ensure(n.measure).notes.push(n);
  for (const s of parsed.staffLines) if (s.measure) ensure(s.measure).staffLines.push(s);
  for (const b of parsed.barLines) if (b.measure) ensure(b.measure).barLines.push(b);
  for (const e of parsed.otherElements) if (e.measure) ensure(e.measure).otherElements.push(e);
  return map;
}

function _measureBounds(elementsByMeasure) {
  const bounds = new Map();
  for (const [mid, g] of elementsByMeasure) {
    let minX = Infinity, maxX = -Infinity;
    const track = (x) => {
      if (typeof x !== 'number') return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    };
    // Notes: their `x` is the SMuFL <use> translate, i.e. the actual
    // notehead position on the page — trustworthy.
    for (const n of g.notes) track(n.x);

    // Staff / bar / line-form decoration: x1/x2 are the segment's
    // endpoints, also trustworthy.  We deliberately skip the rare
    // path-form entries here; their `x` is the ancestor translate
    // (always 0.5 = page-margin start in Verovio output) and would
    // collapse every measure's minX onto the page-margin.
    for (const s of g.staffLines) {
      if (s.isLine) { track(s.x1); track(s.x2); }
    }
    for (const b of g.barLines) {
      if (b.isLine) { track(b.x1); track(b.x2); }
    }

    // Other elements: glyph (<use>) and isLine entries have real
    // positions; `d`-form path entries (stems, simple ledger paths,
    // grpSym braces) carry the page-margin translate as their `x`,
    // not their actual visual position — *exclude* those from
    // bounds.  They still get duplicated correctly: shifting their
    // `x` by the per-measure offset moves the whole stem by that
    // delta because the geometry is `x + path_d * scale`.
    for (const e of g.otherElements) {
      if (e.isLine) { track(e.x1); track(e.x2); }
      else if (e.glyphPath) track(e.x);
      // skip `e.d` entries
    }
    if (minX !== Infinity) bounds.set(mid, { minX, maxX });
  }
  return bounds;
}

/**
 * Emit a measure's worth of geometry onto `out`, shifted by `offset`
 * along X and (for renditions ≥ 2) with the rendition suffix appended
 * to every `id`.
 *
 * The original (suffix='') pass just clones the entries with the
 * possibly-zero offset and an unsuffixed id; this keeps the existing
 * note-mesh-map keys stable so anything outside the unroller (light
 * balls, played-note coloring) sees the same ids before and after.
 *
 * For repeat passes (suffix='-rend2' or higher) we also need fresh
 * ids on the *child* paths inside notes (stems, flags) so the 3D
 * builder doesn't accidentally bucket them together with the
 * originals — but since those child paths aren't keyed by id in the
 * mesh map, and InstancedMesh bucketing is by path-d (not id), we
 * don't have to do anything special there.
 */
function _appendMeasure(out, group, offset, suffix) {
  if (!group) return;
  const sx = (v) => v + offset;
  const renameId = (id) => (id && suffix) ? id + suffix : id;

  for (const n of group.notes) {
    out.notes.push({
      ...n,
      x: sx(n.x),
      ancestorX: typeof n.ancestorX === 'number' ? sx(n.ancestorX) : n.ancestorX,
      id: renameId(n.id),
    });
  }
  for (const s of group.staffLines) {
    if (s.isLine) {
      out.staffLines.push({ ...s, x1: sx(s.x1), x2: sx(s.x2) });
    } else {
      out.staffLines.push({ ...s, x: sx(s.x) });
    }
  }
  for (const b of group.barLines) {
    if (b.isLine) {
      out.barLines.push({ ...b, x1: sx(b.x1), x2: sx(b.x2) });
    } else {
      out.barLines.push({ ...b, x: sx(b.x) });
    }
  }
  for (const e of group.otherElements) {
    if (e.isLine) {
      out.otherElements.push({ ...e, x1: sx(e.x1), x2: sx(e.x2) });
    } else {
      out.otherElements.push({ ...e, x: sx(e.x) });
    }
  }
}

function _minX(parsed) {
  let m = Infinity;
  for (const n of parsed.notes) if (n.x < m) m = n.x;
  for (const s of parsed.staffLines) {
    const x = s.isLine ? Math.min(s.x1, s.x2) : s.x;
    if (x < m) m = x;
  }
  for (const b of parsed.barLines) {
    const x = b.isLine ? Math.min(b.x1, b.x2) : b.x;
    if (x < m) m = x;
  }
  return m === Infinity ? 0 : m;
}
