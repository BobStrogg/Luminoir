/**
 * Main-thread client for the render worker.
 *
 * Exposes the subset of the old `Scene3D` API that `LuminoirApp` uses,
 * but internally posts messages to `renderWorker.js` running on its own
 * thread.  All rendering, scene building, and per-frame animation math
 * happens in the worker — the main thread only:
 *
 *   1. holds the DOM <canvas> placeholder and captures pointer / wheel
 *      / touch events that it forwards to the worker for OrbitControls,
 *   2. sends playback clock anchors whenever state changes so the
 *      worker can derive its own per-frame music time without per-frame
 *      postMessage traffic,
 *   3. sends parsed score data (a serialisable JSON blob produced by
 *      `SVGSceneParser`) whenever a new score loads.
 */
export class RenderClient {
  /** @type {Worker|null} */
  _worker = null;
  /** @type {HTMLCanvasElement|null} */
  _canvas = null;
  /** @type {'WebGPU'|'WebGL'|'unknown'} */
  _rendererKind = 'unknown';
  _readyResolve = null;
  _onResize = null;
  /** Optional consumer callback for periodic worker `stats` posts —
   *  used by the FPS-badge UI to update twice a second.  Setter is
   *  exposed as a public field so callers can `client.onStats = fn`
   *  any time after `init()`. */
  onStats = null;
  /** Exposed so LuminoirApp can log renderer kind on startup. */
  get rendererKind() { return this._rendererKind; }

  /**
   * Transfer the canvas to a worker, spin up the render loop.
   * @param {HTMLCanvasElement} canvas
   */
  async init(canvas) {
    this._canvas = canvas;
    const offscreen = canvas.transferControlToOffscreen();
    this._worker = new Worker(new URL('./renderWorker.js', import.meta.url), {
      type: 'module',
    });
    this._worker.onmessage = (e) => this._onWorkerMessage(e.data);

    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;

    const readyPromise = new Promise((res) => { this._readyResolve = res; });

    // Honour `?renderer=webgl` so developers can reproduce the
    // WebGL-only bugs users hit on insecure-origin URLs (e.g. a
    // `*.local` hostname) without actually moving off `localhost`.
    const forceWebGL = new URLSearchParams(window.location.search).get('renderer') === 'webgl';

    this._worker.postMessage({
      type: 'init',
      canvas: offscreen,
      width,
      height,
      devicePixelRatio,
      rect: rectFor(canvas),
      forceWebGL,
    }, [offscreen]);

    // Handle window resize on main, forward to worker.
    this._onResize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      this._worker.postMessage({
        type: 'resize',
        width: w,
        height: h,
        devicePixelRatio: window.devicePixelRatio || 1,
        rect: rectFor(canvas),
      });
    };
    window.addEventListener('resize', this._onResize);

    attachPointerForwarding(canvas, this._worker);

    await readyPromise;
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._rendererKind = msg.renderer;
        if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; }
        break;
      case 'stats':
        // Periodic worker heartbeat — forward to the FPS badge if
        // someone subscribed.  Other consumers are free to chain
        // their own callbacks; we only support one for now.
        if (typeof this.onStats === 'function') this.onStats(msg);
        break;
      case 'sceneReady':
        // The new score's first frame has hit the canvas.  Fired
        // exactly once per `buildScene`/`setTimeline` cycle.
        if (typeof this.onSceneReady === 'function') this.onSceneReady();
        break;
      case 'probe': {
        const resolver = this._probes.get(msg.id);
        if (resolver) {
          resolver(msg.snapshot);
          this._probes.delete(msg.id);
        }
        break;
      }
    }
  }

  _probes = new Map();
  _probeCounter = 0;

  /** Round-trip a message to the worker and get a snapshot of camera
   *  state.  Useful for verifying event-forwarding from tests. */
  probe() {
    const id = ++this._probeCounter;
    return new Promise((res) => {
      this._probes.set(id, res);
      this._worker.postMessage({ type: 'probe', id });
    });
  }

  /** Send a freshly-parsed score to the worker to mesh. */
  buildScene(parsedScene) {
    this._worker.postMessage({ type: 'buildScene', parsed: parsedScene });
  }

  /**
   * Push the note timeline so the worker-side camera + light-ball
   * controllers can position themselves.
   *
   * `firstNote` is used for the initial camera snap — it's optional
   * since the worker will clamp to xs[0] if omitted.
   */
  setTimeline(timeline, contentMinY, contentMaxY, firstNote) {
    this._worker.postMessage({
      type: 'setTimeline',
      timeline,
      contentMinY,
      contentMaxY,
      firstNote,
    });
  }

  /** Request an immediate camera snap (no spring) to (x, y). */
  snapCameraTo(x, y) {
    this._worker.postMessage({ type: 'snapCamera', x, y });
  }

  /**
   * Send a playback clock anchor.  The worker computes its per-frame
   * music time from its own performance.now() against this anchor, so
   * there's zero main-thread traffic during playback.
   * @param {'playing'|'paused'|'stopped'} state
   * @param {number} musicTime seconds of music
   * @param {number} tempoScale
   */
  setClock(state, musicTime, tempoScale = 1) {
    this._worker.postMessage({ type: 'clock', state, musicTime, tempoScale });
  }

  /**
   * Push a flat dot-path map of `SceneConfig` updates to the worker.
   *
   * Used by the settings panel to apply live config changes (camera
   * pitch, light-ball brightness, audio-visual offset, …) without
   * requiring a full score reload.  Each key is a dot-path into the
   * worker's `SceneConfig` and the value is what to assign at that
   * leaf — see `handleUpdateConfig` in `renderWorker.js` for the
   * supported keys and which trigger a camera re-snap.
   *
   * @param {Record<string, any>} updates
   */
  updateConfig(updates) {
    if (!this._worker || !updates) return;
    this._worker.postMessage({ type: 'updateConfig', updates });
  }

  dispose() {
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._worker) {
      this._worker.postMessage({ type: 'dispose' });
      this._worker.terminate();
      this._worker = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Pointer / wheel / touch forwarding                                 */
/* ------------------------------------------------------------------ */

function rectFor(el) {
  const r = el.getBoundingClientRect();
  return {
    left: r.left, top: r.top, width: r.width, height: r.height,
    right: r.right, bottom: r.bottom,
  };
}

/**
 * Capture pointer / wheel events on the canvas element and forward
 * a serialisable payload to the worker.
 *
 * Modern Three.js OrbitControls attaches its `pointermove` / `pointerup`
 * listeners to the canvas element itself (relying on `setPointerCapture`
 * to keep the event stream flowing even if the pointer leaves the
 * canvas).  Inside the worker we can't do real pointer capture, so we
 * listen at `window`-scope on the main thread and forward every
 * pointermove / pointerup there as an `'element'`-targeted event —
 * the worker's `ElementProxy` re-dispatches on itself and OrbitControls
 * sees a natural-looking event stream.
 */
function attachPointerForwarding(canvas, worker) {
  const post = (target, ev) => {
    worker.postMessage({
      type: 'pointer',
      target,
      payload: eventPayload(ev),
    });
  };

  // Canvas-only events: press-down, gesture cancel, wheel, contextmenu.
  const onCanvas = ['pointerdown', 'pointercancel', 'wheel', 'contextmenu'];
  for (const type of onCanvas) {
    canvas.addEventListener(type, (ev) => {
      // Stop the browser's default for gestures OrbitControls wants.
      if (type === 'wheel' || type === 'contextmenu') ev.preventDefault();
      post('element', ev);
    }, { passive: type !== 'wheel' && type !== 'contextmenu' });
  }

  // Track active pointer IDs so multi-touch gestures (pinch-zoom)
  // forward every pointerup to the worker.  A boolean flag only
  // recorded "something is down"; the first pointerup cleared it and
  // swallowed subsequent ups — OrbitControls then never saw the second
  // finger lift, leaving it stuck in the two-finger (zoom) state and
  // blocking future single-finger rotation.
  const activePointers = new Set();
  canvas.addEventListener('pointerdown', (ev) => { activePointers.add(ev.pointerId); });
  window.addEventListener('pointerup', (ev) => {
    if (activePointers.has(ev.pointerId)) {
      activePointers.delete(ev.pointerId);
      post('element', ev);
    }
  });
  window.addEventListener('pointermove', (ev) => {
    if (activePointers.has(ev.pointerId)) post('element', ev);
  });

  // Touch fallback for browsers without pointer events (mostly older
  // Safari).  Same capture logic as pointer events.
  let touching = false;
  canvas.addEventListener('touchstart', (ev) => {
    touching = true;
    post('element', ev);
  }, { passive: true });
  canvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    post('element', ev);
  }, { passive: false });
  const endTouch = (ev) => {
    if (touching) {
      touching = false;
      post('element', ev);
    }
  };
  canvas.addEventListener('touchend', endTouch, { passive: true });
  canvas.addEventListener('touchcancel', endTouch, { passive: true });
}

function eventPayload(ev) {
  /** @type {any} */
  const p = {
    type: ev.type,
    clientX: ev.clientX, clientY: ev.clientY,
    pageX: ev.pageX, pageY: ev.pageY,
    deltaX: ev.deltaX, deltaY: ev.deltaY, deltaZ: ev.deltaZ,
    deltaMode: ev.deltaMode,
    button: ev.button, buttons: ev.buttons,
    ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey,
    altKey: ev.altKey, metaKey: ev.metaKey,
    pointerId: ev.pointerId, pointerType: ev.pointerType,
    isPrimary: ev.isPrimary,
  };
  if (ev.touches)        p.touches        = touchList(ev.touches);
  if (ev.changedTouches) p.changedTouches = touchList(ev.changedTouches);
  if (ev.targetTouches)  p.targetTouches  = touchList(ev.targetTouches);
  return p;
}

function touchList(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    out.push({
      identifier: t.identifier,
      clientX: t.clientX, clientY: t.clientY,
      pageX: t.pageX, pageY: t.pageY,
    });
  }
  return out;
}
