/**
 * Assign each staff a stable palette index: iterating the timeline in
 * order, the first-seen staff gets the next index.  This is exactly
 * the order used by `LightBallController.setEvents`'s `byStaff`
 * insertion order, so a played note's colour always matches its
 * staff's light ball.
 *
 * @param {Array<{ staff: number }>} timeline
 * @returns {Map<number, number>} staff → palette index
 */
export function assignStaffColorIndices(timeline) {
  const indices = new Map();
  let next = 0;
  for (const e of timeline) {
    if (!indices.has(e.staff)) {
      indices.set(e.staff, next++);
    }
  }
  return indices;
}
