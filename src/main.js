import { LuminoirApp } from './LuminoirApp.js';
import { initControls } from './ui/Controls.js';
import { SettingsPanel } from './ui/SettingsPanel.js';

/**
 * Entry point — bootstraps the Luminoir WebGPU app.
 */
async function main() {
  const canvas = document.getElementById('scene-canvas');
  const loadingText = document.getElementById('loading-text');
  const setStatus = (msg) => {
    if (loadingText) loadingText.textContent = msg;
  };

  // Construct SettingsPanel BEFORE LuminoirApp.  The constructor
  // synchronously hydrates `SceneConfig` from localStorage so the
  // first scene build (inside `app.init`) sees the user's persisted
  // preferences (notation visibility, camera framing, …) without
  // any visible flash of defaults.  The UI itself doesn't render
  // until `attach()` runs after `app.init` resolves.
  const settingsPanel = new SettingsPanel();

  const app = new LuminoirApp();
  window.__luminoirApp = app; // expose for debugging
  /**
   * Drag the camera to a position you like, then run
   * `__captureCameraDefaults()` in the console.  Prints values to
   * paste into `SceneConfig.camera` so the next score load starts
   * from the same view.  Reverses the `snapToTarget` formula:
   *   pitchDegrees = atan(camera.y / dz) where dz = camera.z - target.z
   *   chaseRatio   = (target.x - camera.x) / dz
   *   contentHeadroom factor multiplies the auto-fit distance, so
   *     newHeadroom = currentHeadroom * (newDz / oldContentDistance).
   *     We assume the codebase default headroom (1.0) was active when
   *     the worker computed `contentDistance`.
   */
  window.__captureCameraDefaults = async () => {
    const snap = await app.render.probe();
    const derived = deriveCameraDefaults(snap);
    if (!derived) return null;
    console.log('[Luminoir] Capture:', derived);
    console.log('[Luminoir] Raw:', { camera: snap.cameraPos, target: snap.targetPos, framing: snap.framing });
    return derived;
  };
  /**
   * Floating overlay that polls `probe()` every ~200 ms and prints the
   * derived `pitchDegrees` / `chaseRatio` / `contentHeadroom` live.
   * Drag the camera; the values update as you drag.  Toggle with
   * `__showCameraOverlay()` again or with the `?cam=1` URL param.
   */
  window.__showCameraOverlay = () => toggleCameraOverlay();
  if (new URLSearchParams(window.location.search).get('cam') === '1') {
    // Defer until app is ready so the probe round-trip succeeds.
    queueMicrotask(() => toggleCameraOverlay());
  }
  initControls(app);

  function deriveCameraDefaults(snap) {
    if (!snap || !snap.cameraPos || !snap.targetPos) return null;
    const [cx, cy, cz] = snap.cameraPos;
    const [tx, ty, tz] = snap.targetPos;
    const dz = cz - tz;
    if (dz <= 0) return null;
    const pitchDegrees = (Math.atan2(cy - ty, dz) * 180) / Math.PI;
    const chaseRatio = (tx - cx) / dz;
    const out = { pitchDegrees, chaseRatio };
    if (snap.framing && snap.framing.contentDistance) {
      out.contentHeadroom = dz / snap.framing.contentDistance;
    }
    return out;
  }

  let _camOverlayDiv = null;
  let _camOverlayTimer = 0;
  function toggleCameraOverlay() {
    if (_camOverlayDiv) {
      clearInterval(_camOverlayTimer);
      _camOverlayDiv.remove();
      _camOverlayDiv = null;
      return;
    }
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;background:rgba(0,0,0,0.85);color:#7CFC9C;font:12px/1.4 monospace;padding:8px 14px;border:1px solid #444;border-radius:8px;pointer-events:none;white-space:pre;';
    div.textContent = 'Camera: probing…';
    document.body.appendChild(div);
    _camOverlayDiv = div;
    const tick = async () => {
      try {
        const snap = await app.render.probe();
        const d = deriveCameraDefaults(snap);
        if (!d) { div.textContent = 'Camera: out of formula range (orbit back behind score)'; return; }
        const lines = [
          `pitchDegrees:    ${d.pitchDegrees.toFixed(1)}°`,
          `chaseRatio:      ${d.chaseRatio.toFixed(2)}`,
        ];
        if (d.contentHeadroom != null) lines.push(`contentHeadroom: ${d.contentHeadroom.toFixed(2)}`);
        div.textContent = lines.join('\n');
      } catch (err) {
        div.textContent = 'Camera: probe error — ' + err.message;
      }
    };
    tick();
    _camOverlayTimer = setInterval(tick, 200);
  }

  try {
    await app.init(canvas, setStatus);
    console.log(
      `[Luminoir] Ready — renderer: ${app.render.rendererKind}`,
    );

    // Now that the worker is alive and the first scene is built,
    // render the panel UI and sync live-applyable settings to the
    // worker's `SceneConfig` copy.
    const gearBtn = document.getElementById('btn-settings');
    const popover = document.getElementById('settings-popover');
    if (gearBtn && popover) {
      settingsPanel.attach(app, gearBtn, popover);
    }
  } catch (err) {
    console.error('[Luminoir] Initialization failed:', err);
    setStatus(`Error: ${err.message}`);
  }
}

main();
