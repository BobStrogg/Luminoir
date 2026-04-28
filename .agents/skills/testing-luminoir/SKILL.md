# Testing Luminoir

Luminoir is a browser-based 3D sheet music visualization app using Three.js, Verovio (WASM), and Web Audio API.

## Dev Server Setup

1. Install dependencies: `pnpm install`
2. Start dev server: `pnpm dev` — runs on `http://localhost:5173`
3. The app loads a default demo score ("Albatross" by Fleetwood Mac)
4. Wait for "Loading music engine..." and "Loading demo score..." to finish before interacting
5. If `corepack enable` fails with signature validation errors, install pnpm directly: `npm install -g pnpm@<version>` (check `package.json` `packageManager` field for version)

## App UI Layout

- **Top-left**: Score dropdown selector + playback controls (upload, stop, play/pause)
- **Top-right**: Settings gear icon (opens settings panel) + "WebGPU" badge
- **Main area**: 3D rendered sheet music with interactive camera (OrbitControls)
- **Settings panel**: Playback speed, audio sync, smart camera toggle + sliders, light ball settings

## Key Testing Scenarios

### Smart Camera
- **Default state**: Clear `localStorage` → reload → open Settings gear → "Smart camera" checkbox should be checked
- **Orbit during playback**: Click Play → camera should visibly orbit/shift over several seconds
- **Resume after manual rotation**: During playback, drag to rotate camera → release → wait ~2s (1500ms cooldown) → camera should resume orbit smoothly from user's position without jumping
- The smart camera setting is stored in `localStorage` under key `luminoir.settings.v1`

### Portrait Mode Camera
- Resize browser to narrow width (~400px wide, portrait aspect ratio < 1)
- Switch scores from the dropdown to trigger `snapToTarget()` with the new aspect
- Camera should be noticeably more overhead/top-down compared to landscape view
- The blend factor is `(1 - aspect) * 2` clamped to [0, 1], blending pitch from 30° toward 65°

### Playback & Audio
- Click Play to start MIDI playback — notes highlight with colored markers (gold/cyan)
- Audio uses Web Audio API with SoundFont instruments
- First play requires a user gesture to unlock AudioContext

## Environment Limitations

- **iOS ringer audio fix**: Requires physical iOS device with Safari 17.4+ — cannot test on desktop. The fix uses `navigator.audioSession.type = 'playback'` which is a WebKit extension.
- **Pinch-zoom fix**: Requires multi-touch device — cannot test on desktop without touch simulation. The fix replaces a boolean `dragging` flag with `Set<pointerId>` for proper multi-pointer tracking.
- **WebGPU**: The app prefers WebGPU but falls back to WebGL2. Console warnings about "Failed to create WebGPU Context Provider" are normal on systems without WebGPU support — the app still works fine via WebGL2 fallback.

## Testing Tips

- To test fresh state, clear localStorage via devtools console: `localStorage.clear(); location.reload();`
- To test portrait mode, un-maximize the browser first (`wmctrl -r :ACTIVE: -b remove,maximized_vert,maximized_horz`), then resize (`xdotool getactivewindow windowsize 400 700`)
- After portrait test, re-maximize with `wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz`
- Smart camera orbit is subtle — wait at least 5-6 seconds of playback to see clear movement
- The camera jump fix is best tested by dragging to an extreme angle (e.g., below the score) during playback, then releasing

## Devin Secrets Needed

No secrets required — the app runs entirely client-side with no authentication.
