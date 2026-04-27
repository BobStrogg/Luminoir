# Luminoir

A browser-based 3D sheet music visualization.

Renders musical scores as extruded 3D geometry with animated light balls that bounce from note to note, synchronised to MIDI playback through the Web Audio API.

Live demo: https://bobstrogg.github.io/Luminoir/

## Quick start

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173 in Chrome / Edge / Safari (WebGPU) or any modern browser (WebGL fallback).

## Controls

- **Score selector** — pick from the bundled demo pieces
- **Import** — load your own `.musicxml` / `.mxl` file
- **Play / Pause / Stop** — transport buttons
- **Drag, scroll, pinch** — orbit the camera
- **Gear icon** — playback speed, audio sync, smart-camera, light-ball / notation toggles
- **Space** — play / pause shortcut
- **R** — stop (reset to beginning)

## Tech stack

| Layer | Technology |
|-------|-----------|
| **3D rendering** | Three.js (WebGPU renderer with WebGL fallback) |
| **Music engraving** | Verovio (WASM) — MusicXML → SVG |
| **Audio** | smplr + Web Audio API (sample-based MIDI playback) |
| **Build** | Vite |

## Architecture

```
MusicXML / MXL  ──▶  Verovio (WASM)  ──▶  SVG + MIDI + Timemap
                                            │       │       │
                                            ▼       ▼       ▼
                                      SVGSceneParser
                                            │
                                            ▼
                                      SVG3DBuilder ─────▶  Three.js scene
                                                                │
                                                                ▼
                                                  WebGPURenderer / WebGLRenderer
                                                                │
                                                                ▼
                                                            <canvas>
```

The Verovio toolkit and the Three.js renderer each run in a dedicated Web Worker so the main thread stays free for UI input — the camera keeps responding to drags even while a heavy score is being parsed and meshed.

## Project layout

```
src/
├── main.js                      # Entry point
├── LuminoirApp.js               # Main-thread orchestrator
├── verovio/
│   ├── scoreWorker.js           # Verovio WASM toolkit (worker)
│   ├── ScoreClient.js           # Promise-based client wrapper
│   ├── SVGSceneParser.js        # SVG → structured scene data
│   └── RepeatUnroller.js        # Unroll |: … :| sections inline
├── renderer/
│   ├── renderWorker.js          # Three.js scene + render loop (worker)
│   ├── RenderClient.js          # Main-thread client wrapper
│   └── ElementProxy.js          # Pointer / wheel forwarding
├── rendering/
│   ├── SVG3DBuilder.js          # Parsed scene → Three.js geometry
│   ├── Materials.js
│   ├── SceneConfig.js
│   ├── TitleBlock.js            # Title rasterisation + page layout
│   └── Optimizations.js
├── animation/
│   ├── LightBallController.js
│   └── CameraController.js      # Smart-camera + chase framing
├── playback/
│   └── MIDIPlayer.js            # Sample-based MIDI through Web Audio
├── ui/
│   ├── Controls.js              # Score-select, import, transport
│   ├── SettingsPanel.js         # Gear popover
│   ├── settingsRegistry.js      # Setting declarations
│   └── SettingsPersistence.js   # localStorage round-trip
├── data/
│   └── DemoScores.js            # Bundled score registry
└── styles/
    └── main.css

public/
└── scores/                      # Bundled .mxl files
```

## Browser compatibility

| Browser | Renderer | Status |
|---------|----------|--------|
| Chrome 113+ / Edge 113+ | WebGPU | Full |
| Safari 18.2+ | WebGPU | Full |
| Firefox | WebGL (fallback) | Full |

## Acknowledgments

Built on the shoulders of these open-source projects:

- [Verovio](https://www.verovio.org) — music notation engraving (LGPL-3.0)
- [Three.js](https://threejs.org) — 3D rendering (MIT)
- [smplr](https://github.com/danigb/smplr) — sample-based MIDI playback (MIT)

Demo MusicXML scores are sourced from various publicly-available transcriptions; please refer to the original publishers for any reuse beyond personal study.
