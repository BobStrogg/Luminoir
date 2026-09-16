import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/*  Worker-friendly SVG path-d parser                                  */
/* ------------------------------------------------------------------ */

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
export function parseSimpleLineD(d) {
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
export function parsePathDToShapePath(d) {
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
export function tokenizePathD(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) out.push(m[1]);
    else if (m[2]) out.push(parseFloat(m[2]));
  }
  return out;
}
