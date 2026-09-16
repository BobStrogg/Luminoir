import * as THREE from 'three';
import { SceneConfig } from '../rendering/SceneConfig.js';
import { Materials } from '../rendering/Materials.js';
import { OPTIMIZATIONS } from '../rendering/Optimizations.js';

/**
 * A single light ball: sphere mesh + point light + glow sprite.
 */
export class LightBall {
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
   * Per-frame update: position + all three visual factors in one call
   * so the hot loop triggers `_applyVisuals()` exactly once per ball
   * per frame instead of once per setter.  The glow-visibility cutoff
   * matches `setGlowMod` (effectively-off mods skip the draw call).
   */
  applyFrame(x, y, z, scale, intensity, glowMod) {
    this.setPosition(x, y, z);
    this._scale = scale;
    this._intensity = intensity;
    this._glowMod = glowMod;
    this._glow.visible = this._mesh.visible && glowMod > 0.02;
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
