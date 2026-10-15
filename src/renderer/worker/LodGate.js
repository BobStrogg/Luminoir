import { OPTIMIZATIONS } from '../../rendering/Optimizations.js';
import { LOD_FAR_RADIUS, LOD_NEAR_RADIUS } from '../../rendering/lodDistances.js';
import { castersSuppressedFor, stepDetailGovernor } from './qualityPolicy.js';

/**
 * Distance-ordered visibility for tagged buckets.
 *
 * Detail meshes (stems, flags, ledger lines — `userData.lodDetail`)
 * are ordered by their distance along score X from the camera target,
 * which tracks the playhead.  A chunk whose closest point lies inside
 * `LOD_NEAR_RADIUS` is never hidden, at any zoom and any pressure.
 * Chunks farther than the governor's reach hide first.  The reach
 * glides; the detail shader fades the last couple of world units so a
 * chunk does not pop.
 *
 * Sub-pixel culling (`DISTANCE_CLIP_GLYPHS`) applies only to non-detail
 * glyphs, and only outside the near field.  Stem width is a fraction of
 * a notehead, so a thin-axis test used to drop every stem — including
 * the ones under the camera — as soon as the view zoomed out modestly.
 *
 * Detail buckets are split along X even when global chunking is off, so
 * a single score-wide mesh cannot hide the playhead stem along with the
 * distant ones.  Visibility toggles do not recompile pipelines.
 */
export class LodGate {
  /** Meshes carrying LOD tags (`userData.lodSize` / `userData.lodDetail`)
   *  collected once per scene build by `collect`.  Kept as a
   *  flat array so the per-frame pass doesn't re-traverse the graph. */
  _lodMeshes = [];
  /** Camera-to-target zoom at the last evaluation; NaN forces a
   *  re-evaluation (scene rebuild, resize, reach change). */
  _lodLastZoom = NaN;
  /** Playhead X at the last evaluation. */
  _lodLastFocus = NaN;
  /** Reach (wu) at the last evaluation. */
  _lodLastReach = NaN;
  _governor = { mode: 'open', reach: LOD_FAR_RADIUS, headroom: 1 };
  /** Widest reach the load-time GPU probe could afford. */
  _reachCap = LOD_FAR_RADIUS;
  _gpuFull = 0;
  _gpuTight = 0;
  _gpuTightFraction = 1;
  /** Set at worker init for mobile/Tesla: detail meshes never cast
   *  shadows on those platforms — see `collect()`. */
  constrained = false;
  /** Whether `lodDetail` meshes are currently excluded from the shadow
   *  pass.  On constrained platforms this is permanently true (set in
   *  `collect`); elsewhere `updateCasters` toggles it under sustained
   *  runtime pressure with hysteresis. */
  _castersHidden = false;

  get managedCount() { return this._lodMeshes.length; }
  get hiddenCount() { return this._lodMeshes.reduce((n, m) => n + (m.visible ? 0 : 1), 0); }
  get hiddenDetailCount() {
    return this._lodMeshes.reduce((n, m) => n + (!m.visible && m.userData?.lodDetail ? 1 : 0), 0);
  }
  /** Hidden detail whose closest point is still inside the near field.
   *  Must stay 0 — that is the "nearby stems dropped" failure. */
  get nearHiddenCount() {
    let n = 0;
    for (const mesh of this._lodMeshes) {
      if (mesh.visible || !mesh.userData?.lodDetail) continue;
      const edge = this._nearEdge(mesh, this._lodLastFocus || 0);
      if (edge == null || edge <= LOD_NEAR_RADIUS) n++;
    }
    return n;
  }
  get lastDistance() { return Number.isFinite(this._lodLastZoom) ? this._lodLastZoom : -1; }
  get lastFocus() { return Number.isFinite(this._lodLastFocus) ? this._lodLastFocus : 0; }
  get effectiveThreshold() { return this._governor.reach; }
  get reach() { return this._governor.reach; }
  get reachCap() { return this._reachCap; }
  get headroom() { return this._governor.headroom; }
  get mode() { return this._governor.mode; }
  get castersHidden() { return this._castersHidden; }

  /** Fraction of detail instances still drawn.  1 when nothing is hidden. */
  get detailVisibleFraction() {
    let total = 0;
    let visible = 0;
    for (const mesh of this._lodMeshes) {
      if (!mesh.userData?.lodDetail) continue;
      const count = mesh.count > 0 ? mesh.count : 1;
      total += count;
      if (mesh.visible) visible += count;
    }
    return total > 0 ? visible / total : 1;
  }

  /** Collect the LOD-managed meshes from a freshly-built scene root.
   *  Called from SceneHost.buildScene after the root is attached. */
  collect(root) {
    this._lodMeshes.length = 0;
    this._lodLastZoom = NaN;
    this._lodLastFocus = NaN;
    this._lodLastReach = NaN;
    this._governor = { mode: 'open', reach: LOD_FAR_RADIUS, headroom: 1 };
    this._reachCap = LOD_FAR_RADIUS;
    this._gpuFull = 0;
    this._gpuTight = 0;
    this._gpuTightFraction = 1;
    this._castersHidden = false;
    if (!OPTIMIZATIONS.LOD_DISTANT_ELEMENTS && !OPTIMIZATIONS.DISTANCE_CLIP_GLYPHS) return;
    root.traverse((n) => {
      if (n.isMesh && n.userData && (n.userData.lodSize > 0 || n.userData.lodDetail)) {
        this._lodMeshes.push(n);
      }
    });
    // Constrained platforms: detail meshes never cast shadows at all.
    // Stems/flags/ledger lines are the most numerous instance class —
    // at 1024-2048² map resolution each casts a sub-texel sliver nobody
    // can see, but they dominate the shadow pass's primitive count.
    // Excluding them makes every periodic shadow re-render roughly
    // half the cost.  `castShadow` toggles are render-list filters,
    // not pipeline changes, so this is safe to do before precompile.
    if (this.constrained) {
      for (const mesh of this._lodMeshes) {
        if (mesh.userData.lodDetail) mesh.castShadow = false;
      }
      this._castersHidden = true;
    }
  }

  /** Force re-evaluation on the next `apply` (viewport/DPR changed). */
  invalidate() {
    this._lodLastZoom = NaN;
  }

  clear() {
    this._lodMeshes.length = 0;
    this._lodLastZoom = NaN;
    this._lodLastFocus = NaN;
    this._lodLastReach = NaN;
    this._castersHidden = false;
  }

  /** Jump the reach immediately (load-time probe).  The next `apply`
   *  cannot early-out. */
  snapGovernor(reach) {
    const cap = Math.max(LOD_NEAR_RADIUS, Math.min(LOD_FAR_RADIUS, this._reachCap));
    const r = Math.max(LOD_NEAR_RADIUS, Math.min(cap, reach));
    this._governor = {
      mode: r < cap - 0.5 ? 'tight' : 'open',
      reach: r,
      headroom: this._governor.headroom,
    };
    this._lodLastReach = NaN;
  }

  /** Do not let the runtime glide reopen past the reach that fit. */
  capReach(reach) {
    this._reachCap = Math.max(LOD_NEAR_RADIUS, Math.min(LOD_FAR_RADIUS, reach));
    if (this._governor.reach > this._reachCap) {
      this._governor = { ...this._governor, reach: this._reachCap, mode: 'tight' };
      this._lodLastReach = NaN;
    }
  }

  /** Remember the full-detail and tightened GPU costs so the runtime
   *  governor can scale headroom as detail visibility changes. */
  setGpuModel(fullMs, tightMs, tightFraction) {
    this._gpuFull = fullMs > 0 ? fullMs : 0;
    this._gpuTight = tightMs > 0 ? tightMs : 0;
    this._gpuTightFraction = Math.min(1, Math.max(0, tightFraction));
  }

  /** Estimated GPU scene cost (ms) at the current detail visibility,
   *  or 0 when shedding detail did not measurably help. */
  estimateGpuMs() {
    if (!(this._gpuFull > 0) || !(this._gpuTight > 0) || this._gpuTight >= this._gpuFull * 0.92) {
      return 0;
    }
    const span = 1 - this._gpuTightFraction;
    const f = this.detailVisibleFraction;
    if (!(span > 0.02)) return this._gpuTight;
    const t = Math.min(1, Math.max(0, (f - this._gpuTightFraction) / span));
    return this._gpuTight + (this._gpuFull - this._gpuTight) * t;
  }

  /**
   * Glide the reach from frame-cost headroom.  `active` is false while
   * paused or before any cost sample exists; the reach then holds.
   */
  stepGovernor(costP95, displayMs, dt, active) {
    this._governor = stepDetailGovernor(
      this._governor, costP95, displayMs, dt, active, this._reachCap);
    return this._governor;
  }

  /**
   * Pressure-gated shadow-caster suppression for non-constrained
   * platforms (constrained ones already dropped detail casters in
   * `collect`).  Engages once pressure reaches 0.55, restores below
   * 0.30 — pure policy lives in `qualityPolicy.castersSuppressedFor`.
   * Called every frame; the mesh pass only runs on a state change.
   */
  updateCasters(pressure) {
    if (this.constrained || this._lodMeshes.length === 0) return;
    const want = castersSuppressedFor(this._castersHidden, pressure);
    if (want === this._castersHidden) return;
    this._castersHidden = want;
    for (const mesh of this._lodMeshes) {
      if (mesh.userData.lodDetail) mesh.castShadow = !want;
    }
  }

  /** Closest-point distance along X from `focusX`, or null when the
   *  mesh has no anchor (treated as near — never hidden). */
  _nearEdge(mesh, focusX) {
    const sphere = mesh.boundingSphere;
    let x = null;
    let radius = 0;
    if (sphere && Number.isFinite(sphere.center?.x)) {
      x = sphere.center.x + (mesh.position?.x || 0);
      radius = sphere.radius > 0 ? sphere.radius : 0;
    } else if (mesh.position && Number.isFinite(mesh.position.x)) {
      x = mesh.position.x;
    }
    if (x == null) return null;
    return Math.abs(x - focusX) - radius;
  }

  /**
   * Evaluate distance-ordered LOD for the current playhead and reach.
   * @param {number} [_pressure]  Unused.  Pressure no longer shrinks a
   *   global zoom threshold (that hid every stem, including the ones
   *   at the playhead).  The reach governor owns detail distance.
   * @returns {boolean} true when at least one mesh's visibility toggled.
   */
  apply(camera, controls, pixelRatio, viewportHeightCss, _pressure = 0) {
    if (this._lodMeshes.length === 0 || !camera || !controls) return false;
    const zoom = camera.position.distanceTo(controls.target);
    const focusX = controls.target.x || 0;
    const reach = this._governor.reach;
    if (Number.isFinite(this._lodLastZoom)
        && Math.abs(zoom - this._lodLastZoom) < Math.max(0.05, this._lodLastZoom * 0.01)
        && Math.abs(focusX - this._lodLastFocus) < 0.2
        && Math.abs(reach - this._lodLastReach) < 0.15) {
      return false;
    }
    this._lodLastZoom = zoom;
    this._lodLastFocus = focusX;
    this._lodLastReach = reach;

    const fovRad = (camera.fov * Math.PI) / 180;
    const viewportDevicePx = Math.max(1, viewportHeightCss * pixelRatio);
    const wupp = (2 * zoom * Math.tan(fovRad / 2)) / viewportDevicePx;
    const detailRule = OPTIMIZATIONS.LOD_DISTANT_ELEMENTS;
    const clipRule = OPTIMIZATIONS.DISTANCE_CLIP_GLYPHS;
    // Constant sub-pixel factor.  Pressure used to raise this toward
    // 2 px, which is enough to cull a stem's thin axis everywhere.
    const subPx = 0.7;
    const subPxReshow = 0.85;

    let toggled = false;
    for (let i = 0; i < this._lodMeshes.length; i++) {
      const mesh = this._lodMeshes[i];
      const ud = mesh.userData;
      const edge = this._nearEdge(mesh, focusX);
      // No anchor, or the chunk overlaps the near field: keep it.
      const inNear = edge == null || edge <= LOD_NEAR_RADIUS;
      let wantVisible = true;
      if (ud.lodDetail && detailRule) {
        if (!inNear) {
          const limit = mesh.visible ? reach : Math.max(LOD_NEAR_RADIUS, reach - 0.8);
          wantVisible = edge <= limit;
        }
      } else if (!inNear && clipRule && ud.lodSize > 0) {
        const cutoff = mesh.visible ? wupp * subPx : wupp * subPxReshow;
        wantVisible = ud.lodSize >= cutoff;
      }
      if (wantVisible !== mesh.visible) {
        mesh.visible = wantVisible;
        toggled = true;
      }
    }
    return toggled;
  }
}
