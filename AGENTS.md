# Luminoir – Agent Knowledge Base

Browser-based 3D sheet-music visualisation.  Three.js/WebGPU, Verovio WASM, Web Audio API.

---

## Build & dev commands

```bash
pnpm install          # install deps
pnpm dev              # dev server → http://localhost:5173
pnpm dev:lan          # dev server → https://<lan-host>:5173 (mkcert cert, for LAN access)
pnpm build            # production build → dist/
pnpm test             # Playwright e2e tests (requires running dev server)
```

`package.json` `packageManager` field pins the exact pnpm version.  If `corepack enable`
fails (signature validation errors), use `npm install -g pnpm@<version>` directly.

### Versioning

**Bump the patch version in `package.json` with every commit** (or batch of commits in
a single session).  The version is compiled into the app via Vite's `define` config
(`__APP_VERSION__`) and shown in Settings → About.

Semver convention:
- **Patch** (`1.0.x`): bug fixes, perf tweaks, config changes.
- **Minor** (`1.x.0`): new user-visible features, new settings, new scores.
- **Major** (`x.0.0`): breaking changes to the architecture or data format.

### LAN HTTPS setup (one-time, per machine)

Chrome's Private Network Access policy blocks subresource loads from `.local` hostnames
over plain HTTP.  `pnpm dev:lan` serves over HTTPS using a mkcert-issued cert.

**Server machine (this Mac) — one-time:**
```bash
brew install mkcert nss   # nss = Firefox support
mkcert -install           # installs root CA into macOS Keychain (requires password)
# Regenerate cert if hostname/IP changes:
mkcert -cert-file .certs/cert.pem -key-file .certs/key.pem \
  localhost MacBook-Pro.local 192.168.1.110
```

The `.certs/` directory is `.gitignore`d — never committed.

**Remote devices — one-time per device:**
- **macOS/iOS**: AirDrop or email `$(mkcert -CAROOT)/rootCA.pem` → open → trust in Settings.
- **Android/Chrome**: Settings → Security → Install certificate → CA certificate → select `rootCA.pem`.
- **Windows**: Double-click `rootCA.pem` → Install → Trusted Root Certification Authorities.
- **Quickest fallback**: Just visit `https://MacBook-Pro.local:5173` and click "Advanced → Proceed anyway" once per browser — no CA import needed, but you'll see a warning.

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

1. Try `WebGPURenderer` (three/webgpu) first — better on Chrome/Edge/current Safari.
2. If construction or `init()` throws, fall back to legacy `THREE.WebGLRenderer`.

Do not reintroduce the old `_verifyWebGPURenders()` render-target readback.  It produced
false negatives on working WebGPU contexts and could taint the device after a validation
error, leaving neither WebGPU nor WebGL usable.  Tesla normally exposes no WebGPU and
therefore takes the legacy WebGL path naturally; `/Tesla|TESLA_AUTO/` applies its
constrained quality profile there.

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

**Phase 1 — hidden load-time probes** (`_probeGpuCost` + `_applyLoadTimeQuality` / `_refineSceneQuality`):
- Init renders the empty scene 5 times **with a forced shadow pass per frame** and a
  **GPU-completion fence per frame** (`_gpuSync`: WebGPU `queue.onSubmittedWorkDone()`,
  WebGL 1×1 `readPixels`); it returns the **minimum** sample.
- CRITICAL: the GPU fence makes the probe meaningful on Chromium — bare
  `renderer.render()` only measures CPU submit time (~0.25 ms), which previously routed
  every Chromium browser into the top tier regardless of GPU speed.
- Initial desktop thresholds: < 2 ms → 6144² PCFSoft DPR 2.0; < 5 ms → 4096²
  PCFSoft DPR 1.75; else → 2048² PCF DPR 1.5.
- Mobile and Tesla are constrained profiles: no MSAA, 2048² PCF, DPR 1.5. Safari,
  mobile, and Tesla cap the pooled point-light shader loop at four lights.
- Safari, mobile, and Tesla run a second 3-frame **median** probe with the real score
  while the loading overlay remains visible.  If a forced full frame exceeds 14 ms it
  can only step down (6144→4096→2048, plus 1024/DPR 1.25 on constrained devices).
- Shadow map/DPR/PCF may change only while `_compiling` keeps the loading overlay up;
  they never change during playback. `handleResize` must continue respecting
  `_chosenDprCap`.

**Phase 2 — runtime pressure** (`_runtimePressure`, updated each rAF):
- A 0→1 float driven by the recent p95 rAF interval against a fixed 16.67 ms (60 fps)
  target.  This avoids degrading a healthy 120 Hz session merely because an occasional
  frame takes two display refreshes.
- The p95 ring is sorted at 4 Hz, not every rAF tick; pressure itself still eases every
  frame.  The 30-tick p95 calibration remains diagnostic only.
- Rises toward 1 after sustained p95 ≥ 19.17 ms and falls with p95 ≤ 17.5 ms.
- Two actuators:
  1. `SceneConfig.lightBall.intensity` (= `_baseLightIntensity × (1 − pressure × 0.85)`).
  2. **Shadow-update throttle** (`_updateKeyLight`): static directional-shadow coverage
     refreshes at most 30 Hz at zero pressure and stretches toward 150 ms (~7 Hz) at
     full pressure.  Translating the DirectionalLight never changes shadow direction;
     it only slides the 40 wu-wide coverage frustum, so this is visually stable.
- Controlled by `autoDegrade`; disabling restores full intensity immediately.
- Settings shows a pressure dot (green → amber → red).

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

**Horizontal bucket chunking** (`CHUNK_BUCKETS_BY_X`):
- Enabled at worker init for legacy WebGL (Tesla's expected renderer) and Safari WebGPU;
  disabled for Chromium WebGPU because some drivers pop `InstancedMesh` chunks at
  oblique camera angles.
- Splits each glyph/line bucket into at most 30 X chunks, allowing both the scene camera
  and directional shadow camera to reject the rest of a long score.
- Jupiter WebGL measurement: ~2.5 M → ~459 k submitted triangles at the playhead;
  frame p95 improved from ~12.7 ms to ~9.2 ms on the reference Chromium run.

**Key design rule**: shadow map size, DPR, and PCF type must NEVER be changed during playback. Doing so requires a shadow-map dispose + re-allocate, which causes a blank/flickery frame. They may change while `_compiling` keeps the score-loading overlay visible.

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
