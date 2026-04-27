/**
 * Score title block — the "title + composer" that sits at the
 * top-left of the rendered paper.  Lives in its own module so the
 * MAIN thread (which needs the bounding box to drive the dynamic
 * paper top-margin sizing) and the WORKER (which actually draws the
 * text onto a CanvasTexture) share one source of truth for font
 * sizes, padding, colours, and the world-units-per-pixel ratio.
 */

/* ------------------------------------------------------------------ */
/*  Layout constants (world units)                                      */
/* ------------------------------------------------------------------ */

/** Padding from the paper's left edge before the title's left edge. */
export const TITLE_LEFT_PADDING = 0.18;

/** Minimum (and "default") page-padding constant.  See
 *  `computePageMargins` for how the *effective* padding is computed
 *  per-score — for scores with significant content extending beyond
 *  the visible 5-line staves (pedal markers, octave lines, ledger
 *  lines) the effective padding grows so all three gaps remain
 *  visually equal.
 *
 *  The three gaps that should look equal at a given camera angle:
 *
 *    1. Paper top edge ↔ title top
 *    2. Title bottom ↔ topmost staff line
 *    3. Bottommost staff line ↔ paper bottom edge
 *
 *  Keeping all three equal is what makes the page feel balanced
 *  regardless of how much non-staff notation (pedal markers,
 *  octave 8va/8vb lines, fermatas, etc.) the score adds outside
 *  the staves themselves. */
export const MIN_PAGE_PADDING = 0.20;

/** Title text height in world units.  Sized so that a single-line
 *  title plus its top + bottom padding stays a comfortable
 *  proportion of the camera's natural viewing height. */
export const TITLE_HEIGHT = 0.22;
/** Composer text height in world units (smaller subtitle). */
export const COMPOSER_HEIGHT = 0.13;
/** Vertical gap between title and composer baselines (world units). */
export const TITLE_LINE_GAP = 0.04;

/** Fonts.  Serif for the title (matches the engraved "ink on paper"
 *  feel); same family for the composer at smaller weight so the
 *  block reads as one cohesive byline.
 *  We split out font weight for the title so `measureTitleBlock`
 *  and `rasteriseTitleBlock` can share one source of truth — using
 *  `600` for measuring but plain weight for drawing previously made
 *  the rasteriser clip the bolder glyphs because they were measured
 *  at a smaller width. */
const TITLE_FONT_WEIGHT = '600';
const TITLE_FONT_FAMILY = 'Georgia, "Times New Roman", serif';
const COMPOSER_FONT_FAMILY = 'Georgia, "Times New Roman", serif';

/** Pixels-per-world-unit when rasterising onto an offscreen canvas.
 *  680 px/u keeps the title around 285 px high — Plenty sharp at
 *  every camera distance the project ships with (paper viewing
 *  distance ≤ 10 world units, so the title takes up < 35 % of the
 *  vertical screen at most, which the texture more than covers). */
const PIXELS_PER_UNIT = 680;

/** Maximum width of the title block in world units.  Long titles
 *  truncate with an ellipsis rather than spilling into the staff
 *  area.  The cap is purely cosmetic — the title doesn't displace
 *  notation horizontally any more, so this just controls how much
 *  of the staff width gets covered by extra-long names. */
const MAX_BLOCK_WIDTH = 6.0;

/* ------------------------------------------------------------------ */
/*  Measuring                                                           */
/* ------------------------------------------------------------------ */

/**
 * Measure the title block.  Uses a 1×1 canvas just for its 2D
 * `measureText` API; cheap (<0.1 ms) and works identically on the
 * main thread and inside a Web Worker.
 *
 * @param {string|null} title
 * @param {string|null} composer
 * @returns {{ width: number, height: number, titleWidth: number, composerWidth: number, hasComposer: boolean }} world-unit measurements
 */
export function measureTitleBlock(title, composer) {
  if (!title) {
    return { width: 0, height: 0, titleWidth: 0, composerWidth: 0, hasComposer: false };
  }
  const ctx = _scratchContext();
  ctx.font = `${TITLE_FONT_WEIGHT} ${TITLE_HEIGHT * PIXELS_PER_UNIT}px ${TITLE_FONT_FAMILY}`;
  let titleWidth = ctx.measureText(title).width / PIXELS_PER_UNIT;
  let composerWidth = 0;
  const hasComposer = !!composer;
  if (hasComposer) {
    ctx.font = `${COMPOSER_HEIGHT * PIXELS_PER_UNIT}px ${COMPOSER_FONT_FAMILY}`;
    composerWidth = ctx.measureText(composer).width / PIXELS_PER_UNIT;
  }
  let width = Math.max(titleWidth, composerWidth);
  if (width > MAX_BLOCK_WIDTH) width = MAX_BLOCK_WIDTH;
  const height = hasComposer
    ? TITLE_HEIGHT + TITLE_LINE_GAP + COMPOSER_HEIGHT
    : TITLE_HEIGHT;
  return { width, height, titleWidth, composerWidth, hasComposer };
}

/**
 * Compute the per-score page margins.  Returns geometry that the
 * renderer plugs into `_addPaper` and `_addTitle` so all three of
 *
 *   1. paper top → title top              (`paddingAboveTitle`)
 *   2. title bottom → topmost staff line  (`paddingBetween`)
 *   3. bottommost staff line → paper bottom (`paddingBelowStaff`)
 *
 * end up the same world-unit gap (`pad`).  When the score's content
 * bounding box (which includes pedal markers, ledger lines, octave
 * lines, etc.) extends beyond the visible 5-line staves we GROW the
 * padding so the paper still encloses every rendered element while
 * the three gaps stay equal.
 *
 *   pad = max(
 *     MIN_PAGE_PADDING,                        // never tighter than the default
 *     contentMaxY - staffMaxY,                 // overhang above staff
 *     staffMinY - contentMinY,                 // overhang below staff
 *   )
 *
 * Caller must supply the world-unit Y bounds.  In score-local Y-up
 * coordinates (after the parser's SVG-Y flip):
 *
 *   • `staffMaxY` = top of the topmost staff line
 *   • `staffMinY` = bottom of the bottommost staff line
 *   • `contentMaxY` = topmost edge of any rendered element
 *   • `contentMinY` = bottommost edge of any rendered element
 *
 * Returns the `pad` plus the absolute Y coordinates of the paper
 * top/bottom edges and the title top/bottom edges, so the caller
 * doesn't have to redo the arithmetic.  When `title` is null the
 * title-related fields are `null` and the paper sits symmetrically
 * around the staff with `MIN_PAGE_PADDING` above and below.
 *
 * @param {{ staffMaxY: number, staffMinY: number, contentMaxY: number, contentMinY: number }} bounds
 * @param {string|null} title
 * @param {string|null} composer
 * @returns {{
 *   pad: number,
 *   block: { width: number, height: number, hasComposer: boolean },
 *   paperTopY: number,
 *   paperBottomY: number,
 *   titleTopY: number|null,
 *   titleBottomY: number|null,
 * }}
 */
export function computePageMargins(bounds, title, composer) {
  const block = measureTitleBlock(title, composer);
  const staffMaxY = bounds.staffMaxY ?? bounds.contentMaxY ?? 0;
  const staffMinY = bounds.staffMinY ?? bounds.contentMinY ?? 0;
  const contentMaxY = bounds.contentMaxY ?? staffMaxY;
  const contentMinY = bounds.contentMinY ?? staffMinY;

  const overhangAbove = Math.max(0, contentMaxY - staffMaxY);
  const overhangBelow = Math.max(0, staffMinY - contentMinY);
  const pad = Math.max(MIN_PAGE_PADDING, overhangAbove, overhangBelow);

  const paperBottomY = staffMinY - pad;
  if (block.height === 0) {
    // No title: paper sits symmetrically around the staff.
    return {
      pad,
      block,
      paperTopY: staffMaxY + pad,
      paperBottomY,
      titleTopY: null,
      titleBottomY: null,
    };
  }
  // With a title: title sits one `pad` above the staff and the
  // paper extends another `pad` above the title — yielding three
  // equal gaps top-to-bottom.
  const titleBottomY = staffMaxY + pad;
  const titleTopY = titleBottomY + block.height;
  const paperTopY = titleTopY + pad;
  return {
    pad,
    block,
    paperTopY,
    paperBottomY,
    titleTopY,
    titleBottomY,
  };
}

/* ------------------------------------------------------------------ */
/*  Rasterising                                                         */
/* ------------------------------------------------------------------ */

/**
 * Render the title block onto an OffscreenCanvas (or `<canvas>` if
 * OffscreenCanvas isn't available) sized to the world-unit bounding
 * box.  Returns the canvas plus its world-unit width/height so the
 * caller can wrap it in a `THREE.CanvasTexture` and place a plane
 * of the matching size.
 *
 * @param {string} title
 * @param {string|null} composer
 * @returns {{ canvas: HTMLCanvasElement|OffscreenCanvas, worldWidth: number, worldHeight: number }}
 */
export function rasteriseTitleBlock(title, composer) {
  const block = measureTitleBlock(title, composer);
  if (block.width === 0) return null;

  const px = PIXELS_PER_UNIT;
  const w = Math.ceil(block.width * px);
  const h = Math.ceil(block.height * px);
  const canvas = _newCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // Title — heavier weight, near-black ink colour.  We put a tiny
  // bit of warmth into the ink (#1f1a0e) so it feels printed rather
  // than CSS-black against the cream paper.
  ctx.fillStyle = '#1f1a0e';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.font = `${TITLE_FONT_WEIGHT} ${TITLE_HEIGHT * px}px ${TITLE_FONT_FAMILY}`;
  ctx.fillText(_truncate(ctx, title, w), 0, 0);

  if (block.hasComposer) {
    ctx.fillStyle = '#5a4f3c';
    // Composer baseline = title height + small gap.  textBaseline
    // = 'top' interprets the Y as the top of the next glyph cell,
    // which lines up cleanly when the title font is ascender-heavy.
    const yPx = (TITLE_HEIGHT + TITLE_LINE_GAP) * px;
    ctx.font = `${COMPOSER_HEIGHT * px}px ${COMPOSER_FONT_FAMILY}`;
    ctx.fillText(_truncate(ctx, composer, w), 0, yPx);
  }

  return { canvas, worldWidth: block.width, worldHeight: block.height };
}

/* ------------------------------------------------------------------ */
/*  Internals                                                           */
/* ------------------------------------------------------------------ */

let _scratch = null;
function _scratchContext() {
  if (_scratch) return _scratch;
  const c = _newCanvas(1, 1);
  _scratch = c.getContext('2d');
  return _scratch;
}

function _newCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Append "…" if the rendered text exceeds `maxPx`.  Cheap binary
 * trim — for a 30-character title that overflows we usually clip
 * within ≈ 5 measureText calls.
 */
function _truncate(ctx, text, maxPx) {
  if (ctx.measureText(text).width <= maxPx) return text;
  const ell = '…';
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const trial = text.slice(0, mid) + ell;
    if (ctx.measureText(trial).width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}
