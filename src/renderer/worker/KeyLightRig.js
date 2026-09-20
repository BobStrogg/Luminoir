import * as THREE from 'three';
import { SceneConfig } from '../../rendering/SceneConfig.js';
import { shadowIntervalMs } from './qualityPolicy.js';

/** Keep the light → target offset constant so the incoming light
 *  direction (from the upper-left / front) never changes — what
 *  changes is only *where* on the world plane the shadow camera is
 *  centred.  Now that the score is laid flat as a floor (paper at
 *  world Y≈0), the light sits high overhead with a small horizontal
 *  bias so notation casts a visible cast-shadow toward the camera. */
const _KEY_LIGHT_OFFSET = new THREE.Vector3(-5, 12, 8);

/** Scratch vectors for `fitToScore`'s light-space projection — module
 *  scope so the load-time fit allocates nothing per call. */
const _corner = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

/** Delay (ms) between shadow re-renders.  At 0 pressure the static
 *  shadow coverage refreshes at no more than 30 Hz; full pressure
 *  stretches that interval to 150 ms, or roughly 7 Hz.
 *
 *  Why this is visually free: the key light is a **DirectionalLight**
 *  — translating it never moves the shadows themselves (the cast
 *  direction is constant); it only slides the orthographic frustum
 *  that decides which part of the world the map covers.  The frustum
 *  half-width is 20 wu while the playhead moves ≈ 0.3–1 wu/s, so even
 *  a 150 ms update lag leaves visible casters comfortably inside the
 *  covered region.  Unlike dimming lights, skipping 6144² shadow
 *  passes recovers *most* of the over-budget GPU time — this is the
 *  actuator that actually restores a consistent frame rate when the
 *  pressure system fires.
 *
 *  Constrained platforms (mobile / Tesla legacy WebGL) get a deeper
 *  800 ms floor: their shadow passes are disproportionately
 *  expensive, so sustained pressure trades coverage lag harder. */
const _SHADOW_RECENTER_DISTANCE = 2;
/** On constrained devices the dead zone is much wider.  Every exit
 *  costs one full shadow-map re-render stacked on top of an already-
 *  heavy native-DPR main pass — on iPhone that single frame is the
 *  "pause every few seconds" users report while the camera chases the
 *  playhead (~every 2-6 s at 2 wu).  8 wu is still well under the
 *  20 wu frustum half-width, so coverage keeps a ≥12 wu margin around
 *  the camera target. */
const _SHADOW_RECENTER_DISTANCE_CONSTRAINED = 8;
const _SHADOW_UPDATE_MIN_MS = 1000 / 30;
const _SHADOW_THROTTLE_MAX_DESKTOP_MS = 150;
const _SHADOW_THROTTLE_MAX_CONSTRAINED_MS = 800;

/**
 * The shadow-casting key directional light plus its texel-snapping /
 * dead-zone / pressure-throttle bookkeeping.
 */
export class KeyLightRig {
  /** Reference to the shadow-casting key directional light, set by
   *  `setupLighting()` and read by the render loop so it can slide the
   *  shadow frustum along with the scene camera. */
  _keyLight = null;

  /** World-space size of one shadow-map texel.  Set in
   *  `setupLighting()` from the orthographic frustum dimensions ÷ map
   *  resolution.  `update()` rounds the light's XY position to
   *  multiples of these values so the shadow texel grid stays
   *  pixel-aligned across frames. */
  _keyLightTexelSize = new THREE.Vector2(0.01, 0.01);

  /** Last texel-snapped X/Z position used to position the key light.
   *  The shadow camera recentres only after the view target leaves a
   *  2-world-unit dead zone around this point. */
  _lastKeyLightSnapped = { x: null, z: null };

  /** `performance.now()` of the last shadow-map re-render triggered by
   *  `update()`.  Used by the pressure-driven shadow throttle. */
  _lastShadowUpdateMs = 0;
  _shadowUpdates = 0;
  _shadowThrottled = 0;

  /** Max recenter interval (ms) under full pressure — deeper on
   *  constrained platforms where shadow passes cost the most. */
  _shadowThrottleMaxMs = _SHADOW_THROTTLE_MAX_DESKTOP_MS;

  /** Dead-zone radius (world units) before the shadow frustum slides.
   *  Set per-platform in `setupLighting()` — wider on constrained
   *  devices where each re-render is the dominant periodic hitch. */
  _recenterDistance = _SHADOW_RECENTER_DISTANCE;

  /** When true (constrained platforms), `fitToScore()` sizes the
   *  shadow frustum to cover the entire score once at load and
   *  `update()` never recenters — every caster is static, so the
   *  shadow map renders exactly once behind the loading overlay and
   *  never again during playback. */
  _frozen = false;

  get light() { return this._keyLight; }
  get texelSize() { return this._keyLightTexelSize; }
  get shadowUpdates() { return this._shadowUpdates; }
  get shadowThrottled() { return this._shadowThrottled; }
  get frozen() { return this._frozen; }
  get needsShadowUpdate() { return this._keyLight?.shadow?.needsUpdate; }

  /** Clear the snapped position + throttle timestamp so the next
   *  `update()` / shadow render starts fresh (scene rebuild, shadow
   *  quality change, shadow toggle). */
  resetSnap() {
    this._lastKeyLightSnapped.x = null;
    this._lastKeyLightSnapped.z = null;
    this._lastShadowUpdateMs = 0;
  }

  /** Zero the probe-visible counters (scene rebuild / dispose). */
  resetCounters() {
    this._lastShadowUpdateMs = 0;
    this._shadowUpdates = 0;
    this._shadowThrottled = 0;
  }

  setupLighting(scene, isMobile, renderer, isConstrained = false) {
    this._shadowThrottleMaxMs = isConstrained
      ? _SHADOW_THROTTLE_MAX_CONSTRAINED_MS
      : _SHADOW_THROTTLE_MAX_DESKTOP_MS;
    this._recenterDistance = isConstrained
      ? _SHADOW_RECENTER_DISTANCE_CONSTRAINED
      : _SHADOW_RECENTER_DISTANCE;
    this._frozen = isConstrained;
    // Bright neutral ambient so the white-ish paper reads as actually
    // lit-from-everywhere — the dark-theme value of 0.6 was tuned for
    // a near-black page and looked flat against the cream background.
    scene.add(new THREE.AmbientLight(0xf4f0e4, 1.2));
    const key = new THREE.DirectionalLight(0xfff0dd, 0.9);
    // The key light casts the shadow that grounds every piece of
    // notation onto the paper.  All quality knobs live in
    // `SceneConfig.shadow` — see the long comment there for the
    // full reasoning behind each value.  In short:
    //
    //   • `mapSize` and frustum extents together determine texel size
    //     and therefore how many texels a bar-line shadow covers
    //     (the limiting case for thin-feature stability).
    //   • `bias`/`normalBias` combat shadow acne on the thin extruded
    //     notation; both are kept smaller than `notationDepth = 0.003`
    //     so the offsets can't push comparison samples past thin
    //     casters.
    //   • `radius` controls PCF Soft kernel size; tuned so the
    //     penumbra is visible without washing out narrow shadows.
    //   • `update()` snaps the light's XY to a texel-grid
    //     boundary every frame so the shadow texel raster stays
    //     pixel-aligned across frames — without that, a high-res map
    //     still produces a "crawling" shadow edge as the camera pans.
    //
    // On mobile the shadow map is the dominant cost on each scheduled
    // notation depth pass, even with the 30 Hz refresh cap.
    // 6144² is ~38 M fragments per frame, which by itself blows past
    // an iPhone GPU's 16.67 ms budget once any other notation is in
    // view; clamp to 2048 (≈ 4 M fragments, 9× cheaper) so dense
    // passages of Jupiter etc. don't trigger iOS Safari's rAF clamp.
    const sCfg = SceneConfig.shadow;
    const mapSize = isMobile ? Math.min(sCfg.mapSize, 2048) : sCfg.mapSize;
    key.shadow.mapSize.width = mapSize;
    key.shadow.mapSize.height = mapSize;
    const shadowCam = key.shadow.camera;
    shadowCam.left = -sCfg.frustumHalfWidth;
    shadowCam.right = sCfg.frustumHalfWidth;
    shadowCam.top = sCfg.frustumHalfHeight;
    shadowCam.bottom = -sCfg.frustumHalfHeight;
    shadowCam.near = sCfg.near;
    shadowCam.far = sCfg.far;
    key.shadow.bias = sCfg.bias;
    key.shadow.normalBias = sCfg.normalBias;
    key.shadow.radius = sCfg.radius;
    // World-space size of one shadow-map texel along each axis.  Used
    // by `update()` to snap the light position to a texel
    // boundary; see the longer comment on that function for why.
    this._keyLightTexelSize.set(
      (shadowCam.right - shadowCam.left) / key.shadow.mapSize.width,
      (shadowCam.top - shadowCam.bottom) / key.shadow.mapSize.height,
    );
    // The `target` sub-object is where the directional light "looks
    // at" — the shadow camera's principal axis is
    // `normalize(light.position - light.target.position)`.  We add
    // `target` explicitly (Three.js only auto-adds it when the light
    // is first added to a scene via `scene.add(key)`) so we can safely
    // mutate `target.position` from the render loop.
    scene.add(key.target);
    this._keyLight = key;
    // Apply the master shadow toggle once the light exists.  This sets
    // `renderer.shadowMap.enabled` and `key.castShadow` consistently
    // and seeds the first shadow render if shadows are on.
    this.applyShadowEnabled(renderer);
    // Seed an initial pose so the first-frame render produces a valid
    // shadow map even before any camera updates have occurred.  Values
    // are overwritten every frame in `startRenderLoop()`.
    this.update(0, 0);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xc0d0ff, 0.3);
    fill.position.set(5, 3, -5); scene.add(fill);
    const rim = new THREE.DirectionalLight(0x8888aa, 0.15);
    rim.position.set(0, -3, 5); scene.add(rim);
  }

  /**
   * Fit the shadow frustum to the entire score and pin the light over
   * its centre — the constrained-platform path.  Every caster in the
   * scene (notation, paper, title) is static, so a single shadow render
   * at load replaces per-frame recentering entirely: zero shadow passes
   * during playback, which removes the dominant periodic GPU spike on
   * iPhone-class GPUs.  Called from `SceneHost.buildScene` while
   * `_compiling` still holds the loading overlay up.
   *
   * The bounds arrive in score-local coordinates; `contentRoot`'s
   * −π/2 X rotation maps local X → world X and local Y → world −Z.
   *
   * @param {{ contentMinX:number, contentMinY:number, totalWidth:number, totalHeight:number }} parsed
   */
  fitToScore(parsed) {
    const light = this._keyLight;
    if (!light || !parsed) return;
    const { contentMinX, contentMinY, totalWidth, totalHeight } = parsed;
    if (!Number.isFinite(totalWidth) || !Number.isFinite(totalHeight)) {
      // Malformed bounds — fall back to ordinary recentering rather
      // than leaving the default origin-centred frustum frozen.
      this._frozen = false;
      return;
    }

    const margin = 2;   // wu of slack beyond the outermost casters
    const minX = contentMinX - margin;
    const maxX = contentMinX + totalWidth + margin;
    const minZ = -(contentMinY + totalHeight) - margin;
    const maxZ = -contentMinY + margin;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    // Camera basis for a viewer at `eye` looking at the score centre —
    // mirrors what DirectionalLightShadow.updateMatrices computes.
    _eye.set(cx + _KEY_LIGHT_OFFSET.x, _KEY_LIGHT_OFFSET.y, cz + _KEY_LIGHT_OFFSET.z);
    _corner.set(cx, 0, cz);
    _zAxis.subVectors(_eye, _corner).normalize();      // toward the eye
    _xAxis.crossVectors(_UP, _zAxis).normalize();      // camera right
    _yAxis.crossVectors(_zAxis, _xAxis);               // camera up

    // Project the content box (y = 0…0.3 wu covers notation/title
    // elevation) into light space and take the tight ortho extents.
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    let dMin = Infinity, dMax = -Infinity;
    for (let i = 0; i < 8; i++) {
      _corner.set(
        i & 1 ? maxX : minX,
        i & 2 ? 0.3 : 0,
        i & 4 ? maxZ : minZ,
      ).sub(_eye);
      const u = _corner.dot(_xAxis);
      const v = _corner.dot(_yAxis);
      const d = -_corner.dot(_zAxis);   // distance along the view dir
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      if (d < dMin) dMin = d; if (d > dMax) dMax = d;
    }

    const shadowCam = light.shadow.camera;
    shadowCam.left = uMin - 1;
    shadowCam.right = uMax + 1;
    shadowCam.top = vMax + 1;
    shadowCam.bottom = vMin - 1;
    shadowCam.near = Math.max(0.1, dMin - 2);
    shadowCam.far = dMax + 2;
    shadowCam.updateProjectionMatrix();

    light.target.position.set(cx, 0, cz);
    light.position.copy(_eye);
    light.target.updateMatrixWorld();
    this._keyLightTexelSize.set(
      (shadowCam.right - shadowCam.left) / light.shadow.mapSize.width,
      (shadowCam.top - shadowCam.bottom) / light.shadow.mapSize.height,
    );
    light.shadow.autoUpdate = false;
    // The one and only shadow render — it happens during the precompile
    // warm-up, still behind the loading overlay.
    light.shadow.needsUpdate = true;
    this._lastShadowUpdateMs = 0;
  }

  /** Slide the key directional light and its target to the given world
   *  XZ position (Y = 0 since the paper plane sits there after the
   *  contentRoot rotation).  Called every frame from the render loop
   *  so the shadow camera's orthographic frustum always straddles what
   *  the scene camera is looking at, not just the neighbourhood of the
   *  world origin.
   *
   *  The XZ position is **snapped to texel-grid boundaries** before it
   *  reaches the light: at any non-trivial shadow-map resolution one
   *  texel is still worth a fraction of a world unit, so without
   *  snapping the light's XZ can land at any sub-texel offset, which
   *  means the same notation surface samples a slightly different
   *  texel-grid each frame and the shadow boundary "crawls" across
   *  thin features.  Rounding to a texel multiple stabilises the grid:
   *  a static line's shadow stays in the same texels frame after
   *  frame, even while the camera pans, and the shimmer disappears.
   *  The texel size used here is computed in `setupLighting` from the
   *  resolution and frustum dimensions in `SceneConfig.shadow`. */
  update(x, z, frameNow = performance.now(), pressure = 0) {
    if (!this._keyLight || !SceneConfig.shadow.enabled) return;

    // Disable automatic per-frame shadow re-render so we can drive it
    // manually.  This is set once on the first call; Three.js WebGPU's
    // ShadowNode.js respects `shadow.autoUpdate / shadow.needsUpdate`
    // the same way the classic WebGLShadowMap does (ShadowNode.js:771).
    if (this._keyLight.shadow.autoUpdate) {
      this._keyLight.shadow.autoUpdate = false;
      // Force the very first shadow render now (the light was just placed
      // at the initial position; without this the map stays empty until
      // the camera pans for the first time).
      this._keyLight.shadow.needsUpdate = true;
    }

    // Frozen (constrained): `fitToScore` covered the whole score at
    // load and every caster is static — the map never re-renders.
    if (this._frozen) return;

    const tx = this._keyLightTexelSize.x;
    const tz = this._keyLightTexelSize.y;
    const xs = Math.round(x / tx) * tx;
    const zs = Math.round(z / tz) * tz;

    // Keep the shadow projection completely static while the camera target
    // remains inside a small dead zone.  The orthographic shadow frustum is
    // 40×30 world units, so a 2-unit lag leaves ample coverage while turning
    // a 6144² re-render from a 30 Hz cost into an occasional recenter.
    // `_recenterDistance` is 8 wu on constrained platforms — every exit
    // is one full shadow pass, so they get a much wider zone.
    if (this._lastKeyLightSnapped.x !== null
        && Math.abs(x - this._lastKeyLightSnapped.x) < this._recenterDistance
        && Math.abs(z - this._lastKeyLightSnapped.z) < this._recenterDistance) return;
    if (xs === this._lastKeyLightSnapped.x && zs === this._lastKeyLightSnapped.z) return;

    // Pressure-driven shadow throttle: under sustained GPU pressure,
    // space shadow-map re-renders out in time instead of re-rendering on
    // every texel crossing.  See `_SHADOW_THROTTLE_MAX_MS` for why this
    // is invisible (directional light translation only slides the
    // coverage frustum, never the shadows themselves).  The position
    // intentionally stays *unsnapped-pending* — we return before writing
    // `_lastKeyLightSnapped`, so the next allowed frame picks the move up.
    const now = frameNow;
    const shadowInterval = shadowIntervalMs(
      pressure, _SHADOW_UPDATE_MIN_MS, this._shadowThrottleMaxMs);
    if (this._lastShadowUpdateMs > 0 && now - this._lastShadowUpdateMs < shadowInterval) {
      this._shadowThrottled++;
      return;
    }
    this._lastShadowUpdateMs = now;
    this._shadowUpdates++;

    this._lastKeyLightSnapped.x = xs;
    this._lastKeyLightSnapped.z = zs;

    this._keyLight.target.position.set(xs, 0, zs);
    this._keyLight.position.set(
      xs + _KEY_LIGHT_OFFSET.x,
      _KEY_LIGHT_OFFSET.y,
      zs + _KEY_LIGHT_OFFSET.z,
    );
    // `target` is a separate `Object3D`, not automatically re-matrixed
    // by the renderer; updating its world matrix here ensures the
    // shadow camera's `lookAt(target.matrixWorld.position)` sees the
    // freshly-set value on the same frame.
    this._keyLight.target.updateMatrixWorld();
    // Request a shadow map re-render for this frame now that the light
    // has moved to a new texel-grid position.
    this._keyLight.shadow.needsUpdate = true;
  }

  /** Apply the `SceneConfig.shadow.enabled` flag at runtime.  Called
   *  from `setupLighting` and `handleUpdateConfig` so toggling shadows
   *  off/on takes effect on the next frame (with a one-time material
   *  recompile cost). */
  applyShadowEnabled(renderer) {
    if (!renderer || !this._keyLight) return;
    const enabled = SceneConfig.shadow.enabled;
    renderer.shadowMap.enabled = enabled;
    this._keyLight.castShadow = enabled;
    this._keyLight.shadow.needsUpdate = false;
    if (enabled) {
      this._keyLight.shadow.needsUpdate = true;
      this.resetSnap();
    }
  }
}
