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
 * Quadratic / cubic Bézier extrema are solved analytically instead of
 * treating control points as rendered points.  The latter greatly
 * over-estimates long slurs and makes paper margins score-dependent.
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
export function pathBBox(d) {
  if (!d) return null;
  const cached = _bboxCache.get(d);
  if (cached !== undefined) return cached;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let x = 0, y = 0;
  let startX = 0, startY = 0;
  let cmd = '';
  let previousCommand = '';
  let cubicControlX = 0, cubicControlY = 0;
  let quadraticControlX = 0, quadraticControlY = 0;
  // Gather the tokens once — the regex is the same format used by
  // rendering/pathD.js tokenizePathD, but we don't bother importing that
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
  const trackQuadratic = (x0, y0, cx, cy, x1, y1) => {
    track(x0, y0);
    track(x1, y1);
    const tx = quadraticExtremum(x0, cx, x1);
    const ty = quadraticExtremum(y0, cy, y1);
    if (tx > 0 && tx < 1) track(quadraticAt(x0, cx, x1, tx), quadraticAt(y0, cy, y1, tx));
    if (ty > 0 && ty < 1) track(quadraticAt(x0, cx, x1, ty), quadraticAt(y0, cy, y1, ty));
  };
  const trackCubic = (x0, y0, c1x, c1y, c2x, c2y, x1, y1) => {
    track(x0, y0);
    track(x1, y1);
    const roots = cubicExtrema(x0, c1x, c2x, x1);
    roots.push(...cubicExtrema(y0, c1y, c2y, y1));
    for (const t of roots) {
      if (t > 0 && t < 1) track(
        cubicAt(x0, c1x, c2x, x1, t),
        cubicAt(y0, c1y, c2y, y1, t),
      );
    }
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
        const x0 = x, y0 = y;
        const c1x = rx(toks[i++]); const c1y = ry(toks[i++]);
        const c2x = rx(toks[i++]); const c2y = ry(toks[i++]);
        const nx = rx(toks[i++]); const ny = ry(toks[i++]);
        trackCubic(x0, y0, c1x, c1y, c2x, c2y, nx, ny);
        cubicControlX = c2x; cubicControlY = c2y;
        x = nx; y = ny;
        break;
      }
      case 'S': {
        const x0 = x, y0 = y;
        const c1x = previousCommand === 'C' || previousCommand === 'S' ? 2 * x - cubicControlX : x;
        const c1y = previousCommand === 'C' || previousCommand === 'S' ? 2 * y - cubicControlY : y;
        const c2x = rx(toks[i++]); const c2y = ry(toks[i++]);
        const nx = rx(toks[i++]); const ny = ry(toks[i++]);
        trackCubic(x0, y0, c1x, c1y, c2x, c2y, nx, ny);
        cubicControlX = c2x; cubicControlY = c2y;
        x = nx; y = ny;
        break;
      }
      case 'Q': {
        const x0 = x, y0 = y;
        const c1x = rx(toks[i++]); const c1y = ry(toks[i++]);
        const nx = rx(toks[i++]); const ny = ry(toks[i++]);
        trackQuadratic(x0, y0, c1x, c1y, nx, ny);
        quadraticControlX = c1x; quadraticControlY = c1y;
        x = nx; y = ny;
        break;
      }
      case 'T': {
        const x0 = x, y0 = y;
        const cx = previousCommand === 'Q' || previousCommand === 'T' ? 2 * x - quadraticControlX : x;
        const cy = previousCommand === 'Q' || previousCommand === 'T' ? 2 * y - quadraticControlY : y;
        const nx = rx(toks[i++]); const ny = ry(toks[i++]);
        trackQuadratic(x0, y0, cx, cy, nx, ny);
        quadraticControlX = cx; quadraticControlY = cy;
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
    previousCommand = up;
  }
  if (minX === Infinity) { _bboxCache.set(d, null); return null; }
  const box = { minX, maxX, minY, maxY };
  _bboxCache.set(d, box);
  return box;
}

function quadraticAt(p0, p1, p2, t) {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

function quadraticExtremum(p0, p1, p2) {
  const denominator = p0 - 2 * p1 + p2;
  return Math.abs(denominator) < 1e-12 ? -1 : (p0 - p1) / denominator;
}

function cubicAt(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return mt * mt * mt * p0
    + 3 * mt * mt * t * p1
    + 3 * mt * t * t * p2
    + t * t * t * p3;
}

function cubicExtrema(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 3 * p0 - 6 * p1 + 3 * p2;
  const c = -3 * p0 + 3 * p1;
  const qa = 3 * a;
  const qb = 2 * b;
  if (Math.abs(qa) < 1e-12) {
    return Math.abs(qb) < 1e-12 ? [] : [-c / qb];
  }
  const discriminant = qb * qb - 4 * qa * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-qb + root) / (2 * qa), (-qb - root) / (2 * qa)];
}
