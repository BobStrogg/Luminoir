# Luminoir – Agent Knowledge Base

Browser-based 3D sheet-music visualisation.  Three.js/WebGPU, Verovio WASM, Web Audio API.

---

## Build & dev commands

```bash
pnpm install          # install deps
pnpm dev              # dev server → http://localhost:5173
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

**Adaptive quality system** (`_AdaptiveQuality` class, also in `renderWorker.js`):

| Tier | Shadow map | DPR cap | PCF type |
|------|-----------|---------|---------|
| 0 Full | 6144² | 2.0 | PCFSoft |
| 1 High | 4096² | 1.75 | PCFSoft |
| 2 Medium | 2048² | 1.5 | PCF |
| 3 Low | 1024² | 1.25 | PCF |

- Desktop starts at Tier 0; mobile starts at Tier 2.
- Steps **down** after 1 s sustained p95 frame-interval ≥ 17 ms.
- Steps **up** after 3 s sustained p95 ≤ 13 ms.
- Controlled by `autoDegrade` flag (sent via `updateConfig({ autoDegrade: bool })`).
- Toggle exposed in Settings panel → Renderer section; live tier label updates every 0.5 s.

Shadow map disposal pattern when changing mapSize at runtime:
```js
_keyLight.shadow.mapSize.width  = newSize;
_keyLight.shadow.mapSize.height = newSize;
if (_keyLight.shadow.map) { _keyLight.shadow.map.dispose(); _keyLight.shadow.map = null; }
// Recompute texel size for key-light snapping
_keyLightTexelSize.set((right - left) / newSize, (top - bottom) / newSize);
```

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

6. **DPR on resize**: `handleResize` in the worker hardcodes `Math.min(dpr, 2)` rather
   than using the adaptive tier's DPR cap.  If you add DPR tracking to the resize
   handler, consult `_quality._baseDpr` and `_quality._dprCaps[_quality.tier]`.

---

## GitHub Actions CI

`.github/workflows/deploy.yml` — Vite build + GitHub Pages deploy.
`pnpm/action-setup` step must NOT specify `version:` — it defers to `packageManager` in
`package.json`.  (Multiple-versions error was fixed in commit `669249a`.)
