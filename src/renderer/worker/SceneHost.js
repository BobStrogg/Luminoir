import * as THREE from 'three';
import { LightBallController } from '../../animation/LightBallController.js';
import { OPTIMIZATIONS } from '../../rendering/Optimizations.js';

/**
 * Owns the scene graph (`scene`, `contentRoot`), the score builder,
 * the light-ball controller, and the compile/sceneReady handshake
 * state that spans the `buildScene` → `setTimeline` → precompile
 * message sequence.
 */
export class SceneHost {
  /** @type {THREE.Scene} */
  scene = new THREE.Scene();
  /**
   * Parent group for every score-related object.  Rotated -π/2 around X
   * once, here, so the score builds in its natural SVG-flat coordinate
   * system while the world sees it lying on the floor:
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
  contentRoot = new THREE.Group();
  /** @type {import('../../rendering/SVG3DBuilder.js').SVG3DBuilder | null} */
  builder = null;
  /** @type {LightBallController | null} */
  lightBalls = null;

  /** Scene-build payload held between buildScene and the precompile
   *  call in setTimeline.  We defer the precompile until the light
   *  balls have been added to the scene (during setTimeline), so that
   *  `compileAsync` walks a scene that already contains every object
   *  the main loop is ever going to render.  Without this deferral the
   *  light balls' pipelines get compiled inline on the first post-compile
   *  frame — a 100-200 ms stall visible as the first-note stutter.
   *  @type {{ root: any, parsed: any } | null} */
  _pendingPrecompile = null;

  /** One-shot flag set when the scene rebuild + precompile finishes,
   *  cleared the very next time `renderer.render()` puts a frame on
   *  the canvas.  When it transitions from `true → false` we post a
   *  `sceneReady` message so the main thread can hide its loading
   *  spinner exactly when the new score becomes visible — not at the
   *  earlier moment when `setTimeline` returned (which leaves the
   *  spinner overlapping a still-empty canvas for ≈ 100-200 ms while
   *  precompile runs and the GPU uploads). */
  _postSceneReadyAfterRender = false;

  /** Set to `true` while we're pre-compiling pipelines for a freshly-
   *  built scene.  We pause normal rendering during that window so a
   *  mid-compile `renderer.render()` doesn't trigger slow inline
   *  pipeline creation. */
  _compiling = false;

  /** Cached score-framing inputs.  Populated by `setTimeline`,
   *  consumed by `handleUpdateConfig` when a camera-affecting setting
   *  changes — without this cache we'd have to ask the main thread to
   *  resend the whole note timeline just to re-snap the camera. */
  _lastFraming = null;

  /**
   * @param {object} ctx Shared worker context — reads `keyLightRig`,
   *   `frameStats`, `lod`, `colorizer`, `quality`, `antiAliasing`,
   *   `renderer`, `camera` and `markDirty` lazily.
   */
  constructor(ctx) {
    this._ctx = ctx;
    this.contentRoot.rotation.x = -Math.PI / 2;
  }

  get compiling() { return this._compiling; }
  get lastFraming() { return this._lastFraming; }

  buildScene(parsed, cameraCtrl) {
    const { keyLightRig, frameStats, lod, colorizer } = this._ctx;
    // Hold rendering for the entire build → setTimeline → precompile
    // sequence.  The main loop checks `_compiling` and skips
    // `renderer.render()` while it's true, so there's no risk of a
    // transient frame with half-built state or missing lights.
    this._compiling = true;
    keyLightRig.resetCounters();
    keyLightRig.resetSnap();
    frameStats.resetJitter();

    // Remove previous content.  We don't dispose the InstancedMesh
    // geometries / materials because they're cached inside the builder
    // and shared across score loads — disposing them here would leave
    // the cache pointing at zombie GPU buffers that the next
    // `builder.build()` would unwittingly re-use, producing the
    // characteristic "stray glyphs drawn in the wrong place" bug.
    // The only per-scene resource in the tree is the paper backdrop,
    // which we dispose by hand below.
    while (this.contentRoot.children.length) {
      const child = this.contentRoot.children[0];
      this.contentRoot.remove(child);
      this.disposePerSceneResources(child);
    }
    const { root, noteMeshMap } = this.builder.build(parsed);
    this.contentRoot.add(root);
    // Collect the LOD-tagged meshes for the runtime visibility pass
    // (LOD_DISTANT_ELEMENTS / DISTANCE_CLIP_GLYPHS).
    lod.collect(root);
    // Constrained platforms: fit the shadow frustum to the whole score
    // once — every caster is static, so the map renders a single time
    // (during the precompile warm-up, under the loading overlay) and
    // never again during playback.
    if (keyLightRig.frozen) keyLightRig.fitToScore(parsed);
    colorizer.setScene(noteMeshMap);

    // Create / reset light balls for this score.  `setEvents()` below
    // (called from setTimeline) actually populates the scene
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
    if (this.lightBalls) this.lightBalls.dispose();
    this.lightBalls = new LightBallController(this.contentRoot);
    // Forward chord-arrival events to the smart camera so its
    // exponentially-decaying activity counter rises and falls in
    // sync with what the user actually hears.  Cheap (just a Map
    // mutation per chord) and only fires while playing — see the
    // guards in `LightBallController.update`.
    this.lightBalls.onBeatGroupHit = (staff, chordSize) => {
      if (cameraCtrl) cameraCtrl.recordBeatGroupHit(staff, chordSize);
    };

    // Precompile is deferred to setTimeline — the scene isn't
    // in its final state yet (no light balls).
    this._pendingPrecompile = { root, parsed };
  }

  setTimeline({ timeline, contentMinY, contentMaxY, firstNote }, cameraCtrl) {
    const { colorizer, quality, markDirty } = this._ctx;
    if (this.lightBalls) this.lightBalls.setEvents(timeline);
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
    this._lastFraming = { contentMinY, contentMaxY, firstNote };
    markDirty();

    // Staff → colour map + played-note cursor (see PlayedNoteColorizer
    // for why the assignment order matches the light balls).
    colorizer.setTimeline(timeline);

    // Scene is now final (content + light balls + camera position).
    // Run the precompile here, not in buildScene, so that
    // `compileAsync` sees the complete lights/meshes list and no
    // inline pipeline compilation happens on the first rendered frame.
    if (this._pendingPrecompile) {
      const { root } = this._pendingPrecompile;
      this._pendingPrecompile = null;
      if (OPTIMIZATIONS.PRECOMPILE_PIPELINES) {
        quality.refineSceneQuality()
          .catch((err) => console.warn('[renderWorker] Scene quality probe failed:', err))
          .then(() => this.precompilePipelines(root));
      } else {
        // Precompile disabled — release the render gate set in
        // buildScene so the main loop can draw the new scene.
        quality.refineSceneQuality()
          .catch((err) => console.warn('[renderWorker] Scene quality probe failed:', err))
          .finally(() => {
            this._compiling = false;
            markDirty();
            // Arm sceneReady so the next render notifies the main thread,
            // matching the behaviour of the precompile path.
            this._postSceneReadyAfterRender = true;
          });
      }
    }
  }

  /**
   * Force the renderer to compile every mesh's pipeline up-front,
   * regardless of whether it would be frustum-culled at the current
   * camera position.  Uses `renderer.compileAsync` when available
   * (WebGPU) or falls back to a synchronous `renderer.compile` on
   * WebGL.
   */
  precompilePipelines(root) {
    const { renderer, camera, antiAliasing, markDirty } = this._ctx;
    const scene = this.scene;
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
      this._compiling = false;
      // Scene was just swapped underneath us — mark dirty so the
      // first post-compile frame actually renders the new score
      // (otherwise the idle-gate might skip if nothing else has
      // marked the scene dirty since the rebuild started).
      markDirty();
      // Arm the sceneReady postMessage; the next successful render
      // (which will be the first frame of the new score) clears the
      // flag and notifies the main thread.
      this._postSceneReadyAfterRender = true;
    };
    this._compiling = true;
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
          antiAliasing.render(renderer, scene, camera);
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

  /** Returns true exactly once after the post-precompile render has
   *  been armed — the render loop turns it into the `sceneReady`
   *  postMessage. */
  consumeSceneReady() {
    if (!this._postSceneReadyAfterRender) return false;
    this._postSceneReadyAfterRender = false;
    return true;
  }

  disposePerSceneResources(obj) {
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

  dispose() {
    if (this.lightBalls) { this.lightBalls.dispose(); this.lightBalls = null; }
    // Clear per-scene colouring state so a subsequent `init` starts clean.
    this._ctx.colorizer.clear();
    this._lastFraming = null;
    this._pendingPrecompile = null;
    this._postSceneReadyAfterRender = false;
  }
}
