import * as THREE from 'three';
import { SceneConfig } from '../rendering/SceneConfig.js';

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
  _enabled = true;

  // Score-framing state, set via configureForScore().  Stored in
  // **world** coordinates: contentCenterZ is the world Z of the
  // staff-spread centre (negated score-local Y), `_contentDistance`
  // is the camera-to-target distance needed to fit the staff spread
  // vertically in the view at the current FOV.
  _contentCenterZ = 0;
  _contentDistance = null;

  // Critically-damped spring state for the X follow.  Using an explicit
  // 2nd-order system gives us continuous velocity AND acceleration, so
  // the camera never jerks even when the time-track has a velocity kink.
  _springX = 0;
  _springVelX = 0;
  _springReady = false;

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
   * The user-controlled "rest pose" — the camera-target offset we
   * apply smart camera deltas on top of.  Captured whenever smart
   * camera is NOT actively writing to camera.position (initial pose,
   * during user drag, while smart camera is off) so the next time it
   * resumes, the orbit centres on the user's preferred view rather
   * than snapping back to snapToTarget()'s default.
   * @type {{ x: number, y: number, z: number } | null}
   */
  _restOffset = null;
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
  /** Top-down dramatic-overhead state.  When `_topDownEndAt` is in
   *  the future, the smart-camera pitch is biased upward toward an
   *  overhead view that fades back out via a half-sine. */
  _topDownEndAt = 0;
  /** Smoothed activity multiplier — eased separately from the orbit
   *  offsets so that sudden note-density spikes don't jerk the phase
   *  speed (and therefore the camera speed) abruptly. */
  _easedActivityMul = 1.0;
  /** True while we want to rebuild `_restOffset` on the next frame —
   *  set after snapToTarget() so the new chase pose becomes the
   *  smart-camera baseline. */
  _restOffsetStale = true;

  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('three/examples/jsm/controls/OrbitControls.js').OrbitControls} controls
   */
  constructor(camera, controls) {
    this.camera = camera;
    this._controls = controls;
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
  }

  /**
   * Feed a sorted timeline so the camera can track *musical time*.
   * The timeline must already be sorted by time ascending.
   *
   * We build a piecewise-linear time→x curve using the actual note
   * positions so the camera sits exactly on each note.  Multiple staff
   * events at the same time (a chord) collapse into a single knot
   * whose X is the mean of all staves' note-X at that instant — this
   * gives a sensible central-X when treble and bass render at
   * slightly different horizontal positions.  The spring in `update()`
   * smooths the per-segment velocity changes into a visually
   * continuous motion.
   * @param {Array<{ time: number, x: number }>} timeline
   */
  setTimeTrack(timeline) {
    this._trackIdx = 0;
    if (!timeline || timeline.length === 0) {
      this._track = { times: new Float64Array(0), xs: new Float64Array(0) };
      return;
    }
    // Collapse notes sharing a time instant into a single knot at the
    // mean X.  Times are already monotonically non-decreasing so we
    // only have to look at the previous knot.
    const times = [];
    const xSums = [];
    const counts = [];
    let lastTime = NaN;
    for (const e of timeline) {
      if (e.time === lastTime) {
        xSums[xSums.length - 1] += e.x;
        counts[counts.length - 1] += 1;
      } else {
        times.push(e.time);
        xSums.push(e.x);
        counts.push(1);
        lastTime = e.time;
      }
    }
    const n = times.length;
    const ts = new Float64Array(n);
    const xs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ts[i] = times[i];
      xs[i] = xSums[i] / counts[i];
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
  xAtTime(time) {
    const { times, xs } = this._track;
    const n = times.length;
    if (n === 0) return null;
    if (time <= times[0]) return xs[0];
    if (time >= times[n - 1]) return xs[n - 1];
    // Monotonic cache so playback queries are O(1); walk backwards
    // only if the caller has rewound (stop + replay).
    let i = this._trackIdx;
    if (times[i] > time) i = 0;
    while (i + 1 < n && times[i + 1] <= time) i++;
    this._trackIdx = i;
    const t0 = times[i];
    const t1 = times[i + 1];
    const u = (time - t0) / (t1 - t0);
    return xs[i] + (xs[i + 1] - xs[i]) * u;
  }

  /**
   * Set the horizontal target the camera should follow.
   * Y is locked to the paper plane (0) and Z to the staff-spread
   * centre computed by `configureForScore`, so the orbit target
   * always sits *on the paper* under the active note — only X moves
   * with playback.
   * @param {THREE.Vector3} target  Only `.x` is used.
   */
  setTarget(target) {
    this._target.set(
      target.x,
      0,
      this._contentCenterZ,
    );
  }

  /**
   * Called every frame.
   * Smoothly translates the OrbitControls target toward the desired
   * follow-point, AND applies the same translation to the camera so
   * that the relative viewpoint (the user's rotate/zoom) is preserved.
   * @param {number} dt – delta time in seconds
   */
  update(dt) {
    if (!this._enabled || !this._controls) return;
    // Clamp crazy dt so a dropped frame can't kick the spring into a
    // multi-unit jump.
    const h = Math.min(Math.max(dt, 0.0001), 0.1);

    // Follow the time-derived target exactly — no look-ahead offset.
    // The look-ahead made sense when the camera averaged ball positions
    // (you wanted to peek at upcoming notes past the ball) but now
    // that the camera tracks *musical time* directly it just makes the
    // played note drift off the centre of the screen.
    const desiredX = this._target.x;
    const desiredY = this._target.y;
    const desiredZ = this._target.z;

    if (!this._springReady) {
      this._springX = desiredX;
      this._springVelX = 0;
      this._springReady = true;
    }

    // Critically-damped spring using the closed-form approximation
    // from Game Programming Gems 4 §1.10 (same algorithm as Unity's
    // SmoothDamp).  Unlike a naive Euler integration this is stable
    // for any dt and preserves position + velocity continuity even
    // when the browser drops a frame and hands us a spike in `dt`.
    // smoothTime ≈ the time it takes for ~63 % of the gap to close.
    //
    // 0.9 s gives the camera a deliberately stretchy "tow rope" feel
    // — when the music speeds up the camera doesn't snap forward,
    // it leans into the new tempo and gradually catches up; when the
    // music suddenly slows or stops, the camera coasts to a halt
    // instead of stopping abruptly.  Earlier values (0.25 s, 0.5 s)
    // produced perceptible kinks on every velocity change in the
    // piecewise-linear track and the camera felt twitchy on rapid
    // chord changes.  Going much past 1.0 s starts to feel like the
    // camera is dragging behind the music rather than tracking it,
    // since the steady-state lag at velocity v is v × smoothTime
    // (e.g. at 1 unit/s playback the camera trails by 0.9 units —
    // roughly one quarter-note's spacing).
    const smoothTime = 0.9;
    const omega = 2 / smoothTime;
    const xw = omega * h;
    const exp = 1 / (1 + xw + 0.48 * xw * xw + 0.235 * xw * xw * xw);
    const change = this._springX - desiredX;
    const temp = (this._springVelX + omega * change) * h;
    this._springVelX = (this._springVelX - omega * temp) * exp;
    const prevSpringX = this._springX;
    this._springX = desiredX + (change + temp) * exp;

    // Move both the orbit target and the camera by the same Δx so the
    // user's rotation/zoom around the target is preserved.  Doing this
    // by hand avoids two `Vector3.clone()` allocations per frame —
    // every avoided GC trigger is one fewer source of camera stutter.
    this._controls.target.set(this._springX, desiredY, desiredZ);
    this.camera.position.x += this._springX - prevSpringX;

    // Smart-camera orbital overlay — gentle yaw/pitch/zoom variation
    // applied ON TOP of the user's current orbit pose so the scene
    // doesn't feel static during long passages.  Mouse-drag still
    // wins (see `_userInteracting`); on release we wait
    // `resumeAfterUserMs` so the camera doesn't fight a moving hand.
    this._updateSmartCamera(h);
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
      // The user might have moved the camera away from where smart
      // camera left off — mark the rest pose stale so we re-anchor
      // off whatever they end up at.
      this._restOffsetStale = true;
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
      const delay = cfg ? (cfg.resumeAfterUserMs ?? 1500) : 1500;
      this._smartResumeAt = performance.now() + delay;
    }
  }

  /**
   * Read the current activity weights with on-the-fly exponential
   * decay so the live numbers stay accurate even when no hits have
   * fired in a while (otherwise the counter would only decay at
   * "next hit" time).
   *
   * @returns {{ weights: Map<number, number>, total: number, dominantStaff: number, dominance: number }}
   */
  _smartActivityWeights() {
    const cfg = SceneConfig.smartCamera;
    const decay = Math.max(0.001, cfg.activityDecaySeconds || 2);
    const now = performance.now() / 1000;
    const weights = new Map();
    let total = 0;
    let dominantStaff = -1;
    let maxW = 0;
    for (const [staff, st] of this._staffActivity) {
      const dtSec = Math.max(0, now - st.t);
      const w = st.value * Math.exp(-dtSec / decay);
      if (w > 0.0001) {
        weights.set(staff, w);
        total += w;
        if (w > maxW) { maxW = w; dominantStaff = staff; }
      }
    }
    const dominance = total > 0 ? maxW / total : 0;
    return { weights, total, dominantStaff, dominance };
  }

  /**
   * Compute and apply the per-frame smart-camera orbital overlay.
   *
   * Called once per `update()`.  Captures the user's "rest pose"
   * (camera position relative to the orbit target) whenever the
   * smart camera is NOT writing — so when it later resumes, the
   * sinusoidal yaw/pitch oscillates around wherever the user has
   * the camera, not around `snapToTarget`'s default.
   *
   * @param {number} h – clamped delta time in seconds
   */
  _updateSmartCamera(h) {
    const cfg = SceneConfig.smartCamera;
    if (!cfg) return;

    const tx = this._controls.target.x;
    const ty = this._controls.target.y;
    const tz = this._controls.target.z;

    // Decide whether smart camera will write to camera.position this
    // frame.  Three reasons not to: feature off, user dragging, or
    // we're in the post-release cool-down window.
    const now = performance.now();
    const inCooldown = this._smartResumeAt > 0 && now < this._smartResumeAt;
    const active = cfg.enabled && !this._userInteracting && !inCooldown;

    // Capture / refresh rest pose whenever smart camera is NOT
    // overriding camera.position.  This way, if the user drags to a
    // new angle, the smart camera resumes its orbit centred on
    // whatever they ended up at.
    if (!active) {
      this._restOffset = {
        x: this.camera.position.x - tx,
        y: this.camera.position.y - ty,
        z: this.camera.position.z - tz,
      };
      this._restOffsetStale = false;
      return;
    }

    if (this._restOffsetStale || !this._restOffset) {
      this._restOffset = {
        x: this.camera.position.x - tx,
        y: this.camera.position.y - ty,
        z: this.camera.position.z - tz,
      };
      this._restOffsetStale = false;
    }

    // Activity-driven multipliers.  More notes per second → faster
    // sweep + slightly bigger amplitude.  Hard cap at 2× so frantic
    // pieces don't induce motion sickness.  The multiplier is eased
    // with a long time-constant so density spikes don't jerk the
    // camera speed.
    const { total, dominantStaff, dominance } = this._smartActivityWeights();
    const rawActivityMul = Math.min(2.0, 1.0 + total * 0.05);
    const actEase = 1 - Math.exp(-h / 2.0);
    this._easedActivityMul += (rawActivityMul - this._easedActivityMul) * actEase;

    this._smartPhase += h * (cfg.orbitSpeed ?? 0.15) * this._easedActivityMul;

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
    // camera movement gradual — all automatic motion ramps in/out
    // slowly enough that the user never perceives a discrete step.
    const ease = 1 - Math.exp(-h / 2.0);
    this._smartYaw += (desiredYaw - this._smartYaw) * ease;
    this._smartPitch += (desiredPitch - this._smartPitch) * ease;
    this._smartRadiusFactor += (desiredRadiusFactor - this._smartRadiusFactor) * ease;

    // Convert the rest offset to spherical, apply our deltas, convert
    // back, and write the result to camera.position.  OrbitControls'
    // own update() (called from the worker each frame) just reads
    // this and recomputes its internal spherical state so user input
    // remains correct on the next interaction.
    const r = this._restOffset;
    const baseRadius = Math.hypot(r.x, r.y, r.z);
    if (baseRadius < 1e-4) return; // pathological — skip
    const baseYaw = Math.atan2(r.x, r.z);   // 0 = +Z, π/2 = +X
    const basePitch = Math.asin(Math.max(-1, Math.min(1, r.y / baseRadius)));

    const newYaw = baseYaw + this._smartYaw;
    // The smart camera's pitch deviation from the user's rest pose
    // is at most ±orbitStrength×0.3 ≈ ±0.045 rad — far too small
    // to flip the camera below the ground plane on its own.  Any
    // heavier clamping (the old hard-clamp at halfFov + 0.02, or
    // the soft-clamp that replaced it) forces the camera away from
    // the user's chosen angle when the smart orbit resumes, which
    // is the primary source of the "jump" the user reported.  We
    // only guard against the pathological case of going to or past
    // the ground plane (pitch ≤ 0).
    const newPitch = Math.max(0.01, basePitch + this._smartPitch);
    const newRadius = baseRadius * this._smartRadiusFactor;

    const cosP = Math.cos(newPitch);
    const sinP = Math.sin(newPitch);
    const cosY = Math.cos(newYaw);
    const sinY = Math.sin(newYaw);

    this.camera.position.set(
      tx + newRadius * cosP * sinY,
      ty + newRadius * sinP,
      tz + newRadius * cosP * cosY,
    );
  }

  /**
   * Immediately snap camera to target (no smoothing).
   *
   * The target lives on the floor at `(target.x, 0, contentCenterZ)`;
   * the camera is parked **above** and **slightly behind** that
   * point to give the user the canonical "music-on-a-table at an
   * angle" view.  The pitch (vertical angle of view) is read from
   * `SceneConfig.camera.pitchDegrees`; the chase-cam offset on X is
   * always `-distance × 0.25` capped at 1.5 world units.
   */
  snapToTarget(target) {
    this._target.set(
      target.x,
      0,
      this._contentCenterZ,
    );

    const cfg = SceneConfig.camera;
    const distance = this._contentDistance || cfg.defaultDistance;

    this._controls.target.set(this._target.x, this._target.y, this._target.z);

    // Reset the spring so it doesn't lurch back to the previous
    // smoothed position on the next update().
    this._springX = this._target.x;
    this._springVelX = 0;
    this._springReady = true;

    // Smart camera: snapping invalidates whatever rest pose the
    // overlay had been orbiting around, so flag it for recapture
    // on the next update().  Phase is also rewound so the first
    // few seconds after load look the same regardless of when the
    // user jumped to a new score.
    this._smartPhase = 0;
    this._smartYaw = 0;
    this._smartPitch = 0;
    this._smartRadiusFactor = 1.0;
    this._easedActivityMul = 1.0;
    this._staffActivity.clear();
    this._topDownEndAt = 0;
    this._restOffsetStale = true;

    // Camera position relative to the orbit target:
    //   • Along world X — a chase-cam offset that slides the camera
    //     to the LEFT of the playhead (negative X) so the playhead
    //     appears in the right portion of the screen and there's
    //     room ahead of it for upcoming notes.  The fraction of the
    //     auto-fit distance to chase by is configured via
    //     `cfg.chaseRatio` — 0.6 was an earlier reference where the
    //     chase offset rotated the music X-axis on screen so notes
    //     appear to flow in from the top-right; 0.25
    //     keeps music X nearly parallel to screen X.  See the
    //     `chaseRatio` notes in `SceneConfig.camera`.
    //
    //     Capped at ≈ 3.0 world units in absolute terms so wide
    //     orchestral scores like Sylvia Suite (auto-fit
    //     `_contentDistance` ≈ 28) don't end up with the camera 17
    //     units off-axis from the staff cluster — at the start of
    //     such a song there's no music to the left of the playhead,
    //     and a 17-unit chase would push the entire score into the
    //     right half of the screen with the left half showing
    //     empty void.  Medium and small scores (Perfect: ≈ 1.9,
    //     Twinkle: ≈ 1.1) stay below the cap so the chaseRatio
    //     setting still has its full intended effect there.
    //   • +distance × tan(pitchDegrees) along world Y — above the
    //     paper, giving a `pitchDegrees`-pitch-down view of the
    //     floor in the YZ plane.  Combined with the X chase, the
    //     actual 3D pitch (angle from horizontal to camera→target)
    //     ends up shallower than `pitchDegrees` alone.
    //   • +distance along world Z — toward the camera's "front" of
    //     the music (positive Z is in front of the staff cluster
    //     after the contentRoot rotation).
    // In portrait orientation (aspect < 1) the horizontal FOV is narrow,
    // so the diagonal "music flowing in from the top-right" view wastes
    // screen width.  Steeper pitch + smaller chase keeps more notes
    // visible in the tight horizontal span.  The blend factor ramps
    // linearly between landscape (aspect >= 1 → factor = 0) and tall
    // portrait (aspect ≈ 0.5 → factor ≈ 1), so intermediate sizes
    // transition smoothly.
    const aspect = this.camera.aspect ?? 1;
    const portraitFactor = Math.max(0, Math.min(1, (1 - aspect) * 2));
    const portraitPitch = 65;  // degrees — near-overhead in deep portrait
    const portraitChase = 0.25;
    const basePitchDeg = cfg.pitchDegrees ?? 30;
    const baseChase = cfg.chaseRatio ?? 0.25;
    const effectivePitch = basePitchDeg + (portraitPitch - basePitchDeg) * portraitFactor;
    const effectiveChase = baseChase + (portraitChase - baseChase) * portraitFactor;

    const pitchRad = (effectivePitch * Math.PI) / 180;
    const heightRatio = Math.tan(pitchRad);
    const chaseRatio = effectiveChase;
    const chaseX = -Math.min(distance * chaseRatio, 3.0);
    this.camera.position.set(
      this._target.x + chaseX,
      distance * heightRatio,
      this._target.z + distance,
    );
    this._controls.update();
  }
}
