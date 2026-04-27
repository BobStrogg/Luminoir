import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { SceneConfig } from './SceneConfig.js';
import { Materials } from './Materials.js';
import { OPTIMIZATIONS } from './Optimizations.js';
import {
  rasteriseTitleBlock,
  computePageMargins,
  TITLE_LEFT_PADDING,
} from './TitleBlock.js';

/** Scratch matrix reused by all bucketing helpers — avoids allocating a
 *  fresh `Matrix4` per glyph / line at scene-build time (a Sylvia-level
 *  score would be tens of thousands otherwise).  Callers that need to
 *  retain the result `.clone()` it.
 */
const _scratchMat = new THREE.Matrix4();

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
   * Two instance buckets are used:
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
      this._buildOneMeshPerElement(root, parsed, noteMeshMap);
      return { root, noteMeshMap };
    }

    /** @type {Map<string, { geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[], noteIds: (string|null)[], kind: 'glyph' | 'path' }>} */
    const glyphBuckets = new Map();
    /** @type {Map<string, { material: THREE.Material, matrices: THREE.Matrix4[] }>} */
    const boxBuckets = new Map();
    // Side-channel used by `_bucketGlyph` when a path-d turns out to
    // be a simple M-L line — those are rerouted to boxBuckets for
    // aggressive draw-call coalescing.  We stash the reference so the
    // nested call can reach it without an extra argument.
    this._sharedBoxBuckets = boxBuckets;

    // --- Notes ---
    for (const note of parsed.notes) {
      if (note.glyphPath) {
        // Notehead: white-base material so `setColorAt` can recolour
        // it per-instance during playback.  Pass note.id so the
        // builder can build a noteId → (mesh, index) map.
        this._bucketGlyph(glyphBuckets, note.glyphPath, SceneConfig.extrusionDepth,
          this._noteHeadMat, 'glyph', note.x, note.y, SceneConfig.noteElevation, note.id);
      }
      // Child paths (stems, flags, …) live in *page-margin* coords so we
      // offset them back into the note-local frame.  See `_buildNote` below
      // for the full derivation.  These use `_noteMat` (dark base) and
      // don't get recoloured on playback.
      const offX = (note.ancestorX ?? 0) - note.x;
      const offY = (note.ancestorY ?? 0) - note.y;
      for (const d of note.childPaths) {
        this._bucketGlyph(glyphBuckets, d, SceneConfig.extrusionDepth * 0.5,
          this._noteMat, 'path', note.x + offX, note.y + offY, SceneConfig.noteElevation);
      }
    }

    // --- Other elements (clefs, accidentals, beams, flags, …) ---
    //
    // Classify each element as either "note-attached" or "decoration".
    //
    // Note-attached are the bits that *make up* a note's visual
    // shape on the page — stems, flags, beams.  These have to share
    // the notehead's Z plane so the stem actually connects to its
    // notehead and the beam's bottom edge sits flush with each
    // stem's top instead of floating a millimetre below it.  They
    // use `_noteMat` so they match the dark notehead colour.
    //
    // Everything else — accidentals, ties, slurs, articulations,
    // augmentation dots, dynamics, expression marks, clefs, time /
    // key signatures, tuplet numbers, multi-measure rests, octave
    // brackets, system braces, pedal markers, fermatas, hairpins —
    // is *decoration*.  All of it sits on the lower
    // `otherElementsElevation` plane (Layer 2 in `SceneConfig`'s
    // elevation stack), distinctly below the notes.  This is what
    // gives the played notehead clear Z dominance over its
    // neighbouring accidentals / dots / dynamics; the previous list
    // included these decorations at `noteElevation` and a glowing
    // played note could end up Z-fighting with whatever decoration
    // happened to be parked on the same texel.  Decorations use
    // `_otherMat` (neutral ink colour, slightly lighter than note
    // black) so they read as printed annotations rather than
    // notehead extensions.
    //
    // The historical reason for the split was preventing a
    // duplication bug where stems were pushed into both
    // `note.childPaths` AND `otherElements` (via `_walkTree`'s
    // recursion), producing a pair of stems at different Z levels.
    // That bug stays fixed regardless of which types live in
    // `NOTE_ATTACHED_TYPES`; this is now purely a visual-priority
    // decision.
    const NOTE_ATTACHED_TYPES = new Set([
      'stem', 'flag', 'beam',
    ]);
    for (const el of parsed.otherElements) {
      const attached = NOTE_ATTACHED_TYPES.has(el.type);
      const mat = attached ? this._noteMat : this._otherMat;
      const z = attached ? SceneConfig.noteElevation : SceneConfig.otherElementsElevation;
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
        this._bucketBoxLine(boxBuckets, mat,
          el.x1, el.y1, el.x2, el.y2,
          thickness,
          SceneConfig.notationDepth,
          z);
      } else if (el.glyphPath) {
        this._bucketGlyph(glyphBuckets, el.glyphPath, SceneConfig.extrusionDepth * 0.8,
          mat, 'glyph', el.x, el.y, z, null, el.rotation || 0);
      } else if (el.d) {
        this._bucketGlyph(glyphBuckets, el.d, SceneConfig.extrusionDepth * 0.5,
          mat, 'path', el.x, el.y, z, null, el.rotation || 0);
      }
    }

    // --- Staff lines ---
    for (const sl of parsed.staffLines) {
      if (sl.isLine) {
        this._bucketBoxLine(boxBuckets, this._staffMat,
          sl.x1, sl.y1, sl.x2, sl.y2,
          SceneConfig.staffLineThickness,
          SceneConfig.notationDepth,
          SceneConfig.staffLineElevation);
      } else if (sl.d) {
        this._bucketGlyph(glyphBuckets, sl.d, 16,
          this._staffMat, 'path', sl.x || 0, sl.y || 0,
          SceneConfig.staffLineElevation);
      }
    }

    // --- Bar lines ---
    for (const bl of parsed.barLines) {
      if (bl.isLine) {
        this._bucketBoxLine(boxBuckets, this._barMat,
          bl.x1, bl.y1, bl.x2, bl.y2,
          SceneConfig.barLineWidth,
          SceneConfig.notationDepth,
          SceneConfig.barLineElevation);
      } else if (bl.d) {
        this._bucketGlyph(glyphBuckets, bl.d, 20,
          this._barMat, 'path', bl.x || 0, bl.y || 0, SceneConfig.barLineElevation);
      }
    }

    // --- Emit one InstancedMesh per glyph bucket -----------------------
    //
    // Within each bucket we further chunk by X so Three.js can frustum-
    // cull off-screen chunks.  The chunk width is *adaptive*: on a wide
    // orchestral score (hundreds of world units) a fixed 4-unit chunk
    // produces thousands of InstancedMeshes, which costs enough in
    // per-frame scene-graph traversal to dwarf the culling benefit on
    // some drivers.  We cap the chunk count at `MAX_CHUNKS_PER_BUCKET`
    // per bucket, widening each chunk as needed.
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
    for (const bucket of glyphBuckets.values()) {
      const isNoteHead = bucket.material === this._noteHeadMat;
      this._emitInstancedChunks(
        root, bucket.geometry, bucket.material, bucket.matrices,
        CULL_CHUNK_WIDTH,
        isNoteHead ? noteHeadDefault : null,
        isNoteHead ? bucket.noteIds : null,
        isNoteHead ? noteMeshMap : null,
      );
    }

    // --- Emit one InstancedMesh per box bucket -------------------------
    for (const bucket of boxBuckets.values()) {
      this._emitInstancedChunks(root, this._unitBox, bucket.material, bucket.matrices, CULL_CHUNK_WIDTH);
    }

    // --- Paper backdrop ---
    this._addPaper(root, parsed);

    // --- Title block (top-left of paper) ---
    // The paper's far (top) margin is sized to fit the title block
    // plus equal padding above and below it — the score never
    // shifts to make room — so this is a pure on-paper render.  No-op
    // when `parsed.title` is null (e.g. when an unrecognised file is
    // imported and we couldn't derive a sensible name).
    if (parsed.title) {
      this._addTitle(root, parsed);
    }

    return { root, noteMeshMap };
  }

  /* ------------------------------------------------------------------ */
  /*  No-instancing fallback                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Pre-optimisation build path: one `THREE.Mesh` per SVG element.
   *
   * This is a correctness baseline — slow, but uses the exact same
   * geometry that the bucketed path does, with no instance matrices,
   * no chunking, no stem dedup, and no shared unit-box.  If a visual
   * regression reproduces on the bucketed path but clears here, we
   * know the bug lives in one of the bucketing helpers.
   *
   * Also populates `noteMeshMap` so the fallback supports the same
   * played-note colouring as the bucketed path — each notehead gets
   * its own cloned `_noteHeadMat` and we track the material.
   *
   * @param {THREE.Group} root
   * @param {import('../verovio/SVGSceneParser.js').ParsedScene} parsed
   * @param {Map<string, { mesh: THREE.Mesh, index: number, material?: THREE.Material }>} noteMeshMap
   */
  _buildOneMeshPerElement(root, parsed, noteMeshMap) {
    const s = SceneConfig.scale;

    const addGlyph = (pathD, depth, material, kind, x, y, z, noteId = null, rotation = 0) => {
      const geometry = this._makeExtrudedGeometry(pathD, depth, kind);
      if (!geometry) return;
      // Clone the material for noteheads so each one can be coloured
      // independently during playback.
      const perMeshMat = (material === this._noteHeadMat && noteId)
        ? material.clone()
        : material;
      const mesh = new THREE.Mesh(geometry, perMeshMat);
      if (perMeshMat !== material) {
        perMeshMat.color.setRGB(
          SceneConfig.noteColor.r, SceneConfig.noteColor.g, SceneConfig.noteColor.b,
        );
      }
      mesh.position.set(x, y, z);
      if (rotation) mesh.rotation.z = rotation;
      // Match the bucketed path: frustum culling disabled on every
      // content mesh to work around a Chromium WebGPU culling bug.
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      root.add(mesh);
      if (noteId && noteMeshMap) {
        noteMeshMap.set(noteId, { mesh, index: -1, material: perMeshMat });
      }
    };

    const addBoxLine = (material, x1, y1, x2, y2, widthAcross, depth, zElevation) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) return;
      const geo = new THREE.BoxGeometry(len, widthAcross, depth);
      const mesh = new THREE.Mesh(geo, material);
      // Position in world space: X/Y from the line midpoint, Z from
      // the caller-supplied elevation.  See `_bucketBoxLine` for the
      // history behind this parameter — it used to be misnamed as a
      // Y offset and put stems on the paper plane instead of at the
      // note's hover height.
      mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, zElevation);
      if (Math.abs(dy) > 0.0001) mesh.rotation.z = Math.atan2(dy, dx);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      root.add(mesh);
    };

    // Notes
    for (const note of parsed.notes) {
      if (note.glyphPath) {
        addGlyph(note.glyphPath, SceneConfig.extrusionDepth, this._noteHeadMat,
          'glyph', note.x, note.y, SceneConfig.noteElevation, note.id);
      }
      const offX = (note.ancestorX ?? 0) - note.x;
      const offY = (note.ancestorY ?? 0) - note.y;
      for (const d of note.childPaths) {
        addGlyph(d, SceneConfig.extrusionDepth * 0.5, this._noteMat,
          'path', note.x + offX, note.y + offY, SceneConfig.noteElevation);
      }
    }

    // Other elements
    for (const el of parsed.otherElements) {
      if (el.glyphPath) {
        addGlyph(el.glyphPath, SceneConfig.extrusionDepth * 0.8, this._otherMat,
          'glyph', el.x, el.y, SceneConfig.otherElementsElevation, null, el.rotation || 0);
      } else if (el.d) {
        addGlyph(el.d, SceneConfig.extrusionDepth * 0.5, this._otherMat,
          'path', el.x, el.y, SceneConfig.otherElementsElevation, null, el.rotation || 0);
      }
    }

    // Staff lines
    for (const sl of parsed.staffLines) {
      if (sl.isLine) {
        addBoxLine(this._staffMat, sl.x1, sl.y1, sl.x2, sl.y2,
          SceneConfig.staffLineThickness,
          SceneConfig.staffLineThickness * 0.5,
          SceneConfig.staffLineElevation);
      } else if (sl.d) {
        addGlyph(sl.d, 16, this._staffMat, 'path', sl.x || 0, sl.y || 0,
          SceneConfig.staffLineElevation);
      }
    }

    // Bar lines
    for (const bl of parsed.barLines) {
      if (bl.isLine) {
        addBoxLine(this._barMat, bl.x1, bl.y1, bl.x2, bl.y2,
          SceneConfig.barLineWidth,
          SceneConfig.barLineWidth * 0.5,
          SceneConfig.barLineElevation);
      } else if (bl.d) {
        addGlyph(bl.d, 20, this._barMat, 'path', bl.x || 0, bl.y || 0,
          SceneConfig.barLineElevation);
      }
    }

    // Paper backdrop
    this._addPaper(root, parsed);
    if (parsed.title) {
      this._addTitle(root, parsed);
    }
    void s;
  }

  /* ------------------------------------------------------------------ */
  /*  Instance bucketing                                                 */
  /* ------------------------------------------------------------------ */

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
   * @param {Map} buckets
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
   */
  _bucketGlyph(buckets, pathD, depth, material, kind, x, y, z, noteId = null, rotation = 0) {
    // Path-kind paths (stems, ledger lines, etc.) that are plain line
    // segments go through the line-detection fast path.
    if (OPTIMIZATIONS.STEM_DEDUP && kind === 'path' && !rotation) {
      const line = _parseSimpleLineD(pathD);
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
        this._bucketBoxLine(this._sharedBoxBuckets, material,
          x + line.x1 * s, y - line.y1 * s,
          x + line.x2 * s, y - line.y2 * s,
          // 8-px-wide cross-section matching the staff-line style;
          // Z thickness is the shared `notationDepth` so simple
          // stems sit at the same depth as every other element.
          0.007, SceneConfig.notationDepth, z);
        return;
      }
    }
    const key = kind + ':' + material.uuid + ':' + depth + ':' + pathD;
    let bucket = buckets.get(key);
    if (!bucket) {
      const geometry = this._makeExtrudedGeometry(pathD, depth, kind);
      if (!geometry) return;
      bucket = { geometry, material, matrices: [], noteIds: [], kind };
      buckets.set(key, bucket);
    }
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
  _bucketBoxLine(buckets, material, x1, y1, x2, y2, widthAcross, depth, zElevation) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;
    const key = material.uuid;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material, matrices: [] };
      buckets.set(key, bucket);
    }
    const m = new THREE.Matrix4();
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    m.makeTranslation(cx, cy, zElevation);
    const ang = Math.abs(dy) > 0.0001 ? Math.atan2(dy, dx) : 0;
    if (ang !== 0) m.multiply(_scratchMat.makeRotationZ(ang));
    m.multiply(_scratchMat.makeScale(len, widthAcross, depth));
    bucket.matrices.push(m);
  }

  /**
   * Emit one or more `InstancedMesh`es from a list of instance
   * matrices, partitioning the instances by X chunk so Three.js's
   * per-mesh frustum culling also does coarse horizontal culling.
   *
   * With a single un-chunked `InstancedMesh` the bounding sphere
   * spans the entire score, so all instances are always drawn.
   * Chunking to ~4 world units per mesh lets the renderer skip 95 %+
   * of instances on a Sylvia-Suite-sized score.
   *
   * @param {THREE.Group} root
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Material} material
   * @param {THREE.Matrix4[]} matrices
   * @param {number} chunkWidth
   * @param {THREE.Color=} defaultInstanceColor  Default per-instance
   *   tint to pre-populate on the InstancedMesh's `instanceColor`
   *   buffer.  Non-null for noteheads (using the white-base
   *   `_noteHeadMat`): we init all instances to noteColor so unplayed
   *   notes render identically to the other, dark-material meshes.
   * @param {(string|null)[]=} noteIds  Parallel to `matrices`; the
   *   stable SVG id of the note that owns each instance, or null for
   *   non-note instances.  Only populated for notehead buckets.
   * @param {Map<string, { mesh: THREE.Mesh, index: number, material?: THREE.Material }>=} noteMeshMap
   *   Output map; populated with a `(mesh, index)` entry for every
   *   entry in `noteIds` that is a stable note id.  When the bucket
   *   collapses to a single plain `THREE.Mesh` (count === 1 fast
   *   path) the material is cloned so the single note can still be
   *   recoloured without affecting the shared `_noteHeadMat`, and
   *   `{ mesh, index: -1, material }` is stored instead.
   */
  _emitInstancedChunks(
    root, geometry, material, matrices, chunkWidth,
    defaultInstanceColor = null, noteIds = null, noteMeshMap = null,
  ) {
    if (matrices.length === 0) return;
    // Three.js 0.172 WebGPU bug: `InstancedMesh` with `count === 1`
    // renders with the instance matrix effectively ignored (the single
    // instance appears at world origin with its raw geometry, not at
    // `setMatrixAt(0, ...)`).  Root cause: `InstanceNode` wraps the
    // instance-matrix array in a UBO for count ≤ 1000 but never reuploads
    // it for the count-1 fast path.  Workaround: emit a plain `Mesh`
    // instead — no perf cost because the bucket only has one draw-call
    // either way.
    if (matrices.length === 1) {
      const singleNoteId = noteIds ? noteIds[0] : null;
      // Clone the material for a single notehead so it can be
      // recoloured independently of any shared material — otherwise
      // every notehead using this path-d would change colour at once.
      const perMeshMat = (singleNoteId && defaultInstanceColor)
        ? material.clone()
        : material;
      if (perMeshMat !== material && defaultInstanceColor) {
        perMeshMat.color.copy(defaultInstanceColor);
      }
      const mesh = new THREE.Mesh(geometry, perMeshMat);
      mesh.applyMatrix4(matrices[0]);
      // Chromium WebGPU + `InstancedMesh.frustumCulled` interact
      // badly on some drivers: the per-mesh bounding sphere is
      // computed correctly but the rasteriser sporadically treats
      // chunks as outside the view volume at oblique camera angles,
      // leaving notes popping in and out as the user orbits.  Safari
      // WebKit's WebGPU doesn't repro.  Disabling frustum culling
      // entirely on the score content is a safe trade — with chunking
      // off we already draw every bucket every frame anyway, so we
      // lose no cullable draw calls.
      mesh.frustumCulled = false;
      // Every notation mesh casts a shadow onto the paper.  The
      // paper itself opts in to `receiveShadow` in `_addPaper`.
      mesh.castShadow = true;
      root.add(mesh);
      if (singleNoteId && noteMeshMap) {
        noteMeshMap.set(singleNoteId, { mesh, index: -1, material: perMeshMat });
      }
      return;
    }
    if (!OPTIMIZATIONS.CHUNK_BUCKETS_BY_X) {
      // One InstancedMesh per bucket, no horizontal chunking.  The
      // whole bucket always passes the frustum test because its
      // bounding sphere spans the entire score, so we draw every
      // instance every frame — but we keep draw-call count == bucket
      // count (usually 20-50 for SMuFL music).
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      // Pre-seed the instance-colour buffer so unplayed notes render
      // at noteColor even with the white-base material.  `setColorAt`
      // lazily allocates `mesh.instanceColor` on first call.
      if (defaultInstanceColor) {
        for (let i = 0; i < matrices.length; i++) mesh.setColorAt(i, defaultInstanceColor);
        mesh.instanceColor.needsUpdate = true;
      }
      // Build noteId → (mesh, index) entries for the render worker.
      if (noteIds && noteMeshMap) {
        for (let i = 0; i < matrices.length; i++) {
          const id = noteIds[i];
          if (id) noteMeshMap.set(id, { mesh, index: i });
        }
      }
      root.add(mesh);
      return;
    }
    // Group matrices by X-chunk.  Matrix4 stores translation in
    // `.elements[12..14]`, so `elements[12]` is tx (world X).
    /** @type {Map<number, { m: THREE.Matrix4, noteId: string|null }[]>} */
    const byChunk = new Map();
    for (let i = 0; i < matrices.length; i++) {
      const m = matrices[i];
      const tx = m.elements[12];
      const chunk = Math.floor(tx / chunkWidth);
      let arr = byChunk.get(chunk);
      if (!arr) { arr = []; byChunk.set(chunk, arr); }
      arr.push({ m, noteId: noteIds ? noteIds[i] : null });
    }
    for (const arr of byChunk.values()) {
      // Same WebGPU count=1 workaround as above.
      if (arr.length === 1) {
        const singleNoteId = arr[0].noteId;
        const perMeshMat = (singleNoteId && defaultInstanceColor)
          ? material.clone()
          : material;
        if (perMeshMat !== material && defaultInstanceColor) {
          perMeshMat.color.copy(defaultInstanceColor);
        }
        const mesh = new THREE.Mesh(geometry, perMeshMat);
        mesh.applyMatrix4(arr[0].m);
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        root.add(mesh);
        if (singleNoteId && noteMeshMap) {
          noteMeshMap.set(singleNoteId, { mesh, index: -1, material: perMeshMat });
        }
        continue;
      }
      const mesh = new THREE.InstancedMesh(geometry, material, arr.length);
      for (let i = 0; i < arr.length; i++) {
        mesh.setMatrixAt(i, arr[i].m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      // Deliberately leave frustumCulled on so Three.js can skip
      // chunks that aren't in view.  `computeBoundingSphere` here
      // walks every instance matrix and unions the per-instance
      // sphere — essential, because the default sphere is the
      // single-instance geometry sphere centred at the origin, which
      // would mis-cull everything drawn more than a note-head's
      // width from (0,0,0).
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      if (defaultInstanceColor) {
        for (let i = 0; i < arr.length; i++) mesh.setColorAt(i, defaultInstanceColor);
        mesh.instanceColor.needsUpdate = true;
      }
      if (noteMeshMap) {
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].noteId) noteMeshMap.set(arr[i].noteId, { mesh, index: i });
        }
      }
      root.add(mesh);
    }
  }

  /**
   * Produce the extruded BufferGeometry for a single path-d string.
   * Caches by `(pathD, depth, kind)` so repeated calls don't re-extrude
   * the same shape.  Returns `null` on parse failure.
   */
  _makeExtrudedGeometry(pathD, depth, kind) {
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

  /* ------------------------------------------------------------------ */

  _addPaper(root, parsed) {
    const paperMat = Materials.paper();
    // Page margins around the score's visible 5-line staves.
    //
    // **Equal-padding layout**: the gaps above the title, between the
    // title and the topmost staff line, and below the bottommost
    // staff line are all the same world-unit value (`pad`), so the
    // page reads as evenly balanced top-to-bottom.  When the score
    // has elements that extend past the staves themselves (pedal
    // markers below the bass staff, octave 8va lines above the
    // treble staff, fermatas / hairpins / dynamics) we GROW the pad
    // so the paper still encloses every rendered glyph while the
    // three gaps stay equal.  See `TitleBlock.computePageMargins`
    // for the exact formula.
    //
    // The X (horizontal) margin stays symmetric; the camera doesn't
    // tilt left-right, so X appears uniform.  We do bias the camera
    // pitch slightly so the on-screen whitespace above and below
    // the page doesn't look perspective-skewed; see
    // `CameraController.configureForScore` for the framing maths.
    const marginX = 0.45;
    const totalWidth = parsed.totalWidth ?? 0;
    const minX = parsed.contentMinX ?? 0;
    const margins = computePageMargins(
      {
        staffMaxY: parsed.staffMaxY,
        staffMinY: parsed.staffMinY,
        contentMaxY: (parsed.contentMinY ?? 0) + (parsed.totalHeight ?? 0),
        contentMinY: parsed.contentMinY ?? 0,
      },
      parsed.title,
      parsed.composer,
    );
    const w = totalWidth + marginX * 2;
    const h = margins.paperTopY - margins.paperBottomY;
    // Scale the fibre pattern so individual fibres are on a scale
    // similar to a notehead — too few tiles per world unit makes the
    // normal map look like soft blurred clouds on close-ups, too many
    // and the fibres become sub-pixel noise that aliases under
    // camera motion.  Two tiles per world unit seems to hit the
    // sweet spot across every score size from 2-unit preludes to
    // 90-unit orchestral pages.
    if (paperMat.normalMap) {
      paperMat.normalMap.repeat.set(Math.max(2, w * 2), Math.max(2, h * 2));
    }
    // Bare 4-vertex plane: real paper is flat, the bumpy texture
    // comes entirely from `Materials.paper()`'s normal map shading.
    // No need for `PlaneGeometry` segments since we're not feeding
    // the vertex shader a `displacementMap` to read per-vertex
    // heights from.
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, paperMat);
    const cx = minX + totalWidth / 2;
    // Paper centroid in score-local Y: midpoint of the paper's
    // top/bottom edges.  For titled scores the centroid sits *above*
    // the staff's geometric centre because the top margin is taller
    // (extra pad + block.height + pad for the title block).  For
    // untitled scores the paper centres on the staff itself.
    const cy = (margins.paperTopY + margins.paperBottomY) / 2;
    mesh.position.set(cx, cy, -0.05);
    mesh.name = 'paper';
    // Paper spans the whole score — keep it always drawn for the same
    // reason as the content meshes (Chromium WebGPU culling glitch).
    mesh.frustumCulled = false;
    // The paper is the only mesh in the scene that *receives* the
    // key light's shadow.  Every score element above is at z >=
    // noteElevation while the paper sits at z = -0.05, so the
    // shadow falls on the paper alone and reads as the notation
    // hovering a few millimetres above the page.
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  /**
   * Add the score's title + composer block to the paper's top-left.
   *
   * Workflow:
   *   1. Rasterise the text on a CanvasTexture (TitleBlock.js does
   *      the layout — same constants the main thread used to compute
   *      the notation displacement, so the rendered ink lines up
   *      exactly inside the patch we reserved for it).
   *   2. Wrap the canvas in a `THREE.CanvasTexture` and place a
   *      transparent plane on top of the paper sized to the
   *      canvas's world-unit dimensions.
   *
   * Coordinate system note: in SCORE-LOCAL coords (pre-`contentRoot`
   * X-rotation), Y is "down the page" — small Y is at the top of the
   * paper, larger Y is the bottom.  After the contentRoot rotates the
   * whole tree by -π/2 around X, score-local Y maps to world -Z, so
   * the title at small Y ends up at large Z (back of the table) and
   * the camera looking from +Z toward the score sees it correctly
   * placed at "the top" of the paper.
   *
   * Z-elevation: 0.005 is enough to avoid z-fighting with the paper
   * (which sits at -0.05) without lifting the title visibly off the
   * page; the camera's pitch + the title's `transparent: true`
   * material make the gap invisible.
   */
  _addTitle(root, parsed) {
    const title = parsed.title;
    const composer = parsed.composer;
    const block = rasteriseTitleBlock(title, composer);
    if (!block) return;
    const tex = new THREE.CanvasTexture(block.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    // Coloured ink rendered on cream paper — `MeshBasicMaterial`
    // is unlit so the title reads with the same hue at every camera
    // distance regardless of how the directional key light is
    // hitting the paper underneath.  `depthWrite: false` keeps the
    // plane from punching a hole in the paper's shadow buffer; it
    // sits ~0.005 above the paper, well beneath any notation.
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    });
    const geo = new THREE.PlaneGeometry(block.worldWidth, block.worldHeight);
    const mesh = new THREE.Mesh(geo, mat);
    // Score-local Y is Y-up after the parser's `y: -(…)` flip
    // (SVG's Y-down → Three.js Y-up): smaller Y = bottom of page,
    // larger Y = top of page.  `computePageMargins` returns the
    // exact title-Y-bounds the paper was built around, so the title
    // plane goes there directly without any local arithmetic.
    // After the contentRoot's -π/2 X-rotation this maps to world
    // +Z, putting the title at the visually-correct top-of-paper
    // position from any reasonable camera angle.
    const margins = computePageMargins(
      {
        staffMaxY: parsed.staffMaxY,
        staffMinY: parsed.staffMinY,
        contentMaxY: (parsed.contentMinY ?? 0) + (parsed.totalHeight ?? 0),
        contentMinY: parsed.contentMinY ?? 0,
      },
      title,
      composer,
    );
    const titleCenterY = (margins.titleTopY + margins.titleBottomY) / 2;
    const titleLeftX = (parsed.contentMinX ?? 0) + TITLE_LEFT_PADDING;
    mesh.position.set(
      titleLeftX + block.worldWidth / 2,
      titleCenterY,
      0.005,
    );
    mesh.name = 'title';
    mesh.frustumCulled = false;
    root.add(mesh);
  }

  dispose() {
    this._geometryCache.forEach((geo) => geo.dispose());
    this._geometryCache.clear();
    this._unitBox.dispose();
  }
}

/**
 * If `d` is just a `M x1 y1 L x2 y2` segment (optionally trailing `Z`)
 * return the endpoints; otherwise return `null`.  This lets the
 * builder re-route simple stems / ledger lines into the shared box
 * bucket instead of producing one extruded `InstancedMesh` per unique
 * stem length.
 *
 * We intentionally only handle the *exact* Verovio stem shape —
 * `M x y L x y` — rather than a general path classifier, because that's
 * what Verovio emits and anything else deserves its own extruded shape
 * (e.g. beam geometry, flag geometry).
 */
function _parseSimpleLineD(d) {
  if (typeof d !== 'string') return null;
  // Fast prelim: must start with M and contain exactly one L and no Cs,
  // Qs, As, etc.  A trailing Z is allowed.
  if (d.length < 3) return null;
  if (d[0] !== 'M' && d[0] !== 'm') return null;
  const chars = d;
  let hasL = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === 'C' || c === 'c' || c === 'Q' || c === 'q' || c === 'S' ||
        c === 's' || c === 'T' || c === 't' || c === 'A' || c === 'a' ||
        c === 'H' || c === 'h' || c === 'V' || c === 'v') {
      return null;
    }
    if (c === 'L' || c === 'l') hasL = true;
  }
  if (!hasL) return null;
  // Tokenise.  Numbers are in the same format the path parser below
  // handles (optionally scientific, may have no separator from an
  // adjoining letter command, unary-minus glued to the value, etc.).
  const tokens = [];
  const re = /([MmLlZz])|(-?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(parseFloat(m[2]));
  }
  // Expected sequence: M x1 y1 L x2 y2 [Z]
  if (tokens.length < 6) return null;
  if (typeof tokens[0] !== 'string') return null;
  const m0 = tokens[0];
  const rel0 = m0 === 'm';
  if (typeof tokens[1] !== 'number' || typeof tokens[2] !== 'number') return null;
  const x1 = tokens[1];
  const y1 = tokens[2];
  if (typeof tokens[3] !== 'string') return null;
  const l0 = tokens[3];
  if (l0 !== 'L' && l0 !== 'l') return null;
  const rel1 = l0 === 'l';
  if (typeof tokens[4] !== 'number' || typeof tokens[5] !== 'number') return null;
  let x2 = tokens[4];
  let y2 = tokens[5];
  if (rel1) { x2 += x1; y2 += y1; }
  // Accept an optional trailing Z / z and nothing else.
  if (tokens.length > 6) {
    if (tokens.length !== 7) return null;
    const zTok = tokens[6];
    if (zTok !== 'Z' && zTok !== 'z') return null;
  }
  // Relative M means x1/y1 are relative to (0,0) — which is the same
  // as absolute.  Nothing to do.
  void rel0;
  return { x1, y1, x2, y2 };
}

/* ------------------------------------------------------------------ */
/*  Worker-friendly SVG path-d parser                                  */
/* ------------------------------------------------------------------ */

/**
 * Parse an SVG path `d` string into a `THREE.ShapePath`.
 *
 * This is a minimal implementation that supports the subset of SVG
 * path commands Verovio actually emits for music glyphs — `M`, `L`,
 * `H`, `V`, `C`, `S`, `Q`, `T`, `Z` and their lowercase (relative)
 * counterparts.  Arcs (`A`) are rare in music glyphs; we skip them
 * and log rather than fail.  Using `ShapePath` directly means we
 * never touch `DOMParser`, so this works in a Web Worker.
 */
function parsePathDToShapePath(d) {
  const path = new THREE.ShapePath();
  const tokens = tokenizePathD(d);
  let x = 0, y = 0;
  let startX = 0, startY = 0;
  let lastCx = 0, lastCy = 0;
  let prevCmd = '';
  let cmd = '';
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') { cmd = t; i++; }
    const rel = cmd >= 'a' && cmd <= 'z';
    const upper = cmd.toUpperCase();
    const rx = (v) => (rel ? x + v : v);
    const ry = (v) => (rel ? y + v : v);
    switch (upper) {
      case 'M': {
        const nx = rx(tokens[i++]);
        const ny = ry(tokens[i++]);
        path.moveTo(nx, ny);
        x = nx; y = ny; startX = nx; startY = ny;
        // Subsequent coordinate pairs after M are implicit lineTo's
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': {
        const nx = rx(tokens[i++]);
        const ny = ry(tokens[i++]);
        path.lineTo(nx, ny);
        x = nx; y = ny;
        break;
      }
      case 'H': {
        const nx = rx(tokens[i++]);
        path.lineTo(nx, y);
        x = nx;
        break;
      }
      case 'V': {
        const ny = ry(tokens[i++]);
        path.lineTo(x, ny);
        y = ny;
        break;
      }
      case 'C': {
        const c1x = rx(tokens[i++]);
        const c1y = ry(tokens[i++]);
        const c2x = rx(tokens[i++]);
        const c2y = ry(tokens[i++]);
        const nx = rx(tokens[i++]);
        const ny = ry(tokens[i++]);
        path.bezierCurveTo(c1x, c1y, c2x, c2y, nx, ny);
        lastCx = c2x; lastCy = c2y;
        x = nx; y = ny;
        break;
      }
      case 'S': {
        // Reflected control point from the previous C or S.
        const c1x = (prevCmd === 'C' || prevCmd === 'S') ? (2 * x - lastCx) : x;
        const c1y = (prevCmd === 'C' || prevCmd === 'S') ? (2 * y - lastCy) : y;
        const c2x = rx(tokens[i++]);
        const c2y = ry(tokens[i++]);
        const nx = rx(tokens[i++]);
        const ny = ry(tokens[i++]);
        path.bezierCurveTo(c1x, c1y, c2x, c2y, nx, ny);
        lastCx = c2x; lastCy = c2y;
        x = nx; y = ny;
        break;
      }
      case 'Q': {
        const c1x = rx(tokens[i++]);
        const c1y = ry(tokens[i++]);
        const nx = rx(tokens[i++]);
        const ny = ry(tokens[i++]);
        path.quadraticCurveTo(c1x, c1y, nx, ny);
        lastCx = c1x; lastCy = c1y;
        x = nx; y = ny;
        break;
      }
      case 'T': {
        const c1x = (prevCmd === 'Q' || prevCmd === 'T') ? (2 * x - lastCx) : x;
        const c1y = (prevCmd === 'Q' || prevCmd === 'T') ? (2 * y - lastCy) : y;
        const nx = rx(tokens[i++]);
        const ny = ry(tokens[i++]);
        path.quadraticCurveTo(c1x, c1y, nx, ny);
        lastCx = c1x; lastCy = c1y;
        x = nx; y = ny;
        break;
      }
      case 'Z': {
        path.currentPath.closePath();
        x = startX; y = startY;
        break;
      }
      case 'A': {
        // Elliptical arc — approximate with a straight line to the
        // endpoint.  Music glyphs generated by Verovio basically never
        // use arcs, so this is a safe fallback.
        i += 5; // rx, ry, x-axis-rotation, large-arc-flag, sweep-flag
        const nx = rx(tokens[i++]);
        const ny = ry(tokens[i++]);
        path.lineTo(nx, ny);
        x = nx; y = ny;
        break;
      }
      default:
        // Unknown command — advance index defensively.
        i++;
    }
    prevCmd = upper;
  }
  return path;
}

/**
 * Tokenise a path-d string into `[cmd, num, num, cmd, num, ...]`.
 * Handles scientific-notation floats, comma or whitespace separators,
 * and unprefixed sign (e.g. `M10-5` ≡ `M 10 -5`).
 */
function tokenizePathD(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) out.push(m[1]);
    else if (m[2]) out.push(parseFloat(m[2]));
  }
  return out;
}
