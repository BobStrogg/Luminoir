# Luminoir – Agent Knowledge Base

Browser-based 3D sheet-music visualisation.  Three.js/WebGPU, Verovio WASM, Web Audio API.

---

## Build & dev commands

```bash
pnpm install          # install deps
pnpm dev              # dev server → http://localhost:5173
VITE_HTTPS=1 pnpm dev # dev server → https://<lan-host>:5173 (self-signed cert, for LAN access)
pnpm build            # production build → dist/
pnpm test             # Playwright e2e tests (requires running dev server)
```

`package.json` `packageManager` field pins the exact pnpm version.  If `corepack enable`
fails (signature validation errors), use `npm install -g pnpm@<version>` directly.

---

## Architecture

```
main thread                         render worker (OffscreenCanvas)
──────────────────────────────────  ──────────────────────────────
LuminoirApp.js                      renderWorker.js
  RenderClient.js  ──postMessage──▶   handleInit / handleBuildScene / …
  MIDIPlayer.js    ──clock msg──────▶  startRenderLoop
  SettingsPanel.js ──updateConfig──▶   handleUpdateConfig
  Controls.js      (score picker, transport)
  SVGSceneParser.js (Verovio → JSON)
  scoreWorker.js (Verovio WASM, off-thread)
```

Key principle: **all Three.js state lives in the render worker**.  The main thread holds
only the DOM canvas placeholder; it transfers `OffscreenCanvas` to the worker on init.
Two separate copies of `SceneConfig` exist — one in each realm; live settings changes
must be pushed via `RenderClient.updateConfig({ 'dot.path': value })`.

---

## Dual-renderer strategy

1. Try `WebGPURenderer` (three/webgpu) first — better on Chrome/Edge/Safari TP.
2. Smoke-test with `_verifyWebGPURenders()` (clear 2×2 RT to magenta, read back).
   - Tesla browser: `init()` resolves but nothing reaches the canvas → demote to WebGL.
3. Fall back to legacy `THREE.WebGLRenderer`.

**Do NOT use WebGPURenderer's built-in WebGL2 backend** (`forceWebGL` constructor
option).  Its `InstanceNode` packs matrices into a UBO capped at 256 entries
(`GL_MAX_UNIFORM_BLOCK_SIZE = 16384 bytes`).  Staff-line / stem buckets on any real
score exceed that limit → affected InstancedMeshes silently disappear.

`?renderer=webgl` URL param forces the legacy path even on capable hardware.

---

## Materials (src/rendering/Materials.js)

`Materials.noteHead()` returns different material types depending on renderer:

| Renderer | Material type | Glow mechanism |
|---|---|---|
| WebGPU | `MeshStandardNodeMaterial` | TSL `emissiveNode` reads `varyingProperty('vec3', 'vInstanceColor')` |
| WebGL | `MeshStandardMaterial` + `onBeforeCompile` | GLSL injection gated on `#ifdef USE_COLOR` |

**Critical**: The fragment shader injection must check `#ifdef USE_COLOR`, NOT
`#ifdef USE_INSTANCING_COLOR`.  Three.js only emits `#define USE_INSTANCING_COLOR`
in the **vertex** shader prefix; the fragment prefix only ever gets `#define USE_COLOR`
(which covers all of `vertexColors`, `instancingColor`, and `batchingColor`).
Using the wrong guard silently skips the glow on the WebGL path.

The glow fades by distance from the playhead — `setPlayheadX(x)` pushes a uniform
every frame so old notes behind the camera lose their emissive contribution.

---

## Mobile performance

iOS Safari halves the rAF rate permanently the first time a single frame exceeds 16.67 ms.
Root cause on dense Jupiter bars: 6144² shadow map = ~38 M depth fragments/frame alone.

Mobile UA detection: `_isMobileUA()` in `renderWorker.js` (matches iPhone/iPad/iPod/Android/Mobile).

**GPU quality system** (two phases, in `renderWorker.js`):

**Phase 1 — load-time probe** (`_probeGpuCost` + `_applyLoadTimeQuality`, called once in `handleInit`):
- Renders the empty scene 7 times **with a forced shadow pass per frame** and a
  **GPU-completion fence per frame** (`_gpuSync`: WebGPU `queue.onSubmittedWorkDone()`,
  WebGL 1×1 `readPixels`); returns the **minimum** sample.
- CRITICAL: the GPU fence is what makes the probe meaningful on Chromium — bare
  `renderer.render()` only measures CPU submit time (~0.25 ms on any machine), which
  used to route every Chromium browser into the top tier regardless of GPU speed.
  The minimum (not median) is used because early samples are inflated by idle GPU
  clock ramp-up, which flipped borderline machines between tiers across reloads.
- Picks the highest shadow-map resolution that fits within half the frame budget.
- Sets shadow mapSize, DPR cap, and PCF type **once** — never changes during the session.
  (`handleResize` must respect `_chosenDprCap` — it used to hardcode `min(dpr, 2)` and
  silently undo the probe's choice on the first window resize.)
- Mobile always uses 2048² PCF, DPR 1.5 regardless of probe result.
- Probe thresholds (desktop, GPU-synced): < 2 ms → 6144² PCFSoft DPR 2.0; < 5 ms → 4096² PCFSoft DPR 1.75; else → 2048² PCF DPR 1.5.

**Phase 2 — runtime pressure** (`_runtimePressure`, updated each rAF):
- A 0→1 float driven by p95 rAF interval vs calibrated baseline (30-tick **p95** window).
- CRITICAL: baseline and signal must be the SAME statistic (p95 vs p95).  The old p10
  baseline sat below healthy p95 vsync jitter, so pressure ratcheted to 1.0 within
  seconds of starting any playback — even at a rock-solid 120 fps — and permanently
  dimmed the lights.
- Rises toward 1 over ~1 s of sustained overrun (p95 ≥ baseline × 1.3).
- Falls toward 0 over ~3 s of headroom (p95 ≤ baseline × 1.15).
- Two actuators:
  1. `SceneConfig.lightBall.intensity` (= `_baseLightIntensity × (1 − pressure × 0.85)`) — cosmetic dim.
  2. **Shadow-update throttle** (`_updateKeyLight`): under pressure, shadow-map re-renders
     are spaced out up to `pressure × 150 ms` apart.  This is the actuator that actually
     recovers GPU time (the shadow pass re-renders nearly every frame during playback
     because the playhead crosses a texel almost every tick).  Visually free: translating
     a DirectionalLight never moves the shadows, it only slides the coverage frustum
     (half-width 20 wu vs ≈ 0.5 wu/s playhead motion).
- Controlled by `autoDegrade` flag (`updateConfig({ autoDegrade: bool })`); disabling restores full intensity immediately.
- Settings panel shows a pressure dot (green → amber → red) instead of a tier label.

**Runtime LOD** (`_applyLodVisibility` in `renderWorker.js` + bucket tags from `SVG3DBuilder`):
- Implements `LOD_DISTANT_ELEMENTS` / `DISTANCE_CLIP_GLYPHS` / `LOD_DISTANCE_THRESHOLD`
  from `Optimizations.js` (these flags were previously declared but wired to nothing).
- Build time: stems/flags/ledger-line buckets are tagged `userData.lodDetail`; every
  glyph bucket gets `userData.lodSize` (world-unit footprint).  Detail-tagged box lines
  (simple-line stems) get their own InstancedMesh, separate from beams/staff/bar lines.
- Runtime: detail buckets hide beyond `LOD_DISTANCE_THRESHOLD` (12 wu, where they are
  ≈ 1 px); any tagged bucket hides when its footprint projects below ~0.7 device px.
  Both rules have 15–20 % hysteresis so the smart camera's ±6 % zoom oscillation can't
  flicker them.  The pass runs only when camera distance changes > 1 %.
- Staff lines, bar lines, beams, and noteheads are never distance-hidden (structure);
  noteheads only go sub-pixel past d ≈ 100 (controls maxDistance = 100).
- Mesh `.visible` toggling does NOT recompile WebGPU pipelines (unlike light `.visible`)
  and all pipelines are pre-warmed by `precompilePipelines` regardless of visibility.

**Key design rule**: shadow map size, DPR, and PCF type must NEVER be changed at runtime. Doing so requires a shadow-map dispose + re-allocate, which causes a blank/flickery frame. They are load-time only.

---

## Settings / config pipeline

`settingsRegistry.js` declares every setting with id (dot-path into SceneConfig), type,
apply mode (`'live'` | `'reparse'`), default, section, etc.

- `'live'` → `RenderClient.updateConfig({ [id]: value })` — no scene rebuild.
- `'reparse'` → `app.reloadCurrentScore()` — rebuilds mesh from cached SVG parse.

`SettingsPanel._hydrate()` runs synchronously in the constructor (before `app.init()`)
so the first scene build already sees persisted preferences.

Settings that bypass the registry (pure-worker state, not in SceneConfig):
- `autoDegrade` — adaptive quality toggle, handled in `handleUpdateConfig` before the
  generic dot-path loop and then `continue`d so it never touches SceneConfig.

Worker-side settings that are NOT in the registry (design-time tunables):
- Shadow quality: `SceneConfig.shadow.*` — mapSize, frustumHalfWidth, bias, normalBias, radius.
- All rendering constants: camera defaults, elevation stack, light ball geometry.

---

## Scene coordinate system

`contentRoot` (scene child) is rotated `-π/2` around X so the score's "flat on table" layout
maps correctly to world space:

- Score local X (music time) → World X
- Score local Y (vertical staff spread, top-to-bottom) → World -Z
- Score local Z (elevation off paper) → World +Y

Everything that needs to work in score-local space (balls, camera chase) is parented
under `contentRoot`.  Direct scene children (lights) use world coordinates.

---

## Shadow / key light

- `_keyLight` is a `DirectionalLight` that slides with `controls.target` every frame
  so the shadow frustum always straddles what the camera is looking at.
- `_updateKeyLight(x, z)` snaps the light position to texel-grid boundaries (rounds to
  `_keyLightTexelSize` multiples) to prevent shadow-edge "crawling" during camera pan.
- `_KEY_LIGHT_OFFSET` = `(-5, 12, 8)` gives an upper-left-front incident angle.

---

## Performance patterns

**Idle-render gate** (`_dirty` flag): `renderer.render()` is only called when something
has changed.  During silence + static camera → GPU at ~0%.

**Precompile** (`precompilePipelines`): After each scene build, `compileAsync(scene, camera)`
is called with all objects' `frustumCulled = false` and hidden objects temporarily made
visible so every pipeline is compiled before first playback frame.

**Budget-skip gate**: If the previous render call took > `RENDER_BUDGET_MS` (12 ms),
skip one frame to let the GPU drain.  Skips at most 1 frame in a row.

**Note-glow fade by distance** (`setPlayheadX`): `glowTrailLength` in SceneConfig (default 4.0
world units) determines how far behind the playhead notes keep their emissive.

---

## UI layout

```
#controls-bar (top-left)
  logo | score selector | upload btn | stop btn | play-pause btn

#top-right-controls (top-right)
  gear btn (opens #settings-popover)

#settings-popover
  Sections: Playback | Audio sync | Smart camera | Light balls | Played notes | Notation | Renderer | About
  Renderer section: active backend label | Switch btn (if WebGPU available)
                    Auto-degrade quality: [checkbox] [tier pill]
                    description text
```

**Renderer badge** is inside the Settings panel (not a top-bar overlay).  It was moved
there so the gear icon isn't pushed off-screen on narrow mobile viewports.

---

## Known gotchas

1. **Two SceneConfig copies**: main thread and worker are separate ESM realms.  A change
   on the main thread does NOT automatically propagate — must postMessage via `updateConfig`.

2. **LightBallController parenting**: Must parent under `contentRoot`, not `scene`, so balls
   inherit the `-π/2` X rotation that lays the score flat.

3. **Played-note colour matching**: Staff→colour assignment in `handleSetTimeline` must
   iterate in the same order as `LightBallController.setEvents()` — insertion order of
   the `byStaff` map cycling through `SceneConfig.lightBall.colors`.

4. **WebGPU pipeline cache key**: Three.js WebGPU keys pipelines on
   `(scene, camera, renderTarget, lightsNode)`.  Precompile with the *main* camera and
   canvas renderTarget; warming with a different camera is a no-op.

5. **Shadow map type changes**: Must dispose the existing shadow map for the new
   `shadowMap.type` to take effect.  See the pattern above under "Adaptive quality".

6. **DPR on resize**: `handleResize` in the worker must use `_chosenDprCap` (the
   probe-selected cap), never a hardcoded `Math.min(dpr, 2)` — the hardcoded form
   silently restored full resolution on weak GPUs at the first window resize.
   (Fixed; kept here as a warning for future resize-handler edits.)

---

## GitHub Actions CI

`.github/workflows/deploy.yml` — Vite build + GitHub Pages deploy.
`pnpm/action-setup` step must NOT specify `version:` — it defers to `packageManager` in
`package.json`.  (Multiple-versions error was fixed in commit `669249a`.)
