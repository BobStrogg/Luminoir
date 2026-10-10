export class EventLog {
  constructor(maxEntries = 50) {
    this._max = Math.max(10, maxEntries | 0);
    this._events = [];
  }
  note(msg) {
    try {
      const t = Number(performance.now() || Date.now());
      const line = `[+${(t / 1000).toFixed(3)}s] ${String(msg)}`;
      this._events.push(line);
      if (this._events.length > this._max) {
        this._events.splice(0, this._events.length - this._max);
      }
    } catch {
      // swallow — logging is best-effort only
    }
  }
  clear() {
    this._events.length = 0;
  }
  latest(n = 10) {
    const count = Math.max(0, Math.min(n, this._events.length));
    return this._events.slice(this._events.length - count);
  }
}

