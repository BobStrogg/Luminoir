import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { SceneConfig } from './SceneConfig.js';
import { Materials } from './Materials.js';
import {
  computePageMargins,
  TITLE_LEFT_PADDING,
  TITLE_HEIGHT,
  COMPOSER_HEIGHT,
  TITLE_LINE_GAP,
} from './TitleBlock.js';
// Note: `rasteriseTitleBlock` is intentionally NOT imported here.
// The title is now rendered as extruded 3D geometry (via FontLoader +
// ExtrudeGeometry) so it casts proper ink-shaped shadows.  The raster
// fallback lives in TitleBlock.js and is still used by the main
// thread's `measureTitleBlock` for paper-margin sizing.

/** Resolved title font, populated by `prefetchTitleFont()` during
 *  worker init.  `null` until the fetch completes (or if it fails).
 *  `addTitle` reads this synchronously so `build()` stays sync and
 *  the buildScene → setTimeline message ordering is preserved. */
let _titleFont = null;

/**
 * Kick off the font fetch in the background.  Call once from
 * `handleInit` in the render worker so the font is ready (or nearly
 * so) by the time the first `buildScene` message arrives.
 *
 * Fire-and-forget — no need to await.  If the fetch is still in
 * flight when `addTitle` runs, the title is silently omitted for
 * that scene build; subsequent score loads will have the font cached.
 */
export function prefetchTitleFont() {
  if (_titleFont) return;   // already loaded
  (async () => {
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}fonts/optimer_bold.typeface.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      _titleFont = new FontLoader().parse(json);
    } catch (e) {
      console.warn('[SVG3DBuilder] Could not load title font:', e);
    }
  })();
}

/**
 * Add the paper backdrop mesh to `root`.
 *
 * **Equal-padding layout**: paper edge → title, title → highest
 * rendered notation, and lowest notation → paper edge all use the
 * same fixed world-unit gap.  Full content bounds already include
 * ledger notes, slurs, dynamics, and octave lines, so their extent
 * is never counted a second time as exterior whitespace.
 */
export function addPaper(root, parsed, titleBlock = null) {
  const paperMat = Materials.paper();
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
      contentMaxY: (parsed.contentMinY ?? 0) + (parsed.totalHeight ?? 0),
      contentMinY: parsed.contentMinY ?? 0,
    },
    parsed.title,
    parsed.composer,
    titleBlock,
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
 * Measure the title/composer text in the loaded 3D font.
 * Returns `{ block, title, composer }` or null when the font isn't
 * loaded yet (or there is no title).
 */
export function measureTitleLayout(title, composer) {
  if (!_titleFont || !title) return null;
  const measure = (text, size) => {
    if (!text) return null;
    let shapes;
    try {
      shapes = _titleFont.generateShapes(text, size);
    } catch {
      return null;
    }
    if (!shapes || shapes.length === 0) return null;
    const geometry = new THREE.ShapeGeometry(shapes);
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    const metrics = {
      shapes,
      minY: bounds.min.y,
      maxY: bounds.max.y,
      width: bounds.max.x - bounds.min.x,
      height: bounds.max.y - bounds.min.y,
    };
    geometry.dispose();
    return metrics;
  };
  const titleMetrics = measure(title, TITLE_HEIGHT);
  if (!titleMetrics) return null;
  const composerMetrics = measure(composer, COMPOSER_HEIGHT);
  const height = titleMetrics.height
    + (composerMetrics ? TITLE_LINE_GAP + composerMetrics.height : 0);
  return {
    block: {
      width: Math.max(titleMetrics.width, composerMetrics?.width || 0),
      height,
      hasComposer: !!composerMetrics,
    },
    title: titleMetrics,
    composer: composerMetrics,
  };
}

/**
 * Add the score's title + composer block to the paper's top-left
 * as extruded 3D geometry — the same pipeline used for all other
 * notation — so the text casts a proper ink-shaped shadow onto the
 * paper just like notes and staff lines do.
 *
 * Font: `optimer_bold.typeface.json` (Three.js bundled serif, 112 KB).
 * Loaded once per worker lifetime via `prefetchTitleFont()` and cached.
 *
 * Coordinate system (score-local, pre-contentRoot rotation):
 *   • Y-up: larger Y = top of page, smaller Y = bottom.
 *   • Z = elevation above paper.  Notes sit at `noteElevation`;
 *     this text uses the same value so it shadows identically.
 * `font.generateShapes(text, size)` returns shapes whose XY coords
 * are in world units with baseline at Y = 0 — no additional scale
 * is needed beyond `size = TITLE_HEIGHT` (or `COMPOSER_HEIGHT`).
 *
 * Extrusion depth is chosen to match the visual weight of notation
 * (glyphs extrude ≈ 0.003 wu after scale × glyphUseScale).
 *
 * @param {THREE.Material} baseMaterial  The builder's "other elements"
 *   material, cloned per text mesh so the title's ink colour is
 *   independent of the shared decoration material.
 */
export function addTitle(root, parsed, layout, baseMaterial) {
  const title = parsed.title;
  const composer = parsed.composer;
  if (!title || !_titleFont || !layout) return;

  const margins = computePageMargins(
    {
      contentMaxY: (parsed.contentMinY ?? 0) + (parsed.totalHeight ?? 0),
      contentMinY: parsed.contentMinY ?? 0,
    },
    title,
    composer,
    layout.block,
  );

  const leftX = (parsed.contentMinX ?? 0) + TITLE_LEFT_PADDING;
  const z = SceneConfig.noteElevation;
  // Extrusion depth: match the per-glyph world depth of notation
  // (extrusionDepth × scale × glyphUseScale ≈ 0.003 wu).
  const depth = SceneConfig.extrusionDepth * SceneConfig.scale * SceneConfig.glyphUseScale;

  const _addTextMesh = (metrics, baselineY, color) => {
    const geo = new THREE.ExtrudeGeometry(metrics.shapes, { depth, bevelEnabled: false });
    geo.computeVertexNormals();
    const mat = baseMaterial.clone();
    mat.color.set(color);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(leftX, baselineY, z);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.name = 'title';
    root.add(mesh);
  };

  const titleBaseline = margins.titleTopY - layout.title.maxY;
  _addTextMesh(layout.title, titleBaseline, '#1f1a0e');

  if (composer && layout.composer && margins.titleBottomY != null) {
    const titleVisualBottom = titleBaseline + layout.title.minY;
    const composerBaseline = titleVisualBottom - TITLE_LINE_GAP - layout.composer.maxY;
    _addTextMesh(layout.composer, composerBaseline, '#5a4f3c');
  }
}
