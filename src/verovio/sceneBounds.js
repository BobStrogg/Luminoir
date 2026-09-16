import { SceneConfig } from '../rendering/SceneConfig.js';
import { pathBBox } from './svgPathBounds.js';

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
export function computeBounds(out) {
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
    const bb = pathBBox(d);
    if (!bb) { track(x, y); return; }
    track(x + bb.minX * pathScale, y - bb.maxY * pathScale);
    track(x + bb.maxX * pathScale, y - bb.minY * pathScale);
  };

  const glyphWorldScale = SceneConfig.scale * SceneConfig.glyphUseScale;
  for (const n of out.notes) {
    const bb = pathBBox(n.glyphPath);
    if (bb) {
      track(n.x + bb.minX * glyphWorldScale, n.y + bb.minY * glyphWorldScale);
      track(n.x + bb.maxX * glyphWorldScale, n.y + bb.maxY * glyphWorldScale);
    } else {
      track(n.x, n.y);
    }
  }

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

  // Other elements: glyph (<use>) entries are tracked by their full
  // path bounding box (scaled by glyphUseScale) so that wide glyphs
  // like dynamics ("mf", "ff") don't overhang the paper edge.
  // Path entries go through `trackPath` so their full visual extent
  // contributes (pedal markers below the bass staff, octave brackets
  // above the treble, system braces spanning all staves, etc.)
  // without polluting the bounds with the (0.5, -0.5) ancestor
  // translate carried by stem-like absolute-coord paths.
  for (const el of out.otherElements) {
    if (el.isLine) {
      track(el.x1, el.y1);
      track(el.x2, el.y2);
    } else if (el.glyphPath) {
      // Glyph paths use uniform positive-Y scaling (no Y flip):
      //   world = (el.x + glyph.x × glyphWorldScale,
      //            el.y + glyph.y × glyphWorldScale)
      const bb = pathBBox(el.glyphPath);
      if (bb) {
        track(el.x + bb.minX * glyphWorldScale, el.y + bb.minY * glyphWorldScale);
        track(el.x + bb.maxX * glyphWorldScale, el.y + bb.maxY * glyphWorldScale);
      } else {
        track(el.x, el.y);
      }
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
 * These bounds are retained as diagnostic metadata; paper sizing
 * uses full rendered-content bounds.
 *
 * Returns `{ minY: null, maxY: null }` if no non-ledger staff
 * lines were collected (the parser handles unknown markup
 * gracefully — fallback in `parse()` reuses the full content
 * bounds).
 *
 * @returns {{ minY: number|null, maxY: number|null }}
 */
export function computeStaffBounds(out) {
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
    } else if (sl.d) {
      const bb = pathBBox(sl.d);
      if (bb) {
        const pathMinY = sl.y - bb.maxY * SceneConfig.scale;
        const pathMaxY = sl.y - bb.minY * SceneConfig.scale;
        if (pathMinY < minY) minY = pathMinY;
        if (pathMaxY > maxY) maxY = pathMaxY;
      }
    } else if (typeof sl.y === 'number') {
      if (sl.y < minY) minY = sl.y;
      if (sl.y > maxY) maxY = sl.y;
    }
  }
  if (minY === Infinity) return { minY: null, maxY: null };
  return { minY, maxY };
}
