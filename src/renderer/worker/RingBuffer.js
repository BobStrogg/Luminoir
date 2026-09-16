/**
 * Fixed-capacity ring buffer over a `Float64Array`.
 *
 * Replaces the hand-rolled `Float64Array + idx + filled` triples the
 * render loop uses for frame/render/camera-delta timing windows.
 * All reads go through caller-supplied scratch arrays (or the
 * internal buffer) so nothing allocates per frame.
 */
export class RingBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    this._buf = new Float64Array(capacity);
    this._idx = 0;
    this._filled = 0;
  }

  /** Capacity of the ring (matches the old `ring.length` usage). */
  get length() { return this._buf.length; }

  /** Number of slots currently holding a pushed sample (≤ capacity). */
  get filled() { return this._filled; }

  /** @param {number} v */
  push(v) {
    this._buf[this._idx] = v;
    this._idx = (this._idx + 1) % this._buf.length;
    if (this._filled < this._buf.length) this._filled++;
  }

  /** Clear every slot to `v` without touching the write cursor. */
  fill(v) { this._buf.fill(v); }

  /** Rewind the write cursor and mark the ring empty. */
  reset() {
    this._idx = 0;
    this._filled = 0;
  }

  /**
   * Copy the most-recent `n` samples into `outScratch` in
   * reverse-chronological order (newest first) and return the
   * `Float64Array` subarray view that was written.
   * @param {number} n
   * @param {Float64Array} outScratch
   * @returns {Float64Array}
   */
  latest(n, outScratch) {
    n = Math.min(n, this._filled);
    const out = outScratch.subarray(0, n);
    const len = this._buf.length;
    for (let i = 0; i < n; i++) {
      out[i] = this._buf[(this._idx - 1 - i + len) % len];
    }
    return out;
  }

  /**
   * Percentile over the most-recent `n` samples.  Sorts `scratch`
   * in place; `n` defaults to every filled slot.
   * @param {number} q  0..1
   * @param {number} [n]
   * @param {Float64Array} scratch
   */
  percentile(q, n = this._filled, scratch) {
    if (n <= 0) return 0;
    const s = this.latest(n, scratch);
    s.sort();
    return s[Math.min(n - 1, Math.floor(n * q))];
  }

  /** Mean of the most-recent `n` samples (0 when empty). */
  mean(n) {
    n = Math.min(n, this._filled);
    if (n <= 0) return 0;
    let sum = 0;
    const len = this._buf.length;
    for (let i = 0; i < n; i++) {
      sum += this._buf[(this._idx - 1 - i + len) % len];
    }
    return sum / n;
  }

  /** Max of the most-recent `n` samples (0 when empty). */
  max(n) {
    n = Math.min(n, this._filled);
    let m = 0;
    const len = this._buf.length;
    for (let i = 0; i < n; i++) {
      const v = this._buf[(this._idx - 1 - i + len) % len];
      if (v > m) m = v;
    }
    return m;
  }

  /** Iterate every filled slot in storage order. */
  forEach(cb) {
    for (let i = 0; i < this._filled; i++) cb(this._buf[i]);
  }
}
