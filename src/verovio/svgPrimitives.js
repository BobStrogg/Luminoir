/**
 * Pure conversions from Verovio's non-path SVG primitives
 * (`<polygon>`, `<polyline>`, `<ellipse>`, `<rect>`) into the
 * `{ isLine }` / `{ d, x, y }` entry records the scene builder
 * consumes.  Each returns the entry object minus `type` (the caller
 * stamps the classifier), or null when the element is unusable.
 *
 * `tx` is the element's ancestor-translate `{ rawX, rawY }` in raw
 * SVG units; `scale` is `SceneConfig.scale`.  Y is negated to
 * convert SVG Y-down into Three.js Y-up.
 */

/**
 * Beam bars are `<polygon>` in Verovio output.  Each one has a
 * unique set of points (because coordinates differ per beam), so
 * routing them through the glyph bucket would produce one plain
 * `THREE.Mesh` per beam — hundreds of extra draw calls on scores
 * like Sylvia Suite.  Instead, detect the 4-point rectangle /
 * parallelogram case, compute a centre-line + thickness, and emit
 * as an `isLine` entry so the builder can aggregate every beam in
 * the piece into a single box-bucket `InstancedMesh`.
 *
 * Any polygon that isn't a 4-point shape falls back to a path-d
 * string (correct but unshared); polygons are rare enough outside
 * of beams that this edge-case cost is negligible.
 *
 * @param {string} points  The polygon's `points` attribute.
 * @param {{ rawX: number, rawY: number }} tx  Ancestor translate of the polygon element.
 * @param {number} scale
 * @param {{ x: number, y: number }} fallbackPos  Placement used for
 *   the non-quad path-d fallback (the container's start position).
 */
export function polygonToLineOrPath(points, tx, scale, fallbackPos) {
  if (!points) return null;
  const tokens = points.trim().split(/[\s,]+/).map(parseFloat).filter((n) => !isNaN(n));
  if (tokens.length < 4) return null;
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
    return {
      isLine: true,
      x1: (midLX + tx.rawX) * scale,
      y1: -(midLY + tx.rawY) * scale,
      x2: (midRX + tx.rawX) * scale,
      y2: -(midRY + tx.rawY) * scale,
      thickness: thick,
    };
  }
  // Fallback: emit as path-d so it still renders.
  let d = 'M ' + tokens[0] + ' ' + tokens[1];
  for (let i = 2; i < tokens.length; i += 2) {
    d += ' L ' + tokens[i] + ' ' + tokens[i + 1];
  }
  d += ' Z';
  return { d, ...fallbackPos };
}

/**
 * `<polyline>` → glyph-local path-d anchored at the first point so
 * every polyline with the same *shape* (relative offsets) shares a
 * geometry bucket.  Polylines with different point counts or
 * different relative offsets still get their own bucket — that's
 * correct.
 */
export function polylineToPath(points, tx, scale) {
  if (!points) return null;
  const tokens = points.trim().split(/[\s,]+/).map(parseFloat).filter((n) => !isNaN(n));
  if (tokens.length < 4) return null;
  const ax = tokens[0];
  const ay = tokens[1];
  let d = 'M 0 0';
  for (let i = 2; i + 1 < tokens.length; i += 2) {
    d += ' L ' + (tokens[i] - ax) + ' ' + (tokens[i + 1] - ay);
  }
  return {
    d,
    x: (ax + tx.rawX) * scale,
    y: -(ay + tx.rawY) * scale,
  };
}

/**
 * `<ellipse>` → closed path-d.  Cubic-Bezier circle approximation:
 * 4 quadrants × control distance kappa = (4/3)·tan(π/8) ≈ 0.5523.
 * Produces a closed loop that's visually indistinguishable from a
 * true ellipse at our extrusion resolution.  Glyph-local coords
 * centred at (0, 0) so all dots with the same (rx, ry) share one
 * geometry.
 */
export function ellipseToPath(cx, cy, rx, ry, tx, scale) {
  if (rx <= 0 || ry <= 0) return null;
  const k = 0.5522847498307933;
  const kx = rx * k, ky = ry * k;
  const d =
    `M ${-rx} 0 ` +
    `C ${-rx} ${-ky}, ${-kx} ${-ry}, 0 ${-ry} ` +
    `C ${kx} ${-ry}, ${rx} ${-ky}, ${rx} 0 ` +
    `C ${rx} ${ky}, ${kx} ${ry}, 0 ${ry} ` +
    `C ${-kx} ${ry}, ${-rx} ${ky}, ${-rx} 0 Z`;
  return {
    d,
    x: (cx + tx.rawX) * scale,
    y: -(cy + tx.rawY) * scale,
  };
}

/**
 * `<rect>` → glyph-local rect path-d anchored at (0, 0).  Every
 * pedal-bracket rect with the same (w, h) shares one geometry
 * bucket.
 */
export function rectToPath(x, y, w, h, tx, scale) {
  if (w <= 0 || h <= 0) return null;
  const d = `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  return {
    d,
    x: (x + tx.rawX) * scale,
    y: -(y + tx.rawY) * scale,
  };
}
