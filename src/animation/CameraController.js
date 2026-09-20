import * as THREE from 'three';
import { SceneConfig } from '../rendering/SceneConfig.js';
import { smoothDamp } from './smoothDamp.js';
import { dampingFactorForDt } from '../renderer/worker/qualityPolicy.js';

/**
 * Smooth camera that follows the light balls by updating the
 * OrbitControls target.  The user can freely rotate and zoom
 * while the target point glides along with the music.
 *
 * **Coordinate convention** (post-`contentRoot.rotation.x = -π/2`):
 *
 *   • World X — music progression (left → right across measures).
 *     The orbit target's X follows playback time via the
 *     piecewise-linear note track + critically-damped spring below.
 *
 *   • World Y — vertical, up off the floor.  The orbit target stays
 *     pinned at Y = 0 (the paper plane) because the camera is
 *     orbiting *around the music laid out on a table*, not around a
 *     vertical wall.  Locking target Y means the user's
 *     drag-to-rotate maps onto a celestial sphere centred on the
 *     paper, which feels right for a "walk around the score" gesture.
 *
 *   • World Z — staff-spread depth.  In score-local coordinates the
 *     vertical-staff axis was Y; the -π/2 X rotation maps that to
 *     world -Z, so the staff cluster's centre sits at world
 *     Z = -(score_minY + score_maxY)/2.  We compute that once in
 *     `configureForScore` and lock the orbit target's Z to it so
 *     multi-staff scores stay vertically centred in the view as the
 *     camera scrolls horizontally.
 *
 * The X-follow uses an explicit 2nd-order critically-damped spring
 * so the camera has continuous velocity AND acceleration; without
 * this the camera jerks at every velocity kink in the piecewise-
 * linear time→x track.
 */
export class CameraController {
  /** @type {THREE.PerspectiveCamera} */
  camera;
  /** @type {import('three/examples/jsm/controls/OrbitControls.js').OrbitControls} */
  _controls;

  _target = new THREE.Vector3();
  _lookTarget = new THREE.Vector3();
  _enabled = true;

  // Score-framing state, set via configureForScore().  Stored in
  // **world** coordinates: contentCenterZ is the world Z of the
  // staff-spread centre (negated score-local Y), `_contentDistance`
  // is the camera-to-target distance needed to fit the staff spread
  // vertically in the view at the current FOV.
  _contentCenterZ = 0;
  _contentDistance = null;

  // Critically-damped spring state for the look-ahead target.  The camera
  // position rides at a fixed chase offset behind this target, so a single
  // spring gives us continuous velocity and acceleration for both.
  _lookSpring = { x: 0, v: 0 };
  _lookSpringReady = false;

  // Post-stall catch-up: `_lastTickNow` records the rAF timestamp of the
  // previous update().  A gap > 500 ms means the worker's rAF starved
  // (GPU backpressure, tab throttle) while the wall-clock music time kept
  // running — the playhead is then far ahead, and a 3 s smoothTime makes
  // the camera visibly sprint for seconds.  `_catchUpUntil` engages a
  // tightened smoothTime for ~1.5 s so recovery is a fast glide instead.
  // Switching smoothTime mid-flight never jerks position — it only
  // changes the spring's responsiveness — so this is invisible during
  // normal playback (gaps are ≤ 33 ms even at 30 fps).
  _lastTickNow = 0;
  _catchUpUntil = 0;

  // World-space offset from the look-ahead target to the camera's "chase"
  // pose.  Set by _computeChase() and used by both the base orbit and the
  // smart-camera overlay.
  _chase = new THREE.Vector3(-0.5, 1.5, 2.5);
  _baseSpherical = new THREE.Spherical();

  // The live camera-target spherical offset.  Kept in sync with
  // `controls.spherical` so user drags and auto-return are stateless.
  _currentSpherical = new THREE.Spherical();

  // Desired spherical offset computed by the smart-camera overlay.
  _desiredSpherical = new THREE.Spherical();
  _desiredSphericalActive = false;
  _desiredOffset = new THREE.Vector3();

  // Scratch spherical / vector used to rebuild `camera.position` from
  // `target` + offset while applying the auto-return spring.
  _nextSpherical = new THREE.Spherical();
  _scratchOffset = new THREE.Vector3();

  /**
   * Piecewise-linear time→x mapping derived from the note timeline.
   * `_times[i]` ↔ `_xs[i]` describes one note event; xAtTime() interpolates
   * between adjacent entries.  This keeps the camera sitting on each note
   * (rather than on a loose average) while the spring in `update()`
   * smooths the per-segment velocity changes away.
   * @type {{ times: Float64Array, xs: Float64Array }}
   */
  _track = { times: new Float64Array(0), xs: new Float64Array(0) };
  /** Cached monotonic index into _track for O(1) lookup during playback. */
  _trackIdx = 0;
  _lookTrackIdx = 0;

  /* ------------------------------------------------------------------ */
  /*  Smart camera — cinematic auto-orbit                                */
  /* ------------------------------------------------------------------ */
  /** Phase angle (radians) advanced each frame; drives the sinusoidal
   *  yaw / pitch / zoom oscillations.  Reset on score load. */
  _smartPhase = 0;
  /** Live smart-camera offsets, eased toward the desired sinusoidal
   *  values so a sudden change in activity doesn't jerk the camera. */
  _smartYaw = 0;
  _smartPitch = 0;
  _smartRadiusFactor = 1.0;
  /** True while the user is actively interacting with OrbitControls.
   *  Smart camera defers the orbit, lets the user drag freely, and
   *  resumes a moment after they release. */
  _userInteracting = false;
  /** Performance.now() timestamp at which we may resume the auto orbit
   *  after a user-drag release.  0 means "no pending resume". */
  _smartResumeAt = 0;

  /**
   * Per-staff exponentially-decaying activity counter.  Notes fire
   * `recordBeatGroupHit(staff, chordSize)` each time the playhead
   * lands on a chord; the value decays toward 0 over the
   * `activityDecaySeconds` time-constant in SceneConfig.smartCamera.
   * The smart-camera update reads this each frame to drive a
   * speed/amplitude multiplier and to detect a "dominant staff" worth
   * leaning toward.
   * @type {Map<number, { value: number, t: number }>}
   */
  _staffActivity = new Map();
  /** Reusable scratch Map for `_smartActivityWeights()` — pre-allocated
   *  once to avoid a `new Map()` GC allocation on every rAF tick. */
  _smartWeightsScratch = new Map();
  /** Preallocated result object for `_smartActivityWeights()` — mutated
   *  in place each frame so the smart-camera tick allocates nothing. */
  _activitySummary = { weights: this._smartWeightsScratch, total: 0, dominantStaff: -1, dominance: 0 };
  /** Top-down dramatic-overhead state.  When `_topDownEndAt` is in
   *  the future, the smart-camera pitch is biased upward toward an
   *  overhead view that fades back out via a half-sine. */
  _topDownEndAt = 0;
  /** Smoothed activity multiplier — eased separately from the orbit
   *  offsets so that sudden note-density spikes don't jerk the phase
   *  speed (and therefore the camera speed) abruptly. */
  _easedActivityMul = 1.0;
  /** Last `performance.now()` timestamp the smart camera phase was
   *  advanced.  `0` means it is paused (user interaction, cooldown,
   *  or disabled), so the phase does not accumulate wall-clock time
   *  while inactive. */
  _lastSmartPhaseUpdate = 0;

  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('three/examples/jsm/controls/OrbitControls.js').OrbitControls} controls
   */
  constructor(camera, controls) {
    this.camera = camera;
    this._controls = controls;
    // We drive camera position manually; `controls.update()` applies the
    // user's (damped) rotate/zoom gesture and clamps the orbit.  Damping
    // stays enabled — set in handleInit — because the controller is
    // stateless w.r.t. user input: each frame it reads the post-update
    // camera offset back into `_currentSpherical`, so inertia and the
    // auto-return spring compose without fighting.
    //
    // The worker patches `controls.update` to a no-op so pointer-event
    // handlers can't consume damping steps at event rate; `syncUpdate`
    // is the real bound method and runs exactly once per rAF tick from
    // here.  `_dampingBase` is the configured factor's meaning at 60 Hz
    // — `update()` rescales it by dt so inertia lasts the same
    // wall-clock time on every display.
    this._stepControls = typeof controls.syncUpdate === 'function'
      ? controls.syncUpdate
      : (dt) => controls.update(dt);
    this._dampingBase = controls.dampingFactor || 0.12;
  }

  set enabled(v) {
    this._enabled = v;
  }

  get enabled() {
    return this._enabled;
  }

  /**
   * Called once per loaded score: measures the vertical spread of the
   * content so the camera can back away far enough to keep everything
   * (treble + bass staves in a piano piece) in frame.
   *
   * Inputs `minY` / `maxY` are in **score-local** coordinates as
   * computed by SVGSceneParser.  We negate (and average) here to
   * convert into world Z, since contentRoot's -π/2 X rotation maps
   * local Y to world -Z.
   */
  configureForScore(minY, maxY) {
    const cfg = SceneConfig.camera;
    const spread = maxY - minY;
    // World Z of the staff-cluster centre.  Local Y was top-positive
    // / bottom-negative (post-Y-flip in SVG3DBuilder), so the local
    // mid-point can be either sign — negating it gives the correct
    // world Z to anchor the orbit target on.
    this._contentCenterZ = -(minY + maxY) / 2;

    // Visible height at distance d with fov θ: h = 2 * d * tan(θ/2).
    // Solve for d given the configured headroom factor so the content
    // isn't flush against the edges.  We're computing the distance
    // the camera needs from the orbit target along its forward axis;
    // the `snapToTarget` placement below picks that distance up via
    // `_contentDistance` and uses it for the offset along world +Z.
    //
    // This formula treats the staff plane as if it were perpendicular
    // to the camera's forward axis (a top-down view).  In reality the
    // camera sits at `pitchDegrees` from horizontal, so the staff's
    // world-Z spread projects onto the screen with a `cos(pitch)`
    // foreshortening.  At pitches in the 25–35° range that
    // foreshortening is mild enough that a single `contentHeadroom`
    // multiplier covers it; at extreme pitches you'd need a
    // pitch-aware framing equation.
    const halfFov = (cfg.fov * Math.PI) / 360;
    const headroom = cfg.contentHeadroom ?? 1.25;
    const minDistanceForHeight = (spread * headroom) / (2 * Math.tan(halfFov));
    this._contentDistance = Math.max(cfg.defaultDistance, minDistanceForHeight);
    this._computeChase();
  }

  /**
   * Compute the world-space chase offset from the camera target.  This
   * is the "resting" pose the camera returns to when the user is not
   * interacting.  It depends on the score framing (`_contentDistance`)
   * and the current aspect ratio (portrait gets a steeper pitch and a
   * smaller chase offset).
   */
  _computeChase() {
    const cfg = SceneConfig.camera;
    const distance = this._contentDistance || cfg.defaultDistance;

    const aspect = this.camera.aspect ?? 1;
    const portraitFactor = Math.max(0, Math.min(1, (1 - aspect) * 2));
    const portraitPitch = 65;
    const portraitChase = 0.25;
    const basePitchDeg = cfg.pitchDegrees ?? 30;
    const baseChase = cfg.chaseRatio ?? 0.25;
    const effectivePitch = basePitchDeg + (portraitPitch - basePitchDeg) * portraitFactor;
    const effectiveChase = baseChase + (portraitChase - baseChase) * portraitFactor;

    const pitchRad = (effectivePitch * Math.PI) / 180;
    const heightRatio = Math.tan(pitchRad);
    const chaseX = -Math.min(distance * effectiveChase, 3.0);

    this._chase.set(chaseX, distance * heightRatio, distance);
    this._baseSpherical.setFromVector3(this._chase);
  }

  /**
   * Feed a sorted timeline so the camera can track *musical time*.
   * The timeline must already be sorted by time ascending.
   *
   * We build a piecewise-linear time→x curve using the actual note
   * positions so the camera sits exactly on each note.  Multiple staff
   * events at the same time (a chord) collapse into a single knot at
   * the leftmost active note, matching the original SceneKit demo's
   * "lead note" camera target.  The spring in `update()` smooths the
   * per-segment velocity changes into a visually continuous motion.
   * @param {Array<{ time: number, x: number }>} timeline
   */
  setTimeTrack(timeline) {
    this._trackIdx = 0;
    this._lookTrackIdx = 0;
    if (!timeline || timeline.length === 0) {
      this._track = { times: new Float64Array(0), xs: new Float64Array(0) };
      return;
    }
    // Collapse notes sharing a time instant into a single knot at the
    // leftmost X.  Times are already monotonically non-decreasing so we
    // only have to look at the previous knot.
    const times = [];
    const xsByTime = [];
    let lastTime = NaN;
    for (const e of timeline) {
      if (e.time === lastTime) {
        xsByTime[xsByTime.length - 1] = Math.min(xsByTime[xsByTime.length - 1], e.x);
      } else {
        times.push(e.time);
        xsByTime.push(e.x);
        lastTime = e.time;
      }
    }
    const n = times.length;
    const ts = new Float64Array(n);
    const xs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ts[i] = times[i];
      xs[i] = xsByTime[i];
    }
    this._track = { times: ts, xs };
  }

  /**
   * Piecewise-linear interpolation of the note timeline.  The *target*
   * returned here is the halfway-between-notes position for most of a
   * note's duration, but paired with the critically-damped spring in
   * `update()` (whose steady-state lag at velocity v is v·smoothTime)
   * the two errors cancel and the **spring output** — i.e. what the
   * camera actually shows — sits on the currently-playing note.
   *
   * The cancellation is exact when smoothTime ≈ note_span/2; in
   * practice for 0.25 s smoothing and typical 0.4–0.6 s inter-note
   * spacing the residual is fractions of a note, which is not
   * perceptible.
   */
  xAtTime(time, cache = 'main') {
    const { times, xs } = this._track;
    const n = times.length;
    if (n === 0) return null;
    if (time <= times[0]) return xs[0];
    if (time >= times[n - 1]) return xs[n - 1];
    // Monotonic cache so playback queries are O(1); walk backwards
    // only if the caller has rewound (stop + replay).
    let i = cache === 'lookAhead' ? this._lookTrackIdx : this._trackIdx;
    if (times[i] > time) i = 0;
    while (i + 1 < n && times[i + 1] <= time) i++;
    if (cache === 'lookAhead') this._lookTrackIdx = i;
    else this._trackIdx = i;
    const t0 = times[i];
    const t1 = times[i + 1];
    const u = (time - t0) / (t1 - t0);
    return xs[i] + (xs[i + 1] - xs[i]) * u;
  }

  /**
   * Set the horizontal target the camera should follow and look toward.
   * Y is locked to the paper plane (0) and Z to the staff-spread
   * centre computed by `configureForScore`, so the orbit target
   * always sits *on the paper*.  The camera position follows the
   * current note X while the look target can sit slightly ahead, matching
   * the original demo's anticipatory framing without changing playback
   * timing.
   * @param {THREE.Vector3} target  Only `.x` is used.
   * @param {number} [lookAheadX]
   */
  setTarget(target, lookAheadX = target.x) {
    this._target.set(
      target.x,
      0,
      this._contentCenterZ,
    );
    this._lookTarget.set(
      lookAheadX,
      0,
      this._contentCenterZ,
    );
  }

  /**
   * Called every frame.
   * Smoothly translates the OrbitControls target along the note rail;
   * the camera is kept at the same spherical offset so it follows the
   * target.  User drag updates that offset directly, and after a cool
   * down period the auto-return spring pulls it back to the chase pose.
   * @param {number} dt – delta time in seconds
   */
  update(dt, now = performance.now()) {
    if (!this._enabled || !this._controls) return;
    // Clamp crazy dt so a dropped frame can't kick the spring into a
    // multi-unit jump.
    const h = Math.min(Math.max(dt, 0.0001), 0.1);

    const desiredLookX = this._lookTarget.x;
    const desiredY = this._lookTarget.y;
    const desiredZ = this._lookTarget.z;

    if (!this._lookSpringReady) {
      this._lookSpring.x = desiredLookX;
      this._lookSpring.v = 0;
      this._lookSpringReady = true;
    }

    // Critically-damped spring for the look-ahead target.  The camera
    // position is an OrbitControls spherical offset around this target;
    // driving position via `sphericalDelta` lets user drag and the
    // auto-return spring share the same state.
    const smoothTime = SceneConfig.camera.smoothTime ?? 3.0;
    if (this._lastTickNow > 0 && now - this._lastTickNow > 500) {
      this._catchUpUntil = now + 1500;
    }
    this._lastTickNow = now;
    smoothDamp(this._lookSpring, desiredLookX,
      now < this._catchUpUntil ? Math.min(smoothTime, 0.9) : smoothTime, h);

    // The orbit target follows the music.  Read the current camera offset
    // (which may have been updated by OrbitControls user events since the
    // last frame) before moving the target, then rebuild position and let
    // `controls.update` add the user's drag, clamp, and sync.
    this._scratchOffset.copy(this.camera.position).sub(this._controls.target);
    this._currentSpherical.setFromVector3(this._scratchOffset);

    this._controls.target.set(this._lookSpring.x, desiredY, desiredZ);

    // Recalculate the chase pose in case orientation changed.
    this._computeChase();

    // Let the smart camera propose its desired spherical offset.
    this._desiredSphericalActive = false;
    this._updateSmartCamera(h, now);

    // Start from the camera's current offset around the target.
    this._nextSpherical.copy(this._currentSpherical);

    // Auto-return: after the user releases and the cooldown has passed,
    // pull the spherical offset toward the chase pose (or the chase pose
    // plus the smart camera overlay, if enabled).
    const inCooldown = this._smartResumeAt > 0 && now < this._smartResumeAt;
    const returnActive = !this._userInteracting && !inCooldown;
    if (returnActive) {
      const returnTime = SceneConfig.camera.returnTime ?? 2.0;
      const k = 1 - Math.exp(-h / returnTime);
      const desiredSpherical = this._desiredSphericalActive
        ? this._desiredSpherical
        : this._baseSpherical;
      const current = this._currentSpherical;

      this._nextSpherical.theta += this._wrapAngle(desiredSpherical.theta - current.theta) * k;
      this._nextSpherical.phi += (desiredSpherical.phi - current.phi) * k;
      this._nextSpherical.radius += (desiredSpherical.radius - current.radius) * k;
    }

    // Rebuild camera position from target + desired offset.  OrbitControls
    // will then apply the user's `_sphericalDelta` and clamp, writing the
    // final camera position and re-syncing `camera.position`.
    this._scratchOffset.setFromSpherical(this._nextSpherical);
    this.camera.position.copy(this._controls.target).add(this._scratchOffset);

    // Damping is per-update-call, so rescale the factor by this frame's
    // (quantized) dt: identical drags get identical wall-clock inertia
    // on 60 Hz and 120 Hz displays and across dropped frames.
    if (this._controls.enableDamping) {
      this._controls.dampingFactor = dampingFactorForDt(this._dampingBase, h);
    }
    this._stepControls(h);

    // Capture the final clamped spherical offset for next frame.
    this._scratchOffset.copy(this.camera.position).sub(this._controls.target);
    this._currentSpherical.setFromVector3(this._scratchOffset);
  }

  /** Wrap an angle to (-π, π]. */
  _wrapAngle(theta) {
    return Math.atan2(Math.sin(theta), Math.cos(theta));
  }

  /* ------------------------------------------------------------------ */
  /*  Smart camera                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Record a chord hit on the given staff.  Builds an exponentially-
   * decaying activity counter that drives the smart-camera speed +
   * amplitude.  The Hit time stamp is `performance.now()`-based so
   * the decay still works correctly across paused/resumed playback.
   *
   * Cheap (<1 µs) — safe to call directly from the per-frame
   * light-ball update loop.
   *
   * @param {number} staffKey
   * @param {number} chordSize
   */
  recordBeatGroupHit(staffKey, chordSize) {
    const cfg = SceneConfig.smartCamera;
    if (!cfg || !cfg.enabled) return;
    const decay = Math.max(0.001, cfg.activityDecaySeconds || 2);
    const now = performance.now() / 1000;
    const prev = this._staffActivity.get(staffKey);
    const add = Math.max(1, chordSize | 0);
    if (prev) {
      const dtSec = Math.max(0, now - prev.t);
      prev.value = prev.value * Math.exp(-dtSec / decay) + add;
      prev.t = now;
    } else {
      this._staffActivity.set(staffKey, { value: add, t: now });
    }
  }

  /**
   * Tell the controller the user has started / stopped interacting
   * with OrbitControls.  Wired from the worker's `controls`
   * 'start' / 'end' listeners.  While interacting the smart camera
   * yields entirely; on release we re-arm a `resumeAfterUserMs`
   * delay so the orbit doesn't snap back into action mid-release.
   */
  setUserInteracting(active) {
    if (active) {
      this._userInteracting = true;
    } else {
      this._userInteracting = false;
      // Reset the eased smart-camera offsets to neutral so the
      // orbit resumes smoothly from wherever the user left the
      // camera.  Without this the stale offsets from the previous
      // active cycle are applied on top of the new rest pose,
      // causing a visible jump.
      this._smartYaw = 0;
      this._smartPitch = 0;
      this._smartRadiusFactor = 1.0;
      const cfg = SceneConfig.smartCamera;
      const delay = cfg ? (cfg.resumeAfterUserMs ?? 3000) : 3000;
      this._smartResumeAt = performance.now() + delay;
    }
  }

  /**
   * Read the current activity weights with on-the-fly exponential
   * decay so the live numbers stay accurate even when no hits have
   * fired in a while (otherwise the counter would only decay at
   * "next hit" time).
   *
   * Reuses `_smartWeightsScratch` to avoid a `new Map()` allocation
   * per rAF tick on high-staff-count scores.
   *
   * @returns {{ weights: Map<number, number>, total: number, dominantStaff: number, dominance: number }}
   */
  _smartActivityWeights() {
    const cfg = SceneConfig.smartCamera;
    const decay = Math.max(0.001, cfg.activityDecaySeconds || 2);
    const now = performance.now() / 1000;
    // Reuse the pre-allocated scratch Map — clear() is O(n) but avoids
    // the GC cost of allocating + discarding a new Map every frame.
    this._smartWeightsScratch.clear();
    let total = 0;
    let dominantStaff = -1;
    let maxW = 0;
    for (const [staff, st] of this._staffActivity) {
      const dtSec = Math.max(0, now - st.t);
      const w = st.value * Math.exp(-dtSec / decay);
      if (w > 0.0001) {
        this._smartWeightsScratch.set(staff, w);
        total += w;
        if (w > maxW) { maxW = w; dominantStaff = staff; }
      }
    }
    const sum = this._activitySummary;
    sum.total = total;
    sum.dominantStaff = dominantStaff;
    sum.dominance = total > 0 ? maxW / total : 0;
    return sum;
  }

  /**
   * Compute the per-frame smart-camera orbital overlay.
   *
   * Called once per `update()`.  When active, it writes a desired
   * spherical offset (chase base + sinusoidal yaw/pitch/radius) to
   * `this._desiredSpherical`; `update()`'s auto-return spring pulls
   * the camera toward it.  When inactive, the desired spherical is
   * simply the chase base.
   *
   * @param {number} h – clamped delta time in seconds
   */
  _updateSmartCamera(h, now) {
    const cfg = SceneConfig.smartCamera;
    if (!cfg) return;

    // Decide whether the smart camera is allowed to influence the
    // desired spherical offset this frame.  Three reasons not to:
    // feature off, user dragging, or we're in the post-release cool-down.
    const inCooldown = this._smartResumeAt > 0 && now < this._smartResumeAt;
    const active = cfg.enabled && !this._userInteracting && !inCooldown;

    if (!active) {
      this._desiredSphericalActive = false;
      this._lastSmartPhaseUpdate = 0;
      return;
    }

    this._desiredSphericalActive = true;

    // Activity-driven multipliers.  More notes per second → faster
    // sweep + slightly bigger amplitude.  Hard cap at 2× so frantic
    // pieces don't induce motion sickness.  The multiplier is eased
    // with a long time-constant so density spikes don't jerk the
    // camera speed.
    const { total, dominantStaff, dominance } = this._smartActivityWeights();
    const rawActivityMul = Math.min(2.0, 1.0 + total * 0.05);
    const actEase = 1 - Math.exp(-h / 2.0);
    this._easedActivityMul += (rawActivityMul - this._easedActivityMul) * actEase;

    // Drive the smart-camera phase from wall-clock time rather than the
    // smoothed integration dt.  This makes the orbit independent of rAF
    // interval jitter and dt smoothing lag, so the camera glides rather
    // than pulsing when the frame cadence wobbles.
    if (this._lastSmartPhaseUpdate <= 0) this._lastSmartPhaseUpdate = now;
    const phaseDt = Math.min(Math.max((now - this._lastSmartPhaseUpdate) / 1000, 0), 0.1);
    this._lastSmartPhaseUpdate = now;
    this._smartPhase += phaseDt * (cfg.orbitSpeed ?? 0.15) * this._easedActivityMul;

    // Two superimposed sinusoids on yaw so the motion never traces
    // out an obvious back-and-forth period — the secondary harmonic
    // breaks the pattern enough that even a long passage stays
    // visually "fresh" without looking random.
    const yawCycle = Math.sin(this._smartPhase * 0.7);
    const yawSecondary = Math.sin(this._smartPhase * 1.3) * 0.3;
    let desiredYaw = (yawCycle + yawSecondary) * (cfg.orbitStrength ?? 0.25);

    // Pitch wobble is intentionally smaller (×0.3) — a strong pitch
    // sweep makes the floor whip past, which feels nauseous, while
    // yaw mostly translates "behind / in front of the staff".
    const pitchCycle = Math.sin(this._smartPhase * 0.5 + 1.2);
    let desiredPitch = pitchCycle * (cfg.orbitStrength ?? 0.25) * 0.3;

    // Zoom oscillation — slowly varies the camera radius so the
    // perceived distance to the score breathes a little.  Phase is
    // offset so it doesn't peak with yaw at the same instant.
    const zoomCycle = Math.sin(this._smartPhase * 0.4 + 2.7);
    const desiredRadiusFactor = 1.0 + zoomCycle * (cfg.zoomStrength ?? 0.10);

    // Staff-bias yaw — when one staff hogs the recent activity
    // (>55% of total weight), nudge the orbit yaw toward / away
    // from it depending on staff index.  Reduced amplitude so the
    // bias stacks with the sinusoid rather than overpowering it.
    if (dominance > 0.55) {
      const biasMag = (dominance - 0.55) * 2.5 * (cfg.orbitStrength ?? 0.25);
      const sign = (dominantStaff % 2 === 1) ? +1 : -1;
      desiredYaw += biasMag * sign * 0.5 * (cfg.biasStrength ?? 0.5);
    }

    // Critically-damped easing of the live offsets toward their
    // sinusoidal targets.  The 2.0 s time-constant keeps every
    // camera movement gradual.
    const ease = 1 - Math.exp(-h / 2.0);
    this._smartYaw += (desiredYaw - this._smartYaw) * ease;
    this._smartPitch += (desiredPitch - this._smartPitch) * ease;
    this._smartRadiusFactor += (desiredRadiusFactor - this._smartRadiusFactor) * ease;

    // Compute desired spherical offset from the chase base + smart deltas.
    const base = this._chase;
    const baseRadius = base.length();
    if (baseRadius < 1e-4) {
      this._desiredSphericalActive = false;
      return;
    }
    const baseYaw = Math.atan2(base.x, base.z);   // 0 = +Z, π/2 = +X
    const basePitch = Math.asin(Math.max(-1, Math.min(1, base.y / baseRadius)));

    const newYaw = baseYaw + this._smartYaw;
    const newPitch = Math.max(0.01, basePitch + this._smartPitch);
    const newRadius = baseRadius * this._smartRadiusFactor;

    const cosP = Math.cos(newPitch);
    const sinP = Math.sin(newPitch);
    const cosY = Math.cos(newYaw);
    const sinY = Math.sin(newYaw);

    this._desiredOffset.set(
      newRadius * cosP * sinY,
      newRadius * sinP,
      newRadius * cosP * cosY,
    );
    this._desiredSpherical.setFromVector3(this._desiredOffset);
  }

  /**
   * Immediately snap camera to target (no smoothing).
   *
   * The target lives on the floor at `(target.x, 0, contentCenterZ)`;
   * the camera is parked **above** and **slightly behind** that
   * point to give the user the canonical "music-on-a-table at an
   * angle" view.  The pitch (vertical angle of view) is read from
   * `SceneConfig.camera.pitchDegrees`; the chase-cam offset on X is
   * `-distance × chaseRatio` capped at 3 world units.
   */
  snapToTarget(target, lookAheadX = target.x) {
    this._target.set(
      target.x,
      0,
      this._contentCenterZ,
    );
    this._lookTarget.set(
      lookAheadX,
      0,
      this._contentCenterZ,
    );

    this._controls.target.set(this._lookTarget.x, this._lookTarget.y, this._lookTarget.z);

    // Reset the look-ahead spring so it doesn't lurch back to the previous
    // smoothed position on the next update().
    this._lookSpring.x = this._lookTarget.x;
    this._lookSpring.v = 0;
    this._lookSpringReady = true;

    // Smart camera: phase is rewound so the first few seconds after load
    // look the same regardless of when the user jumped to a new score.
    this._smartPhase = 0;
    this._smartYaw = 0;
    this._smartPitch = 0;
    this._smartRadiusFactor = 1.0;
    this._easedActivityMul = 1.0;
    this._staffActivity.clear();
    this._topDownEndAt = 0;

    // Recompute chase offset from current framing and place the camera
    // at target + chase.  `controls.update()` will sync its internal
    // spherical with that offset, which we then store as the current spherical.
    this._computeChase();
    this.camera.position.copy(this._controls.target).add(this._chase);
    this._stepControls();
    this._scratchOffset.copy(this.camera.position).sub(this._controls.target);
    this._currentSpherical.setFromVector3(this._scratchOffset);
  }
}
