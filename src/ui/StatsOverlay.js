export class StatsOverlay {
  /**
   * @param {import('../renderer/RenderClient.js').RenderClient} renderClient
   * @param {HTMLCanvasElement} canvas
   */
  constructor(renderClient, canvas) {
    this._client = renderClient;
    this._canvas = canvas;
    this._div = document.createElement('div');
    this._div.style.cssText = [
      'position:fixed',
      'right:calc(env(safe-area-inset-right, 0px) + 8px)',
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 8px)',
      'z-index:9999',
      'background:rgba(0,0,0,0.70)',
      'color:#D7F9FF',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif',
      'padding:8px 10px',
      'border:1px solid rgba(255,255,255,0.2)',
      'border-radius:8px',
      'white-space:pre',
      'pointer-events:auto',
      'user-select:none',
      'touch-action:manipulation',
      'min-width: 220px',
      'max-width: 70vw',
      'box-sizing:border-box',
    ].join(';');
    this._div.textContent = 'stats: waiting…';
    document.body.appendChild(this._div);
    // Compact toggle
    this._toggle = document.createElement('div');
    this._toggle.textContent = '▾';
    this._toggle.style.cssText = [
      'position:absolute',
      'top:2px',
      'right:6px',
      'font-size:12px',
      'opacity:0.7',
      'cursor:pointer',
      'pointer-events:auto',
    ].join(';');
    this._div.appendChild(this._toggle);
    this._collapsed = false;
    this._toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this._collapsed = !this._collapsed;
      this._toggle.textContent = this._collapsed ? '▸' : '▾';
      // Force next render
      this._lastUpdate = 0;
    });
    // Tap to reset session-long counters
    this._div.addEventListener('click', () => {
      this._client.resetStatsCounters();
    });
    this._lastUpdate = 0;
    this._client.onStats = (s) => this._onStats(s);
  }

  _onStats(s) {
    // Throttle DOM writes (stats already at 2 Hz; keep it that way)
    const now = performance.now();
    if (now - this._lastUpdate < 400) return;
    this._lastUpdate = now;
    const c = this._canvas;
    const dpr = window.devicePixelRatio || 1;
    const res = `${c?.width || 0}×${c?.height || 0}`;
    const renderer = this._client.rendererKind || 'unknown';
    const fps = (s.fps || 0).toFixed(1);
    const p95 = (s.frameMsRecentP95 || s.frameMsP95 || 0).toFixed(2);
    const p99 = (s.frameMsRecentP99 || 0).toFixed(2);
    const fmax = (s.frameMsMax || 0).toFixed(2);
    const over8 = s.longFramesOver8_3 ?? 0;
    const over16 = s.longFramesOver16_7 ?? 0;
    const over33 = s.longFramesOver33_3 ?? 0;
    const over8T = s.longFramesOver8_3_total ?? 0;
    const over16T = s.longFramesOver16_7_total ?? 0;
    const over33T = s.longFramesOver33_3_total ?? 0;
    const aa = `${s.antiAliasing || 'None'}${s.msaaSamples > 1 ? ` (${s.msaaSamples}x)` : ''}${s.fxaaSuppressed ? ' [FXAA off]' : ''}`;
    const aq = `${s.aqCalibrated ? 'cal' : 'uncal'} base ${Number(s.aqBaselineMs || 0).toFixed(2)} ms  pressure ${Number(s.gpuPressure || 0).toFixed(2)}`;
    if (this._collapsed) {
      this._div.textContent =
        `fps ${fps}  p95 ${p95}ms  max ${fmax}ms  ${renderer} DPR ${dpr}  res ${res}`;
      this._div.appendChild(this._toggle);
      return;
    }
    this._div.textContent = [
      `fps ${fps}    p95 ${p95} ms   p99 ${p99} ms   max ${fmax} ms`,
      `>8.3 ${over8} | >16.7 ${over16} | >33.3 ${over33}  (recent)`,
      `Σ>8.3 ${over8T} | Σ>16.7 ${over16T} | Σ>33.3 ${over33T} (session)`,
      `renderer ${renderer}   DPR ${dpr}   res ${res}`,
      `AA ${aa}`,
      `AQ ${aq}`,
      '',
      'Tap to reset session counters  •  Tap ▾ to collapse',
    ].join('\n');
    this._div.appendChild(this._toggle);
  }

  dispose() {
    if (this._div) this._div.remove();
    this._div = null;
    this._client.onStats = null;
  }
}

