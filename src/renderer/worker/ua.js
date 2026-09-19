/** Best-effort mobile detection from the worker's user-agent.  Used to
 *  pick a smaller shadow map, a cheaper PCF filter and no MSAA so iOS
 *  Safari's "frame went over 16.67 ms → rAF clamps to 30 Hz and stays
 *  there" behaviour doesn't trigger during dense passages of large
 *  scores like Jupiter.  (The framebuffer always runs at native
 *  devicePixelRatio — resolution is never reduced.) */
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

export function isTeslaUA() {
  return /Tesla|TESLA_AUTO/i.test(workerUserAgent());
}

/**
 * One-shot platform classification used by `handleInit`.
 * @returns {{ isMobile: boolean, isSafari: boolean, isTesla: boolean, isConstrained: boolean }}
 */
export function detectPlatform() {
  const isMobile = isMobileUA();
  const isSafari = isSafariUA();
  const isTesla = isTeslaUA();
  return { isMobile, isSafari, isTesla, isConstrained: isMobile || isTesla };
}
