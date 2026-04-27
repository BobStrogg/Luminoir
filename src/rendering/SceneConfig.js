/**
 * Scene configuration — central source of truth for all visual /
 * camera / light-ball constants the rendering pipeline reads.  Most
 * fields are persisted via the settings panel; the rest are
 * design-time tunables.
 */
export const SceneConfig = {
  // SVG to world-unit scale (Verovio SVG coords are ~thousands of units)
  scale: 0.001,

  /**
   * Audio/visual sync offset in milliseconds.  Added to the music time
   * the visual side reads each frame, so:
   *
   *   • +N — visuals are shifted N ms *earlier* in music time, i.e.
   *     the light ball lights up a note ≈ N ms before the audio
   *     emits it.  Use this when the audio output appears to lag
   *     behind the visuals (audio interface buffer, Bluetooth speaker
   *     latency, etc.).
   *   • -N — visuals are shifted N ms *later*; useful if visuals
   *     somehow run ahead of audio (rare in this codebase since both
   *     are anchored to the same `performance.now()` clock).
   *   •  0 — visuals follow the same clock as audio with no shift.
   *
   * The offset lives in `SceneConfig` so it can be tweaked at runtime
   * from the settings panel; the worker reads it inside
   * `currentMusicTime()` every frame, so changes apply on the very
   * next rAF without any reparse or scene rebuild.
   */
  audioVisualOffsetMs: 0,

  /**
   * Playback-speed multiplier applied on top of the score's native
   * MIDI tempo map.  1.0 = play at the tempo encoded in the score's
   * `<sound tempo="…"/>` events / MIDI tempo meta-events; 0.5 = half
   * speed; 2.0 = double speed.
   *
   * Lives here (rather than in MIDIPlayer alone) so the settings
   * panel can read/write it through the same registry every other
   * setting uses, and so the worker's clock anchor stays in sync
   * (the render worker derives its own per-frame music time from the
   * same `tempoScale` MIDIPlayer hands it).
   */
  playbackSpeed: 1.0,

  // Verovio renders SMuFL glyph references as <use width="480"/> pulling from
  // a <symbol viewBox="0 0 1000 1000">, so the glyph's raw path coords must
  // be multiplied by 480/1000 = 0.48 to match the on-page size.  Without this
  // factor, notehead/clef/time-sig glyphs render ~2× too big.
  glyphUseScale: 0.48,

  // Extrusion depth for note geometry (SVG units before scaling)
  extrusionDepth: 6.0,

  /**
   * Z-thickness in **world** units used for every box-line element
   * (staff lines, bar lines, simple-line stems, beam bars).  Box
   * lines historically derived their depth from the *visible*
   * thickness — `widthAcross * 0.5` — which made beam bars (with a
   * width of ≈ 0.06 world units) about 10× thicker in Z than every
   * other piece of notation, so they bulged out of the page from
   * oblique camera angles.  A single shared constant tuned to match
   * the notehead's extruded depth (0.00288 world units, see
   * `extrusionDepth × scale × glyphUseScale`) keeps every score
   * element on the same vertical plane.
   */
  notationDepth: 0.003,

  // Staff / note appearance
  staffLineThickness: 0.008,
  /**
   * Three-layer elevation stack for the notation — each element class
   * sits at a fixed Z above the paper plane, all close enough that
   * the whole score still reads as "ink on paper" but with enough
   * separation to avoid z-fighting between layers at oblique camera
   * angles.
   *
   * Layer 1 — structural lines (staff lines, bar lines): the bottom
   *   of the stack, almost flush with the paper.  `barLineElevation`
   *   used to be hardcoded to 0 while staff lines sat at 0.001, so
   *   at certain angles bar lines poked through the staff.  Putting
   *   both at the same tiny lift keeps them coplanar.
   *
   * Layer 2 — every non-note glyph that decorates the page (clefs,
   *   key/time signatures, accidentals, augmentation dots, dynamics,
   *   articulations, ties, slurs, expression marks, tempo/dir text,
   *   pedal brackets, fermatas, hairpins, octave lines, tuplet
   *   numbers, system braces, …).  All of these sit *visibly below*
   *   the notes so a glowing played notehead always has clear Z
   *   dominance over an adjacent accidental or dot — without that,
   *   the bright emissive notehead and a dark glyph at the same
   *   elevation flicker for which one is "in front" depending on
   *   sub-pixel depth.
   *
   * Layer 3 — notes and the parts that physically *make up* a note's
   *   visual shape (noteheads, stems, flags, beams).  These three
   *   types must share the notehead's Z plane so the stem connects
   *   cleanly to its notehead and the beam's bottom edge sits flush
   *   with each stem's top instead of floating a millimetre below.
   *   Decorations like accidentals or dots that *attach to* a note
   *   conceptually but are drawn alongside it deliberately go to
   *   Layer 2 (see comment in `SVG3DBuilder._build`'s
   *   `NOTE_ATTACHED_TYPES`).
   *
   * The whole stack spans 0.008 world units — roughly 2.5× the
   * notation extrusion depth (`notationDepth = 0.003`), which gives
   * each layer ≈1.5× its own thickness of clearance from its
   * neighbours.  That's enough for a typical "hovering ink" look
   * without any visible detachment at the camera angles the user
   * orbits through during normal interaction.
   *
   * The previous `noteElevation = 0.04` put notes roughly 40× their
   * own thickness above the paper, which from a low-angle view
   * looked like each notehead was floating on its own small pillar
   * rather than being part of a printed page.
   */
  staffLineElevation: 0.002,
  barLineElevation: 0.002,
  otherElementsElevation: 0.006,
  noteElevation: 0.010,
  barLineWidth: 0.02,

  /**
   * Notation feature flags — opt-in/opt-out of specific element
   * classes that the SVG parser is otherwise capable of rendering.
   *
   * `hiddenClasses` is a list of Verovio SVG class names whose
   * `<g class="…">` groups should be skipped entirely during the
   * parse walk.  Skipped groups don't contribute to bounds,
   * geometry, or the played-note timeline — visually they
   * disappear, and the score's bbox tightens around the remaining
   * notation.
   *
   * Defaults
   *   • `pedal` — sustain-pedal `Ped./*` brackets sit ≈1 staff-step
   *     below the bass clef; they're a visual chunk that visually
   *     dominates the page, and once included in the bounds the
   *     paper has to grow to fit them which pushes the staff
   *     itself toward the top of the view.  Most users find this
   *     distracting on busy piano scores (Perfect, Moonlight,
   *     Sound of Silence, …) and prefer the score with pedals
   *     suppressed by default.  Add `'pedal'` here to revert; add
   *     other class names (e.g. `'hairpin'`, `'octave'`) to hide
   *     more decoration.  See `SVGSceneParser._walkTree` for the
   *     filter point.
   */
  notation: {
    hiddenClasses: ['pedal'],
  },

  // Colors (linear-space floats, dark-elegant theme)
  backgroundColor: 0x0a0a10,
  // Paper now reads as warm off-white so the page looks like actual
  // sheet music rather than a void.  Notes/bar/staff lines are dark
  // enough to remain clearly legible against this background; the
  // light balls still stand out against the bright page because
  // they're emissive and have an additive glow halo.
  paperColor: { r: 0.92, g: 0.90, b: 0.84 },
  staffColor: { r: 0.18, g: 0.18, b: 0.22 },
  noteColor: { r: 0.08, g: 0.08, b: 0.10 },
  barLineColor: { r: 0.18, g: 0.18, b: 0.22 },

  noteReflectivity: 0.35,
  noteMetalness: 0.15,
  noteRoughness: 0.55,

  /**
   * Per-staff played-note appearance.
   *
   * `darkness` multiplies the staff palette colour before it's
   * written into the notehead's `instanceColor`.  Only affects the
   * emissive channel in the current `Materials.noteHead` design —
   * the diffuse stays at `noteColor` for every note — so this knob
   * mainly controls *hue saturation* of the glow (higher = more
   * saturated staff colour, lower = more muted).
   *
   * `glowStrength` scales the per-instance HDR emissive contribution
   * added to `mat.emissiveNode`.  With the diffuse held at dark
   * noteColor, the played notehead's visible brightness comes almost
   * entirely from this channel — at 3.0, the ACES-tone-mapped
   * output sits in the 0.6–0.8 brightness range (clearly glowing
   * against the cream paper) while still preserving hue
   * differentiation between gold, blue, violet, and mint staves.
   *
   * Unplayed notes keep `instanceColor = noteColor`, so their
   * `vInstanceColor` magnitude sits at the baseline and the
   * played-amount clamp evaluates to zero — unplayed notes stay
   * matte at the soft `materialEmissive` floor.
   */
  playedNote: {
    darkness: 0.7,
    glowStrength: 3.0,
  },

  // Light ball defaults
  lightBall: {
    radius: 0.045,
    // Rest Z of a light ball relative to the page plane.  Tracks the
    // notation elevation stack: with notes now at `noteElevation =
    // 0.010`, a ball at `restZ = 0.05` has its bottom at
    // z ≈ 0.005 (well below the notehead's top at ≈ 0.013) and its
    // centre 0.04 above the note — clearly hovering without floating
    // detached from the page the way the previous `restZ = 0.10`
    // did now that the whole notation stack is much closer to the
    // paper.
    restZ: 0.05,
    // Base world-space size of the glow sprite (diameter ≈ radius *
    // glowRadiusMultiplier * 2).  With perspective attenuation on,
    // the apparent size on screen is roughly
    // baseSize * focal / cameraDistance.  Tuned together with the
    // *linear* `glowMod = d × 0.25` boost in `LightBallController`
    // to give a roughly constant ≈14 px halo at any zoom — close-up
    // and Sylvia-Suite wide-shot scenes both end up with the same
    // visible halo size in screen space.
    //
    // Paired with the low-opacity radial gradient in
    // `Materials.lightBallGlow`, a ×0.6 multiplier gives a tight
    // coloured haze around the emissive sphere rather than the
    // page-filling bloom we had on the dark theme.
    glowRadiusMultiplier: 1.0,
    // PointLight intensity on the pooled shared light for this
    // staff.  Halved again from 0.3 to keep the moving light ball
    // a subtle accent — most of the page illumination comes from
    // the ambient + key directional lights, the ball's own pooled
    // PointLight just *warms* the few notes around it.
    intensity: 0.15,
    // World-space falloff distance for the pooled PointLight.  The
    // previous default of 4 lit up the paper in a 4-unit radius
    // around every active ball — at typical camera distances that's
    // more than half the screen, which on a cream background bloomed
    // into a washed-out hotspot.  1.2 keeps the warm tint tight
    // around the ball, so you still see it shining on the page but
    // without losing note legibility in the adjacent bars.
    lightDistance: 1.2,
    bounceHeight: 0.08,
    trailLength: 8,
    // Pulse-on-hit: when the ball reaches a new chord, briefly scale it up.
    // This is what gives each note a visible "landing" even during long
    // smooth interpolations.
    pulseDuration: 0.15,
    pulseScale: 1.25,
    colors: [
      // Saturated LED palette — one near-1.0 channel + two low channels
      // so ACES tone-mapping preserves hue even at HDR brightness.  A
      // pastel `(0.9, 0.8, 0.6)` played-note emissive saturates on all
      // channels simultaneously and reads as cream-white after ACES;
      // these vivid near-primary colours keep their identity because
      // only the dominant channel hits the shoulder.
      { r: 1.0, g: 0.45, b: 0.05 },   // warm amber
      { r: 0.05, g: 0.65, b: 1.0 },   // cool cyan
      { r: 0.85, g: 0.2, b: 1.0 },    // magenta-violet
      { r: 0.2, g: 1.0, b: 0.4 },     // vivid green
    ],
  },

  /**
   * Camera defaults.  All distances are in **world** units; the
   * orientation conventions assume the score's `contentRoot` has been
   * rotated -π/2 around X (paper plane laid on the world XZ plane,
   * notation extruding in +Y).
   *
   *   • `fov`              — vertical field of view in degrees.
   *   • `near` / `far`     — perspective frustum bounds.
   *   • `defaultDistance`  — camera-to-orbit-target distance along
   *     world Z when no score is loaded.  Once a score loads,
   *     `CameraController.configureForScore` may *increase* this
   *     value so the full staff-spread fits vertically in the FOV.
   *
   *   • `pitchDegrees`     — vertical angle from horizontal at which
   *     the camera looks DOWN at the page in the YZ plane.  Combined
   *     with `chaseRatio`, this controls the overall 3D pitch the
   *     camera ends up at.  Useful values:
   *       45° — what the app uses now; the camera looks down on the
   *             page at the same angle it sits in front, putting the
   *             playhead near the centre of the screen with the
   *             upcoming bar laid out diagonally toward the top.
   *       30° — earlier mid-pitch reference; flatter look that puts
   *             the staves nearly parallel to the screen.
   *       25° — cinematic low-angle look; very side-on, score sits
   *             in the lower 2/3 of the screen.
   *       <halfFov — degenerate; the screen TOP looks above the
   *             horizon (sees the dark void), not just empty floor.
   *             Avoid going below ≈ fov/2 + 1° unless you actually
   *             want a visible horizon line in the frame.
   *
   *   • `chaseRatio`       — fraction of the auto-fit distance that
   *     the camera sits *behind* the playhead in world X.  Its main
   *     visual role is rotating the music X-axis on screen:
   *       0.25 — earlier setup; chase ≈ d/4 keeps music X nearly
   *             parallel to screen X (notes flow left-to-right).
   *       0.60 — earlier reference where the chase offset was 60% of
   *             the auto-fit distance.
   *       1.00 — what the app uses now; the chase offset equals the
   *             auto-fit distance (capped at the 3.0-absolute-units
   *             ceiling in `CameraController.snapToTarget` so wide
   *             orchestral scores don't fly off-axis).  Music X then
   *             projects strongly toward the top-right corner —
   *             upcoming notes appear to flow in diagonally with
   *             pronounced forward perspective.
   *
   *   • `contentHeadroom`  — multiplier on the score's vertical
   *     spread when computing the auto-fit camera distance.  Lower
   *     values pack the score tighter against the FOV (more pixels
   *     per note); for a single-staff piece this can drop below 1.0
   *     because the staff-line height alone leaves plenty of FOV
   *     margin.  When the auto-fit distance falls below
   *     `defaultDistance`, the controller clamps to `defaultDistance`
   *     so a single-staff Twinkle doesn't end up zoomed-in inches
   *     from the noteheads.  Together with `pitchDegrees` this is
   *     the primary "how close does the camera sit to the page?" knob.
   */
  camera: {
    fov: 55,
    near: 0.1,
    far: 200,
    defaultDistance: 1.8,
    pitchDegrees: 45,
    chaseRatio: 1.0,
    contentHeadroom: 0.55,
  },

  /**
   * Cinematic auto-camera that gently orbits the playhead during
   * playback so a static scene doesn't feel still.
   *
   * **Behaviour at a glance**
   *   • Enabled by default — opt-out from the settings panel if
   *     you prefer a steady, side-on view (or are manually
   *     framing for a recording).
   *   • While enabled and during playback, applies sinusoidal
   *     yaw / pitch / radius offsets ON TOP of the user's current
   *     orbit pose.  Mouse drag still wins — interacting with
   *     OrbitControls suspends the auto-camera and resumes it
   *     after `resumeAfterUserMs` so the user's release doesn't
   *     fight a moving target.
   *   • A per-staff exponentially-decaying "activity" signal
   *     (chord size hitting the playhead) drives a speed +
   *     amplitude multiplier — the camera idles during quiet
   *     phrases and livens up under dense passages.
   *
   *   • `enabled`            — master on/off.
   *   • `orbitStrength`      — peak yaw / pitch swing in radians.
   *     0.25 ≈ ±14° feels lively without being motion-sick.  Pitch
   *     gets 0.3× this so the camera doesn't crash through the
   *     paper.
   *   • `orbitSpeed`         — base phase advance (rad/s).  At
   *     0.15 the primary yaw cycle is ≈ 9 s long; activity speeds
   *     it up to a hard cap of 2× during the densest passages.
   *   • `zoomStrength`       — peak fractional radius wobble.  0.10
   *     means the camera occasionally pulls 10 % closer or backs
   *     10 % off; lower values feel more like Hollywood handheld,
   *     higher start to feel like a TV-zoom.
   *   • `activityDecaySeconds` — exponential-decay time-constant
   *     for the activity counter.  ≈ 2.0 s lets a sudden run of
   *     16ths build up a few seconds of energy that fades away
   *     before the next phrase.
   *   • `biasStrength`       — 0..1, how much the camera leans
   *     toward the dominant staff (when one staff has > 55 % of
   *     the recent activity).  0.5 = subtle nudge; 1.0 = aggressive
   *     follow.  Reduces the orbit yaw amplitude when biased so
   *     the cumulative motion stays inside `orbitStrength`.
   *   • `topDownChance`      — Bernoulli probability *per second*
   *     of triggering a 1-shot near-overhead pitch dip during
   *     high-activity passages (totalActivity > 3.0).  At 0.01 a
   *     fast piece sees one every ≈ 100 s of energetic playing.
   *   • `topDownDuration`    — seconds the overhead drift lasts;
   *     blends in/out with a half-sine so the transition is
   *     untreasured.
   *   • `resumeAfterUserMs`  — quiet period after the user
   *     releases the mouse before the orbit resumes.  Smooth
   *     enough that releasing the drag feels intentional, not
   *     "fighting the camera".
   */
  smartCamera: {
    enabled: true,
    orbitStrength: 0.15,
    orbitSpeed: 0.08,
    zoomStrength: 0.06,
    activityDecaySeconds: 2.0,
    biasStrength: 0.3,
    topDownChance: 0,
    topDownDuration: 4.0,
    resumeAfterUserMs: 1500,
  },

  /**
   * Directional key-light shadow quality.  All shadow-map tuning knobs
   * live here so they can be adjusted from one place.  Read once at
   * startup by `renderWorker.js`; changing them at runtime requires a
   * page reload.
   *
   * The trickiest tradeoffs revolve around `barLineWidth = 0.02` —
   * vertical bar lines are the thinnest cast-shadow source on the
   * page.  Three settings interact to determine whether their shadows
   * stay solid during camera motion or shimmer on/off:
   *
   *   • `mapSize` × frustum extents → texel size.  At the default
   *     6144² over a 40×30 frustum, one texel is ≈0.0065×0.0049 world
   *     units, so a 0.02-wide bar line covers ≈ 3 texels — comfortably
   *     above the temporal-aliasing threshold even before texel
   *     snapping (`_updateKeyLight`) and PCF smoothing kick in.
   *     Dropping to 4096² leaves the bar covering only ≈ 2 texels,
   *     and the shadow can flicker depending on which texel boundary
   *     the line lands on as the camera pans.  Bumping to 8192² is
   *     possible if you want even crisper shadows; cost is ≈ +2 ms
   *     per frame on Sylvia-Suite-sized scores.
   *
   *   • `radius` (PCF Soft kernel size).  This *softens* the shadow
   *     edges by averaging samples in a multi-texel neighbourhood.
   *     If the kernel radius exceeds the shadow's own width the
   *     filter washes out thin shadows: with a 0.02 bar-line shadow
   *     and a `radius = 3` kernel (≈ 0.02 world units at 6144²) the
   *     shadow's contribution is diluted by ≈ 4× and the line reads
   *     as faint smudge rather than a clean shadow.  `radius = 2`
   *     keeps the soft penumbra without overwhelming thin features.
   *
   *   • `normalBias` offsets the depth-comparison sample point along
   *     the receiving surface's normal to combat shadow acne.  The
   *     offset must stay *smaller* than `notationDepth = 0.003` —
   *     otherwise the bias can push the sample completely past a
   *     thin caster and report "lit" for what should clearly be in
   *     shadow.  0.002 leaves enough margin for both anti-acne and
   *     thin-geometry coverage.
   *
   *   • `bias` is a constant depth offset that combats the same
   *     acne.  Less negative is gentler — too-negative values can
   *     also cause "Peter Panning" where the shadow appears
   *     detached from the object.  -0.0003 is the smallest value
   *     that still suppresses acne on the metallic notehead
   *     materials.
   *
   * Frustum extents are sized to cover Sylvia-Suite's worst-case wide
   * shot (camera at d=30, FOV 55° → ~31×17 world units visible) plus
   * a margin for objects just outside the view that still cast into
   * it.  Tightening the frustum *increases* shadow detail (smaller
   * texels) but risks clipping shadows from off-screen notes.
   */
  shadow: {
    mapSize: 6144,
    frustumHalfWidth: 20,
    frustumHalfHeight: 15,
    near: 0.5,
    far: 40,
    bias: -0.0003,
    normalBias: 0.002,
    radius: 2,
  },
};
