# Frame-time benchmark

A repeatable headless benchmark that measures frame-time tails while playing a
built-in score under the WebGL path. Results are per-frame wall-clock intervals
(rAF-to-rAF), reported as p50/p95/p99/max and counts over 8.3/16.7/33.3 ms.

What it does
- Serves the production build via `vite preview`.
- Launches headless Chromium (Playwright) with CPU throttling.
- Navigates to `/?renderer=webgl&bench=1&auto=play&score=<id>&durationSec=<n>`.
- Worker aggregates per-frame intervals and returns a summary.

One-shot run (Jupiter, 10 s, 4× CPU):
```bash
pnpm build
PORT=5181 BENCH_DURATION=10 BENCH_CPU=4 BENCH_SCORES=jupiter pnpm bench
```

Widest multi-staff built-in (Star Trek: First Contact):
```bash
PORT=5182 BENCH_DURATION=10 BENCH_CPU=4 BENCH_SCORES=starTrekFirstContact pnpm bench
```

Compare with/without dynamic shadow dead‑zone widening (stutter fix):
```bash
# Baseline (disable widening during the run)
PORT=5183 BENCH_DURATION=10 BENCH_CPU=4 BENCH_SCORES=jupiter BENCH_NOWIDEN=1 pnpm bench
# After (default: widening enabled)
PORT=5184 BENCH_DURATION=10 BENCH_CPU=4 BENCH_SCORES=jupiter pnpm bench
```

Notes
- Audio is bypassed in bench mode to avoid autoplay policies; the worker clock
  runs in “playing” state regardless of audio.
- Headless WebGL uses SwiftShader on many machines, so absolute numbers are not
  comparable to real GPUs, but deltas between code changes are reliable.
- The benchmark prints a machine‑readable line:
  `__BENCH_RESULT__{"samples":...,"p50":...,"p95":...,"p99":...,"max":...}`
  which can be scraped by CI or local tooling.

## Offline camera-follow harness (Node)

Deterministic, browser-free harness that drives the real `CameraController`
against the actual note timeline for built-in scores. Reports velocity,
acceleration, and jerk statistics (dt-normalized) and exports PNG plots.

Usage:
```bash
# Single score, 8 s, smoothing disabled (baseline)
pnpm bench:camera -- --score=jupiter --duration=8 --smooth=false

# Full sweep (Jupiter + StarTrek, 60/120 Hz, stalls/jitter)
pnpm bench:camera:all
```

Artifacts land under `bench/camera-offline-results/`:
- JSON metrics per run
- Plots: `*-position.png`, `*-velocity.png`, `*-acceleration.png`
