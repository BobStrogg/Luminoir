/**
 * Render worker entry.
 *
 * Hosts the entire Three.js pipeline (renderer, scene, camera,
 * OrbitControls, 3D mesh builder) and both animation controllers
 * (camera + light balls).  The main thread keeps anything that
 * requires DOM / Web-Audio / Verovio access — it sends parsed score
 * data + playback-clock anchors across, and the worker derives its
 * own frame timing.
 *
 * Running rendering off-thread means main-thread garbage collection
 * or userland work can never drop a rendered frame.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SceneConfig } from '../rendering/SceneConfig.js';
import { SVG3DBuilder } from '../rendering/SVG3DBuilder.js';
import { setRendererKind } from '../rendering/Materials.js';
import { LightBallController } from '../animation/LightBallController.js';
import { CameraController } from '../animation/CameraController.js';
import { ElementProxy } from './ElementProxy.js';
import { OPTIMIZATIONS } from '../rendering/Optimizations.js';

/* ------------------------------------------------------------------ */
/*  Per-worker global state                                            */
/* ------------------------------------------------------------------ */

/** @type {THREE.WebGLRenderer | import('three/webgpu').WebGPURenderer | null} */
let renderer = null;
/** @type {THREE.Scene} */
const scene = new THREE.Scene();
/**
 * Parent group for every score-related object.  Rotated -π/2 around X
 * once, here, so the score builds in its natural SVG-flat coordinate
 * system (notation laid out on the local XY plane, extruding in +Z)
 * and ends up rendered as a horizontal "floor" in world space:
 *
 *   • Local X (music progression) → World X (unchanged)
 *   • Local Y (vertical staff spread, top→bottom on the page) → World -Z
 *     (negative Z extends "back" away from the camera, so a higher
 *     staff's notes sit at a more-negative world Z; lower staves at
 *     more-positive Z toward the viewer).
 *   • Local Z (notation elevation off the paper) → World +Y (up)
 *
 * After the rotation: the paper plane (built at local Z=-0.05) sits at
 * world Y≈-0.05; noteheads (built at local Z=0.010) hover at world
 * Y≈0.010; light balls (built at local restZ=0.05) bounce in world Y.
 *
 * Every downstream system that operates in **score-local** coordinates
 * (SVG3DBuilder output, LightBallController ball/light positions,
 * CameraController X-follow track) parents under this group, so its
 * authoring-time XY semantics are preserved while the visible result
 * is a flat-floor 3D layout.
 */
const contentRoot = new THREE.Group();
contentRoot.rotation.x = -Math.PI / 2;
/** @type {THREE.PerspectiveCamera} */
let camera = null;
/** @type {OrbitControls} */
let controls = null;
/** @type {ElementProxy} */
let elementProxy = null;
// Builder is constructed lazily during `handleInit` *after* we've
// detected which renderer is active and called `setRendererKind()`,
// so its internal `Materials.noteHead()` factory picks the right
// shader path on first use.  Leaving it as a module-level
// `new SVG3DBuilder()` initialiser would always bind the default
// WebGL path at load time and silently skip the WebGPU-only
// `emissiveNode` glow.
/** @type {SVG3DBuilder | null} */
let builder = null;
/** @type {LightBallController | null} */
let lightBalls = null;
/** @type {CameraController | null} */
let cameraCtrl = null;

let rafId = 0;
let lastFrameTime = 0;

// Playback clock anchor.  Main thread sends state changes; worker
// computes current music time locally from its own performance.now().
/** @type {{ state: 'stopped' | 'playing' | 'paused', musicAnchor: number, perfAnchor: number, tempoScale: number }} */
let clock = { state: 'stopped', musicAnchor: 0, perfAnchor: 0, tempoScale: 1 };

// Cached score-framing inputs.  Populated by `handleSetTimeline`,
// consumed by `handleUpdateConfig` when a camera-affecting setting
// changes — without this cache we'd have to ask the main thread to
// resend the whole note timeline just to re-snap the camera.
let _lastFraming = null;

/* ------------------------------------------------------------------ */
/*  Message plumbing                                                   */
/* ------------------------------------------------------------------ */

self.onmessage = async (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':         return await handleInit(msg);
    case 'resize':       return handleResize(msg);
    case 'pointer':      return handlePointer(msg);
    case 'buildScene':   return handleBuildScene(msg);
    case 'setTimeline':  return handleSetTimeline(msg);
    case 'snapCamera':   return handleSnapCamera(msg);
    case 'clock':        return handleClock(msg);
    case 'updateConfig': return handleUpdateConfig(msg);
    case 'dispose':      return handleDispose();
    case 'probe':        return handleProbe(msg);
    default:
      console.warn('[renderWorker] unknown message:', msg.type);
  }
};

function post(msg) { self.postMessage(msg); }

/* ------------------------------------------------------------------ */
/*  Init                                                                */
/* ------------------------------------------------------------------ */

async function handleInit({ canvas, width, height, devicePixelRatio, rect, forceWebGL }) {
  // Dual-renderer: try `WebGPURenderer` first (for Chrome/Edge on
  // secure contexts), fall back to the legacy `THREE.WebGLRenderer`
  // everywhere else.  We deliberately do *not* use `WebGPURenderer`'s
  // built-in WebGL2 fallback (`forceWebGL: true` → `WebGLBackend`)
  // because `InstanceNode` in that backend packs `instanceMatrix`
  // into a UBO capped at GL_MAX_UNIFORM_BLOCK_SIZE = 16384 bytes —
  // which is only 256 matrices.  Any InstancedMesh with more than
  // 256 instances (our staff-line and simple-stem buckets can
  // easily hit 400+ on Dream a Little Dream, 2000+ on Sylvia Suite)
  // fails its vertex shader link with
  //   "Size of uniform block NodeBuffer_N in VERTEX shader exceeds…"
  // and the affected meshes disappear from the render.  The legacy
  // `WebGLRenderer` always uses instanced vertex attributes for
  // matrices so it has no such cap.
  //
  // `?renderer=webgl` forces the legacy fallback even on a
  // WebGPU-capable origin, useful for reproducing WebGL-specific
  // bugs from the same machine.
  let usingWebGPU = false;
  if (!forceWebGL) {
    try {
      const { WebGPURenderer } = await import('three/webgpu');
      renderer = new WebGPURenderer({ canvas, antialias: true });
      await renderer.init();
      usingWebGPU = true;
    } catch (e) {
      renderer = null;
    }
  }
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  }
  // Tell the `Materials` module which GLSL-injection path to use —
  // must be called *before* the first `Materials.noteHead()` in the
  // builder constructor below.  The WebGL path uses the legacy
  // `onBeforeCompile` GLSL hook; the WebGPU path uses TSL
  // `emissiveNode` on a `MeshStandardNodeMaterial`.
  setRendererKind(usingWebGPU ? 'webgpu' : 'webgl');
  builder = new SVG3DBuilder();
  // Apply tone mapping + sRGB output on every renderer path.  The
  // played-note material pushes its emissive into HDR territory
  // (≈3+ before tone-mapping) so a recognisable shape remains under
  // a self-luminous glow rather than clipping to a flat white blob;
  // ACES Filmic compresses that range smoothly back into 0..1 for
  // the displayable framebuffer.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false); // false = don't set style; we're off-DOM
  renderer.setClearColor(SceneConfig.backgroundColor, 1);

  // Enable shadow rendering on whichever renderer we got.  The key
  // light below casts a soft shadow (PCF on WebGL, an equivalent
  // soft-edge filter on WebGPU); every mesh in the score has
  // `castShadow = true` and the paper backdrop has
  // `receiveShadow = true`, so the resulting shadow shows the
  // notation hovering subtly above the page rather than looking
  // pasted-on.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const cfg = SceneConfig.camera;
  camera = new THREE.PerspectiveCamera(cfg.fov, width / height, cfg.near, cfg.far);
  // Initial pose: above the floor (positive Y) and in front of the
  // music's near edge (positive Z), looking back at the world origin
  // — the score's left edge sits at world (0, 0, 0) before
  // `configureForScore` runs and re-centres the orbit target on the
  // staff cluster, so this gives a sensible above-and-behind preview
  // until the first score loads.  Y is derived from `defaultDistance
  // × tan(pitchDegrees)` so the pre-score pose matches the same
  // viewing pitch the chase camera will snap to once a score loads;
  // without this the camera appears to "jump" to a lower angle the
  // moment configureForScore runs.
  const initialPitchRad = ((cfg.pitchDegrees ?? 30) * Math.PI) / 180;
  const initialHeight = cfg.defaultDistance * Math.tan(initialPitchRad);
  camera.position.set(0, initialHeight, cfg.defaultDistance);
  camera.lookAt(0, 0, 0);

  // ElementProxy mocks the DOM element OrbitControls attaches to.
  elementProxy = new ElementProxy();
  elementProxy.setRect(rect);
  controls = new OrbitControls(camera, elementProxy);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enablePan = false;
  controls.minDistance = 0.3;
  controls.maxDistance = 100;
  controls.target.set(0, 0, 0);
  // Any user-driven motion or damping-settle frame fires `change`;
  // wire it to the idle-render gate so we re-submit the GPU pass
  // exactly when something visible has updated.
  controls.addEventListener('change', _markDirty);

  scene.background = new THREE.Color(SceneConfig.backgroundColor);
  scene.add(contentRoot);
  setupLighting(scene);

  cameraCtrl = new CameraController(camera, controls);

  // Smart camera coordination — the controller's auto-orbit needs
  // to know when the user is actively dragging (so it can yield)
  // and what staff just received a chord (so it can drive its
  // activity multiplier).  Both signals are wired here, in the
  // worker, because both originate worker-side: OrbitControls
  // events and the per-frame light-ball hit detector.
  controls.addEventListener('start', () => cameraCtrl?.setUserInteracting(true));
  controls.addEventListener('end', () => cameraCtrl?.setUserInteracting(false));

  post({ type: 'ready', renderer: usingWebGPU ? 'WebGPU' : 'WebGL' });

  startRenderLoop();
}

function setupLighting(scene) {
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
  //   • `_updateKeyLight` snaps the light's XY to a texel-grid
  //     boundary every frame so the shadow texel raster stays
  //     pixel-aligned across frames — without that, a high-res map
  //     still produces a "crawling" shadow edge as the camera pans.
  const sCfg = SceneConfig.shadow;
  key.castShadow = true;
  key.shadow.mapSize.width = sCfg.mapSize;
  key.shadow.mapSize.height = sCfg.mapSize;
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
  // by `_updateKeyLight` to snap the light position to a texel
  // boundary; see the longer comment on that function for why.
  _keyLightTexelSize.set(
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
  _keyLight = key;
  // Seed an initial pose so the first-frame render produces a valid
  // shadow map even before any camera updates have occurred.  Values
  // are overwritten every frame in `startRenderLoop()`.
  _updateKeyLight(0, 0);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc0d0ff, 0.3);
  fill.position.set(5, 3, -5); scene.add(fill);
  const rim = new THREE.DirectionalLight(0x8888aa, 0.15);
  rim.position.set(0, -3, 5); scene.add(rim);
}

/** Reference to the shadow-casting key directional light, set by
 *  `setupLighting()` and read by the render loop so it can slide the
 *  shadow frustum along with the scene camera. */
/** @type {THREE.DirectionalLight | null} */
let _keyLight = null;

/** World-space size of one shadow-map texel.  Set in
 *  `setupLighting()` from the orthographic frustum dimensions ÷ map
 *  resolution.  `_updateKeyLight` rounds the light's XY position to
 *  multiples of these values so the shadow texel grid stays
 *  pixel-aligned across frames. */
const _keyLightTexelSize = new THREE.Vector2(0.01, 0.01);

/** Keep the light → target offset constant so the incoming light
 *  direction (from the upper-left / front) never changes — what
 *  changes is only *where* on the world plane the shadow camera is
 *  centred.  Now that the score is laid flat as a floor (paper at
 *  world Y≈0), the light sits high overhead with a small horizontal
 *  bias so notation casts a visible cast-shadow toward the camera. */
const _KEY_LIGHT_OFFSET = new THREE.Vector3(-5, 12, 8);

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
function _updateKeyLight(x, z) {
  if (!_keyLight) return;
  const tx = _keyLightTexelSize.x;
  const tz = _keyLightTexelSize.y;
  const xs = Math.round(x / tx) * tx;
  const zs = Math.round(z / tz) * tz;
  _keyLight.target.position.set(xs, 0, zs);
  _keyLight.position.set(
    xs + _KEY_LIGHT_OFFSET.x,
    _KEY_LIGHT_OFFSET.y,
    zs + _KEY_LIGHT_OFFSET.z,
  );
  // `target` is a separate `Object3D`, not automatically re-matrixed
  // by the renderer; updating its world matrix here ensures the
  // shadow camera's `lookAt(target.matrixWorld.position)` sees the
  // freshly-set value on the same frame.
  _keyLight.target.updateMatrixWorld();
}

/* ------------------------------------------------------------------ */
/*  Resize / pointer                                                    */
/* ------------------------------------------------------------------ */

function handleResize({ width, height, devicePixelRatio, rect }) {
  if (!renderer || !camera) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  if (elementProxy) elementProxy.setRect(rect);
  _markDirty();
}

function handlePointer({ target, payload }) {
  if (!elementProxy) return;
  elementProxy.dispatchProxied(target, payload);
  // Pointer events that change camera state will fire `change` via
  // OrbitControls and mark the scene dirty automatically — but we
  // mark eagerly here too in case the event is e.g. a touch-end
  // that doesn't immediately move the camera but should still wake
  // the render loop so the next animation step lands on screen.
  _markDirty();
}

/* ------------------------------------------------------------------ */
/*  Scene build / timeline                                              */
/* ------------------------------------------------------------------ */

/** Scene-build payload held between handleBuildScene and the precompile
 *  call in handleSetTimeline.  We defer the precompile until the light
 *  balls have been added to the scene (during setTimeline), so that
 *  `compileAsync` walks a scene that already contains every object
 *  the main loop is ever going to render.  Without this deferral the
 *  light balls' pipelines get compiled inline on the first post-compile
 *  frame — a 100-200 ms stall visible as the first-note stutter.
 *  @type {{ root: any, parsed: any } | null} */
let _pendingPrecompile = null;

/** One-shot flag set when the scene rebuild + precompile finishes,
 *  cleared the very next time `renderer.render()` puts a frame on
 *  the canvas.  When it transitions from `true → false` we post a
 *  `sceneReady` message so the main thread can hide its loading
 *  spinner exactly when the new score becomes visible — not at the
 *  earlier moment when `setTimeline` returned (which leaves the
 *  spinner overlapping a still-empty canvas for ≈ 100-200 ms while
 *  precompile runs and the GPU uploads). */
let _postSceneReadyAfterRender = false;

/* ------------------------------------------------------------------ */
/*  Per-note playback colouring                                        */
/* ------------------------------------------------------------------ */

/** noteId → { mesh, index, material? } mapping built by SVG3DBuilder.
 *  Populated in handleBuildScene; used by the per-frame colouring
 *  loop below and reset to null on dispose / scene rebuild. */
/** @type {Map<string, { mesh: any, index: number, material?: any }> | null} */
let _noteMeshMap = null;

/** Timeline entries (sorted by time) with `{ time, id, staff, x, y }`.
 *  Used to advance the played-note cursor each frame. */
/** @type {Array<{ time: number, id: string, staff: number, x: number, y: number }> | null} */
let _playedTimeline = null;

/** How far through `_playedTimeline` we've already coloured.  On
 *  scrub-back we roll the cursor back and revert each entry. */
let _playedCursor = 0;

/** staff-number → THREE.Color for the note tint applied when a note
 *  from that staff plays.  Assigned in the same iteration order as
 *  `LightBallController.setEvents()` so the colours visually match
 *  each staff's light ball. */
/** @type {Map<number, THREE.Color>} */
const _staffColors = new Map();

/** THREE.Color shared across all un-coloured notes — allocated once
 *  per scene rebuild and mutated with the current `SceneConfig.noteColor`
 *  so a live theme change would propagate without re-alloc. */
let _defaultNoteColor = new THREE.Color(
  SceneConfig.noteColor.r, SceneConfig.noteColor.g, SceneConfig.noteColor.b,
);

/** Meshes whose `instanceColor` buffer was written this frame —
 *  we flag `needsUpdate = true` in one pass at the end of each
 *  cursor advance / rollback batch rather than per setColorAt call. */
const _dirtyInstanceMeshes = new Set();

/**
 * Apply (or revert to default) the per-note tint on the tracked
 * notehead mesh for `noteId`.
 *
 * For InstancedMesh-backed notes (`index >= 0`) we call
 * `setColorAt(index, color)` and defer the `needsUpdate` flag to
 * `_flushDirtyMeshes()` below.  For the count-1 plain-Mesh fallback
 * (`index === -1`) we update the cloned per-mesh material's
 * `.color` directly — no per-frame upload, it's applied on the
 * next render.
 *
 * @param {string} noteId
 * @param {THREE.Color} color
 */
function _applyNoteColor(noteId, color) {
  const entry = _noteMeshMap && _noteMeshMap.get(noteId);
  if (!entry) return;
  if (entry.index >= 0 && entry.mesh && entry.mesh.isInstancedMesh) {
    entry.mesh.setColorAt(entry.index, color);
    _dirtyInstanceMeshes.add(entry.mesh);
  } else if (entry.material && entry.material.color) {
    entry.material.color.copy(color);
  }
}

function _flushDirtyMeshes() {
  for (const mesh of _dirtyInstanceMeshes) {
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  _dirtyInstanceMeshes.clear();
}

/**
 * Walk `_playedTimeline` in whichever direction `musicTime` moved
 * since last frame, applying staff-colour tints to newly-crossed
 * entries and reverting tints on entries that are now in the future
 * (e.g. user scrubbed backward, or transport reset to the start).
 *
 * Cheaper than a full timeline scan per frame — we keep `_playedCursor`
 * as a fast-path pointer and only ever touch the delta from the
 * previous frame.
 */
function _syncNoteColors(musicTime) {
  if (!_playedTimeline || !_noteMeshMap || _playedTimeline.length === 0) return;
  const tl = _playedTimeline;
  // Forward: cursor points at the next *un-played* entry.  Advance
  // while that entry's time is at or before the current music time.
  while (_playedCursor < tl.length && tl[_playedCursor].time <= musicTime) {
    const evt = tl[_playedCursor];
    const col = _staffColors.get(evt.staff) || _defaultNoteColor;
    _applyNoteColor(evt.id, col);
    _playedCursor++;
  }
  // Backward: cursor has advanced past a point we're now to the left
  // of.  Revert each newly-future entry.  Typical case is transport
  // reset (`musicTime === 0`), which rolls every played note back to
  // the default colour in one frame.
  while (_playedCursor > 0 && tl[_playedCursor - 1].time > musicTime) {
    _playedCursor--;
    const evt = tl[_playedCursor];
    _applyNoteColor(evt.id, _defaultNoteColor);
  }
  _flushDirtyMeshes();
}

function handleBuildScene({ parsed }) {
  // Hold rendering for the entire build → setTimeline → precompile
  // sequence.  The main loop checks `_compiling` and skips
  // `renderer.render()` while it's true, so there's no risk of a
  // transient frame with half-built state or missing lights.
  _compiling = true;

  // Remove previous content.  We don't dispose the InstancedMesh
  // geometries / materials because they're cached inside the builder
  // and shared across score loads — disposing them here would leave
  // the cache pointing at zombie GPU buffers that the next
  // `builder.build()` would unwittingly re-use, producing the
  // characteristic "stray glyphs drawn in the wrong place" bug.
  // The only per-scene resource in the tree is the paper backdrop,
  // which we dispose by hand below.
  while (contentRoot.children.length) {
    const child = contentRoot.children[0];
    contentRoot.remove(child);
    disposePerSceneResources(child);
  }
  const { root, noteMeshMap } = builder.build(parsed);
  contentRoot.add(root);
  // Replace the per-scene note-mesh map.  Previous entries point at
  // meshes that just got removed from the scene, so they must not
  // leak into the next score's colour updates.
  _noteMeshMap = noteMeshMap;
  _playedTimeline = null;
  _playedCursor = 0;
  _staffColors.clear();
  _dirtyInstanceMeshes.clear();
  _defaultNoteColor.setRGB(
    SceneConfig.noteColor.r, SceneConfig.noteColor.g, SceneConfig.noteColor.b,
  );

  // Create / reset light balls for this score.  `setEvents()` below
  // (called from handleSetTimeline) actually populates the scene
  // with the individual ball meshes / lights / sprites.
  //
  // Parent under `contentRoot`, not `scene` — contentRoot's -π/2 X
  // rotation is what tips the score from "wall" to "floor", and we
  // want the balls/lights to inherit that same transform so a ball
  // positioned at score-local `(noteX, noteY, restZ)` ends up at the
  // same world position as its underlying notehead.  Parenting under
  // the scene directly would leave the balls hovering in the
  // pre-rotation XY plane while the notation sat on the floor — the
  // exact "balls hanging in space" bug we'd otherwise have to work
  // around with explicit per-ball coordinate transforms.
  if (lightBalls) lightBalls.dispose();
  lightBalls = new LightBallController(contentRoot);
  // Forward chord-arrival events to the smart camera so its
  // exponentially-decaying activity counter rises and falls in
  // sync with what the user actually hears.  Cheap (just a Map
  // mutation per chord) and only fires while playing — see the
  // guards in `LightBallController.update`.
  lightBalls.onBeatGroupHit = (staff, chordSize) => {
    if (cameraCtrl) cameraCtrl.recordBeatGroupHit(staff, chordSize);
  };

  // Precompile is deferred to handleSetTimeline — the scene isn't
  // in its final state yet (no light balls).
  _pendingPrecompile = { root, parsed };
}

/**
 * Force the renderer to compile every mesh's pipeline up-front,
 * regardless of whether it would be frustum-culled at the current
 * camera position.  Uses `renderer.compileAsync` when available
 * (WebGPU) or falls back to a synchronous `renderer.compile` on
 * WebGL.
 */
function precompilePipelines(root, parsed) {
  if (!renderer || !scene || !camera) return;
  /** @type {{ mesh: any, prev: boolean }[]} */
  const frustumToggled = [];
  root.traverse((n) => {
    if (n.isMesh && n.frustumCulled) {
      frustumToggled.push({ mesh: n, prev: n.frustumCulled });
      n.frustumCulled = false;
    }
  });
  // Also force every currently-hidden mesh/sprite in the *whole*
  // scene (not just `root`) to visible for the duration of the
  // compile.  `_projectObject` skips anything with `visible === false`,
  // so without this the hidden light-ball meshes + sprites don't get
  // their pipelines compiled during precompile — and then compile
  // inline the first time a chord transition shows them mid-playback,
  // which the user perceives as a 15-40 ms camera freeze per new
  // staff coming in.
  /** @type {{ obj: any, prev: boolean }[]} */
  const visibilityToggled = [];
  scene.traverse((n) => {
    if ((n.isMesh || n.isSprite) && n.visible === false) {
      visibilityToggled.push({ obj: n, prev: false });
      n.visible = true;
    }
  });
  scene.updateMatrixWorld(true);

  const restore = () => {
    for (const t of frustumToggled) t.mesh.frustumCulled = t.prev;
    for (const t of visibilityToggled) t.obj.visible = t.prev;
    _compiling = false;
    // Scene was just swapped underneath us — mark dirty so the
    // first post-compile frame actually renders the new score
    // (otherwise the idle-gate might skip if nothing else has
    // marked the scene dirty since the rebuild started).
    _markDirty();
    // Arm the sceneReady postMessage; the next successful render
    // (which will be the first frame of the new score) clears the
    // flag and notifies the main thread.
    _postSceneReadyAfterRender = true;
  };
  _compiling = true;
  try {
    // Two-phase warm-up using the *main* camera and the *canvas* render
    // target.  Three.js WebGPU keys its pipeline cache on
    // `(scene, camera, renderTarget, lightsNode)`, so warming with a
    // different camera or a different render target wouldn't save the
    // main render loop any inline-compile work (we learnt this the
    // slow way — first-playback stutter was every chunk compiling its
    // main-camera pipelines on their first visible frame).
    //
    //   1. `compileAsync(scene, camera)` creates every pipeline object
    //      for the renderContext the main loop will actually use.
    //   2. A single throw-away `render(scene, camera)` to the canvas
    //      triggers the lazy GPU-side buffer uploads (instance matrices,
    //      vertex arrays) that Three.js defers until first-draw.
    //
    // `frustumCulled = false` (plus the temporary `visible = true` set
    // above) ensures every mesh/sprite in the entire scene — including
    // chunks that aren't in the main camera's frustum right now and
    // hidden light balls that will be revealed on later chords — is
    // in the render list, so all pipelines compile and all instance
    // buffers upload up front.
    //
    // The warm-up render goes directly to the canvas because
    // there's no visible flash anymore: by the time this runs,
    // `handleSetTimeline` has already fired and the camera is snapped
    // to the first note.
    const afterCompile = () => {
      try {
        renderer.render(scene, camera);
      } catch { /* swallow */ }
      restore();
    };
    if (typeof renderer.compileAsync === 'function') {
      renderer.compileAsync(scene, camera).then(afterCompile, afterCompile);
    } else if (typeof renderer.compile === 'function') {
      renderer.compile(scene, camera);
      afterCompile();
    } else {
      restore();
    }
  } catch {
    restore();
  }
}

function handleSetTimeline({ timeline, contentMinY, contentMaxY, firstNote }) {
  if (lightBalls) lightBalls.setEvents(timeline);
  if (cameraCtrl) {
    cameraCtrl.configureForScore(contentMinY, contentMaxY);
    cameraCtrl.setTimeTrack(timeline);
  }
  if (firstNote && cameraCtrl) {
    cameraCtrl.snapToTarget(new THREE.Vector3(firstNote.x, firstNote.y, 0));
  }
  // Cache the framing inputs so a settings-panel-driven config change
  // (e.g. `camera.pitchDegrees`) can re-call `configureForScore` +
  // `snapToTarget` without requiring the main thread to resend the
  // whole timeline.  Cleared on dispose alongside the camera & light
  // controllers in `handleDispose`.
  _lastFraming = { contentMinY, contentMaxY, firstNote };
  _markDirty();

  // Build the staff → colour map that the per-frame colouring loop
  // uses.  Matching the exact assignment order of
  // `LightBallController.setEvents()` — insertion order of the
  // `byStaff` map, cycling through `SceneConfig.lightBall.colors` —
  // guarantees a played note's colour matches its light ball.
  //
  // The palette colours are the *bright* hues used by the hovering
  // light ball; on a played notehead we want a darker, muted
  // version so the note stands out from unplayed notes without
  // competing with the moving light ball above it.  `playedNote.
  // darkness` in `SceneConfig` scales each channel down; the
  // `Materials.noteHead` fragment shader adds a per-instance
  // emissive contribution in the same hue so the darker colour
  // reads as a soft inner glow rather than a matte fill.
  _staffColors.clear();
  const seenStaves = new Set();
  const palette = SceneConfig.lightBall.colors;
  const darkness = SceneConfig.playedNote.darkness;
  let colorIdx = 0;
  for (const e of timeline) {
    if (seenStaves.has(e.staff)) continue;
    seenStaves.add(e.staff);
    const c = palette[colorIdx % palette.length];
    _staffColors.set(e.staff, new THREE.Color(c.r * darkness, c.g * darkness, c.b * darkness));
    colorIdx++;
  }
  // Store timeline + reset the played cursor so a new score starts
  // fresh.  We don't pre-apply default colours here because every
  // notehead mesh was built with `instanceColor = noteColor` already
  // by SVG3DBuilder.  The render loop will set colours on the fly
  // as the transport advances past each entry.
  _playedTimeline = timeline;
  _playedCursor = 0;

  // Scene is now final (content + light balls + camera position).
  // Run the precompile here, not in handleBuildScene, so that
  // `compileAsync` sees the complete lights/meshes list and no
  // inline pipeline compilation happens on the first rendered frame.
  if (_pendingPrecompile) {
    const { root, parsed } = _pendingPrecompile;
    _pendingPrecompile = null;
    if (OPTIMIZATIONS.PRECOMPILE_PIPELINES) {
      precompilePipelines(root, parsed);
    } else {
      // Precompile disabled — release the render gate set in
      // handleBuildScene so the main loop can draw the new scene.
      _compiling = false;
      _markDirty();
      // Arm sceneReady so the next render notifies the main thread,
      // matching the behaviour of the precompile path.
      _postSceneReadyAfterRender = true;
    }
  }
}

function handleSnapCamera({ x, y }) {
  if (cameraCtrl) cameraCtrl.snapToTarget(new THREE.Vector3(x, y, 0));
  _markDirty();
}

function disposePerSceneResources(obj) {
  // Only dispose things that were created *for this scene* and aren't
  // in the builder's shared cache.
  //
  //   - In the bucketing build path (`BUCKET_INSTANCES: true`) every
  //     extruded glyph `BufferGeometry` lives in the builder's
  //     `_geometryCache` and the box-line geometry is the shared
  //     `_unitBox`.  The paper backdrop is the only per-scene
  //     object — disposing any of the shared geometries here would
  //     leave the cache pointing at zombie GPU buffers that the next
  //     `builder.build()` would re-use, producing the characteristic
  //     "stray glyphs drawn in the wrong place" bug.
  //
  //   - In the one-mesh-per-element fallback
  //     (`BUCKET_INSTANCES: false`) each line creates its own
  //     `BoxGeometry`, so we dispose those here.  Extruded glyph
  //     geometries are still cached, so we skip those.
  obj.traverse((node) => {
    if (node.name === 'paper') {
      if (node.geometry) node.geometry.dispose();
      if (node.material) node.material.dispose();
      return;
    }
    if (!OPTIMIZATIONS.BUCKET_INSTANCES) {
      if (node.isMesh && node.geometry && node.geometry.type === 'BoxGeometry') {
        node.geometry.dispose();
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Playback clock                                                      */
/* ------------------------------------------------------------------ */

/**
 * Main thread calls this on every state change (play / pause / stop /
 * setTempo).  We record the music time at this instant and our own
 * perf-clock reference so later frames can compute the current music
 * time locally without any main-thread round-trip.
 */
function handleClock({ state, musicTime, tempoScale }) {
  clock = {
    state,
    musicAnchor: musicTime,
    perfAnchor: performance.now(),
    tempoScale: tempoScale ?? 1,
  };
  if (state === 'playing') {
    if (lightBalls) lightBalls.play();
  } else if (state === 'paused') {
    if (lightBalls) lightBalls.pause();
  } else if (state === 'stopped') {
    if (lightBalls) lightBalls.stop();
  }
  // State transition / scrub — mark dirty so the *next* frame
  // renders the updated cursor / colour state.  When `state` is
  // `playing` the loop forces `_dirty` true every frame anyway, so
  // this only matters for play→stop, play→pause, and seek-while-
  // paused, but it's cheap to do unconditionally.
  _markDirty();
}

function currentMusicTime() {
  // `audioVisualOffsetMs` is added unconditionally to the music time
  // the visual side reads each frame.  Anchored on `SceneConfig` so a
  // settings-panel slider can move it live; the rAF loop calls into
  // here every frame, so a new value lights up on the very next
  // tick.  See the property's JSDoc in `SceneConfig.js` for sign
  // convention (+N = visuals lead audio by N ms).
  const offsetSec = (SceneConfig.audioVisualOffsetMs || 0) / 1000;
  if (clock.state === 'playing') {
    const elapsed = (performance.now() - clock.perfAnchor) / 1000;
    return clock.musicAnchor + elapsed * clock.tempoScale + offsetSec;
  }
  return clock.musicAnchor + offsetSec;
}

/* ------------------------------------------------------------------ */
/*  Render loop                                                         */
/* ------------------------------------------------------------------ */

/**
 * Frame-budget rendering.
 *
 * Every rAF tick we *always* advance the animation (camera + light
 * balls) so the user-visible motion never stutters — even on scores
 * that push the GPU beyond its per-frame budget.  Rendering itself,
 * however, can skip frames when the previous `renderer.render()` call
 * took longer than the target budget; on the next tick we render
 * again.  The effect is: motion remains smooth, the visible image
 * simply updates at a lower rate on overloaded scenes.
 *
 * We measure submission wall time only — WebGPU/WebGL don't block
 * until a fence, so this under-counts GPU time on some drivers, but
 * it's enough to detect catastrophic rendering slowdowns (e.g.
 * `renderer.render()` taking > 12 ms is a clear signal to throttle).
 */
const RENDER_BUDGET_MS = 12;
let _lastRenderMs = 0;
let _framesSinceRender = 0;
/** Rolling buffer of recent per-frame render-submit timings (ms) so
 *  `probe` can report histograms without us keeping stats forever. */
const _renderMsRing = new Float64Array(120);
let _renderMsIdx = 0;
let _renderMsFilled = 0;
let _rendersSkipped = 0;
/** Wall-clock rAF-to-rAF interval in ms — this is the true "how long
 *  is a frame actually taking" metric, including GPU execution time
 *  that `renderer.render()`'s submit-time doesn't capture.  A 2 fps
 *  user experience shows up here as ~500 ms intervals even though
 *  submit time is <5 ms. */
const _frameMsRing = new Float64Array(120);
let _frameMsIdx = 0;
let _frameMsFilled = 0;
/** Set to `true` while we're pre-compiling pipelines for a freshly-
 *  built scene.  We pause normal rendering during that window so a
 *  mid-compile `renderer.render()` doesn't trigger slow inline
 *  pipeline creation. */
let _compiling = false;

/** Idle-render gate.  When the user isn't interacting and the music
 *  isn't playing, every frame's image is identical to the previous
 *  one — submitting `renderer.render()` to the GPU 60 times a second
 *  for the same pixels is pure waste, especially with the 6144²
 *  shadow map (≈ 38 M depth-buffer texels redrawn every frame).
 *
 *  We start the flag at `true` so the first frame after init lands a
 *  rendered image on screen, then set it back to `false` after each
 *  successful `renderer.render()`.  Anything that could change the
 *  picture flips it back to `true`:
 *
 *    • OrbitControls's `change` event (user drag, scroll-zoom, or
 *      damping settle frame).
 *    • Pointer events (in case the user does something the controls
 *      don't fire `change` for, e.g. touch-end).
 *    • Resize.
 *    • Scene rebuild / timeline load / camera snap.
 *    • Clock state transitions (play / pause / stop / scrub).
 *    • While the music clock is `playing`, the loop forces it `true`
 *      every frame because notation colours, light-ball positions,
 *      and the camera spring are all advancing.
 *
 *  When idle, the rAF loop still runs (the animation-phase work below
 *  is sub-millisecond when there's nothing animating), but
 *  `renderer.render()` is skipped — GPU drops to ~0 % utilisation
 *  until the user interacts again. */
let _dirty = true;

function _markDirty() { _dirty = true; }

function startRenderLoop() {
  lastFrameTime = performance.now();
  const loop = () => {
    rafId = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(Math.max((now - lastFrameTime) / 1000, 0), 0.1);
    const frameMs = now - lastFrameTime;
    lastFrameTime = now;

    // Record actual rAF interval so `probe()` can distinguish
    // submit-time from real GPU-bound frame time.
    if (frameMs > 0 && frameMs < 2000) {
      _frameMsRing[_frameMsIdx] = frameMs;
      _frameMsIdx = (_frameMsIdx + 1) % _frameMsRing.length;
      if (_frameMsFilled < _frameMsRing.length) _frameMsFilled++;
    }

    // --- Animation phase (always runs) -------------------------------
    const musicTime = currentMusicTime();
    if (lightBalls) {
      lightBalls.setTime(musicTime);
      lightBalls.update(dt, camera);
    }
    if (cameraCtrl) {
      const xTime = cameraCtrl.xAtTime(musicTime);
      if (xTime != null) {
        _camTarget.set(xTime, 0, 0);
        cameraCtrl.setTarget(_camTarget);
      }
      cameraCtrl.update(dt);
    }
    controls.update();
    // Slide the key light's shadow camera to straddle whatever the
    // scene camera is currently looking at.  The orbit controls'
    // target tracks the music during playback and the user's pan
    // gestures when paused — using it here means the shadow frustum
    // is automatically "focused" wherever the user's attention is,
    // so notation anywhere in the view always casts a visible
    // shadow rather than only the chunk near the world origin.
    _updateKeyLight(controls.target.x, controls.target.z);
    // Advance / rewind the played-note cursor and apply per-staff
    // instanceColor updates.  Runs every frame so playback keeps the
    // coloured-note state exactly in sync with the current music
    // time — a scrub-back to 0 automatically reverts every played
    // note to the default dark colour in a single frame.
    _syncNoteColors(musicTime);

    // --- Render phase (can be skipped when idle or under pressure) ----
    // Two reasons to skip a frame:
    //   • `_compiling` — a pipeline-precompile pass is in flight; a
    //     mid-compile `renderer.render()` would trigger slow inline
    //     pipeline creation that's exactly what we're warming up to
    //     avoid.
    //   • `!_dirty` — nothing visible changed since last render
    //     (idle scene, paused music, settled camera).  The GPU pass
    //     would just blit the same pixels again.
    //
    // Music currently playing forces `_dirty = true` every frame
    // because notation colours, light-ball positions and camera-X
    // are all advancing on the music clock.
    //
    // The render-budget gate is layered on top — when a previous
    // submit blew past the budget we skip *one* frame to give the
    // GPU time to drain, but only one in a row, so the picture
    // doesn't go stale on a sustained slowdown.
    if (clock.state === 'playing') _dirty = true;
    const budgetGate = !OPTIMIZATIONS.RENDER_BUDGET_SKIP
      || _lastRenderMs <= RENDER_BUDGET_MS
      || _framesSinceRender >= 1;
    const shouldRender = !_compiling && _dirty && budgetGate;
    if (shouldRender) {
      const t0 = performance.now();
      renderer.render(scene, camera);
      _lastRenderMs = performance.now() - t0;
      _framesSinceRender = 0;
      _renderMsRing[_renderMsIdx] = _lastRenderMs;
      _renderMsIdx = (_renderMsIdx + 1) % _renderMsRing.length;
      if (_renderMsFilled < _renderMsRing.length) _renderMsFilled++;
      _dirty = false;

      // Tell the main thread the new score is now on screen so it
      // can hide the loading spinner.  Post exactly once per build,
      // after the very first successful render that follows
      // precompile completion.  Doing it from inside `restore()`
      // (synchronously after `_compiling = false`) would fire the
      // message before any frame has actually reached the canvas
      // and give the user a brief flash of empty paper.
      if (_postSceneReadyAfterRender) {
        _postSceneReadyAfterRender = false;
        self.postMessage({ type: 'sceneReady' });
      }
    } else {
      _framesSinceRender++;
      _rendersSkipped++;
    }

    // --- Stats heartbeat ---------------------------------------------
    // Post a small stats summary every ~0.5 s so the main-thread FPS
    // badge has fresh numbers without flooding postMessage every
    // frame.  Numbers are derived from the same ring buffers
    // `handleProbe` reads, so the badge agrees with what `probe()`
    // would report on demand.
    if (now - _lastStatsPostMs >= STATS_POST_INTERVAL_MS) {
      _postStats();
      _lastStatsPostMs = now;
    }
  };
  loop();
}

/** Wall-clock millisecond between consecutive `stats` messages.  500 ms
 *  is fast enough that a sudden slowdown is visible within a beat or
 *  two but slow enough that postMessage cost itself is negligible
 *  (≈ 2 messages/sec). */
const STATS_POST_INTERVAL_MS = 500;
let _lastStatsPostMs = 0;

/** Compute and post a fresh `stats` snapshot to the main thread.
 *  Reads only the cheap recent-window samples (last second of frame
 *  intervals) so we don't have to touch the ring buffers' tail. */
function _postStats() {
  // Recent-window samples: the last min(samples, ~60 frames worth)
  // give the freshest readout.  Walk the ring backwards from
  // _frameMsIdx until we've collected up to 60 entries or used the
  // whole filled portion.
  const fLen = _frameMsFilled;
  if (fLen === 0) return;
  const want = Math.min(fLen, 60);
  let fSum = 0;
  let fMax = 0;
  for (let i = 0; i < want; i++) {
    const idx = (_frameMsIdx - 1 - i + _frameMsRing.length) % _frameMsRing.length;
    const v = _frameMsRing[idx];
    fSum += v;
    if (v > fMax) fMax = v;
  }
  const fMean = fSum / want;
  const fps = fMean > 0 ? (1000 / fMean) : 0;

  // Render-submit window (only render frames count; idle frames
  // skip the renderer call so we don't want to dilute the average
  // with zeros).
  const rLen = _renderMsFilled;
  let rSum = 0, rMax = 0, rP95 = 0;
  if (rLen > 0) {
    const rWant = Math.min(rLen, 60);
    const rSamples = [];
    for (let i = 0; i < rWant; i++) {
      const idx = (_renderMsIdx - 1 - i + _renderMsRing.length) % _renderMsRing.length;
      const v = _renderMsRing[idx];
      rSamples.push(v);
      rSum += v;
      if (v > rMax) rMax = v;
    }
    rSamples.sort((a, b) => a - b);
    rP95 = rSamples[Math.min(rSamples.length - 1, Math.floor(rSamples.length * 0.95))];
  }
  const rMean = rLen > 0 ? rSum / Math.min(rLen, 60) : 0;

  post({
    type: 'stats',
    fps,
    frameMs: fMean,
    frameMsMax: fMax,
    renderMs: rMean,
    renderMsP95: rP95,
    renderMsMax: rMax,
    rendering: _dirty || clock.state === 'playing',
  });
}

// Scratch Vector3 for setTarget — allocating one per frame would defeat
// the whole point of running in a worker.
const _camTarget = new THREE.Vector3();

/**
 * Apply a flat dot-path map of `SceneConfig` updates from the main
 * thread.  The main and worker threads each have their own copy of
 * `SceneConfig` (separate ESM module realms), so a settings-panel
 * change has to round-trip through `postMessage` to take effect on
 * the rendering side.
 *
 * Updates are dot-path keyed (`'camera.pitchDegrees'`, `'lightBall.intensity'`,
 * `'audioVisualOffsetMs'`) so the message is small even when only one
 * leaf changes.  Most properties are read every frame from
 * `SceneConfig` already (light-ball bounce/pulse/glow, the
 * audio-visual offset in `currentMusicTime`), so the side effect for
 * those is zero — just write the new value and the next rAF picks it
 * up.  The exceptions are camera-framing settings
 * (`camera.pitchDegrees` / `camera.contentHeadroom` / `camera.chaseRatio`) —
 * those are read at `configureForScore` / `snapToTarget` time, so we
 * re-call both with the cached framing inputs from
 * `handleSetTimeline`.
 *
 * Reparse-required settings (notation classes, FOV, colours) are
 * NOT routed through here — the main thread handles those by
 * tearing down and rebuilding the score, which sends a fresh
 * `buildScene` + `setTimeline` to the worker.
 */
function handleUpdateConfig({ updates }) {
  if (!updates || typeof updates !== 'object') return;
  let cameraDirty = false;
  for (const path in updates) {
    const value = updates[path];
    const parts = path.split('.');
    let obj = SceneConfig;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (obj[k] === undefined || obj[k] === null) obj[k] = {};
      obj = obj[k];
    }
    obj[parts[parts.length - 1]] = value;

    if (path === 'camera.pitchDegrees'
        || path === 'camera.contentHeadroom'
        || path === 'camera.chaseRatio') {
      cameraDirty = true;
    }
  }
  if (cameraDirty && cameraCtrl && _lastFraming) {
    cameraCtrl.configureForScore(_lastFraming.contentMinY, _lastFraming.contentMaxY);
    if (_lastFraming.firstNote) {
      cameraCtrl.snapToTarget(new THREE.Vector3(_lastFraming.firstNote.x, _lastFraming.firstNote.y, 0));
    }
  }
  _markDirty();
}

function handleDispose() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (lightBalls) { lightBalls.dispose(); lightBalls = null; }
  if (controls)   { controls.dispose();   controls = null; }
  if (renderer)   { renderer.dispose();   renderer = null; }
  // Clear per-scene colouring state so a subsequent `init` starts clean.
  _noteMeshMap = null;
  _playedTimeline = null;
  _playedCursor = 0;
  _staffColors.clear();
  _dirtyInstanceMeshes.clear();
  _lastFraming = null;
}

/** Read-back hook used by tests: returns a small snapshot of camera +
 *  animation state so the main thread can verify wiring (e.g. that
 *  forwarded pointer events are actually driving OrbitControls). */
function handleProbe({ id }) {
  // Render-time histogram across the ring buffer
  let rSum = 0, rMax = 0;
  const rSamples = [];
  for (let i = 0; i < _renderMsFilled; i++) {
    const v = _renderMsRing[i];
    rSamples.push(v);
    rSum += v;
    if (v > rMax) rMax = v;
  }
  rSamples.sort((a, b) => a - b);
  const p = (q) => rSamples[Math.min(rSamples.length - 1, Math.floor(rSamples.length * q))];

  // Actual rAF-to-rAF frame time.  This is what the user perceives —
  // includes GPU execution time that `renderer.render`'s submit-time
  // doesn't capture.
  let fSum = 0, fMax = 0;
  const fSamples = [];
  for (let i = 0; i < _frameMsFilled; i++) {
    const v = _frameMsRing[i];
    fSamples.push(v);
    fSum += v;
    if (v > fMax) fMax = v;
  }
  fSamples.sort((a, b) => a - b);
  const fp = (q) => fSamples[Math.min(fSamples.length - 1, Math.floor(fSamples.length * q))];

  // Mesh + light count in the scene graph (lights matter because each
  // one adds a loop iteration to every fragment shader).
  let meshCount = 0, instancedMeshCount = 0, totalInstances = 0, spriteCount = 0;
  let pointLightCount = 0, directionalLightCount = 0, ambientLightCount = 0;
  scene.traverse((n) => {
    if (n.isMesh) meshCount++;
    if (n.isInstancedMesh) { instancedMeshCount++; totalInstances += n.count; }
    if (n.isSprite) spriteCount++;
    if (n.isPointLight) pointLightCount++;
    if (n.isDirectionalLight) directionalLightCount++;
    if (n.isAmbientLight) ambientLightCount++;
  });
  self.postMessage({
    type: 'probe',
    id,
    snapshot: {
      cameraPos: camera ? [camera.position.x, camera.position.y, camera.position.z] : null,
      cameraDistance: camera && controls ? camera.position.distanceTo(controls.target) : null,
      targetPos: controls ? [controls.target.x, controls.target.y, controls.target.z] : null,
      // Auto-fit framing inputs cached at score-load time.  Exposed on
      // probe so a debug helper on the main thread can reverse-derive
      // the `pitchDegrees` / `chaseRatio` / `contentHeadroom` values
      // that would reproduce the user's current dragged camera pose
      // as the new defaults.
      framing: cameraCtrl ? {
        contentDistance: cameraCtrl._contentDistance,
        contentCenterZ: cameraCtrl._contentCenterZ,
        contentMinY: _lastFraming ? _lastFraming.contentMinY : null,
        contentMaxY: _lastFraming ? _lastFraming.contentMaxY : null,
      } : null,
      smartCamera: cameraCtrl ? {
        enabled: !!SceneConfig.smartCamera?.enabled,
        userInteracting: cameraCtrl._userInteracting,
        phase: cameraCtrl._smartPhase,
        yaw: cameraCtrl._smartYaw,
        pitch: cameraCtrl._smartPitch,
        radiusFactor: cameraCtrl._smartRadiusFactor,
        activityCount: cameraCtrl._staffActivity.size,
      } : null,
      clockState: clock.state,
      render: {
        samples: _renderMsFilled,
        mean: _renderMsFilled ? (rSum / _renderMsFilled) : 0,
        p50: _renderMsFilled ? p(0.5) : 0,
        p95: _renderMsFilled ? p(0.95) : 0,
        p99: _renderMsFilled ? p(0.99) : 0,
        max: rMax,
        skipped: _rendersSkipped,
        compiling: _compiling,
        dirty: _dirty,
      },
      frame: {
        samples: _frameMsFilled,
        mean: _frameMsFilled ? (fSum / _frameMsFilled) : 0,
        p50: _frameMsFilled ? fp(0.5) : 0,
        p95: _frameMsFilled ? fp(0.95) : 0,
        p99: _frameMsFilled ? fp(0.99) : 0,
        max: fMax,
      },
      scene: {
        meshCount, instancedMeshCount, totalInstances, spriteCount,
        pointLights: pointLightCount,
        directionalLights: directionalLightCount,
        ambientLights: ambientLightCount,
      },
    },
  });
}
