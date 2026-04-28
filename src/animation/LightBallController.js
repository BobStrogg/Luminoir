import * as THREE from 'three';
import { SceneConfig } from '../rendering/SceneConfig.js';
import { Materials } from '../rendering/Materials.js';
import { OPTIMIZATIONS } from '../rendering/Optimizations.js';

/**
 * Animated light balls that bounce from note to note.
 * One ball per staff, splitting into sub-balls for chords and
 * merging back for single notes.
 */
export class LightBallController {
  /**
   * Parent `Object3D` for every ball mesh, pooled point light and
   * glow sprite this controller creates.  The renderer passes its
   * `contentRoot` here, not the bare `Scene` — contentRoot is rotated
   * -π/2 around X to tip the score from a vertical "wall" into a
   * horizontal "floor", and parenting the balls under that same
   * transform means a ball positioned at score-local
   * `(noteX, noteY, restZ)` ends up at the same world position as the
   * underlying notehead instance.  Bouncing on local Z (elevation)
   * naturally produces "ball jumping up off the page" once the floor
   * rotation kicks in, no per-ball transform code required.
   * @type {THREE.Object3D}
   */
  _scene;
  /**
   * Per-staff animation data.
   * @type {Map<number, { chordGroups: ChordGroup[], balls: LightBall[], color: object, lightIdx: number }>}
   */
  _staffData = new Map();

  /**
   * Pool of shared PointLights.  One light per entry, possibly shared
   * across multiple staves on many-staff scores.  Created once at
   * setEvents() time and never resized so the NUM_POINT_LIGHTS shader
   * constant stays stable and pipelines don't recompile mid-frame.
   * @type {THREE.PointLight[]}
   */
  _lightPool = [];

  /** Pre-allocated per-light accumulators reused every frame. */
  _poolAccum = [];

  _isPlaying = false;
  _currentTime = 0; // seconds

  /** Per-staff bookkeeping for pulse-on-hit effect. */
  _lastVisitedIdx = new Map();
  _hitTime = new Map();

  /**
   * Optional callback fired the first time the playhead arrives at a
   * new chord on a given staff during playback.  Used by the smart
   * camera (CameraController.recordBeatGroupHit) to track per-staff
   * note density without needing to inspect the timeline itself.
   *
   * Signature: `(staffNumber: number, chordSize: number) => void`.
   *
   * Why fire here instead of from the timeline?  The light-ball
   * update already detects "ball just landed on a new chord" via
   * the `_lastVisitedIdx` cache below — no extra scan needed.  And
   * it fires at the same tempo-scaled instant the user perceives
   * the hit, so the camera's activity multiplier rises and falls in
   * sync with what the user sees rather than ticking off a wall
   * clock.
   *
   * @type {((staff: number, chordSize: number) => void) | null}
   */
  onBeatGroupHit = null;

  /**
   * @param {THREE.Object3D} parent  Group/Scene the balls + lights are
   *   added to.  See class docstring for why the renderer passes
   *   `contentRoot` (the rotated score parent) and not the raw scene.
   */
  constructor(parent) {
    this._scene = parent;
  }

  /**
   * Set the note-event timeline (sorted by time ascending).
   * Each event: { time, x, y, id, staff }
   *
   * Events are grouped into ChordGroups per staff — simultaneous notes
   * on the same staff form a single group.  One LightBall is pre-allocated
   * for every note in the largest chord on each staff.
   */
  setEvents(events) {
    this._clearAll();
    this._lastVisitedIdx.clear();
    this._hitTime.clear();

    // Group events by staff
    /** @type {Map<number, Array>} */
    const byStaff = new Map();
    for (const e of events) {
      let arr = byStaff.get(e.staff);
      if (!arr) { arr = []; byStaff.set(e.staff, arr); }
      arr.push(e);
    }

    // Build the shared-staff-light pool up front.  When the number of
    // staves exceeds MAX_POINT_LIGHTS we assign multiple staves to each
    // pool entry, so the scene's total point-light count stays capped
    // regardless of score size.  This keeps the fragment-shader light
    // loop short on big scores like Sylvia Suite (27 staves → 8 lights).
    let poolSize = 0;
    if (OPTIMIZATIONS.SHARED_STAFF_LIGHTS) {
      const cap = OPTIMIZATIONS.MAX_POINT_LIGHTS > 0
        ? OPTIMIZATIONS.MAX_POINT_LIGHTS
        : byStaff.size;
      poolSize = Math.min(byStaff.size, cap);
      for (let i = 0; i < poolSize; i++) {
        const light = new THREE.PointLight(
          0xffffff,
          0, // off until `update()` places it and sets intensity
          SceneConfig.lightBall.lightDistance ?? 4,
          1.5, // decay
        );
        light.name = `pooledLight_${i}`;
        this._scene.add(light);
        this._lightPool.push(light);
      }
      this._poolAccum = new Array(poolSize);
      for (let i = 0; i < poolSize; i++) {
        this._poolAccum[i] = { x: 0, y: 0, z: 0, n: 0, pulse: 0 };
      }
    }

    let colorIdx = 0;
    let staffIdxForPool = 0;
    const staffCount = byStaff.size;
    for (const [staff, staffEvents] of byStaff) {
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
      }

      // Pre-compute stable note orderings between consecutive chord groups
      // so that balls track the nearest note rather than jumping by y-index.
      _buildMatchings(chordGroups);

      // Determine max chord size for this staff
      const maxSize = Math.max(1, ...chordGroups.map((g) => g.notes.length));

      // Create ball pool
      const color = SceneConfig.lightBall.colors[colorIdx % SceneConfig.lightBall.colors.length];
      const balls = [];
      for (let i = 0; i < maxSize; i++) {
        const ball = new LightBall(this._scene, color, `${staff}_${i}`);
        balls.push(ball);
        // Initially only the first chord's balls are visible
        ball.setVisible(false);
      }

      // Map this staff to one of the pooled shared lights.  Use
      // contiguous blocks (floor(idx * poolSize / staffCount)) rather
      // than round-robin so each pool light serves a vertically-
      // adjacent group of staves — the light can then stay close to
      // all of its assigned balls even when only a subset are active.
      const lightIdx = poolSize > 0
        ? Math.min(poolSize - 1, Math.floor(staffIdxForPool * poolSize / staffCount))
        : -1;
      staffIdxForPool++;

      // Position balls at first chord group
      if (chordGroups.length > 0) {
        const first = chordGroups[0];
        for (let i = 0; i < balls.length; i++) {
          if (i < first.notes.length) {
            balls[i].setPosition(first.notes[i].x, first.notes[i].y, SceneConfig.lightBall.restZ);
            balls[i].setVisible(true);
          }
        }
        // Seed the pooled light on the first chord's centroid so the
        // warm-up render has a non-zero light position (otherwise it
        // defaults to (0,0,0) which gets baked into the pipeline
        // upload with intensity 0).
        if (lightIdx >= 0 && first.notes.length > 0) {
          const c = _centerOf(first.notes);
          this._lightPool[lightIdx].position.set(c.x, c.y, SceneConfig.lightBall.restZ);
        }
      }

      this._staffData.set(staff, { chordGroups, balls, color, lightIdx });
      colorIdx++;
    }
  }

  play() {
    this._isPlaying = true;
  }

  pause() {
    this._isPlaying = false;
  }

  stop() {
    this._isPlaying = false;
    this._currentTime = 0;
    this._lastVisitedIdx.clear();
    this._hitTime.clear();
    // Return balls to their first chord-group positions
    for (const data of this._staffData.values()) {
      const { chordGroups, balls } = data;
      if (chordGroups.length > 0) {
        const first = chordGroups[0];
        for (let i = 0; i < balls.length; i++) {
          if (i < first.notes.length) {
            balls[i].setPosition(first.notes[i].x, first.notes[i].y, SceneConfig.lightBall.restZ);
            balls[i].setVisible(true);
            balls[i].setScale(1);
            balls[i].setIntensity(1);
          } else {
            balls[i].setVisible(false);
          }
        }
      }
    }
  }

  setTime(seconds) {
    this._currentTime = seconds;
  }

  /**
   * @param {number} dt – delta time in seconds
   * @param {THREE.Camera=} camera – optional; used to attenuate the
   *   per-ball glow sprite size with distance so close-up views don't
   *   get a screen-filling halo.  The glow effect itself is always
   *   enabled per ball regardless of the pooled PointLight assignment.
   */
  update(dt, camera = null) {
    if (!this._isPlaying) return;

    const bounceHeight = SceneConfig.lightBall.bounceHeight;
    const pulseDuration = SceneConfig.lightBall.pulseDuration;
    const pulseScale = SceneConfig.lightBall.pulseScale;

    // Scratch vector reused for camera-distance computations.
    const camPos = camera ? camera.position : null;

    // Reset pooled-light aggregators for this frame.
    const poolAccum = this._poolAccum;
    for (let i = 0; i < poolAccum.length; i++) {
      const a = poolAccum[i];
      a.x = 0; a.y = 0; a.z = 0; a.n = 0; a.pulse = 0;
    }

    for (const [staff, data] of this._staffData) {
      const { chordGroups, balls, lightIdx } = data;
      if (chordGroups.length === 0) continue;

      // Find the latest chord group whose start time is <= current time.
      let prevIdx = 0;
      for (let i = 0; i < chordGroups.length; i++) {
        if (chordGroups[i].time <= this._currentTime) prevIdx = i;
      }
      const nextIdx = Math.min(prevIdx + 1, chordGroups.length - 1);

      const prev = chordGroups[prevIdx];
      const next = chordGroups[nextIdx];

      // Detect a "note hit": ball has just arrived at a new chord.
      // Fire a pulse that decays over `pulseDuration`.
      const lastIdx = this._lastVisitedIdx.get(staff);
      if (lastIdx !== prevIdx) {
        this._lastVisitedIdx.set(staff, prevIdx);
        this._hitTime.set(staff, this._currentTime);
        // Notify subscribers (currently just the smart camera) once
        // playback has actually started.  Pre-play the
        // `_lastVisitedIdx` map fills in as the timeline initialises
        // and we'd otherwise fire spurious hits at score load.
        if (this._isPlaying && this.onBeatGroupHit && lastIdx !== undefined) {
          this.onBeatGroupHit(staff, prev.notes.length);
        }
      }
      const sinceHit = this._currentTime - (this._hitTime.get(staff) ?? -Infinity);
      const pulse = sinceHit < pulseDuration
        ? 1 + (pulseScale - 1) * Math.pow(1 - sinceHit / pulseDuration, 2)
        : 1;

      // Continuous time-based progress: `progress = (t - start) / span`.
      // The ball is always moving — what makes each note feel "landed" is the
      // pulse above, not a dwell.
      const span = next.time - prev.time;
      const t = span > 0
        ? Math.min(1, Math.max(0, (this._currentTime - prev.time) / span))
        : 1;

      // easeInOutQuad bounce easing.
      const s = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      // Parabolic bounce: peaks at t=0.5, touches down at t=0 and t=1.
      const bounceAmt = 4 * t * (1 - t);

      const prevCount = prev.notes.length;
      const nextCount = next.notes.length;
      const activeCount = Math.max(prevCount, nextCount);
      const toNext = prev.toNext; // pre-computed nearest-neighbour map

      for (let i = 0; i < balls.length; i++) {
        if (i >= activeCount) {
          balls[i].setVisible(false);
          continue;
        }

        // Source position: use this ball's note if it exists, otherwise
        // start from the centre of the previous chord (split effect).
        let srcX, srcY;
        if (i < prevCount) {
          srcX = prev.notes[i].x;
          srcY = prev.notes[i].y;
        } else {
          const c = _centerOf(prev.notes);
          srcX = c.x;
          srcY = c.y;
        }

        // Target position: use the matched note in the next group.
        // Falls back to the centre when merging.
        let dstX, dstY;
        const j = toNext ? toNext[i] : i;
        if (j != null && j < nextCount) {
          dstX = next.notes[j].x;
          dstY = next.notes[j].y;
        } else {
          const c = _centerOf(next.notes);
          dstX = c.x;
          dstY = c.y;
        }

        // Position interpolation with eased progress (smooth start/stop).
        const x = srcX + (dstX - srcX) * s;
        const yBase = srcY + (dstY - srcY) * s;
        const bounce = bounceAmt * bounceHeight;
        const y = yBase + bounce;
        const z = SceneConfig.lightBall.restZ + bounce * 0.3;

        // Split / merge scale shaping.
        let scaleFactor = 1.0;
        if (i >= prevCount) {
          scaleFactor = s;            // splitting off — grow in
        } else if (j == null || j >= nextCount) {
          scaleFactor = 1 - s;        // merging — shrink out
        }

        const visible = scaleFactor > 0.01;
        balls[i].setVisible(visible);
        if (visible) {
          balls[i].setPosition(x, y, z);
          balls[i].setScale(scaleFactor * pulse);
          balls[i].setIntensity((0.7 + bounceAmt * 0.6) * pulse);

          // Modulate the per-ball glow sprite so every staff has a
          // visible halo at any zoom.  With perspective attenuation
          // on, the sprite naturally shrinks 1/d with distance — to
          // keep its apparent screen size roughly constant we scale
          // the world-space size linearly with `d` (`mod = d × k`),
          // so the two factors cancel out.  The minimum clamp keeps
          // the halo from becoming sub-radius at very close zooms.
          //
          // Why this matters in practice: orchestral scores like
          // Sylvia Suite need the camera to back off to ≈30 world
          // units so all 27 staves fit in frame, and at that
          // distance the previous `sqrt(d/2)` formula produced
          // halos only ≈4 px across — small enough that the user
          // reads them as "missing" on most staves.  A linear scale
          // keeps the halo at a stable ≈14 px regardless of how
          // far the camera has pulled back, so every staff's ball
          // glows visibly even on the largest scores.
          //
          // Performance: glow sprites are screen-aligned quads
          // rendered with additive blending and a tiny 128² texture;
          // 30+ of them per frame is well under a millisecond on any
          // GPU we care about, so we don't need a hard cutoff to
          // skip them at extreme distances.  (The previous
          // `glowFarDistance = 80` cutoff was a hack to avoid
          // drawing sub-pixel sprites that didn't make a visible
          // difference, but it also clipped the glow on legitimate
          // wide-shot views and is no longer applied.)
          if (camPos) {
            const dx = camPos.x - x;
            const dy = camPos.y - y;
            const dz = camPos.z - z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            // `0.15` keeps the apparent screen size of the halo
            // roughly constant (≈10 px) across the full viewing-
            // distance range (Dream-style 2..12 close-up,
            // Sylvia-style 30 wide-shot).  The clamp at 0.25 keeps
            // a usable minimum at extreme close-ups so the halo
            // doesn't disappear entirely when the user mashes the
            // mouse-wheel zoom.  The opacity side of `glowMod`
            // (set in `_applyVisuals`) effectively dims the halo
            // at close-ups and ramps it to full strength at wide
            // shots, which combined with the texture's intrinsic
            // alpha (0.18 / 0.05) gives the user's preferred
            // "subtle close-up, visible on every Sylvia ball"
            // balance.
            const mod = Math.max(0.25, d * 0.15);
            balls[i].setGlowMod(mod);
          }

          // Contribute to the pooled light assigned to this staff.
          // Pool lights follow the centroid of every visible ball from
          // every staff they serve, which gives reasonable coverage
          // even when one light represents multiple staves.
          if (lightIdx >= 0) {
            const acc = poolAccum[lightIdx];
            acc.x += x;
            acc.y += y;
            acc.z += z;
            acc.n += 1;
            if (pulse > acc.pulse) acc.pulse = pulse;
          }
        }
      }
    }

    // Commit pooled-light positions & intensities for this frame.
    for (let i = 0; i < this._lightPool.length; i++) {
      const light = this._lightPool[i];
      const acc = poolAccum[i];
      if (acc.n > 0) {
        light.position.set(acc.x / acc.n, acc.y / acc.n, acc.z / acc.n);
        // Brighter when more balls contribute, capped so we don't wash
        // out the scene when many staves pile onto one pool entry.
        const brightness = Math.min(1.6, 0.8 + acc.n * 0.15) * (acc.pulse || 1);
        light.intensity = SceneConfig.lightBall.intensity * brightness;
      } else {
        light.intensity = 0;
      }
    }
  }

  _clearAll() {
    for (const data of this._staffData.values()) {
      for (const ball of data.balls) ball.dispose();
    }
    this._staffData.clear();
    for (const light of this._lightPool) {
      this._scene.remove(light);
      light.dispose?.();
    }
    this._lightPool.length = 0;
  }

  dispose() {
    this._clearAll();
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Average position of an array of { x, y } notes. */
function _centerOf(notes) {
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
function _buildMatchings(groups) {
  for (let g = 0; g < groups.length - 1; g++) {
    const cur = groups[g];
    const nxt = groups[g + 1];
    const maxN = Math.max(cur.notes.length, nxt.notes.length);

    // Build toNext: for each ball slot in cur, which slot in nxt?
    // Use null to mark "merge into group centre" (no specific target).
    const toNext = new Array(maxN);
    const taken = new Set();

    for (let i = 0; i < maxN; i++) {
      const src = i < cur.notes.length ? cur.notes[i] : _centerOf(cur.notes);
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

/* ------------------------------------------------------------------ */

/**
 * @typedef {{ time: number, notes: Array<{ x: number, y: number, id: string }> }} ChordGroup
 */

/**
 * A single light ball: sphere mesh + point light + glow sprite.
 */
class LightBall {
  position = new THREE.Vector3();
  _scale = 1;
  _intensity = 1;
  _glowMod = 1;

  constructor(scene, color, key) {
    this._scene = scene;
    this._color = color;

    const cfg = SceneConfig.lightBall;

    // Sphere mesh
    const geo = new THREE.SphereGeometry(cfg.radius, 16, 12);
    this._mesh = new THREE.Mesh(geo, Materials.lightBall(color));
    this._mesh.name = `lightBall_${key}`;
    scene.add(this._mesh);

    // Per-ball PointLight — skipped when `SHARED_STAFF_LIGHTS` is on
    // (the controller creates one shared light per staff instead).
    // Every point light adds a per-fragment loop iteration in the lit
    // material shader, so on a many-staff score the savings from
    // going from "one light per ball" to "one light per staff" are
    // substantial (Sylvia Suite: 39 lights → ~20).  Initial
    // intensity is zero so a newly-created hidden ball doesn't
    // flood the scene with stray lighting when this path is in use.
    if (!OPTIMIZATIONS.SHARED_STAFF_LIGHTS) {
      this._light = new THREE.PointLight(
        new THREE.Color(color.r, color.g, color.b),
        0,
        4, // distance
        1.5, // decay
      );
      scene.add(this._light);
    } else {
      this._light = null;
    }

    // Glow sprite
    this._glow = new THREE.Sprite(Materials.lightBallGlow(color));
    this._glow.scale.setScalar(cfg.radius * cfg.glowRadiusMultiplier * 2);
    scene.add(this._glow);
  }

  setPosition(x, y, z) {
    this.position.set(x, y, z);
    this._mesh.position.copy(this.position);
    if (this._light) this._light.position.copy(this.position);
    this._glow.position.copy(this.position);
  }

  setIntensity(factor) {
    this._intensity = factor;
    this._applyVisuals();
  }

  setScale(factor) {
    this._scale = factor;
    this._applyVisuals();
  }

  /**
   * Multiplier on the glow sprite's size & opacity applied after
   * scale/intensity.  Controller sets this from camera distance so
   * distant-view glows can fade out without touching the sphere mesh.
   */
  setGlowMod(mod) {
    this._glowMod = mod;
    // Very small mod = effectively off — skip the draw call entirely
    // so 30+ invisible sprites don't pay per-frame overhead on a big
    // wide shot where every glow is faded.
    const show = this._mesh.visible && mod > 0.02;
    this._glow.visible = show;
    if (show) this._applyVisuals();
  }

  setVisible(visible) {
    // Toggle the mesh and glow sprite, but *not* the point light's
    // `.visible` flag.
    //
    // Three.js's WebGPU pipeline cache key includes a hash of the
    // scene's light list — when a light toggles `visible`, the
    // `lightsNode` cache key changes, which invalidates every mesh's
    // render object *and forces a pipeline recompile*.  On a
    // moderately complex score that means a mid-playback stall every
    // time a chord grows and a new ball's light flips on, which the
    // user sees as the camera pausing right on each note landing.
    //
    // Instead we keep the light permanently in the scene graph and
    // drive its contribution via `intensity`: zero when "hidden",
    // the usual `_applyVisuals()`-derived value when "visible".  The
    // lightsNode hash stays stable, no pipelines recompile.
    this._mesh.visible = visible;
    // Glow sprite respects the camera-distance mod set by the
    // controller — don't re-enable it here if the mod has faded it
    // to zero.
    this._glow.visible = visible && this._glowMod > 0.02;
    if (visible) {
      this._applyVisuals();
    } else if (this._light) {
      this._light.intensity = 0;
    }
  }

  /** Combine scale and intensity into final visual state. */
  _applyVisuals() {
    const s = Math.max(0.001, this._scale);
    const f = this._intensity;
    const cfg = SceneConfig.lightBall;

    this._mesh.scale.setScalar(s);
    if (this._light) this._light.intensity = cfg.intensity * f * s;
    // Self-emissive on the ball sphere.  Halved again from
    // `0.35 + f * 0.2` to match the lower `lightBall.intensity`
    // and dimmer glow halo — the ball still reads as bright
    // because it's pure-white-on-cream, but it no longer dominates
    // the played notehead's HDR glow underneath it.
    this._mesh.material.emissiveIntensity = (0.175 + f * 0.1) * s;

    const baseGlow = cfg.radius * cfg.glowRadiusMultiplier * 2;
    const glowMod = this._glowMod ?? 1;
    this._glow.scale.setScalar(baseGlow * (0.8 + f * 0.4) * s * glowMod);
    // Fade the sprite alpha alongside the size so the edge of the
    // fade-out doesn't pop when the mesh's draw call flips off.
    this._glow.material.opacity = glowMod;
  }

  reset() {
    this.setPosition(0, 0, 0);
    this._scale = 1;
    this._intensity = 1;
    this._applyVisuals();
  }

  dispose() {
    this._scene.remove(this._mesh);
    if (this._light) this._scene.remove(this._light);
    this._scene.remove(this._glow);
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
    if (this._glow.material.map) this._glow.material.map.dispose();
    this._glow.material.dispose();
  }
}
