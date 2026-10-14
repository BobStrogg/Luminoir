/** Best-effort mobile detection from the worker's user-agent.  Used to
 *  pick a smaller shadow map, a cheaper PCF filter and no MSAA so iOS
 *  Safari's "frame went over 16.67 ms → rAF clamps to 30 Hz and stays
 *  there" behaviour doesn't trigger during dense passages of large
 *  scores like Jupiter.  Desktop and phones keep the native
 *  devicePixelRatio. Tesla is the exception: a load-time pixel budget
 *  (see chooseTeslaPixelRatio), never a runtime DPR change. */
export function workerUserAgent() {
  return (typeof self !== 'undefined' && self.navigator && self.navigator.userAgent) || '';
}

export function isMobileUA() {
  return /iPhone|iPad|iPod|Android|Mobile/i.test(workerUserAgent());
}

export function isSafariUA() {
  const ua = workerUserAgent();
  return /AppleWebKit/i.test(ua)
    && /Safari/i.test(ua)
    && !/(Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android)/i.test(ua);
}

export function isTeslaUA(ua = workerUserAgent()) {
  return /Tesla|TESLA_AUTO|QtCarBrowser/i.test(ua);
}

/**
 * One-shot platform classification used by `handleInit`.
 * Accepts optional hints from the main thread to improve robustness on
 * embedded browsers (e.g., Tesla) whose UA may not include a Tesla token.
 * @param {{ platformOverride?: string, mainUA?: string, uaData?: { platform?: string, brands?: Array<{brand:string,version?:string}> }, maxTouchPoints?: number, screen?: { width?: number, height?: number }, vendor?: string }} [hints]
 * @returns {{ isMobile: boolean, isSafari: boolean, isTesla: boolean, isConstrained: boolean, reason: string, ua: string, uaData?: any }}
 */
export function detectPlatform(hints = {}) {
  const uaWorker = workerUserAgent();
  const ua = hints.mainUA || uaWorker;
  const isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
  const isSafari = (() => {
    return /AppleWebKit/i.test(ua)
      && /Safari/i.test(ua)
      && !/(Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android)/i.test(ua);
  })();
  let isTesla = false;
  let reason = '';
  // 1) Explicit override via URL param
  if (String(hints.platformOverride || '').toLowerCase() === 'tesla') {
    isTesla = true; reason = 'override:param';
  }
  // 2) UA tokens
  if (!isTesla && isTeslaUA(ua)) {
    isTesla = true; reason = 'ua:token';
  }
  // 3) Heuristics: Linux/X11 Chromium + touch + large landscape screen typical of in-car display.
  if (!isTesla) {
    const plat = String(hints.uaData?.platform || (self?.navigator?.platform || '')).toLowerCase();
    const brandsText = Array.isArray(hints.uaData?.brands) ? hints.uaData.brands.map(b => b.brand).join(',') : '';
    const isLinux = /linux|x11/.test(plat) || /x11; linux/i.test(ua);
    const isChromiumBrand = /Chrom/i.test(ua) || /chrom/i.test(brandsText);
    const touch = Number(hints.maxTouchPoints || (self?.navigator?.maxTouchPoints || 0));
    const sw = Number(hints.screen?.width || 0);
    const sh = Number(hints.screen?.height || 0);
    const largeLandscape = (Math.max(sw, sh) >= 1200) && (Math.max(sw, sh) / Math.max(1, Math.min(sw, sh)) >= 1.2);
    if (isLinux && isChromiumBrand && touch > 0 && largeLandscape) {
      isTesla = true; reason = 'heuristic:linux+chromium+touch+large';
    }
  }
  // 4) Fallback to worker UA detection only (legacy)
  if (!isTesla && isTeslaUA(uaWorker)) {
    isTesla = true; reason = 'ua:token(worker)';
  }
  return {
    isMobile,
    isSafari,
    isTesla,
    isConstrained: isMobile || isTesla,
    reason,
    ua,
    uaData: hints.uaData || null,
  };
}
