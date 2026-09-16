import { OPTIMIZATIONS } from '../../rendering/Optimizations.js';

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
export class LodGate {
  /** Meshes carrying LOD tags (`userData.lodSize` / `userData.lodDetail`)
   *  collected once per scene build by `collect`.  Kept as a
   *  flat array so the per-frame pass doesn't re-traverse the graph. */
  _lodMeshes = [];
  /** Camera-to-target distance at the last LOD evaluation; -1 forces a
   *  re-evaluation (scene rebuild, resize, DPR change). */
  _lodLastDistance = -1;

  get managedCount() { return this._lodMeshes.length; }
  get hiddenCount() { return this._lodMeshes.reduce((n, m) => n + (m.visible ? 0 : 1), 0); }
  get lastDistance() { return this._lodLastDistance; }

  /** Collect the LOD-managed meshes from a freshly-built scene root.
   *  Called from SceneHost.buildScene after the root is attached. */
  collect(root) {
    this._lodMeshes.length = 0;
    this._lodLastDistance = -1;
    if (!OPTIMIZATIONS.LOD_DISTANT_ELEMENTS && !OPTIMIZATIONS.DISTANCE_CLIP_GLYPHS) return;
    root.traverse((n) => {
      if (n.isMesh && n.userData && (n.userData.lodSize > 0 || n.userData.lodDetail)) {
        this._lodMeshes.push(n);
      }
    });
  }

  /** Force re-evaluation on the next `apply` (viewport/DPR changed). */
  invalidate() {
    this._lodLastDistance = -1;
  }

  clear() {
    this._lodMeshes.length = 0;
    this._lodLastDistance = -1;
  }

  /**
   * Evaluate the LOD rules for the current camera distance.
   * @returns {boolean} true when at least one mesh's visibility
   *   toggled — the caller should mark the frame dirty.
   */
  apply(camera, controls, pixelRatio, viewportHeightCss) {
    if (this._lodMeshes.length === 0 || !camera || !controls) return false;
    const d = camera.position.distanceTo(controls.target);
    if (this._lodLastDistance > 0
        && Math.abs(d - this._lodLastDistance) < this._lodLastDistance * 0.01) return false;
    this._lodLastDistance = d;

    // World units per *device* pixel at the orbit-target distance.
    const fovRad = (camera.fov * Math.PI) / 180;
    const viewportDevicePx = Math.max(1, viewportHeightCss * pixelRatio);
    const wupp = (2 * d * Math.tan(fovRad / 2)) / viewportDevicePx;

    const detailRule = OPTIMIZATIONS.LOD_DISTANT_ELEMENTS;
    const clipRule = OPTIMIZATIONS.DISTANCE_CLIP_GLYPHS;
    const T = OPTIMIZATIONS.LOD_DISTANCE_THRESHOLD || 12;

    let toggled = false;
    for (let i = 0; i < this._lodMeshes.length; i++) {
      const mesh = this._lodMeshes[i];
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
    return toggled;
  }
}
