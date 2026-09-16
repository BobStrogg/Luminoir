import * as THREE from 'three';
import { RingBuffer } from './RingBuffer.js';

/** Per-frame work flags recorded alongside each rAF interval so the
 *  jitter probe can correlate slow frames with the work that preceded
 *  them (shadow pass, note-colour upload, stats heartbeat, budget
 *  skip). */
export const FRAME_SHADOW = 1;
export const FRAME_COLORS = 2;
export const FRAME_STATS = 4;
export const FRAME_BUDGET_SKIP = 8;

/**
 * Frame-timing bookkeeping: rolling ring buffers for rAF intervals,
 * render-submit times and camera-delta jitter, plus the jitter
 * correlation buckets and the scratch array used for in-place
 * percentile sorts.
 */
export class FrameStats {
  /** Rolling buffer of recent per-frame render-submit timings (ms) so
   *  `probe` can report histograms without us keeping stats forever. */
  _renderMsRing = new RingBuffer(120);
  _lastRenderMs = 0;
  _framesSinceRender = 0;
  _rendersSkipped = 0;
  /** Wall-clock rAF-to-rAF interval in ms — this is the true "how long
   *  is a frame actually taking" metric, including GPU execution time
   *  that `renderer.render()`'s submit-time doesn't capture.  A 2 fps
   *  user experience shows up here as ~500 ms intervals even though
   *  submit time is <5 ms.
   *  Written on *every* rAF tick (playing + idle) — used by `probe()`
   *  for the full frame-time histogram in the developer overlay. */
  _frameMsRing = new RingBuffer(120);
  /** Subset of `_frameMsRing` — only records intervals from ticks that
   *  occur while `clock.state === 'playing'`.  The AQ p95 window reads
   *  from this ring instead of `_frameMsRing` so that idle frames
   *  (camera settled, music paused) don't dilute the pressure signal
   *  and cause the AQ system to see artificially low percentiles. */
  _playFrameMsRing = new RingBuffer(120);
  _lastFrameFlags = 0;
  _lastFrameCpuMs = 0;
  _jitterTotals = {
    all: FrameStats._newJitterBucket(),
    afterShadow: FrameStats._newJitterBucket(),
    afterNoShadow: FrameStats._newJitterBucket(),
    afterColorUpload: FrameStats._newJitterBucket(),
    afterStats: FrameStats._newJitterBucket(),
    afterBudgetSkip: FrameStats._newJitterBucket(),
  };
  /** Pre-allocated scratch buffer for in-place sorting inside the
   *  500 ms stats heartbeat.  Using typed arrays and sorting them
   *  in-place avoids the `new Array` + `push` allocations that were
   *  triggering minor GC pauses every frame and causing the rAF
   *  interval to jitter (manifesting as inconsistent 45-60 fps on
   *  ProMotion hardware despite <4 ms GPU render time). */
  _statsScratch = new Float64Array(120);

  /** Camera-position history for a per-frame `cameraJitter` probe metric. */
  _prevCameraPos = new THREE.Vector3();
  _prevCameraDelta = 0;
  _cameraDeltaRing = new RingBuffer(120);

  get playFrameRing() { return this._playFrameMsRing; }
  get lastRenderMs() { return this._lastRenderMs; }
  get framesSinceRender() { return this._framesSinceRender; }

  static _newJitterBucket() {
    return { count: 0, sum: 0, max: 0, cpuSum: 0, cpuMax: 0, over12: 0, over16: 0, over20: 0, over33: 0 };
  }

  _addJitterSample(bucket, frame, cpu) {
    bucket.count++;
    bucket.sum += frame;
    bucket.cpuSum += cpu;
    if (frame > bucket.max) bucket.max = frame;
    if (cpu > bucket.cpuMax) bucket.cpuMax = cpu;
    if (frame > 12) bucket.over12++;
    if (frame > 16) bucket.over16++;
    if (frame > 20) bucket.over20++;
    if (frame > 33) bucket.over33++;
  }

  _recordJitterSample(frame, cpu, flags) {
    this._addJitterSample(this._jitterTotals.all, frame, cpu);
    this._addJitterSample(
      flags & FRAME_SHADOW ? this._jitterTotals.afterShadow : this._jitterTotals.afterNoShadow,
      frame, cpu);
    if (flags & FRAME_COLORS) this._addJitterSample(this._jitterTotals.afterColorUpload, frame, cpu);
    if (flags & FRAME_STATS) this._addJitterSample(this._jitterTotals.afterStats, frame, cpu);
    if (flags & FRAME_BUDGET_SKIP) this._addJitterSample(this._jitterTotals.afterBudgetSkip, frame, cpu);
  }

  resetJitter() {
    for (const bucket of Object.values(this._jitterTotals)) {
      bucket.count = 0;
      bucket.sum = 0;
      bucket.max = 0;
      bucket.cpuSum = 0;
      bucket.cpuMax = 0;
      bucket.over12 = 0;
      bucket.over16 = 0;
      bucket.over20 = 0;
      bucket.over33 = 0;
    }
  }

  /** Record one rAF interval.  `playing` mirrors
   *  `clock.state === 'playing'`: it routes the sample into the
   *  play-session ring and correlates it with the *previous* frame's
   *  flags/cpu in the jitter buckets. */
  recordFrame(frameMs, playing) {
    this._frameMsRing.push(frameMs);
    if (playing) this._recordJitterSample(frameMs, this._lastFrameCpuMs, this._lastFrameFlags);
    // Separate ring for AQ: only record play-session frames so that
    // long idle intervals don't make the p95 look deceptively low.
    if (playing) {
      this._playFrameMsRing.push(frameMs);
    }
  }

  /** Camera-position change for the `cameraJitter` probe metric.
   *  Variation here (not absolute motion) is the best proxy we have
   *  for visible camera jitter caused by rAF dt noise. */
  recordCameraDelta(cameraPos) {
    const dx = cameraPos.x - this._prevCameraPos.x;
    const dy = cameraPos.y - this._prevCameraPos.y;
    const dz = cameraPos.z - this._prevCameraPos.z;
    const delta = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this._prevCameraPos.copy(cameraPos);
    const deltaDelta = Math.abs(delta - this._prevCameraDelta);
    this._prevCameraDelta = delta;
    this._cameraDeltaRing.push(deltaDelta);
  }

  /** Seed the camera-position history used by the cameraJitter probe
   *  metric so the first frame after init doesn't record a bogus
   *  giant jump. */
  seedCameraPos(pos) {
    this._prevCameraPos.copy(pos);
    this._prevCameraDelta = 0;
    this._cameraDeltaRing.reset();
    this._cameraDeltaRing.fill(0);
  }

  recordRender(ms) {
    this._lastRenderMs = ms;
    this._framesSinceRender = 0;
    this._renderMsRing.push(ms);
  }

  recordSkip() {
    this._framesSinceRender++;
    this._rendersSkipped++;
  }

  /** Flush the timing rings on play-start so stale idle-period
   *  intervals don't distort the p95 pressure signal. */
  resetForPlay() {
    this._playFrameMsRing.reset();
    this._frameMsRing.reset();
    this._frameMsRing.fill(0);
    this._lastFrameFlags = 0;
    this._lastFrameCpuMs = 0;
    this.resetJitter();
  }

  /** Store this tick's flags + worker CPU so the *next* frame's
   *  interval can be correlated with the work that preceded it. */
  endFrame(frameFlags, cpuMs) {
    this._lastFrameFlags = frameFlags;
    this._lastFrameCpuMs = cpuMs;
  }

  /** Build the `stats` message payload (or null when no frames have
   *  been recorded yet).  `extra` carries the fields the loop owns:
   *  `rendering`, `autoDegrade`, `gpuPressure`, `aqBaselineMs`,
   *  `aqCalibrated`, `antiAliasing`, `msaaSamples`, `fxaaSuppressed`. */
  buildStatsMessage(extra) {
    // Recent-window samples: the last min(samples, ~60 frames worth)
    // give the freshest readout — the ring's most-recent 60 entries.
    const fLen = this._frameMsRing.filled;
    if (fLen === 0) return null;
    const want = Math.min(fLen, 60);
    const fMean = this._frameMsRing.mean(want);
    const fMax = this._frameMsRing.max(want);
    const fps = fMean > 0 ? (1000 / fMean) : 0;

    // Render-submit window (only render frames count; idle frames
    // skip the renderer call so we don't want to dilute the average
    // with zeros).
    const rLen = this._renderMsRing.filled;
    let rMean = 0, rMax = 0, rP95 = 0;
    if (rLen > 0) {
      const rWant = Math.min(rLen, 60);
      rMean = this._renderMsRing.mean(rWant);
      rMax = this._renderMsRing.max(rWant);
      rP95 = this._renderMsRing.percentile(0.95, rWant, this._statsScratch);
    }

    // Compute play-frame p95 for the pressure diagnostic.
    let playP95 = 0;
    if (this._playFrameMsRing.filled > 0) {
      const pWant = Math.min(this._playFrameMsRing.filled, 60);
      playP95 = this._playFrameMsRing.percentile(0.95, pWant, this._statsScratch);
    }

    return {
      type: 'stats',
      fps,
      frameMs: fMean,
      frameMsMax: fMax,
      frameMsP95: playP95,
      renderMs: rMean,
      renderMsP95: rP95,
      renderMsMax: rMax,
      ...extra,
    };
  }

  /** The timing/jitter sub-objects of the `probe` snapshot. */
  buildProbeSnapshotParts() {
    const summarizeBucket = (bucket) => ({
      count: bucket.count,
      mean: bucket.count ? bucket.sum / bucket.count : 0,
      max: bucket.max,
      cpuMean: bucket.count ? bucket.cpuSum / bucket.count : 0,
      cpuMax: bucket.cpuMax,
      over12: bucket.over12,
      over16: bucket.over16,
      over20: bucket.over20,
      over33: bucket.over33,
    });

    // Render-time histogram across the ring buffer
    const rMax = this._renderMsRing.max(this._renderMsRing.filled);
    const p = (q) => this._renderMsRing.percentile(q, this._renderMsRing.filled, this._statsScratch);

    // Actual rAF-to-rAF frame time.  This is what the user perceives —
    // includes GPU execution time that `renderer.render`'s submit-time
    // doesn't capture.
    let fMax = 0;
    this._frameMsRing.forEach((v) => { if (v > fMax) fMax = v; });
    const fp = (q) => this._frameMsRing.percentile(q, this._frameMsRing.filled, this._statsScratch);

    // Camera-position second-difference (jitter) samples.  This measures
    // how much the camera's per-frame movement *changes*, not how much it
    // moves, so it isolates the high-frequency jitter from the underlying
    // smooth tracking motion.
    let cMax = 0;
    this._cameraDeltaRing.forEach((v) => { if (v > cMax) cMax = v; });
    const cp = (q) => this._cameraDeltaRing.percentile(q, this._cameraDeltaRing.filled, this._statsScratch);

    return {
      render: {
        samples: this._renderMsRing.filled,
        mean: this._renderMsRing.mean(this._renderMsRing.filled),
        p50: this._renderMsRing.filled ? p(0.5) : 0,
        p95: this._renderMsRing.filled ? p(0.95) : 0,
        p99: this._renderMsRing.filled ? p(0.99) : 0,
        max: rMax,
        skipped: this._rendersSkipped,
      },
      frame: {
        samples: this._frameMsRing.filled,
        mean: this._frameMsRing.mean(this._frameMsRing.filled),
        p50: this._frameMsRing.filled ? fp(0.5) : 0,
        p95: this._frameMsRing.filled ? fp(0.95) : 0,
        p99: this._frameMsRing.filled ? fp(0.99) : 0,
        max: fMax,
      },
      jitter: {
        all: summarizeBucket(this._jitterTotals.all),
        afterShadow: summarizeBucket(this._jitterTotals.afterShadow),
        afterNoShadow: summarizeBucket(this._jitterTotals.afterNoShadow),
        afterColorUpload: summarizeBucket(this._jitterTotals.afterColorUpload),
        afterStats: summarizeBucket(this._jitterTotals.afterStats),
        afterBudgetSkip: summarizeBucket(this._jitterTotals.afterBudgetSkip),
      },
      cameraJitter: {
        samples: this._cameraDeltaRing.filled,
        mean: this._cameraDeltaRing.mean(this._cameraDeltaRing.filled),
        p50: this._cameraDeltaRing.filled ? cp(0.5) : 0,
        p95: this._cameraDeltaRing.filled ? cp(0.95) : 0,
        p99: this._cameraDeltaRing.filled ? cp(0.99) : 0,
        max: cMax,
      },
    };
  }
}
