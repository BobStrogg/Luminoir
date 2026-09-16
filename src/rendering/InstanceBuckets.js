import * as THREE from 'three';
import { SceneConfig } from './SceneConfig.js';
import { OPTIMIZATIONS } from './Optimizations.js';
import { parseSimpleLineD } from './pathD.js';

/** Scratch matrix reused by all bucketing helpers — avoids allocating a
 *  fresh `Matrix4` per glyph / line at scene-build time (a Sylvia-level
 *  score would be tens of thousands otherwise).  Callers that need to
 *  retain the result `.clone()` it.
 */
const _scratchMat = new THREE.Matrix4();

/**
 * Accumulates per-geometry instance buckets for `SVG3DBuilder.build()`.
 *
 * Rather than emit one `Mesh` per SVG element (which for a complex
 * score can reach tens of thousands of draw calls) every element is
 * grouped by its *geometry* so the emit phase can produce a single
 * `InstancedMesh` per group:
 *   1. *Glyphs*  — any SVG `<path>` that turned into an extruded
 *      `ShapeGeometry`.  Sharing is keyed on `(pathD, depth, material)`.
 *   2. *Boxes*   — staff / bar lines that used the simple
 *      `BoxGeometry` path.  A single unit cube instance, scaled and
 *      rotated per-line.
 */
export class InstanceBucketer {
  /** @type {Map<string, { geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[], noteIds: (string|null)[], kind: 'glyph' | 'path' }>} */
  glyphBuckets = new Map();
  /** @type {Map<string, { material: THREE.Material, matrices: THREE.Matrix4[] }>} */
  boxBuckets = new Map();

  /**
   * @param {(pathD: string, depth: number, kind: 'glyph'|'path') => THREE.BufferGeometry|null} makeExtrudedGeometry
   *   The builder's cached geometry factory.
   */
  constructor(makeExtrudedGeometry) {
    this._makeExtrudedGeometry = makeExtrudedGeometry;
  }

  /**
   * Add one instance of a path-derived extruded shape into the right
   * bucket.  Creates (and caches) the shared geometry on first use;
   * subsequent instances reuse it and just push a fresh transform.
   *
   * Many Verovio path-d strings (stems, ledger lines) are just a
   * `M x1 y1 L x2 y2` segment — i.e. a straight line.  Those have a
   * *different* d-string per note (because x1/y1/x2/y2 change), so
   * each one would create its own bucket and its own InstancedMesh,
   * defeating the whole point of bucketing.  Instead we detect the
   * line case and reroute these to the box-line bucket where every
   * stem in the score shares one shared `BoxGeometry`.
   *
   * @param {string} pathD
   * @param {number} depth
   * @param {THREE.Material} material
   * @param {'glyph'|'path'} kind SMuFL <use> glyph (0.48 scale) vs. page-margin path (1.0 scale + Y-flip)
   * @param {number} x @param {number} y @param {number} z
   * @param {string=} noteId Stable SVG element id of the owning note.
   *   Populated only for notehead glyphs — stems / child paths pass
   *   undefined.  The render worker later uses this to look up the
   *   `(mesh, instanceIndex)` for a given playing note.
   * @param {number=} rotation Z-axis rotation (radians) baked into the
   *   instance matrix.  Used by `<g class="arpeg" transform="rotate(...)">`
   *   so the wavy arpeggio symbol renders standing upright next to its
   *   chord rather than lying flat.  Skipped (zero) for the common
   *   case so unrotated glyphs don't pay an extra matrix multiply.
   * @param {boolean=} lodDetail Marks this element as a small per-note
   *   decoration (stem / flag / ledger line) for the
   *   `LOD_DISTANT_ELEMENTS` runtime pass — the emitted mesh's
   *   `userData.lodDetail` lets the render worker hide the bucket
   *   beyond `LOD_DISTANCE_THRESHOLD`.
   */
  addGlyph(pathD, depth, material, kind, x, y, z, noteId = null, rotation = 0, lodDetail = false) {
    // Path-kind paths (stems, ledger lines, etc.) that are plain line
    // segments go through the line-detection fast path.
    if (OPTIMIZATIONS.STEM_DEDUP && kind === 'path' && !rotation) {
      const line = parseSimpleLineD(pathD);
      if (line) {
        // Page-margin coords: subject to the same Y flip that the
        // extruded path geometry would get (`geo.scale(s, -s, s)`).
        const s = SceneConfig.scale;
        // Pass `z` (the owning note's elevation) through so the
        // stem sits in the same plane as its notehead — previously
        // hard-coded 0 left simple stems flush against the paper
        // while noteheads floated at `noteElevation`, which on
        // oblique camera angles looks like the note is detached
        // from its stem.
        this.addBoxLine(material,
          x + line.x1 * s, y - line.y1 * s,
          x + line.x2 * s, y - line.y2 * s,
          // 8-px-wide cross-section matching the staff-line style;
          // Z thickness is the shared `notationDepth` so simple
          // stems sit at the same depth as every other element.
          0.007, SceneConfig.notationDepth, z, lodDetail);
        return;
      }
    }
    const key = kind + ':' + material.uuid + ':' + depth + ':' + pathD;
    let bucket = this.glyphBuckets.get(key);
    if (!bucket) {
      const geometry = this._makeExtrudedGeometry(pathD, depth, kind);
      if (!geometry) return;
      bucket = { geometry, material, matrices: [], noteIds: [], kind, lodDetail: false };
      this.glyphBuckets.set(key, bucket);
    }
    // A bucket counts as "detail" if any contributor tags it — stems /
    // flags routed via note childPaths and via `otherElements` share
    // path-d buckets, and both classes are the small per-note
    // decorations the LOD pass targets.
    if (lodDetail) bucket.lodDetail = true;
    // Compose translate × rotateZ when rotation is requested; the plain
    // translate path is the hot one (every notehead, beam, stem, …)
    // so we keep its makeTranslation fast-path.
    let mat;
    if (rotation) {
      mat = new THREE.Matrix4();
      mat.makeRotationZ(rotation);
      // setPosition only writes the translation column, leaving the
      // rotation we just baked in intact.
      mat.setPosition(x, y, z);
    } else {
      mat = _scratchMat.makeTranslation(x, y, z).clone();
    }
    bucket.matrices.push(mat);
    bucket.noteIds.push(noteId || null);
  }

  /**
   * Add one box-line instance (staff / bar line).  Everything uses a
   * single shared `BoxGeometry(1,1,1)` in the emit phase; we just
   * store translate × rotateZ × scale per instance here.
   *
   * `zElevation` is the **Z** translation of the line in world space —
   * i.e. how far off the paper backdrop the line hovers.  Historical
   * note: this used to be called `yElevation` and was applied to the
   * `cy` (Y) translation, which silently turned into a tiny vertical
   * shift on the page rather than an elevation off the paper.  That
   * left simple-line stems rendered at z = 0 while their noteheads
   * sat at `SceneConfig.noteElevation = 0.04`, so from oblique camera
   * angles the notehead appeared to float off the staff with the
   * stem stuck down on the page — visible as a detached "halo" on
   * every note.  Using the value for Z instead (and passing
   * `SceneConfig.noteElevation` for stems) puts them in the same
   * plane as their owning note.
   */
  addBoxLine(material, x1, y1, x2, y2, widthAcross, depth, zElevation, lodDetail = false) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;
    // Detail-tagged lines (simple-line stems rerouted from
    // `addGlyph`) get their own bucket, separate from structural
    // lines that share the same material (beams also use `_noteMat`).
    // Costs at most one extra InstancedMesh per material, and lets
    // the LOD pass hide *just* the stems beyond the distance
    // threshold while beams / staff lines / bar lines stay visible.
    const key = material.uuid + (lodDetail ? ':detail' : '');
    let bucket = this.boxBuckets.get(key);
    if (!bucket) {
      bucket = { material, matrices: [], lodDetail, lodSize: 0 };
      this.boxBuckets.set(key, bucket);
    }
    // Track the *largest* cross-section in the bucket — sub-pixel
    // culling must only fire when even the widest member is invisible.
    if (widthAcross > bucket.lodSize) bucket.lodSize = widthAcross;
    const m = new THREE.Matrix4();
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    m.makeTranslation(cx, cy, zElevation);
    const ang = Math.abs(dy) > 0.0001 ? Math.atan2(dy, dx) : 0;
    if (ang !== 0) m.multiply(_scratchMat.makeRotationZ(ang));
    m.multiply(_scratchMat.makeScale(len, widthAcross, depth));
    bucket.matrices.push(m);
  }
}
