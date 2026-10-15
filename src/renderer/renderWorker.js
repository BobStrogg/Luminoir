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
 *
 * The per-subsystem state that used to live here as module globals is
 * now owned by the classes under `./worker/`; this file is just the
 * message switch plus the `handleInit` wiring sequence.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SceneConfig } from '../rendering/SceneConfig.js';
import { SVG3DBuilder } from '../rendering/SVG3DBuilder.js';
import { prefetchTitleFont } from '../rendering/PaperAndTitle.js';
import { setRendererKind } from '../rendering/Materials.js';
import { CameraController } from '../animation/CameraController.js';
import { ElementProxy } from './ElementProxy.js';
import { OPTIMIZATIONS } from '../rendering/Optimizations.js';
import { chooseTeslaPixelRatio } from './worker/qualityPolicy.js';
import { detectPlatform } from './worker/ua.js';
import { createRenderer, applyOutputSettings } from './worker/RendererFactory.js';
import { AntiAliasing } from './worker/AntiAliasing.js';
import { KeyLightRig } from './worker/KeyLightRig.js';
import { QualityController } from './worker/QualityController.js';
import { LodGate } from './worker/LodGate.js';
import { PlayedNoteColorizer } from './worker/PlayedNoteColorizer.js';
import { PlaybackClock } from './worker/PlaybackClock.js';
import { FrameStats } from './worker/FrameStats.js';
import { SceneHost } from './worker/SceneHost.js';
import { RenderLoop } from './worker/RenderLoop.js';
import { EventLog } from './worker/EventLog.js';
import { installMeshGpuDisposal } from './worker/meshGpuDisposal.js';
import { instanceBytesOutstanding } from '../rendering/instanceLedger.js';

/* ------------------------------------------------------------------ */
/*  Shared worker context                                              */
/* ------------------------------------------------------------------ */

/**
 * Plain object shared by every worker subsystem.  Components read
 * their peers through `ctx` lazily (per call, not per construction)
 * so there are no import cycles and construction order is free.
 * `renderer`, `camera`, `controls`, `elementProxy` and `cameraCtrl`
 * are filled in by `handleInit`.
 */
const ctx = {
  post: (msg) => self.postMessage(msg),
  markDirty: () => ctx.loop.markDirty(),
  renderer: null,
  /** @type {THREE.PerspectiveCamera | null} */
  camera: null,
  /** @type {OrbitControls | null} */
  controls: null,
  /** @type {ElementProxy | null} */
  elementProxy: null,
  /** @type {CameraController | null} */
  cameraCtrl: null,
  /** Viewport CSS height, tracked from init/resize for the pixel-size
   *  estimate in `LodGate.apply`. */
  viewportHeightCss: 600,
};

ctx.host = new SceneHost(ctx);
ctx.clock = new PlaybackClock();
ctx.frameStats = new FrameStats();
ctx.keyLightRig = new KeyLightRig();
ctx.antiAliasing = new AntiAliasing();
ctx.quality = new QualityController(ctx);
ctx.lod = new LodGate();
ctx.colorizer = new PlayedNoteColorizer();
ctx.loop = new RenderLoop(ctx);
ctx.eventLog = new EventLog(80);
// Convenience alias — the scene itself lives on the host.
ctx.scene = ctx.host.scene;
// Benchmark aggregator (enabled only during explicit bench runs)
ctx.benchmark = {
  enabled: false,
  frames: /** @type {number[]} */([]),
  over8: 0,
  over16: 0,
  over33: 0,
};
// Page-visibility bookkeeping for background-tab interval labelling.
ctx._pageHidden = false;
ctx._hiddenSince = 0;
ctx._lastHiddenDurationMs = 0;
ctx._visibleAt = 0;
// Persistent diagnostic context (shown separately from rolling events).
ctx.diagContext = [];
/** CSS viewport last applied, and the native vs chosen pixel ratios. */
ctx.cssWidth = 1;
ctx.cssHeight = 1;
ctx.nativePixelRatio = 1;
ctx.renderPixelRatio = 1;
/** Set when the scene probe steps the ratio down, so a later resize
 *  cannot climb back above a ratio the probe already rejected. */
ctx.probePixelRatioCeiling = 0;

function upsertDiag(prefix, line) {
  const arr = ctx.diagContext;
  if (!Array.isArray(arr)) return;
  const i = arr.findIndex((s) => typeof s === 'string' && s.startsWith(prefix));
  if (i >= 0) arr[i] = line;
  else arr.push(line);
}

function removeDiagPrefix(prefix) {
  const arr = ctx.diagContext;
  if (!Array.isArray(arr)) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (typeof arr[i] === 'string' && arr[i].startsWith(prefix)) arr.splice(i, 1);
  }
}

function syncShadowDiag() {
  const enabled = !!SceneConfig.shadow.enabled && !!ctx.renderer?.shadowMap?.enabled;
  if (!enabled) {
    removeDiagPrefix('Quality: shadowMapSize=');
    upsertDiag('Shadows:', 'Shadows: off');
    return;
  }
  const soft = ctx.renderer.shadowMap.type === THREE.PCFSoftShadowMap;
  const size = ctx.quality?.chosenShadowMapSize
    || ctx.keyLightRig?.light?.shadow?.mapSize?.width
    || 0;
  upsertDiag('Shadows:', `Shadows: ${soft ? 'PCFSoft' : 'PCF'}${size ? ` map ${size}` : ''}`);
}

function syncRendererDprDiag() {
  const arr = ctx.diagContext;
  if (!Array.isArray(arr)) return;
  const i = arr.findIndex((s) => typeof s === 'string' && s.startsWith('Renderer:'));
  if (i < 0) return;
  const dpr = Number(ctx.renderPixelRatio || 1).toFixed(2);
  const native = Number(ctx.nativePixelRatio || 1).toFixed(2);
  arr[i] = arr[i].replace(/DPR [\d.]+ \(native [\d.]+\)/, `DPR ${dpr} (native ${native})`);
}

function syncFramebufferDiag() {
  const renderer = ctx.renderer;
  const dpr = renderer?.getPixelRatio?.() || ctx.renderPixelRatio || 1;
  const native = ctx.nativePixelRatio || dpr;
  const bufW = renderer?.domElement?.width || Math.round((ctx.cssWidth || 0) * dpr);
  const bufH = renderer?.domElement?.height || Math.round((ctx.cssHeight || 0) * dpr);
  upsertDiag('Framebuffer:', `Framebuffer: DPR ${Number(dpr).toFixed(2)} (native ${Number(native).toFixed(2)}) ${bufW}×${bufH}`);
}

/** Apply the session pixel ratio. Tesla passes a load-time budget;
 *  everyone else passes the native DPR. Does not change ratio during
 *  playback except via resize, which reuses the probe ceiling. */
function applyRenderPixelRatio(ratio) {
  const renderer = ctx.renderer;
  if (!renderer || !(ctx.cssWidth > 0) || !(ctx.cssHeight > 0)) return;
  const native = ctx.nativePixelRatio || 1;
  const next = Math.min(native, Math.max(0.25, ratio));
  const prev = typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 0;
  ctx.renderPixelRatio = next;
  renderer.setPixelRatio(next);
  renderer.setSize(ctx.cssWidth, ctx.cssHeight, false);
  if (ctx.antiAliasing) ctx.antiAliasing.resize(renderer, ctx.cssWidth, ctx.cssHeight);
  if (ctx.lod) ctx.lod.invalidate();
  ctx.markDirty();
  syncFramebufferDiag();
  syncRendererDprDiag();
  if (Math.abs(prev - next) > 0.01) {
    const bufW = renderer.domElement?.width || 0;
    const bufH = renderer.domElement?.height || 0;
    ctx.eventLog?.note?.(`pixel-ratio: ${next.toFixed(2)} (native ${native.toFixed(2)}) buffer ${bufW}×${bufH}`);
  }
}
ctx.applyRenderPixelRatio = applyRenderPixelRatio;
ctx.syncShadowDiag = syncShadowDiag;

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
    case 'benchmarkStart': return handleBenchmarkStart(msg);
    case 'benchmarkStop':  return handleBenchmarkStop(msg);
    case 'statsReset':    return handleStatsReset();
    case 'resetFrameWindow': return handleResetFrameWindow();
    case 'visibility':    return handleVisibility(msg);
    case 'tick':          return ctx.loop.externalTick(msg.now);
    default:
      console.warn('[renderWorker] unknown message:', msg.type);
  }
};

/* ------------------------------------------------------------------ */
/*  Init                                                                */
/* ------------------------------------------------------------------ */

async function handleInit({ canvas, width, height, devicePixelRatio, rect, forceWebGL, preferWebGPU, driveFromMain, shadowEnabled, forceShadows, dtSmoothAlpha, smartCameraEnabled, lookAheadSeconds, smoothTime, platformOverride, clientHints }) {
  // SceneConfig is mirrored in the worker; set the runtime flags
  // from the main thread before the renderer is configured.
  SceneConfig.shadow.enabled = shadowEnabled !== false;
  if (typeof dtSmoothAlpha === 'number') SceneConfig.dtSmoothAlpha = dtSmoothAlpha;
  if (typeof smartCameraEnabled === 'boolean') SceneConfig.smartCamera.enabled = smartCameraEnabled;
  if (typeof lookAheadSeconds === 'number') SceneConfig.camera.lookAheadSeconds = lookAheadSeconds;
  if (typeof smoothTime === 'number') SceneConfig.camera.smoothTime = smoothTime;
  // Mobile devices (iOS Safari especially) sit right on the edge of
  // the per-frame budget at desktop quality, and the OS halves the
  // rAF rate the moment a frame goes over.  Trim shadow resolution and
  // antialias here so dense passages stay under 16.67 ms. Desktop and
  // phones keep native DPR. Tesla picks a load-time pixel budget
  // (sharper than the old 1.0 cap) and does not change it mid-playback.
  const plat = detectPlatform({ platformOverride, ...(clientHints || {}) });
  const { isMobile, isSafari, isTesla, isConstrained } = plat;
  ctx.eventLog.note(`init: ua mobile=${isMobile} safari=${isSafari} tesla=${isTesla} constrained=${isConstrained}`);
  ctx.diagContext.push(`Platform: mobile=${isMobile} safari=${isSafari} tesla=${isTesla} constrained=${isConstrained}`);
  if (plat.ua) ctx.diagContext.push(`UA: ${plat.ua}`);
  if (plat.reason) ctx.diagContext.push(`TeslaReason: ${plat.reason}`);
  // Expose Tesla flag to subsystems (RenderLoop needs it for rate-lock decisions)
  ctx.isTesla = !!isTesla;
  // Tesla: avoid budget-driven render skips (prefer steady cadence)
  if (isTesla) {
    try {
      OPTIMIZATIONS.RENDER_BUDGET_SKIP = false;
      ctx.eventLog.note('optim: RENDER_BUDGET_SKIP disabled (Tesla)');
      ctx.diagContext.push('Optim: no render-budget skip (Tesla)');
    } catch {}
  }
  // Hint materials to use cheaper, unlit variants for structural lines on
  // constrained platforms; purely visual trade-off with a big fragment win.
  try {
    if (!SceneConfig.performance) SceneConfig.performance = {};
    SceneConfig.performance.mobileFlatShading = !!isConstrained;
    SceneConfig.performance.cheapSurfaces = !!isTesla;
  } catch {}

  // MSAA on TBDR mobile GPUs costs significant memory bandwidth per
  // frame; turning it off is one of the bigger single-knob wins on
  // iOS.  Desktop keeps the antialias for crisp notation edges.
  const wantAntialias = !isMobile && !isTesla;
  // Prefer the legacy WebGLRenderer on Safari for stall-free cadence unless
  // explicitly overridden by ?renderer=webgpu. WebGL avoids occasional
  // multi-frame queue/present stalls observed on iOS WebGPU.
  const forceLegacy = !!forceWebGL || ((isSafari || isTesla) && !preferWebGPU);
  const { renderer, usingWebGPU, error } = await createRenderer(
    { canvas, forceWebGL: forceLegacy, antialias: wantAntialias });
  if (!renderer) {
    ctx.post({
      type: 'renderer_error',
      message: error?.message ?? 'WebGL context creation failed',
    });
    return;
  }
  ctx.renderer = renderer;
  ctx.gpuDisposal = installMeshGpuDisposal(renderer);
  ctx.eventLog.note(`renderer: ${usingWebGPU ? 'WebGPU' : 'WebGL'}; antialias=${wantAntialias ? 'MSAA' : 'none'}; dpr=${(devicePixelRatio||1).toFixed(2)}${forceLegacy ? ' [forced legacy on Safari]' : ''}`);

  // Tell the `Materials` module which GLSL-injection path to use —
  // must be called *before* the first `Materials.noteHead()` in the
  // builder constructor below.  The WebGL path uses the legacy
  // `onBeforeCompile` GLSL hook; the WebGPU path uses TSL
  // `emissiveNode` on a `MeshStandardNodeMaterial`.
  setRendererKind(usingWebGPU ? 'webgpu' : 'webgl');
  OPTIMIZATIONS.CHUNK_BUCKETS_BY_X = !usingWebGPU || isSafari;
  OPTIMIZATIONS.MAX_POINT_LIGHTS = (isConstrained || isSafari) ? 4 : 8;
  // Builder is constructed *after* `setRendererKind()` so its internal
  // `Materials.noteHead()` factory picks the right shader path on
  // first use.
  ctx.host.builder = new SVG3DBuilder();
  applyOutputSettings(renderer);
  // Tesla used to clamp DPR at 1.0. On a ~2× panel that left the
  // drawing buffer at CSS resolution (the 804×638 buffer behind a
  // 1.96 window DPR) and the score looked soft. Pick a sharper
  // load-time ratio instead; the scene probe may step it down while
  // the overlay is still up, but never back to a blanket 1.0 cap.
  ctx.cssWidth = width;
  ctx.cssHeight = height;
  ctx.nativePixelRatio = devicePixelRatio || 1;
  ctx.viewportHeightCss = height;
  const effectiveDpr = isTesla
    ? chooseTeslaPixelRatio(ctx.nativePixelRatio, width, height)
    : ctx.nativePixelRatio;
  applyRenderPixelRatio(effectiveDpr);
  renderer.setClearColor(SceneConfig.backgroundColor, 1);
  upsertDiag('Renderer:', `Renderer: ${usingWebGPU ? 'WebGPU' : 'WebGL'}; AA=${wantAntialias ? 'MSAA' : 'none'}; DPR ${effectiveDpr.toFixed(2)} (native ${ctx.nativePixelRatio.toFixed(2)})`);

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
  // `?shadow=1` is the only way to keep shadows on Tesla. The default
  // init flag is "on", and `KeyLightRig.applyShadowEnabled` copies
  // `SceneConfig.shadow.enabled` onto the renderer — a later write of
  // `shadowMap.enabled = false` used to be undone there, which is why
  // v1.1.26 still showed a PCF shadow map.
  if (isTesla && !forceShadows) SceneConfig.shadow.enabled = false;
  renderer.shadowMap.enabled = !!SceneConfig.shadow.enabled;
  renderer.shadowMap.type = (isMobile || isTesla)
    ? THREE.PCFShadowMap
    : THREE.PCFSoftShadowMap;
  ctx.eventLog.note(`shadows: ${SceneConfig.shadow.enabled ? 'on' : 'off'} type=${renderer.shadowMap.type === THREE.PCFSoftShadowMap ? 'PCFSoft' : 'PCF'}`);

  const cfg = SceneConfig.camera;
  const camera = ctx.camera = new THREE.PerspectiveCamera(cfg.fov, width / height, cfg.near, cfg.far);
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
  const elementProxy = ctx.elementProxy = new ElementProxy();
  elementProxy.setRect(rect);
  const controls = ctx.controls = new OrbitControls(camera, elementProxy);
  // Drag inertia: OrbitControls decays sphericalDelta by dampingFactor
  // each update, so a flicked drag glides to a stop instead of freezing
  // on pointer-up.  Safe to combine with CameraController's springs —
  // the controller is stateless w.r.t. user input (it reads the
  // post-update camera offset back into _currentSpherical every frame),
  // and auto-return only engages seconds after release anyway.
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  // OrbitControls calls `this.update()` synchronously inside EVERY
  // pointer-move / wheel / key handler, and each call consumes a full
  // damping step — so residual inertia decayed at pointer-event rate
  // (up to ~1 kHz on gaming mice) rather than frame rate, making the
  // same gesture feel different on every device.  Replace the public
  // `update` with a no-op so event handlers only accumulate deltas;
  // `CameraController` invokes `syncUpdate(dt)` exactly once per rAF
  // tick, giving damping a fixed, dt-scaled cadence identical on every
  // display.  Deltas already aggregate in `_sphericalDelta`, so nothing
  // is lost — the summed gesture applies on the next frame.
  controls.syncUpdate = controls.update.bind(controls);
  controls.update = () => {};
  controls.enablePan = false;
  controls.minDistance = 0.3;
  controls.maxDistance = 100;
  controls.target.set(0, 0, 0);
  // Any user-driven motion fires `change`; wire it to the idle-render
  // gate so we re-submit the GPU pass exactly when something visible
  // has updated.
  controls.addEventListener('change', ctx.markDirty);

  ctx.scene.background = new THREE.Color(SceneConfig.backgroundColor);
  ctx.scene.add(ctx.host.contentRoot);
  ctx.keyLightRig.setupLighting(ctx.scene, isMobile, renderer, isConstrained);
  syncShadowDiag();
  if (ctx.keyLightRig.frozen && SceneConfig.shadow.enabled) {
    ctx.eventLog.note('shadows: frozen frustum (constrained platform)');
  }

  // Save base light intensity so the runtime pressure system can scale it.
  ctx.quality.baseLightIntensity = SceneConfig.lightBall.intensity;

  await ctx.antiAliasing.setup(renderer, ctx.scene, camera, usingWebGPU, width, height, {
    disableFxaa: !!isTesla,
  });

  // Load-time GPU probe — renders the empty scene (lights + paper, no score
  // geometry) and uses the measured cost to select the highest shadow-map
  // resolution the GPU can sustain within half the per-frame budget.
  // Awaited here (the GPU-sync fences are async), while the score worker is
  // busy with Verovio WASM, so it adds no perceptible latency to load time.
  ctx.quality.runSceneProbe = isMobile || isSafari || isTesla;
  ctx.quality.allowVeryLowQuality = isConstrained;
  ctx.quality.sceneGpuBudgetMs = 14;
  // Constrained platforms never let detail meshes (stems/flags/ledger
  // lines — the most numerous instance class) cast shadows; their
  // shadows are sub-texel anyway and excluding them roughly halves the
  // periodic shadow-pass cost.  Set before the first `lod.collect()`.
  ctx.lod.constrained = isConstrained;
  if (SceneConfig.shadow.enabled) {
    const probeMs = await ctx.quality.probeGpuCost(5);
    ctx.quality.probeMsMeasured = probeMs;
    ctx.quality.applyLoadTimeQuality(probeMs, isConstrained);
    ctx.eventLog.note(`load-probe: ${probeMs.toFixed(2)} ms → shadowMapSize=${ctx.quality.chosenShadowMapSize}`);
    syncShadowDiag();
  } else {
    ctx.quality.probeMsMeasured = 0;
    ctx.eventLog.note('load-probe: skipped (shadows off)');
    syncShadowDiag();
  }

  const cameraCtrl = ctx.cameraCtrl = new CameraController(camera, controls);
  ctx.frameStats.seedCameraPos(camera.position);

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

  ctx.post({
    type: 'ready',
    renderer: usingWebGPU ? 'WebGPU' : 'WebGL',
    antiAliasing: ctx.antiAliasing.mode,
    msaaSamples: ctx.antiAliasing.msaaSamples,
    shadowsEnabled: !!SceneConfig.shadow.enabled,
    tesla: !!isTesla,
  });

  // Prefer main-thread vsync drive on Tesla unless explicitly disabled by URL.
  const useExternalDrive = !!driveFromMain || !!isTesla;
  ctx.loop.setExternalDrive(useExternalDrive);
  ctx.loop.start();
  if (useExternalDrive) {
    try { ctx.post({ type: 'requestMainVsyncDrive' }); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/*  Resize / pointer                                                    */
/* ------------------------------------------------------------------ */

function handleResize({ width, height, devicePixelRatio, rect }) {
  const { renderer, camera, elementProxy } = ctx;
  if (!renderer || !camera) return;
  ctx.cssWidth = width;
  ctx.cssHeight = height;
  ctx.viewportHeightCss = height;
  ctx.nativePixelRatio = devicePixelRatio || 1;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  // Tesla keeps the load-time ratio (and any probe ceiling). A resize
  // used to stamp the native DPR back on and undo the cap — or, with
  // the old 1.0 cap, ignore it entirely. Non-Tesla stays at native.
  if (ctx.isTesla) {
    const chosen = chooseTeslaPixelRatio(ctx.nativePixelRatio, width, height);
    const cap = ctx.probePixelRatioCeiling;
    applyRenderPixelRatio(cap ? Math.min(chosen, cap) : chosen);
  } else {
    applyRenderPixelRatio(ctx.nativePixelRatio);
  }
  if (elementProxy) elementProxy.setRect(rect);
  ctx.markDirty();
  ctx.eventLog.note(`resize: ${Math.floor(width)}×${Math.floor(height)} dpr=${ctx.renderPixelRatio.toFixed(2)} native=${ctx.nativePixelRatio.toFixed(2)}`);
}

function handlePointer({ target, payload }) {
  if (!ctx.elementProxy) return;
  ctx.elementProxy.dispatchProxied(target, payload);
  // Pointer events that change camera state will fire `change` via
  // OrbitControls and mark the scene dirty automatically — but we
  // mark eagerly here too in case the event is e.g. a touch-end
  // that doesn't immediately move the camera but should still wake
  // the render loop so the next animation step lands on screen.
  ctx.markDirty();
}

/* ------------------------------------------------------------------ */
/*  Scene build / timeline / camera                                     */
/* ------------------------------------------------------------------ */

function handleBuildScene({ parsed }) {
  ctx.host.buildScene(parsed, ctx.cameraCtrl);
}

function handleSetTimeline(msg) {
  ctx.host.setTimeline(msg, ctx.cameraCtrl);
}

function handleSnapCamera({ x, y }) {
  if (ctx.cameraCtrl) ctx.cameraCtrl.snapToTarget(new THREE.Vector3(x, y, 0));
  ctx.markDirty();
}

/* ------------------------------------------------------------------ */
/*  Playback clock                                                      */
/* ------------------------------------------------------------------ */

function handleClock({ state, musicTime, tempoScale, outputDelayMs }) {
  const { clock, host, frameStats } = ctx;
  // Land the delay before `set` flags the play-start snap, so the
  // first visual frame is already behind currentTime by the speaker delay.
  if (Number.isFinite(outputDelayMs)) SceneConfig.audioOutputDelayMs = outputDelayMs;
  clock.set(state, musicTime, tempoScale);
  if (state === 'playing') {
    if (host.lightBalls) host.lightBalls.play();
    // NOTE: no calibration reset here — the display's refresh rate is
    // identical before and during playback, and idle foreground ticks
    // measure it more cleanly than the heaviest frames of a play
    // session.  Calibration is fed every rAF tick in RenderLoop.
    // Also flush the play-frame ring so old intervals from before this
    // play session don't distort the p95 pressure signal.
    frameStats.resetForPlay();
  } else if (state === 'paused') {
    if (host.lightBalls) host.lightBalls.pause();
  } else if (state === 'stopped') {
    if (host.lightBalls) host.lightBalls.stop();
  }
  // State transition / scrub — mark dirty so the *next* frame
  // renders the updated cursor / colour state.  When `state` is
  // `playing` the loop forces `_dirty` true every frame anyway, so
  // this only matters for play→stop, play→pause, and seek-while-
  // paused, but it's cheap to do unconditionally.
  ctx.markDirty();
}

/* ------------------------------------------------------------------ */
/*  Config / dispose / probe                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Benchmark control                                                   */
/* ------------------------------------------------------------------ */
function handleBenchmarkStart({ durationSec }) {
  ctx.benchmark.enabled = true;
  ctx.benchmark.frames.length = 0;
  ctx.benchmark.over8 = 0;
  ctx.benchmark.over16 = 0;
  ctx.benchmark.over33 = 0;
  if (durationSec && Number.isFinite(durationSec) && durationSec > 0) {
    const t = setTimeout(() => {
      // Auto-stop; main thread may still call explicit stop.
      if (ctx.benchmark.enabled) handleBenchmarkStop({});
    }, durationSec * 1000);
    // detach timer ref so worker can exit if needed
    if (t && t.unref) t.unref();
  }
}

function handleBenchmarkStop() {
  const arr = ctx.benchmark.frames.slice().sort((a, b) => a - b);
  const n = arr.length;
  const pick = (q) => n ? arr[Math.min(n - 1, Math.floor(n * q))] : 0;
  const p50 = pick(0.5), p95 = pick(0.95), p99 = pick(0.99);
  const max = n ? arr[n - 1] : 0;
  // Camera summary from the rings
  const fs = ctx.frameStats;
  const jitterRing = fs._cameraDeltaRing;
  const scratch = fs._statsScratch;
  const jn = jitterRing.filled;
  const jmax = jitterRing.max(jn);
  const jp50 = jitterRing.percentile(0.5, jn, scratch);
  const jp95 = jitterRing.percentile(0.95, jn, scratch);
  const jp99 = jitterRing.percentile(0.99, jn, scratch);
  const velP95 = fs._velRing.percentile(0.95, fs._velRing.filled, scratch);
  const velP99 = fs._velRing.percentile(0.99, fs._velRing.filled, scratch);
  const accP95 = fs._accRing.percentile(0.95, fs._accRing.filled, scratch);
  const accP99 = fs._accRing.percentile(0.99, fs._accRing.filled, scratch);
  const jerkP95 = fs._jerkRing.percentile(0.95, fs._jerkRing.filled, scratch);
  const jerkP99 = fs._jerkRing.percentile(0.99, fs._jerkRing.filled, scratch);
  const pixP95 = fs._pixRing.percentile(0.95, fs._pixRing.filled, scratch);
  const pixP99 = fs._pixRing.percentile(0.99, fs._pixRing.filled, scratch);
  const result = {
    samples: n,
    p50, p95, p99, max,
    over8_3: ctx.benchmark.over8,
    over16_7: ctx.benchmark.over16,
    over33_3: ctx.benchmark.over33,
    cameraJitter: {
      samples: jn,
      p50: jp50, p95: jp95, p99: jp99, max: jmax,
    },
    cameraKinematics: {
      totalDistance: fs._totalCamDistance ?? 0,
      peakSpeed: fs._peakCamSpeed ?? 0,
      velP95, velP99, accP95, accP99, jerkP95, jerkP99,
      pixelP95: pixP95, pixelP99: pixP99,
    },
  };
  ctx.post({ type: 'benchmarkResult', result });
  ctx.benchmark.enabled = false;
}

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
 * audio-visual offset in `musicTimeAt`), so the side effect for
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
  const { quality, cameraCtrl, host, keyLightRig, renderer } = ctx;
  // Pure-worker flags — not stored in SceneConfig — handled before
  // the generic dot-path loop.
  if ('autoDegrade' in updates) {
    quality.setAutoDegrade(!!updates.autoDegrade);
  }
  // Debug-only pressure override for probing the pressure actuators
  // (LOD gate, shadow throttle, FXAA suppression) on demand.
  if ('debugPressure' in updates) {
    quality.setDebugPressure(updates.debugPressure);
  }
  let cameraDirty = false;
  for (const path in updates) {
    // `autoDegrade` / `debugPressure` are handled above; skip them
    // here so we don't poke them into `SceneConfig`.
    if (path === 'autoDegrade' || path === 'debugPressure') continue;
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
    if (path === 'shadow.enabled') {
      keyLightRig.applyShadowEnabled(renderer);
      syncShadowDiag();
    }
  }
  const lastFraming = host.lastFraming;
  if (cameraDirty && cameraCtrl && lastFraming) {
    cameraCtrl.configureForScore(lastFraming.contentMinY, lastFraming.contentMaxY);
    if (lastFraming.firstNote) {
      cameraCtrl.snapToTarget(new THREE.Vector3(lastFraming.firstNote.x, lastFraming.firstNote.y, 0));
    }
  }
  ctx.markDirty();
}

function handleDispose() {
  ctx.loop.stop();
  ctx.host.dispose();
  if (ctx.controls) { ctx.controls.dispose(); ctx.controls = null; }
  ctx.antiAliasing.dispose();
  if (ctx.renderer) { ctx.renderer.dispose(); ctx.renderer = null; }
  ctx.keyLightRig.resetCounters();
  ctx.keyLightRig.resetSnap();
  ctx.lod.clear();
}

function handleStatsReset() {
  ctx.frameStats.resetSessionCounters();
  ctx.eventLog.clear();
}

function handleResetFrameWindow() {
  ctx.frameStats.resetSampleWindow();
}

function handleVisibility({ state }) {
  const s = String(state || 'visible');
  if (s === 'hidden') {
    ctx._pageHidden = true;
    ctx._hiddenSince = performance.now();
  } else {
    // visible (or anything else)
    const now = performance.now();
    ctx._pageHidden = false;
    ctx._lastHiddenDurationMs = ctx._hiddenSince > 0 ? (now - ctx._hiddenSince) : 0;
    ctx._visibleAt = now;
    ctx._hiddenSince = 0;
  }
}

/** Read-back hook used by tests: returns a small snapshot of camera +
 *  animation state so the main thread can verify wiring (e.g. that
 *  forwarded pointer events are actually driving OrbitControls). */
function handleProbe({ id }) {
  const { host, clock, frameStats, quality, keyLightRig, lod, antiAliasing } = ctx;
  const { camera, controls, cameraCtrl, renderer } = ctx;
  const parts = frameStats.buildProbeSnapshotParts();

  // Mesh + light count in the scene graph (lights matter because each
  // one adds a loop iteration to every fragment shader).
  let meshCount = 0, instancedMeshCount = 0, totalInstances = 0, spriteCount = 0;
  let pointLightCount = 0, directionalLightCount = 0, ambientLightCount = 0;
  ctx.scene.traverse((n) => {
    if (n.isMesh) meshCount++;
    if (n.isInstancedMesh) { instancedMeshCount++; totalInstances += n.count; }
    if (n.isSprite) spriteCount++;
    if (n.isPointLight) pointLightCount++;
    if (n.isDirectionalLight) directionalLightCount++;
    if (n.isAmbientLight) ambientLightCount++;
  });
  const renderInfo = renderer?.info?.render || {};
  const memoryInfo = renderer?.info?.memory || {};
  const programList = renderer?.info?.programs;
  const pipelines = renderer?._pipelines;
  const stagePrograms = pipelines?.programs;
  const lastFraming = host.lastFraming;
  const listenerHosts = [ctx.scene, camera, controls, renderer, host.contentRoot, keyLightRig.light];
  let listenerCount = 0;
  for (const obj of listenerHosts) {
    const map = obj && obj._listeners;
    if (!map) continue;
    for (const key of Object.keys(map)) {
      const list = map[key];
      if (Array.isArray(list)) listenerCount += list.length;
    }
  }
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
        contentMinY: lastFraming ? lastFraming.contentMinY : null,
        contentMaxY: lastFraming ? lastFraming.contentMaxY : null,
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
      antiAliasing: {
        mode: antiAliasing.mode,
        msaaSamples: antiAliasing.msaaSamples,
        fxaaSuppressed: antiAliasing.suppressed,
      },
      render: {
        ...parts.render,
        compiling: host.compiling,
        dirty: ctx.loop.dirty,
      },
      frame: parts.frame,
      jitter: parts.jitter,
      cameraJitter: parts.cameraJitter,
      scene: {
        meshCount, instancedMeshCount, totalInstances, spriteCount,
        pointLights: pointLightCount,
        directionalLights: directionalLightCount,
        ambientLights: ambientLightCount,
        childCount: ctx.scene?.children?.length || 0,
        contentChildren: host.contentRoot?.children?.length || 0,
        drawCalls: renderInfo.calls || 0,
        triangles: renderInfo.triangles || 0,
        geometries: memoryInfo.geometries || 0,
        textures: memoryInfo.textures || 0,
        programs: Array.isArray(programList) ? programList.length : null,
        pipelines: pipelines?.caches?.size ?? null,
        stagePrograms: stagePrograms
          ? (stagePrograms.vertex?.size || 0) + (stagePrograms.fragment?.size || 0) + (stagePrograms.compute?.size || 0)
          : null,
        geometryCache: host.builder?._geometryCache?.size || 0,
        instanceBytes: instanceBytesOutstanding(),
        gpuTrackedMeshes: ctx.gpuDisposal?.trackedMeshes ?? 0,
        gpuTrackedObjects: ctx.gpuDisposal?.trackedObjects ?? 0,
        listeners: listenerCount,
        eventLog: ctx.eventLog?.size || 0,
        backend: renderer?.isWebGPURenderer ? 'webgpu' : 'webgl',
      },
      quality: {
        probeMs: quality.probeMs,
        sceneProbeMs: quality.sceneProbeMs,
        sceneGpuMs: quality.sceneGpuMs,
        shadowMapSize: quality.chosenShadowMapSize,
        pixelRatio: renderer && renderer.getPixelRatio ? renderer.getPixelRatio() : 0,
        pressure: quality.pressure,
        baselineMs: quality.baselineMs,
        displayMs: quality.displayMs,
        calibrated: quality.calibrated,
        chunking: OPTIMIZATIONS.CHUNK_BUCKETS_BY_X,
        shadowUpdates: keyLightRig.shadowUpdates,
        shadowThrottled: keyLightRig.shadowThrottled,
        shadowFrozen: keyLightRig.frozen,
      },
      lod: {
        managed: lod.managedCount,
        hidden: lod.hiddenCount,
        hiddenDetail: lod.hiddenDetailCount,
        nearHidden: lod.nearHiddenCount,
        lastDistance: lod.lastDistance,
        focusX: lod.lastFocus,
        effectiveThreshold: lod.effectiveThreshold,
        reach: lod.reach,
        reachCap: lod.reachCap,
        headroom: lod.headroom,
        mode: lod.mode,
        detailFraction: lod.detailVisibleFraction,
        castersHidden: lod.castersHidden,
      },
    },
  });
}
