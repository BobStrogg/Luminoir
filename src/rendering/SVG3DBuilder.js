import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { SceneConfig } from './SceneConfig.js';
import { Materials } from './Materials.js';
import { OPTIMIZATIONS } from './Optimizations.js';
import { parsePathDToShapePath } from './pathD.js';
import { InstanceBucketer } from './InstanceBuckets.js';
import { emitInstancedChunks } from './InstancedChunkEmitter.js';
import { addPaper, addTitle, measureTitleLayout } from './PaperAndTitle.js';
import { buildOneMeshPerElement } from './LegacyMeshBuilder.js';

/**
 * Elements that count as "note-attached" rather than "decoration"
 * (stems, flags, beams — see `_bucketOtherElements` for the
 * classification rationale).
 */
const NOTE_ATTACHED_TYPES = new Set([
  'stem', 'flag', 'beam',
]);

/**
 * Converts parsed SVG scene data into Three.js geometry — SVG paths
 * become extruded 3D meshes laid flat on the paper plane.
 */
export class SVG3DBuilder {
  constructor() {
    this._noteMat = Materials.note();
    // Noteheads (the `glyphPath` on each `note`) use a white-base
    // variant so `InstancedMesh.setColorAt()` can recolour a note to
    // its staff's palette entry during playback without being muted
    // by a dark `material.color` multiplier.  Stems/flags/beams stay
    // on `_noteMat` and keep the default dark colour.
    this._noteHeadMat = Materials.noteHead();
    this._staffMat = Materials.staffLine();
    this._barMat = Materials.barLine();
    this._otherMat = Materials.other();
    /** Shared unit cube used by every box-line InstancedMesh (staff
     *  lines, bar lines, detected stem segments).  One geometry,
     *  per-instance scale × rotate × translate matrices supply the
     *  actual dimensions. */
    this._unitBox = new THREE.BoxGeometry(1, 1, 1);
    /** Extruded glyph geometries, shared across all notes that use
     *  the same SMuFL path.  Keyed by `(kind, depth, pathD)`. */
    this._geometryCache = new Map();
  }

  /**
   * Build the full 3D node hierarchy from a ParsedScene.
   *
   * Rather than emit one `Mesh` per SVG element (which for a complex
   * score can reach tens of thousands of draw calls) we group every
   * element by its *geometry* and emit a single `InstancedMesh` per
   * group.  The same extruded notehead shape is then drawn once per
   * frame for all N occurrences, with per-instance transforms
   * supplying each note's position.
   *
   * Two instance buckets are used (see `InstanceBucketer`):
   *   1. *Glyphs*  — any SVG `<path>` that turned into an extruded
   *      `ShapeGeometry`.  Sharing is keyed on `(pathD, depth, material)`.
   *   2. *Boxes*   — staff / bar lines that used the simple
   *      `BoxGeometry` path.  A single unit cube instance, scaled and
   *      rotated per-line.
   *
   * Draw-call count therefore scales with the number of *unique*
   * glyphs, not the number of notes.  For SMuFL music that's typically
   * 20–50, independent of score length.
   *
   * Along with the scene-graph root we return a `noteMeshMap`:
   * `Map<noteId, { mesh, index, material? }>` pointing at the
   * notehead instance (or, for count-1 buckets, the cloned per-note
   * material) for each note.  The render worker uses this to recolour
   * played notes via `InstancedMesh.setColorAt()` during playback.
   *
   * @param {import('../verovio/SVGSceneParser.js').ParsedScene} parsed
   * @returns {{ root: THREE.Group, noteMeshMap: Map<string, { mesh: THREE.Mesh, index: number, material?: THREE.Material }> }}
   */
  build(parsed) {
    const root = new THREE.Group();
    /** @type {Map<string, { mesh: THREE.Mesh, index: number, material?: THREE.Material }>} */
    const noteMeshMap = new Map();

    if (!OPTIMIZATIONS.BUCKET_INSTANCES) {
      // Fallback: one `THREE.Mesh` per SVG element.  Slow on large
      // scores (N draw calls) but a useful correctness baseline while
      // bisecting visual regressions — exactly the path we had before
      // the bucketing optimisations landed.
      buildOneMeshPerElement(this, root, parsed, noteMeshMap);
      return { root, noteMeshMap };
    }

    const bucketer = new InstanceBucketer(
      (pathD, depth, kind) => this.makeExtrudedGeometry(pathD, depth, kind),
    );
    this._bucketNotes(bucketer, parsed);
    this._bucketOtherElements(bucketer, parsed);
    this._bucketStaffAndBarLines(bucketer, parsed);
    this._emitBuckets(root, bucketer, parsed, noteMeshMap);

    const titleLayout = parsed.title ? measureTitleLayout(parsed.title, parsed.composer) : null;

    // --- Paper backdrop ---
    addPaper(root, parsed, titleLayout?.block);

    // --- Title block (top-left of paper) ---
    // The paper's far (top) margin is sized to fit the title block
    // plus equal padding above and below it — the score never
    // shifts to make room — so this is a pure on-paper render.  No-op
    // when `parsed.title` is null (e.g. when an unrecognised file is
    // imported and we couldn't derive a sensible name).
    if (parsed.title) {
      addTitle(root, parsed, titleLayout, this._otherMat);
    }

    return { root, noteMeshMap };
  }

  /**
   * Bucket noteheads + their child paths (stems, flags, ledger bits).
   */
  _bucketNotes(bucketer, parsed) {
    for (const note of parsed.notes) {
      if (note.glyphPath) {
        // Notehead: white-base material so `setColorAt` can recolour
        // it per-instance during playback.  Pass note.id so the
        // builder can build a noteId → (mesh, index) map.
        bucketer.addGlyph(note.glyphPath, SceneConfig.extrusionDepth,
          this._noteHeadMat, 'glyph', note.x, note.y, SceneConfig.noteElevation, note.id);
      }
      // Child paths (stems, flags, …) live in *page-margin* coords so we
      // offset them back into the note-local frame.  See the note
      // handling in `LegacyMeshBuilder` for the same derivation.
      // These use `_noteMat` (dark base) and don't get recoloured on
      // playback.
      //
      // `lodDetail: true` — these are exactly the "small per-note
      // decorations (child paths — stems, flags, ledger lines)" that
      // `OPTIMIZATIONS.LOD_DISTANT_ELEMENTS` is documented to skip
      // when the camera is beyond `LOD_DISTANCE_THRESHOLD`.  The tag
      // flows through the bucket onto the emitted meshes' `userData`,
      // where the render worker's per-frame LOD pass gates visibility.
      const offX = (note.ancestorX ?? 0) - note.x;
      const offY = (note.ancestorY ?? 0) - note.y;
      for (const d of note.childPaths) {
        bucketer.addGlyph(d, SceneConfig.extrusionDepth * 0.5,
          this._noteMat, 'path', note.x + offX, note.y + offY, SceneConfig.noteElevation,
          null, 0, true);
      }
    }
  }

  /**
   * Bucket clefs, accidentals, beams, flags and every other
   * non-note, non-structural element.
   *
   * Classify each element as either "note-attached" or "decoration".
   *
   * Note-attached are the bits that *make up* a note's visual
   * shape on the page — stems, flags, beams.  These have to share
   * the notehead's Z plane so the stem actually connects to its
   * notehead and the beam's bottom edge sits flush with each
   * stem's top instead of floating a millimetre below it.  They
   * use `_noteMat` so they match the dark notehead colour.
   *
   * Everything else — accidentals, ties, slurs, articulations,
   * augmentation dots, dynamics, expression marks, clefs, time /
   * key signatures, tuplet numbers, multi-measure rests, octave
   * brackets, system braces, pedal markers, fermatas, hairpins —
   * is *decoration*.  All of it sits on the lower
   * `otherElementsElevation` plane (Layer 2 in `SceneConfig`'s
   * elevation stack), distinctly below the notes.  This is what
   * gives the played notehead clear Z dominance over its
   * neighbouring accidentals / dots / dynamics; the previous list
   * included these decorations at `noteElevation` and a glowing
   * played note could end up Z-fighting with whatever decoration
   * happened to be parked on the same texel.  Decorations use
   * `_otherMat` (neutral ink colour, slightly lighter than note
   * black) so they read as printed annotations rather than
   * notehead extensions.
   *
   * The historical reason for the split was preventing a
   * duplication bug where stems were pushed into both
   * `note.childPaths` AND `otherElements` (via `_walkTree`'s
   * recursion), producing a pair of stems at different Z levels.
   * That bug stays fixed regardless of which types live in
   * `NOTE_ATTACHED_TYPES`; this is now purely a visual-priority
   * decision.
   */
  _bucketOtherElements(bucketer, parsed) {
    for (const el of parsed.otherElements) {
      const attached = NOTE_ATTACHED_TYPES.has(el.type);
      const mat = attached ? this._noteMat : this._otherMat;
      const z = attached ? SceneConfig.noteElevation : SceneConfig.otherElementsElevation;
      // Stems and flags are the per-note detail class the LOD pass can
      // hide at distance.  Beams are deliberately NOT tagged: they're
      // thick horizontal bars that remain clearly visible well past
      // the LOD threshold, and hiding them would visibly change the
      // music's texture at moderate zoom-outs.
      const lodDetail = el.type === 'stem' || el.type === 'flag';
      if (el.isLine) {
        // Beam bars (and any future axis-aligned quad elements) are
        // emitted by the parser as `isLine: true` with a thickness.
        // Route them through the shared box bucket so every beam in
        // the piece collapses into a single `InstancedMesh` — without
        // this, each unique beam geometry produces its own plain
        // `Mesh` and Sylvia-sized scores pay hundreds of extra
        // draw calls per frame.  The Z extrusion uses the shared
        // `notationDepth` rather than `thickness × 0.5` so a wide
        // beam doesn't end up with 10× the depth of a stem or
        // notehead — they all bulge out of the page by the same
        // amount.
        const thickness = el.thickness ?? SceneConfig.staffLineThickness;
        bucketer.addBoxLine(mat,
          el.x1, el.y1, el.x2, el.y2,
          thickness,
          SceneConfig.notationDepth,
          z, lodDetail);
      } else if (el.glyphPath) {
        bucketer.addGlyph(el.glyphPath, SceneConfig.extrusionDepth * 0.8,
          mat, 'glyph', el.x, el.y, z, null, el.rotation || 0, lodDetail);
      } else if (el.d) {
        bucketer.addGlyph(el.d, SceneConfig.extrusionDepth * 0.5,
          mat, 'path', el.x, el.y, z, null, el.rotation || 0, lodDetail);
      }
    }
  }

  /**
   * Bucket staff lines + bar lines (structural; never LOD-tagged).
   */
  _bucketStaffAndBarLines(bucketer, parsed) {
    // --- Staff lines ---
    for (const sl of parsed.staffLines) {
      if (sl.isLine) {
        bucketer.addBoxLine(this._staffMat,
          sl.x1, sl.y1, sl.x2, sl.y2,
          SceneConfig.staffLineThickness,
          SceneConfig.notationDepth,
          SceneConfig.staffLineElevation);
      } else if (sl.d) {
        bucketer.addGlyph(sl.d, 16,
          this._staffMat, 'path', sl.x || 0, sl.y || 0,
          SceneConfig.staffLineElevation);
      }
    }

    // --- Bar lines ---
    for (const bl of parsed.barLines) {
      if (bl.isLine) {
        bucketer.addBoxLine(this._barMat,
          bl.x1, bl.y1, bl.x2, bl.y2,
          SceneConfig.barLineWidth,
          SceneConfig.notationDepth,
          SceneConfig.barLineElevation);
      } else if (bl.d) {
        bucketer.addGlyph(bl.d, 20,
          this._barMat, 'path', bl.x || 0, bl.y || 0, SceneConfig.barLineElevation);
      }
    }
  }

  /**
   * Emit one InstancedMesh per glyph bucket / box bucket.
   *
   * Within each bucket we further chunk by X so Three.js can frustum-
   * cull off-screen chunks.  The chunk width is *adaptive*: on a wide
   * orchestral score (hundreds of world units) a fixed 4-unit chunk
   * produces thousands of InstancedMeshes, which costs enough in
   * per-frame scene-graph traversal to dwarf the culling benefit on
   * some drivers.  We cap the chunk count at `MAX_CHUNKS_PER_BUCKET`
   * per bucket, widening each chunk as needed.
   */
  _emitBuckets(root, bucketer, parsed, noteMeshMap) {
    const MAX_CHUNKS_PER_BUCKET = 30;
    const MIN_CHUNK_WIDTH = 4;
    const scoreWidth = Math.max(1, parsed.totalWidth || 1);
    const CULL_CHUNK_WIDTH = Math.max(MIN_CHUNK_WIDTH, scoreWidth / MAX_CHUNKS_PER_BUCKET);
    // Default per-instance tint applied to every notehead InstancedMesh
    // at build time so unplayed notes render at the same dark colour
    // as the non-head note paths (the stems / flags still use
    // `_noteMat` which has its base colour baked in).
    const noteHeadDefault = new THREE.Color(
      SceneConfig.noteColor.r,
      SceneConfig.noteColor.g,
      SceneConfig.noteColor.b,
    );
    for (const bucket of bucketer.glyphBuckets.values()) {
      const isNoteHead = bucket.material === this._noteHeadMat;
      // World-unit footprint of one glyph instance — instance matrices
      // for glyphs are pure translations, so the shared geometry's
      // bounding box IS the world size.  The runtime LOD pass uses
      // this for `DISTANCE_CLIP_GLYPHS` sub-pixel culling.
      if (!bucket.geometry.boundingBox) bucket.geometry.computeBoundingBox();
      const bb = bucket.geometry.boundingBox;
      const lodSize = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y);
      emitInstancedChunks(
        root, bucket.geometry, bucket.material, bucket.matrices,
        CULL_CHUNK_WIDTH,
        isNoteHead ? noteHeadDefault : null,
        isNoteHead ? bucket.noteIds : null,
        isNoteHead ? noteMeshMap : null,
        { lodSize, lodDetail: !!bucket.lodDetail },
      );
    }

    // --- Emit one InstancedMesh per box bucket -------------------------
    for (const bucket of bucketer.boxBuckets.values()) {
      // Box lines use their largest cross-section width as the LOD
      // size: a line vanishes visually when its *thin* axis goes
      // sub-pixel, regardless of its length.  Only detail-tagged line
      // buckets (stems) participate; structural lines (staff, bar,
      // beams) carry lodDetail=false and are never hidden by the
      // distance rule — for them lodSize=0 also disables sub-pixel
      // culling, keeping the page structure visible at any zoom.
      emitInstancedChunks(root, this._unitBox, bucket.material, bucket.matrices, CULL_CHUNK_WIDTH,
        null, null, null,
        { lodSize: bucket.lodDetail ? bucket.lodSize : 0, lodDetail: !!bucket.lodDetail });
    }
  }

  /**
   * Produce the extruded BufferGeometry for a single path-d string.
   * Caches by `(pathD, depth, kind)` so repeated calls don't re-extrude
   * the same shape.  Returns `null` on parse failure.
   */
  makeExtrudedGeometry(pathD, depth, kind) {
    const cacheKey = kind + ':' + depth + ':' + pathD;
    const cached = this._geometryCache.get(cacheKey);
    if (cached) return cached;
    try {
      const shapes = this._pathToShapes(pathD);
      if (!shapes || shapes.length === 0) return null;
      const geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
      if (kind === 'glyph') {
        // SMuFL <use> glyph: viewBox 1000 → <use width="480"/> ⇒ 0.48.
        const worldScale = SceneConfig.scale * SceneConfig.glyphUseScale;
        geo.scale(worldScale, worldScale, worldScale);
      } else {
        // Page-margin path (stems, flags, bars, staff lines): raw SVG
        // coords; flip Y to undo SVG's Y-down convention.
        const s = SceneConfig.scale;
        geo.scale(s, -s, s);
      }
      geo.computeVertexNormals();
      this._geometryCache.set(cacheKey, geo);
      return geo;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  SVG path parsing                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Parse an SVG path `d` string into an array of Three.js `Shape`s.
   *
   * We can't use `SVGLoader.parse()` here because it goes through
   * `DOMParser`, which isn't available inside the render Web Worker
   * (Chromium workers don't expose it).  Instead we build a
   * `THREE.ShapePath` directly from the path-data tokens and then
   * hand it to `SVGLoader.createShapes()` (which is DOM-free).
   */
  _pathToShapes(d) {
    const shapePath = parsePathDToShapePath(d);
    return SVGLoader.createShapes(shapePath);
  }

  dispose() {
    this._geometryCache.forEach((geo) => geo.dispose());
    this._geometryCache.clear();
    this._unitBox.dispose();
  }
}
