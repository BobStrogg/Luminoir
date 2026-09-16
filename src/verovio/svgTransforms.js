/**
 * Pure DOM helpers for reading Verovio SVG transforms and simple
 * path-d forms.  No class state — every function takes the element
 * it should inspect.
 */

/** Read a single `translate(x, y)` transform on `el`. */
export function getTranslate(el) {
  const t = el.getAttribute('transform') || '';
  const match = t.match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/);
  if (match) return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
  return { x: 0, y: 0 };
}

/**
 * Sum every `translate(...)` transform on the ancestor chain from
 * `el` (inclusive) up to the `<svg>` root.  Returns raw SVG-space
 * offsets — callers apply scale and the Y-flip themselves.
 */
export function getAncestorTranslate(el) {
  let x = 0, y = 0;
  let cur = el;
  while (cur && cur.tagName !== 'svg') {
    const t = getTranslate(cur);
    x += t.x;
    y += t.y;
    cur = cur.parentElement;
  }
  return { rawX: x, rawY: y };
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
export function getAncestorRotation(el) {
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

/** Detect a `M x1 y1 L x2 y2` single-segment path-d. */
export function parseLineEndpoints(d) {
  const m = d.match(/^M\s*([-\d.]+)[\s,]+([-\d.]+)\s*L\s*([-\d.]+)[\s,]+([-\d.]+)/);
  if (!m) return null;
  return {
    x1: parseFloat(m[1]),
    y1: parseFloat(m[2]),
    x2: parseFloat(m[3]),
    y2: parseFloat(m[4]),
  };
}

/** Some `<defs>` entries wrap their path in a child element. */
export function getChildPathD(defEl) {
  const child = defEl.querySelector('path');
  return child ? child.getAttribute('d') : null;
}
