/**
 * Feature flags for the rendering fast-paths.
 *
 * These optimisations drastically reduce draw-call count and pan-time
 * stalls on large scores, but each one rewrites either the scene graph
 * or the render loop in a non-trivial way.  If we ever see a visual
 * regression we can flip them off one-by-one to isolate which stage
 * broke.  When the bisect is done, set everything back to `true`.
 *
 * Effect on scene graph
 * ---------------------
 *   `BUCKET_INSTANCES`   one `InstancedMesh` per `(pathD, depth, material)`
 *                        vs. one `Mesh` per SVG element.  Without this the
 *                        draw-call count scales with *note count* not
 *                        *unique glyph count*.
 *   `CHUNK_BUCKETS_BY_X` partition each bucket into multiple
 *                        `InstancedMesh`es along X so Three.js's per-mesh
 *                        frustum culling also skips horizontally off-screen
 *                        chunks.  Without this you draw the whole score
 *                        every frame even when panned to one side.
 *   `STEM_DEDUP`         detect `M x y L x y` line paths and re-route them
 *                        into the shared box bucket.  Each unique stem
 *                        length would otherwise be its own `pathD` and
 *                        therefore its own bucket.
 *   `SHARED_UNIT_BOX`    reuse a single `BoxGeometry(1,1,1)` for every
 *                        staff-line / bar-line / stem instance; per-instance
 *                        matrices supply scale & rotation.
 *
 * Effect on render loop
 * ---------------------
 *   `PRECOMPILE_PIPELINES`  call `compileAsync` at score-load so the first
 *                           pan doesn't stall on inline pipeline compile.
 *   `RENDER_BUDGET_SKIP`    drop a render tick if the previous submit took
 *                           longer than the budget.  Still advances animation.
 *
 * Effect on lighting cost per fragment
 * ------------------------------------
 *   `SHARED_STAFF_LIGHTS`  use one shared `PointLight` per staff instead
 *                          of one per `LightBall`.  Every extra point
 *                          light adds a loop iteration to the fragment
 *                          shader on every pixel of every mesh, so on a
 *                          20-staff / 4-ball-per-staff score this cuts
 *                          the shader light loop from ~40 iterations to
 *                          ~20.  Slight visual difference: the light
 *                          sits at the centroid of the active balls on
 *                          that staff, not on each ball individually.
 *   `MAX_POINT_LIGHTS`     hard cap on total point lights in the scene
 *                          (0 = no cap).  Anything above this is culled
 *                          to minimise fragment shader cost on very
 *                          wide / many-staff scores.
 *
 * Effect on geometry / draw cost when zoomed out
 * ----------------------------------------------
 *   `LOD_DISTANT_ELEMENTS`  when the camera is further than
 *                           `LOD_DISTANCE_THRESHOLD` from its target,
 *                           skip emitting the small per-note decorations
 *                           (child paths — stems, flags, ledger lines)
 *                           at build time.  Their draw-call cost stays
 *                           but we render far fewer total primitives.
 *   `DISTANCE_CLIP_GLYPHS`  when the camera is far enough away that
 *                           individual notehead glyphs would be sub-pixel
 *                           anyway, cull them from the render list each
 *                           frame.  Cheaper than skipping at build
 *                           time because it adapts to zoom changes.
 */
export const OPTIMIZATIONS = {
  // Scene-build optimisations (SVG3DBuilder)
  BUCKET_INSTANCES: true,
  CHUNK_BUCKETS_BY_X: false,
  STEM_DEDUP: true,
  SHARED_UNIT_BOX: false,

  // Lighting (LightBallController)
  SHARED_STAFF_LIGHTS: true,
  MAX_POINT_LIGHTS: 8,

  // Zoomed-out LOD (SVG3DBuilder + runtime)
  LOD_DISTANT_ELEMENTS: true,
  LOD_DISTANCE_THRESHOLD: 12,
  DISTANCE_CLIP_GLYPHS: true,

  // Render-loop optimisations (renderWorker)
  PRECOMPILE_PIPELINES: true,
  RENDER_BUDGET_SKIP: false,
};
