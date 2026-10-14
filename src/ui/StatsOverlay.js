import { presentLocked60 } from '../renderer/worker/qualityPolicy.js';

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
      // Wrap long lines for narrow screens while preserving alignment.
      'white-space:pre-wrap',
      'overflow-wrap:anywhere',
      'word-break:break-word',
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
    // Prefer the worker's drawing-buffer ratio. `window.devicePixelRatio`
    // stayed at 1.96 while Tesla rendered a 1.0 buffer, so the overlay
    // hid the softness the owner was seeing.
    const dprNum = s.renderPixelRatio > 0 ? s.renderPixelRatio : (window.devicePixelRatio || 1);
    const dpr = Number(dprNum).toFixed(2);
    const res = (s.bufferWidth > 0 && s.bufferHeight > 0)
      ? `${s.bufferWidth}×${s.bufferHeight}`
      : `${c?.width || 0}×${c?.height || 0}`;
    const renderer = this._client.rendererKind || 'unknown';
    const fps = (s.fps || 0).toFixed(1);
    const mfps = (s.mainFps || 0).toFixed(1);
    const mhz = (s.displayHz || 0).toFixed(1);
    const p95 = (s.frameMsRecentP95 || s.frameMsP95 || 0).toFixed(2);
    const p99 = (s.frameMsRecentP99 || 0).toFixed(2);
    const mp50 = (s.mainFrameMsRecentP50 || 0).toFixed(2);
    const mp95 = (s.mainFrameMsRecentP95 || 0).toFixed(2);
    const mp99 = (s.mainFrameMsRecentP99 || 0).toFixed(2);
    const gq95 = (s.gpuQueueRecentP95 || 0).toFixed(2);
    const gq99 = (s.gpuQueueRecentP99 || 0).toFixed(2);
    const fmax = (s.frameMsMax || 0).toFixed(2);
    const over8 = s.longFramesOver8_3 ?? 0;
    const over16 = s.longFramesOver16_7 ?? 0;
    const over33 = s.longFramesOver33_3 ?? 0;
    const over8T = s.longFramesOver8_3_total ?? 0;
    const over16T = s.longFramesOver16_7_total ?? 0;
    const over33T = s.longFramesOver33_3_total ?? 0;
    const aa = `${s.antiAliasing || 'None'}${s.msaaSamples > 1 ? ` (${s.msaaSamples}x)` : ''}${s.fxaaSuppressed ? ' [FXAA off]' : ''}`;
    const aq = `${s.aqCalibrated ? 'cal' : 'uncal'} base ${Number(s.aqBaselineMs || 0).toFixed(2)} ms  pressure ${Number(s.gpuPressure || 0).toFixed(2)}`;
    const events = Array.isArray(s.events) ? s.events.slice(-8) : [];
    const context = Array.isArray(s.context) ? s.context : [];
    const rate = s.rateMode ? `${s.rateMode}${s.rateDecimationN ? ` (N=${s.rateDecimationN})` : ''}` : 'unknown';
    const switches = Number(s.rateSwitches || 0);
    const hist = `hist 1x:${s.present1x ?? 0} 2x:${s.present2x ?? 0} 3x+:${s.present3x ?? 0}`;
    // Audio metrics (from main)
    const app = typeof window !== 'undefined' ? (window.__luminoirApp || null) : null;
    const ac = app?.midiPlayer?._ctx || null;
    const sr = ac?.sampleRate || 0;
    const baseLat = ac?.baseLatency || 0;
    const outLat = ac?.outputLatency || 0;
    // Long-window AudioContext/wall rate. A single ~0.5 s slice (the
    // old estimator) jitters by about ±2%, which is where a lone
    // 1.019 reading comes from. Until the window is 2 s the value
    // stays blank; a sustained drift outside ±0.8% is corrected in
    // MIDIPlayer and shown here as clock + corrected.
    const avApplied = formatSignedMs(s.avOffsetMs);
    const avOutput = formatSignedMs(s.avOutputMs, false);
    const avUser = formatSignedMs(s.avUserMs);
    const info = app?.midiPlayer?.audioClockInfo?.() || null;
    let audioSpeed = '—';
    if (info?.reliable) {
      audioSpeed = info.corrected
        ? `1.000 (clock ${info.rate.toFixed(3)} corrected)`
        : info.rate.toFixed(3);
    }
    const missesPerMin = (s.mainMissPerMin || 0).toFixed(1);
    // Present cadence, not main-thread rAF. N=2 on a 60 Hz panel is
    // 30 fps even when main p95 is 16.7 ms.
    const locked60 = !(s.displayHz > 0)
      ? '…'
      : (presentLocked60(s.displayHz, s.rateDecimationN || 1) ? 'yes' : 'no');
    if (this._collapsed) {
      this._div.textContent =
        `fps ${fps} (main ${mfps})  p95 ${p95}ms (main ${mp95}ms)  max ${fmax}ms\nGPU q p95 ${gq95}ms  ${renderer} DPR ${dpr} res ${res}\nAudio sr ${sr}Hz base ${Math.round(baseLat*1000)}ms out ${Math.round(outLat*1000)}ms speed ${audioSpeed}\nA/V applied ${avApplied}  output ${avOutput}  user ${avUser}\nRate ${rate} • switches ${switches} • ${hist}`;
      this._div.appendChild(this._toggle);
      return;
    }
    const lines = [
      `fps ${fps}  (main ${mfps})`,
      `worker p95 ${p95} ms   p99 ${p99} ms   max ${fmax} ms`,
      `main   p50 ${mp50} ms  p95 ${mp95} ms  p99 ${mp99} ms`,
      `display ${mhz} Hz  missed/min ${missesPerMin}  Locked 60: ${locked60}`,
      `GPU queue drain p95 ${gq95} ms  p99 ${gq99} ms`,
      `>8.3 ${over8} | >16.7 ${over16} | >33.3 ${over33}  (recent)`,
      `Σ>8.3 ${over8T} | Σ>16.7 ${over16T} | Σ>33.3 ${over33T} (session)`,
      `renderer ${renderer}   vsync ${s.vsyncDriver || 'unknown'}   DPR ${dpr}   res ${res}`,
      `Audio sampleRate ${sr} Hz   baseLatency ${Math.round(baseLat*1000)} ms   outputLatency ${Math.round(outLat*1000)} ms   audioSpeed ${audioSpeed}`,
      `A/V applied ${avApplied}   output ${avOutput}   user ${avUser}`,
      `AA ${aa}`,
      `AQ ${aq}`,
      `Rate ${rate}   switches ${switches}   ${hist}`,
    ];
    if (context.length > 0) {
      lines.push('');
      lines.push('Context:');
      for (const c of context) lines.push(`• ${c}`);
    }
    if (events.length > 0) {
      lines.push('');
      lines.push('Recent events:');
      for (const ev of events) lines.push(`- ${ev}`);
    }
    lines.push('');
    lines.push('Tap to reset session counters  •  Tap ▾ to collapse');
    this._div.textContent = lines.join('\n');
    this._div.appendChild(this._toggle);
  }

  dispose() {
    if (this._div) this._div.remove();
    this._div = null;
    this._client.onStats = null;
  }
}

function formatSignedMs(value, signed = true) {
  if (!Number.isFinite(value)) return '—';
  const r = Math.round(value);
  if (!signed) return `${r} ms`;
  return r > 0 ? `+${r} ms` : `${r} ms`;
}

