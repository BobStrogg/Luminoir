import { describe, it, expect } from 'vitest';
import { detectPlatform } from '../../../src/renderer/worker/ua.js';

describe('detectPlatform (Tesla heuristics and override)', () => {
  it('detects Tesla via UA token "Tesla"', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Tesla/2023.44 Chrome/116.0.0.0 Safari/537.36';
    const plat = detectPlatform({ mainUA: ua, uaData: { platform: 'Linux', brands: [{ brand: 'Chromium', version: '116' }] }, maxTouchPoints: 1, screen: { width: 1920, height: 1080 } });
    expect(plat.isTesla).toBe(true);
    expect(plat.reason).toContain('ua:token');
  });

  it('detects Tesla via UA token "QtCarBrowser"', () => {
    const ua = 'QtCarBrowser/1.0 (Chromium 116) Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Safari/537.36';
    const plat = detectPlatform({ mainUA: ua, uaData: { platform: 'Linux', brands: [{ brand: 'Chromium', version: '116' }] }, maxTouchPoints: 1, screen: { width: 1920, height: 1080 } });
    expect(plat.isTesla).toBe(true);
    expect(plat.reason).toContain('ua:token');
  });

  it('detects Tesla via override param', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/116.0.0.0 Safari/537.36';
    const plat = detectPlatform({ platformOverride: 'tesla', mainUA: ua, uaData: { platform: 'Linux', brands: [{ brand: 'Chromium', version: '116' }] }, maxTouchPoints: 0, screen: { width: 1024, height: 768 } });
    expect(plat.isTesla).toBe(true);
    expect(plat.reason).toBe('override:param');
  });

  it('detects Tesla via heuristic (Linux+Chromium+touch+large landscape)', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36';
    const plat = detectPlatform({
      mainUA: ua,
      uaData: { platform: 'Linux', brands: [{ brand: 'Chromium', version: '116' }] },
      maxTouchPoints: 2,
      screen: { width: 1920, height: 1080 },
    });
    expect(plat.isTesla).toBe(true);
    expect(plat.reason).toBe('heuristic:linux+chromium+touch+large');
  });
});

