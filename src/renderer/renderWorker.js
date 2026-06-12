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
import { SVG3DBuilder, prefetchTitleFont } from '../rendering/SVG3DBuilder.js';
import { setRendererKind, setPlayheadX } from '../rendering/Materials.js';
import { LightBallController } from '../animation/LightBallController.js';
import { CameraController } from '../animation/CameraController.js';
import { ElementProxy } from './ElementProxy.js';
import { OPTIMIZATIONS } from '../rendering/Optimizations.js';

/* ------------------------------------------------------------------ */
/*  GPU quality — load-time probe + runtime pressure                  */
/* ------------------------------------------------------------------ */

/**
 * Two-phase GPU quality system.
 *
 * **Phase 1 — load-time probe** (`_probeGpuCost`, called once during
 * `handleInit`):
 *   Renders the empty scene (paper + lights, no score geometry) several
 *   times and measures wall-clock time.  From that cost it picks the
 *   highest shadow-map resolution that keeps a single frame under the
 *   target budget, then sets shadow mapSize, DPR, and PCF type once.
 *   These settings never change again during the session — no mid-session
 *   dispose, no resolution pop, no shadow-map flicker.
 *
 *   The probe runs in parallel with the Verovio WASM parse of the first
 *   score, so it adds zero latency to the perceived load time.
 *
 * **Phase 2 — runtime pressure** (`_runtimePressure`, updated each rAF):
 *   A 0→1 float that rises when frames are over-budget and falls when
 *   there is headroom.  It is used only to smoothly scale
 *   `SceneConfig.lightBall.intensity` (the point-light contribution of
 *   the bouncing balls).  `LightBallController.update()` reads that
 *   field every frame, so the change takes effect on the very next tick
 *   with no visual artifact — the lights gently dim under pressure and
 *   recover when the load eases.
 *
 *   Changing light intensity is the only runtime-safe knob: shadow map
 *   size, DPR, and PCF type all require a dispose / reallocate that
 *   causes a blank or flickery frame, so they are load-time only.
 *
 * Calibration:
 *   The baseline rAF interval is measured from the first 30 play-session
 *   ticks (≈ 250 ms at 120 Hz) using the p95 percentile — the *same*
 *   statistic the runtime signal uses, so healthy-vs-degraded comparisons
 *   are like-for-like and thresholds adapt automatically to 60/90/120 Hz
 *   and ProMotion displays.
 */

/** Baseline rAF interval (ms) learned from the first play session.
 *  Set once by `_calibrate()`; used by the runtime pressure logic. */
let _baselineMs = 16.67;
let _calibrated = false;
let _calibCount = 0;
const _CALIB_TICKS = 30;
const _calibBuf  = new Float64Array(_CALIB_TICKS);
const _calibSort = new Float64Array(_CALIB_TICKS);

/** Feed one rAF interval sample.  Locks `_baselineMs` after
 *  `_CALIB_TICKS` samples using the **p95** of the collected window.
 *
 *  The percentile choice matters: the runtime pressure signal compares
 *  the *p95* of recent play frames against this baseline, so the
 *  baseline must be the same statistic measured under healthy
 *  conditions.  The previous p10 baseline (the *fastest* frames)
 *  guaranteed a mismatch — at 120 Hz, healthy vsync jitter puts p95 at
 *  ≈ 9.5–10.3 ms while p10 reads ≈ 7.9 ms, so p95 never dropped below
 *  the release threshold (p10 × 1.15 ≈ 9.1 ms) and pressure ratcheted
 *  to 1.0 within seconds of starting *any* playback, permanently
 *  dimming the lights even at a rock-solid 120 fps.
 *
 *  p95 of a 30-sample window (index 28) is also robust to a single
 *  outlier — e.g. the one-off soundfont-load stall right at play
 *  start lands at index 29 and doesn't skew the baseline. */
function _calibrate(frameMs) {
  if (_calibrated || frameMs <= 0 || frameMs >= 2000) return;
  _calibBuf[_calibCount++] = frameMs;
  if (_calibCount >= _CALIB_TICKS) {
    _calibSort.set(_calibBuf);
    _calibSort.sort();
    // Clamp to a sane range in case the tab is throttled, vsync is
    // locked, or the calibration window caught a multi-spike burst
    // (upper bound covers 60 Hz p95 ≈ 17–18 ms with margin).
    _baselineMs = Math.max(6, Math.min(25, _calibSort[Math.floor(_CALIB_TICKS * 0.95)]));
    _calibrated = true;
  }
}

/** Reset calibration — call on play-start so baseline re-measures
 *  from the fresh play context, not stale idle intervals. */
function _resetCalibration() {
  _calibCount = 0;
  _calibBuf.fill(0);
  _baselineMs = 16.67;
  _calibrated = false;
}

/**
 * 0→1 runtime pressure float.  0 = no pressure (lights at full
 * intensity); 1 = maximum pressure (lights fully dimmed).
 * Driven by `_updateRuntimePressure()` in the rAF loop.
 */
let _runtimePressure = 0;
/** Base light intensity saved at init so pressure can scale it. */
let _baseLightIntensity = 0;
/** Whether the auto-dim system is enabled (mirrors the Settings toggle). */
let _autoDimEnabled = true;
/** Diagnostics: what the load-time probe measured and chose.  Exposed
 *  via `probe()` so the dev overlay / Playwright tests can verify the
 *  quality selection matches the hardware. */
let _probeMsMeasured = -1;
let _chosenShadowMapSize = 0;
let _chosenDprCap = 0;

/**
 * Update `_runtimePressure` and apply it to light intensity.
 * Call once per rAF tick after computing `frameP95`.
 * @param {number} dt        Frame duration in seconds.
 * @param {number} frameP95  Recent p95 rAF interval in ms.
 */
function _updateRuntimePressure(dt, frameP95) {
  if (!_autoDimEnabled || !_calibrated) return;

  const highMs = _baselineMs * 1.3;  // > 30 % over budget → build pressure
  const lowMs  = _baselineMs * 1.15; // comfortably under → release pressure

  if (frameP95 >= highMs) {
    // Rise toward 1 over ~1 s of sustained overrun.
    _runtimePressure = Math.min(1, _runtimePressure + dt);
  } else if (frameP95 <= lowMs) {
    // Fall back toward 0 over ~3 s of sustained headroom.
    _runtimePressure = Math.max(0, _runtimePressure - dt / 3);
  } else {
    // In-budget but not strongly under — decay slowly so a mix of
    // good/bad frames doesn't cause visible light flutter.
    _runtimePressure = Math.max(0, _runtimePressure - dt * 0.15);
  }

  // Apply to light intensity.  LightBallController reads
  // SceneConfig.lightBall.intensity every update() call, so writing
  // here takes effect on the very next frame with no artifacts.
  SceneConfig.lightBall.intensity = _baseLightIntensity * (1 - _runtimePressure * 0.85);
}

/**
 * Block until the GPU has actually finished executing all submitted
 * work.  `renderer.render()` only measures CPU-side command encoding —
 * on Chromium (WebGPU *and* WebGL) submission never waits for the GPU,
 * so timing `render()` alone reads ~0.2 ms regardless of how slow the
 * GPU is.  That made the old probe classify every Chromium machine as
 * "very fast" and hand out 6144² shadows + DPR 2.0 unconditionally —
 * exactly the machines that then couldn't hold a consistent frame rate.
 *
 *   • WebGPU: `device.queue.onSubmittedWorkDone()` resolves when the
 *     queue is drained.
 *   • WebGL: a 1×1 `readPixels` forces a full pipeline flush + sync
 *     (the classic synchronous fence).
 */
async function _gpuSync() {
  if (!renderer) return;
  const device = renderer.backend?.device;
  if (device?.queue?.onSubmittedWorkDone) {
    await device.queue.onSubmittedWorkDone();
    return;
  }
  const gl = typeof renderer.getContext === 'function' ? renderer.getContext() : null;
  if (gl && typeof gl.readPixels === 'function') {
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
}

/**
 * Probe GPU rendering cost with the empty scene (lights, paper, no
 * score geometry) by rendering it `count` times and returning the
 * best-case wall-clock time per frame in milliseconds — *including*
 * GPU execution time (see `_gpuSync`) and *including* a full
 * shadow-map pass per frame.
 *
 * The shadow pass must be forced explicitly: `_updateKeyLight` switches
 * the key light to manual shadow updates (`shadow.autoUpdate = false`)
 * during `setupLighting`, so without `needsUpdate = true` per frame the
 * probe would measure frames with no shadow render at all — and the
 * shadow pass is precisely the dominant cost the probe exists to
 * measure (during playback the playhead crosses a shadow texel almost
 * every frame, so the real render loop re-renders the map nearly every
 * frame).
 *
 * Called once during `handleInit`, before `startRenderLoop`, while the
 * score worker is busy parsing the first score's Verovio WASM.  On a
 * fast machine this takes 20–60 ms and is invisible to the user.
 *
 * Returns the **minimum** sample rather than the median: the probe
 * classifies *capability* ("can this GPU sustain the top tier?"), and
 * the minimum is the GPU's demonstrated best case.  Early probe frames
 * run while the GPU is still ramping up from idle clocks, which
 * inflates the median enough to flip borderline machines between
 * tiers from one reload to the next; the min is stable because a
 * genuinely slow GPU's best case is still slow.
 */
async function _probeGpuCost(count = 7) {
  if (!renderer || !scene || !camera) return 0;
  // Warm-up render — don't measure: first call often stalls on driver
  // JIT / shader cache miss regardless of scene complexity.
  renderer.render(scene, camera);
  await _gpuSync();
  let best = Infinity;
  for (let i = 0; i < count; i++) {
    if (_keyLight) _keyLight.shadow.needsUpdate = true;
    const t0 = performance.now();
    renderer.render(scene, camera);
    await _gpuSync();
    const t = performance.now() - t0;
    if (t < best) best = t;
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Choose and apply shadow-map size, DPR cap, and PCF type based on the
 * result of `_probeGpuCost()`.  Called once from `handleInit`.
 *
 * Target budget per probe frame = baseline / 2 (leave half the frame
 * time for geometry + shading once a score is loaded).  For a 120 Hz
 * display the budget is ~4 ms; for 60 Hz ~8 ms.
 *
 * Probe cost reference, GPU-synced via `_gpuSync` (empty scene with a
 * forced 6144² PCFSoft shadow pass at DPR ≤ 2 — see `_probeGpuCost`):
 *   Apple M-series / discrete GPU   ≈ 1.5–2 ms/frame  → keep 6144²
 *   recent integrated GPU           ≈ 2–5 ms/frame    → 4096²
 *   older / budget integrated GPU   ≈ 5 ms+           → 2048²
 * (The pre-GPU-sync numbers that used to live here were submit-time
 * only and read ~0.25 ms on every Chromium machine, which routed all
 * of them into the top tier regardless of actual GPU speed.)
 */
function _applyLoadTimeQuality(probeMs, baseDpr, isMobile) {
  // On mobile the rAF rate halves permanently the first time a frame
  // exceeds budget, so we are extremely conservative.
  if (isMobile) {
    _setShadowQuality(2048, false, baseDpr, 1.5);
    return;
  }
  // For desktop, pick the highest quality that fits half the frame budget.
  // Probe was done on empty scene; real scene costs more, so the half-
  // budget target provides headroom for geometry + shading.
  if (probeMs < 2) {
    // Very fast GPU (M3/M4, dedicated GPU) — full quality.
    _setShadowQuality(6144, true, baseDpr, 2.0);
  } else if (probeMs < 5) {
    // Typical Apple Silicon or recent integrated GPU.
    _setShadowQuality(4096, true, baseDpr, 1.75);
  } else {
    // Slower integrated GPU — drop to 2048 with plain PCF.
    _setShadowQuality(2048, false, baseDpr, 1.5);
  }
}

/** Apply shadow quality and DPR settings.  Must be called before
 *  the render loop starts so there is no mid-session dispose. */
function _setShadowQuality(mapSize, softPcf, baseDpr, dprCap) {
  if (!renderer || !_keyLight) return;
  _chosenShadowMapSize = mapSize;
  _chosenDprCap = dprCap;
  renderer.shadowMap.type = softPcf
    ? THREE.PCFSoftShadowMap
    : THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(baseDpr, dprCap));
  if (_keyLight.shadow.mapSize.width !== mapSize) {
    _keyLight.shadow.mapSize.width  = mapSize;
    _keyLight.shadow.mapSize.height = mapSize;
    if (_keyLight.shadow.map) {
      _keyLight.shadow.map.dispose();
      _keyLight.shadow.map = null;
    }
    _keyLight.shadow.autoUpdate = true;
    _lastKeyLightSnapped.x = null;
    _lastKeyLightSnapped.z = null;
    const shadowCam = _keyLight.shadow.camera;
    _keyLightTexelSize.set(
      (shadowCam.right - shadowCam.left) / mapSize,
      (shadowCam.top - shadowCam.bottom) / mapSize,
    );
  }
  _markDirty();
}

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

/** Best-effort mobile detection from the worker's user-agent.  Used to
 *  pick a smaller shadow map, cheaper PCF filter and a tighter
 *  device-pixel-ratio cap so iOS Safari's "frame went over 16.67 ms →
 *  rAF clamps to 30 Hz and stays there" behaviour doesn't trigger
 *  during dense passages of large scores like Jupiter. */
function _isMobileUA() {
  const ua = (typeof self !== 'undefined' && self.navigator && self.navigator.userAgent) || '';
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
}

async function handleInit({ canvas, width, height, devicePixelRatio, rect, forceWebGL }) {
  // Mobile devices (iOS Safari especially) sit right on the edge of
  // the per-frame budget at desktop quality, and the OS halves the
  // rAF rate the moment a frame goes over.  Trim shadow / DPR /
  // antialias here so dense passages stay under 16.67 ms.
  const isMobile = _isMobileUA();

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
  // MSAA on TBDR mobile GPUs costs significant memory bandwidth per
  // frame; turning it off is one of the bigger single-knob wins on
  // iOS.  Desktop keeps the antialias for crisp notation edges.
  const wantAntialias = !isMobile;
  if (!forceWebGL) {
    try {
      const { WebGPURenderer } = await import('three/webgpu');
      renderer = new WebGPURenderer({ canvas, antialias: wantAntialias });
      await renderer.init();
      usingWebGPU = true;
    } catch (e) {
      renderer = null;
    }
  }
  if (!renderer) {
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: wantAntialias });
    } catch (e) {
      post({
        type: 'renderer_error',
        message: e?.message ?? 'WebGL context creation failed',
      });
      return;
    }
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
  // Cap DPR more aggressively on mobile — a Retina iPhone reports
  // DPR 3, which triples fragment-shader work for very little visual
  // gain on a 6" screen showing the entire score.
  //
  // The adaptive degrader will adjust both DPR and shadow mapSize at
  // runtime; here we apply the starting tier's DPR cap directly via
  // `setPixelRatio` — the degrader's `apply()` call below does the
  // same thing but we need the renderer sized before `setSize`.
  const dprCap = isMobile ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
  renderer.setSize(width, height, false); // false = don't set style; we're off-DOM
  renderer.setClearColor(SceneConfig.backgroundColor, 1);
  _viewportHeightCss = height;

  // Enable shadow rendering on whichever renderer we got.  The key
  // light below casts a soft shadow (PCF on WebGL, an equivalent
  // soft-edge filter on WebGPU); every mesh in the score has
  // `castShadow = true` and the paper backdrop has
  // `receiveShadow = true`, so the resulting shadow shows the
  // notation hovering subtly above the page rather than looking
  // pasted-on.
  //
  // On mobile we step down to plain `PCFShadowMap`; the soft variant
  // averages a multi-tap kernel per fragment and is one of the
  // largest single contributors to fragment cost in the shadow pass.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = isMobile
    ? THREE.PCFShadowMap
    : THREE.PCFSoftShadowMap;

  const cfg = SceneConfig.camera;
  camera = new THREE.PerspectiveCamera(cfg.fov, width / height, cfg.near, cfg.far);
  // Initial pose uses the same left-of-playhead chase formula as
  // CameraController.snapToTarget(), so the first score starts from
  // the "following from the left" side instead of briefly looking back
  // from the playhead's right.
  const initialPitchRad = ((cfg.pitchDegrees ?? 30) * Math.PI) / 180;
  const initialHeight = cfg.defaultDistance * Math.tan(initialPitchRad);
  const initialChaseX = -Math.min(cfg.defaultDistance * (cfg.chaseRatio ?? 0.25), 3.0);
  camera.position.set(initialChaseX, initialHeight, cfg.defaultDistance);
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
  setupLighting(scene, isMobile);

  // Save base light intensity so the runtime pressure system can scale it.
  _baseLightIntensity = SceneConfig.lightBall.intensity;

  // Load-time GPU probe — renders the empty scene (lights + paper, no score
  // geometry) and uses the measured cost to select the highest shadow-map
  // resolution the GPU can sustain within half the per-frame budget.
  // Awaited here (the GPU-sync fences are async), while the score worker is
  // busy with Verovio WASM, so it adds no perceptible latency to load time.
  const baseDpr  = devicePixelRatio || 1;
  const probeMs  = await _probeGpuCost(5);
  _probeMsMeasured = probeMs;
  _applyLoadTimeQuality(probeMs, baseDpr, isMobile);

  cameraCtrl = new CameraController(camera, controls);

  // Smart camera coordination — the controller's auto-orbit needs
  // to know when the user is actively dragging (so it can yield)
  // and what staff just received a chord (so it can drive its
  // activity multiplier).  Both signals are wired here, in the
  // worker, because both originate worker-side: OrbitControls
  // events and the per-frame light-ball hit detector.
  controls.addEventListener('start', () => cameraCtrl?.setUserInteracting(true));
  controls.addEventListener('end', () => cameraCtrl?.setUserInteracting(false));

  // Kick off the title-font fetch in the background so it is ready
  // (or nearly so) by the time the first `buildScene` message arrives.
  // Fire-and-forget — `prefetchTitleFont` stores the result in a
  // module-level variable that `_addTitle` reads synchronously.
  prefetchTitleFont();

  post({ type: 'ready', renderer: usingWebGPU ? 'WebGPU' : 'WebGL' });

  startRenderLoop();
}

function setupLighting(scene, isMobile) {
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
  //
  // On mobile the shadow map is rendered every frame by the
  // notation depth pass, so its size dominates fragment cost.
  // 6144² is ~38 M fragments per frame, which by itself blows past
  // an iPhone GPU's 16.67 ms budget once any other notation is in
  // view; clamp to 2048 (≈ 4 M fragments, 9× cheaper) so dense
  // passages of Jupiter etc. don't trigger iOS Safari's rAF clamp.
  const sCfg = SceneConfig.shadow;
  const mapSize = isMobile ? Math.min(sCfg.mapSize, 2048) : sCfg.mapSize;
  key.castShadow = true;
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

/** Last texel-snapped X/Z position used to position the key light.
 *  Stored as a plain pair so `_updateKeyLight` can skip re-rendering
 *  the shadow map on frames where the light hasn't moved — typically
 *  every idle frame and every play frame where the playhead stayed
 *  within the same texel column (≈ 1-2 cm in world units). */
const _lastKeyLightSnapped = { x: null, z: null };

/** `performance.now()` of the last shadow-map re-render triggered by
 *  `_updateKeyLight`.  Used by the pressure-driven shadow throttle. */
let _lastShadowUpdateMs = 0;

/** Maximum extra delay (ms) between shadow re-renders at full runtime
 *  pressure.  Scales linearly with `_runtimePressure`, so 0 pressure
 *  keeps today's behaviour (re-render whenever the snapped position
 *  changes — nearly every frame during playback) and full pressure
 *  caps the shadow pass at ~7 Hz.
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
 *  pressure system fires. */
const _SHADOW_THROTTLE_MAX_MS = 150;

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

  // Disable automatic per-frame shadow re-render so we can drive it
  // manually.  This is set once on the first call; Three.js WebGPU's
  // ShadowNode.js respects `shadow.autoUpdate / shadow.needsUpdate`
  // the same way the classic WebGLShadowMap does (ShadowNode.js:771).
  if (_keyLight.shadow.autoUpdate) {
    _keyLight.shadow.autoUpdate = false;
    // Force the very first shadow render now (the light was just placed
    // at the initial position; without this the map stays empty until
    // the camera pans for the first time).
    _keyLight.shadow.needsUpdate = true;
  }

  // Skip position update + shadow re-render when the snapped position
  // hasn't changed — on most frames during playback the playhead moves
  // less than one texel width per tick, so this fires only once every
  // several frames rather than every frame.
  if (xs === _lastKeyLightSnapped.x && zs === _lastKeyLightSnapped.z) return;

  // Pressure-driven shadow throttle: under sustained GPU pressure,
  // space shadow-map re-renders out in time instead of re-rendering on
  // every texel crossing.  See `_SHADOW_THROTTLE_MAX_MS` for why this
  // is invisible (directional light translation only slides the
  // coverage frustum, never the shadows themselves).  The position
  // intentionally stays *unsnapped-pending* — we return before writing
  // `_lastKeyLightSnapped`, so the next allowed frame picks the move up.
  if (_runtimePressure > 0 && _lastShadowUpdateMs > 0) {
    const now = performance.now();
    if (now - _lastShadowUpdateMs < _runtimePressure * _SHADOW_THROTTLE_MAX_MS) return;
    _lastShadowUpdateMs = now;
  } else {
    _lastShadowUpdateMs = performance.now();
  }

  _lastKeyLightSnapped.x = xs;
  _lastKeyLightSnapped.z = zs;

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
  // Request a shadow map re-render for this frame now that the light
  // has moved to a new texel-grid position.
  _keyLight.shadow.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/*  Runtime LOD — LOD_DISTANT_ELEMENTS + DISTANCE_CLIP_GLYPHS          */
/* ------------------------------------------------------------------ */

/** Meshes carrying LOD tags (`userData.lodSize` / `userData.lodDetail`)
 *  collected once per scene build by `_collectLodMeshes`.  Kept as a
 *  flat array so the per-frame pass doesn't re-traverse the graph. */
let _lodMeshes = [];
/** Camera-to-target distance at the last LOD evaluation; -1 forces a
 *  re-evaluation (scene rebuild, resize, DPR change). */
let _lodLastDistance = -1;
/** Viewport CSS height, tracked from init/resize for the pixel-size
 *  estimate in `_applyLodVisibility`. */
let _viewportHeightCss = 600;

/** Collect the LOD-managed meshes from a freshly-built scene root.
 *  Called from handleBuildScene after the root is attached. */
function _collectLodMeshes(root) {
  _lodMeshes.length = 0;
  _lodLastDistance = -1;
  if (!OPTIMIZATIONS.LOD_DISTANT_ELEMENTS && !OPTIMIZATIONS.DISTANCE_CLIP_GLYPHS) return;
  root.traverse((n) => {
    if (n.isMesh && n.userData && (n.userData.lodSize > 0 || n.userData.lodDetail)) {
      _lodMeshes.push(n);
    }
  });
}

/**
 * Distance-driven visibility gating for the tagged buckets — this is
 * the runtime half of the two LOD flags in `Optimizations.js`:
 *
 *   • `LOD_DISTANT_ELEMENTS` — buckets tagged `lodDetail` (stems,
 *     flags, ledger lines: the small per-note decorations) hide when
 *     the camera is further than `LOD_DISTANCE_THRESHOLD` from its
 *     orbit target.  At that distance they're ≈ 1 device pixel and
 *     contribute nothing visually, but they're the *most numerous*
 *     instance class — on a dense score they dominate both the shadow
 *     pass and the main pass primitive count.
 *
 *   • `DISTANCE_CLIP_GLYPHS` — any tagged bucket hides when its
 *     world-unit footprint (`lodSize`) projects below ~0.7 device
 *     pixels.  This is the generic safety net for extreme zoom-outs;
 *     noteheads only cross it past d ≈ 100+.
 *
 * Both rules use hysteresis (hide and show thresholds differ by
 * ~15–20 %) so the smart camera's gentle zoom oscillation (±6 %
 * radius) can never make buckets flicker at a boundary.
 *
 * Cost: a single distance check per frame; the full mesh pass (a few
 * dozen entries) only runs when the distance actually moved > 1 %.
 * Visibility toggling on plain/instanced meshes does NOT invalidate
 * WebGPU pipelines (unlike light visibility) — pipelines for every
 * mesh were warmed by `precompilePipelines` regardless of visibility.
 */
function _applyLodVisibility() {
  if (_lodMeshes.length === 0 || !camera || !controls) return;
  const d = camera.position.distanceTo(controls.target);
  if (_lodLastDistance > 0 && Math.abs(d - _lodLastDistance) < _lodLastDistance * 0.01) return;
  _lodLastDistance = d;

  // World units per *device* pixel at the orbit-target distance.
  const fovRad = (camera.fov * Math.PI) / 180;
  const pr = renderer && typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1;
  const viewportDevicePx = Math.max(1, _viewportHeightCss * pr);
  const wupp = (2 * d * Math.tan(fovRad / 2)) / viewportDevicePx;

  const detailRule = OPTIMIZATIONS.LOD_DISTANT_ELEMENTS;
  const clipRule = OPTIMIZATIONS.DISTANCE_CLIP_GLYPHS;
  const T = OPTIMIZATIONS.LOD_DISTANCE_THRESHOLD || 12;

  let toggled = false;
  for (let i = 0; i < _lodMeshes.length; i++) {
    const mesh = _lodMeshes[i];
    const ud = mesh.userData;
    let wantVisible;
    if (mesh.visible) {
      const hideDetail = detailRule && ud.lodDetail && d > T;
      const hideSubPixel = clipRule && ud.lodSize > 0 && ud.lodSize < wupp * 0.7;
      wantVisible = !(hideDetail || hideSubPixel);
    } else {
      // Re-show only once we're clearly back inside both thresholds.
      const stillDetailHidden = detailRule && ud.lodDetail && d > T * 0.85;
      const stillSubPixel = clipRule && ud.lodSize > 0 && ud.lodSize < wupp * 0.85;
      wantVisible = !(stillDetailHidden || stillSubPixel);
    }
    if (wantVisible !== mesh.visible) {
      mesh.visible = wantVisible;
      toggled = true;
    }
  }
  if (toggled) _markDirty();
}

/* ------------------------------------------------------------------ */
/*  Resize / pointer                                                    */
/* ------------------------------------------------------------------ */

function handleResize({ width, height, devicePixelRatio, rect }) {
  if (!renderer || !camera) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  // Respect the DPR cap chosen by the load-time GPU probe — the old
  // hardcoded `min(dpr, 2)` silently undid the probe's choice on the
  // first window resize, putting weak GPUs right back at full
  // resolution.
  const dprCap = _chosenDprCap > 0 ? _chosenDprCap : 2;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
  renderer.setSize(width, height, false);
  _viewportHeightCss = height;
  _lodLastDistance = -1; // viewport changed → pixel sizes changed → re-evaluate LOD
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
  // Collect the LOD-tagged meshes for the runtime visibility pass
  // (LOD_DISTANT_ELEMENTS / DISTANCE_CLIP_GLYPHS).
  _collectLodMeshes(root);
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
    // Title text: ExtrudeGeometry + cloned material, both created per
    // score load and not in any shared cache.
    if (node.name === 'title') {
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
    // Reset the baseline calibration so it re-measures from the first
    // frames of this play session — not from stale idle-period rAF ticks.
    _resetCalibration();
    // Also flush the play-frame ring so old intervals from before this
    // play session don't distort the p95 pressure signal.
    _playFrameMsIdx = 0;
    _playFrameMsFilled = 0;
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
 *  submit time is <5 ms.
 *  Written on *every* rAF tick (playing + idle) — used by `probe()`
 *  for the full frame-time histogram in the developer overlay. */
const _frameMsRing = new Float64Array(120);
let _frameMsIdx = 0;
let _frameMsFilled = 0;
/** Subset of `_frameMsRing` — only records intervals from ticks that
 *  occur while `clock.state === 'playing'`.  The AQ p95 window reads
 *  from this ring instead of `_frameMsRing` so that idle frames
 *  (camera settled, music paused) don't dilute the pressure signal
 *  and cause the AQ system to see artificially low percentiles. */
const _playFrameMsRing = new Float64Array(120);
let _playFrameMsIdx = 0;
let _playFrameMsFilled = 0;
/** Pre-allocated scratch buffers for in-place sorting inside the hot
 *  rAF loop and the 500 ms stats heartbeat.  Using typed arrays and
 *  sorting them in-place avoids the `new Array` + `push` allocations
 *  that were triggering minor GC pauses every frame and causing the
 *  rAF interval to jitter (manifesting as inconsistent 45-60 fps on
 *  ProMotion hardware despite <4 ms GPU render time). */
const _aqScratch = new Float64Array(120);    // AQ p95 — written every rAF
const _statsScratch = new Float64Array(120); // _postStats p95 — written every 500 ms

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
      // Separate ring for AQ: only record play-session frames so that
      // long idle intervals don't make the p95 look deceptively low.
      if (clock.state === 'playing') {
        _playFrameMsRing[_playFrameMsIdx] = frameMs;
        _playFrameMsIdx = (_playFrameMsIdx + 1) % _playFrameMsRing.length;
        if (_playFrameMsFilled < _playFrameMsRing.length) _playFrameMsFilled++;
      }
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
        const lookAheadSeconds = clock.state === 'playing'
          ? Math.max(0, SceneConfig.camera.lookAheadSeconds ?? 0)
          : 0;
        const xLook = lookAheadSeconds > 0
          ? cameraCtrl.xAtTime(musicTime + lookAheadSeconds, 'lookAhead')
          : xTime;
        _camTarget.set(xTime, 0, 0);
        cameraCtrl.setTarget(_camTarget, xLook ?? xTime);
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
    // Distance-LOD visibility gating (LOD_DISTANT_ELEMENTS /
    // DISTANCE_CLIP_GLYPHS).  Skipped while a precompile is in flight
    // — precompilePipelines temporarily toggles hidden meshes visible
    // and restores them afterwards, and a concurrent LOD pass would
    // corrupt that bookkeeping.
    if (!_compiling) _applyLodVisibility();
    // Feed the current playhead X into the glow-falloff uniform so the
    // noteHead shader can fade out emissive glow on distant played notes.
    setPlayheadX(_camTarget.x);
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

    // --- Runtime pressure (light dimming) ----------------------------
    // Uses rAF-to-rAF interval as the GPU pressure signal; only fires
    // once the baseline has been calibrated from play-session frames.
    // Also feeds the calibration window while playing.
    //
    // Unlike the old tier system this does NOT change shadow map size,
    // DPR, or PCF type at runtime — those are set once by the load-time
    // probe and never touched again, eliminating all mid-session flicker.
    // The only runtime adjustment is smoothly scaling light-ball intensity
    // via SceneConfig.lightBall.intensity, which LightBallController reads
    // every frame with no reallocation.
    if (_playFrameMsFilled > 0) {
      // Calibration: only feeds play-session rAF intervals.
      if (clock.state === 'playing') _calibrate(frameMs);
      // Compute p95 over the play-frame ring — same logic as before,
      // no heap allocation.
      const wantAq = Math.min(_playFrameMsFilled, 60);
      for (let i = 0; i < wantAq; i++) {
        const idx = (_playFrameMsIdx - 1 - i + _playFrameMsRing.length) % _playFrameMsRing.length;
        _aqScratch[i] = _playFrameMsRing[idx];
      }
      _aqScratch.subarray(0, wantAq).sort();
      const aqP95 = _aqScratch[Math.min(wantAq - 1, Math.floor(wantAq * 0.95))];
      _updateRuntimePressure(dt, aqP95);
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
    for (let i = 0; i < rWant; i++) {
      const idx = (_renderMsIdx - 1 - i + _renderMsRing.length) % _renderMsRing.length;
      const v = _renderMsRing[idx];
      _statsScratch[i] = v;
      rSum += v;
      if (v > rMax) rMax = v;
    }
    _statsScratch.subarray(0, rWant).sort();
    rP95 = _statsScratch[Math.min(rWant - 1, Math.floor(rWant * 0.95))];
  }
  const rMean = rLen > 0 ? rSum / Math.min(rLen, 60) : 0;

  // Compute play-frame p95 for the pressure diagnostic.
  let playP95 = 0;
  if (_playFrameMsFilled > 0) {
    const pWant = Math.min(_playFrameMsFilled, 60);
    for (let i = 0; i < pWant; i++) {
      const idx = (_playFrameMsIdx - 1 - i + _playFrameMsRing.length) % _playFrameMsRing.length;
      _statsScratch[i] = _playFrameMsRing[idx];
    }
    _statsScratch.subarray(0, pWant).sort();
    playP95 = _statsScratch[Math.min(pWant - 1, Math.floor(pWant * 0.95))];
  }

  post({
    type: 'stats',
    fps,
    frameMs: fMean,
    frameMsMax: fMax,
    frameMsP95: playP95,
    renderMs: rMean,
    renderMsP95: rP95,
    renderMsMax: rMax,
    rendering: _dirty || clock.state === 'playing',
    autoDegrade: _autoDimEnabled,
    gpuPressure: _runtimePressure,
    aqBaselineMs: _baselineMs,
    aqCalibrated: _calibrated,
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
  // Pure-worker flags — not stored in SceneConfig — handled before
  // the generic dot-path loop.
  if ('autoDegrade' in updates) {
    const wasEnabled = _autoDimEnabled;
    _autoDimEnabled = !!updates.autoDegrade;
    if (!wasEnabled && _autoDimEnabled) {
      // Re-enabling after a manual disable: reset calibration so stale
      // rAF intervals from the disabled period don't seed a misleading
      // baseline.  Also restore full light intensity immediately.
      _resetCalibration();
      _runtimePressure = 0;
      SceneConfig.lightBall.intensity = _baseLightIntensity;
    } else if (!_autoDimEnabled) {
      // Disabling: restore full intensity so lights snap back.
      _runtimePressure = 0;
      SceneConfig.lightBall.intensity = _baseLightIntensity;
    }
  }
  let cameraDirty = false;
  for (const path in updates) {
    // `autoDegrade` is handled above; skip it here so we don't
    // accidentally poke an `autoDegrade` key into `SceneConfig`.
    if (path === 'autoDegrade') continue;
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
  _lodMeshes.length = 0;
  _lodLastDistance = -1;
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
      quality: {
        probeMs: _probeMsMeasured,
        shadowMapSize: _chosenShadowMapSize,
        dprCap: _chosenDprCap,
        pixelRatio: renderer && renderer.getPixelRatio ? renderer.getPixelRatio() : 0,
        pressure: _runtimePressure,
        baselineMs: _baselineMs,
        calibrated: _calibrated,
      },
      lod: {
        managed: _lodMeshes.length,
        hidden: _lodMeshes.reduce((n, m) => n + (m.visible ? 0 : 1), 0),
        lastDistance: _lodLastDistance,
      },
    },
  });
}
