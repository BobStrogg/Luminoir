/**
 * Distance-ordered detail LOD, measured along score X from the
 * camera target (the playhead).  Shared by the quality governor,
 * `LodGate`, and the detail-fade shader so the three cannot drift.
 *
 * Anything whose closest point lies inside `LOD_NEAR_RADIUS` is never
 * hidden and never faded — nearby notes and stems stay.  Detail past
 * `LOD_FAR_RADIUS` is the first thing a full-quality view may drop.
 * The fade band is the last `LOD_FADE_WIDTH` world units before the
 * reach, so a chunk does not pop off at the boundary.
 */
export const LOD_NEAR_RADIUS = 6;
export const LOD_FAR_RADIUS = 36;
export const LOD_FADE_WIDTH = 2.5;
