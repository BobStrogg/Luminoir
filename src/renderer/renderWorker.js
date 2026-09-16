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
// Convenience alias — the scene itself lives on the host.
ctx.scene = ctx.host.scene;

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

/* ------------------------------------------------------------------ */
/*  Init                                                                */
/* ------------------------------------------------------------------ */

async function handleInit({ canvas, width, height, devicePixelRatio, rect, forceWebGL, shadowEnabled, dtSmoothAlpha, smartCameraEnabled, lookAheadSeconds, smoothTime }) {
  // SceneConfig is mirrored in the worker; set the runtime flags
  // from the main thread before the renderer is configured.
  SceneConfig.shadow.enabled = shadowEnabled !== false;
  if (typeof dtSmoothAlpha === 'number') SceneConfig.dtSmoothAlpha = dtSmoothAlpha;
  if (typeof smartCameraEnabled === 'boolean') SceneConfig.smartCamera.enabled = smartCameraEnabled;
  if (typeof lookAheadSeconds === 'number') SceneConfig.camera.lookAheadSeconds = lookAheadSeconds;
  if (typeof smoothTime === 'number') SceneConfig.camera.smoothTime = smoothTime;
  // Mobile devices (iOS Safari especially) sit right on the edge of
  // the per-frame budget at desktop quality, and the OS halves the
  // rAF rate the moment a frame goes over.  Trim shadow / DPR /
  // antialias here so dense passages stay under 16.67 ms.
  const { isMobile, isSafari, isTesla, isConstrained } = detectPlatform();

  // MSAA on TBDR mobile GPUs costs significant memory bandwidth per
  // frame; turning it off is one of the bigger single-knob wins on
  // iOS.  Desktop keeps the antialias for crisp notation edges.
  const wantAntialias = !isMobile && !isTesla;
  const { renderer, usingWebGPU, error } = await createRenderer(
    { canvas, forceWebGL, antialias: wantAntialias });
  if (!renderer) {
    ctx.post({
      type: 'renderer_error',
      message: error?.message ?? 'WebGL context creation failed',
    });
    return;
  }
  ctx.renderer = renderer;

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
  // Cap DPR more aggressively on mobile — a Retina iPhone reports
  // DPR 3, which triples fragment-shader work for very little visual
  // gain on a 6" screen showing the entire score.
  const dprCap = isMobile ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
  renderer.setSize(width, height, false); // false = don't set style; we're off-DOM
  renderer.setClearColor(SceneConfig.backgroundColor, 1);
  ctx.viewportHeightCss = height;

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
  renderer.shadowMap.enabled = SceneConfig.shadow.enabled;
  renderer.shadowMap.type = isMobile
    ? THREE.PCFShadowMap
    : THREE.PCFSoftShadowMap;

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
  controls.enableDamping = false;  // CameraController drives via sphericalDelta
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

  // Save base light intensity so the runtime pressure system can scale it.
  ctx.quality.baseLightIntensity = SceneConfig.lightBall.intensity;

  await ctx.antiAliasing.setup(renderer, ctx.scene, camera, usingWebGPU, width, height);

  // Load-time GPU probe — renders the empty scene (lights + paper, no score
  // geometry) and uses the measured cost to select the highest shadow-map
  // resolution the GPU can sustain within half the per-frame budget.
  // Awaited here (the GPU-sync fences are async), while the score worker is
  // busy with Verovio WASM, so it adds no perceptible latency to load time.
  const baseDpr = devicePixelRatio || 1;
  ctx.quality.baseDevicePixelRatio = baseDpr;
  ctx.quality.runSceneProbe = isMobile || isSafari || isTesla;
  ctx.quality.allowVeryLowQuality = isConstrained;
  ctx.quality.sceneGpuBudgetMs = 14;
  const probeMs = await ctx.quality.probeGpuCost(5);
  ctx.quality.probeMsMeasured = probeMs;
  ctx.quality.applyLoadTimeQuality(probeMs, baseDpr, isConstrained);

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
  });

  ctx.loop.start();
}

/* ------------------------------------------------------------------ */
/*  Resize / pointer                                                    */
/* ------------------------------------------------------------------ */

function handleResize({ width, height, devicePixelRatio, rect }) {
  const { renderer, camera, elementProxy, antiAliasing, quality, lod } = ctx;
  if (!renderer || !camera) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  // Respect the DPR cap chosen by the load-time GPU probe — the old
  // hardcoded `min(dpr, 2)` silently undid the probe's choice on the
  // first window resize, putting weak GPUs right back at full
  // resolution.
  const dprCap = quality.chosenDprCap > 0 ? quality.chosenDprCap : 2;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
  renderer.setSize(width, height, false);
  antiAliasing.resize(renderer, width, height);
  ctx.viewportHeightCss = height;
  lod.invalidate(); // viewport changed → pixel sizes changed → re-evaluate LOD
  if (elementProxy) elementProxy.setRect(rect);
  ctx.markDirty();
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

function handleClock({ state, musicTime, tempoScale }) {
  const { clock, host, quality, frameStats } = ctx;
  clock.set(state, musicTime, tempoScale);
  if (state === 'playing') {
    if (host.lightBalls) host.lightBalls.play();
    // Reset the baseline calibration so it re-measures from the first
    // frames of this play session — not from stale idle-period rAF ticks.
    quality.resetCalibration();
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
    if (path === 'shadow.enabled') keyLightRig.applyShadowEnabled(renderer);
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
  const lastFraming = host.lastFraming;
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
        drawCalls: renderInfo.calls || 0,
        triangles: renderInfo.triangles || 0,
      },
      quality: {
        probeMs: quality.probeMs,
        sceneProbeMs: quality.sceneProbeMs,
        shadowMapSize: quality.chosenShadowMapSize,
        dprCap: quality.chosenDprCap,
        pixelRatio: renderer && renderer.getPixelRatio ? renderer.getPixelRatio() : 0,
        pressure: quality.pressure,
        baselineMs: quality.baselineMs,
        calibrated: quality.calibrated,
        chunking: OPTIMIZATIONS.CHUNK_BUCKETS_BY_X,
        shadowUpdates: keyLightRig.shadowUpdates,
        shadowThrottled: keyLightRig.shadowThrottled,
      },
      lod: {
        managed: lod.managedCount,
        hidden: lod.hiddenCount,
        lastDistance: lod.lastDistance,
        effectiveThreshold: lod.effectiveThreshold,
      },
    },
  });
}
