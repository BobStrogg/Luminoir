/* ------------------------------------------------------------------ */
/*  Chord-group helpers for LightBallController                        */
/* ------------------------------------------------------------------ */

/** Average position of an array of { x, y } notes. */
export function centerOf(notes) {
  let x = 0, y = 0;
  for (const n of notes) { x += n.x; y += n.y; }
  return { x: x / notes.length, y: y / notes.length };
}

/**
 * Pre-compute a `toNext` index map on each chord group so that ball i
 * in the current group maps to `toNext[i]` in the next group (nearest
 * neighbour by y, avoiding duplicates).  This keeps each ball tracking
 * the closest note through chord transitions instead of jumping by
 * sorted index.
 */
export function buildMatchings(groups) {
  for (let g = 0; g < groups.length - 1; g++) {
    const cur = groups[g];
    const nxt = groups[g + 1];
    const maxN = Math.max(cur.notes.length, nxt.notes.length);

    // Build toNext: for each ball slot in cur, which slot in nxt?
    // Use null to mark "merge into group centre" (no specific target).
    const toNext = new Array(maxN);
    const taken = new Set();

    for (let i = 0; i < maxN; i++) {
      const src = i < cur.notes.length ? cur.notes[i] : centerOf(cur.notes);
      let bestJ = -1, bestDist = Infinity;
      for (let j = 0; j < nxt.notes.length; j++) {
        if (taken.has(j)) continue;
        const dy = nxt.notes[j].y - src.y;
        const dx = nxt.notes[j].x - src.x;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) { bestDist = dist; bestJ = j; }
      }
      if (bestJ >= 0) {
        toNext[i] = bestJ;
        taken.add(bestJ);
      } else {
        // No target available in next group — ball will merge/fade rather
        // than collapse onto note 0 alongside another ball.
        toNext[i] = null;
      }
    }
    cur.toNext = toNext;
  }
}

/**
 * Sort a staff's events by time, cluster simultaneous notes (within
 * 1 ms) into ChordGroups, sort each group's notes by y, pre-compute
 * the `toNext` nearest-neighbour matchings, and stamp `group.center`
 * so the hot loop never recomputes the centroid per frame.
 *
 * @param {Array<{ time: number, x: number, y: number, id: string }>} staffEvents
 * @returns {ChordGroup[]}
 */
export function buildChordGroups(staffEvents) {
  // Sort by time
  staffEvents.sort((a, b) => a.time - b.time);

  // Build chord groups (cluster events within 1 ms of each other)
  /** @type {ChordGroup[]} */
  const chordGroups = [];
  /** @type {ChordGroup|null} */
  let cur = null;

  for (const e of staffEvents) {
    if (!cur || Math.abs(e.time - cur.time) > 0.001) {
      cur = { time: e.time, notes: [] };
      chordGroups.push(cur);
    }
    cur.notes.push({ x: e.x, y: e.y, id: e.id });
  }

  // Sort notes within each group by y-position (pitch order)
  for (const g of chordGroups) {
    g.notes.sort((a, b) => a.y - b.y);
    g.center = centerOf(g.notes);
  }

  // Pre-compute stable note orderings between consecutive chord groups
  // so that balls track the nearest note rather than jumping by y-index.
  buildMatchings(chordGroups);

  return chordGroups;
}

/**
 * @typedef {{ time: number, notes: Array<{ x: number, y: number, id: string }>, center: { x: number, y: number } }} ChordGroup
 */
