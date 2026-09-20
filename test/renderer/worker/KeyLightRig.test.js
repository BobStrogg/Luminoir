import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { KeyLightRig } from '../../../src/renderer/worker/KeyLightRig.js';

/** Build a rig with lights added to a throwaway scene.  `renderer` is
 *  null — `applyShadowEnabled` early-returns without one, which is all
 *  we need for the math under test. */
function rig(isMobile, isConstrained) {
  const r = new KeyLightRig();
  r.setupLighting(new THREE.Scene(), isMobile, null, isConstrained);
  return r;
}

describe('KeyLightRig.fitToScore (frozen / constrained path)', () => {
  it('covers the whole score and never re-renders', () => {
    const r = rig(true, true);
    expect(r.frozen).toBe(true);
    r.fitToScore({ contentMinX: 0, contentMinY: 0, totalWidth: 40, totalHeight: 10 });
    const cam = r.light.shadow.camera;
    // Score-local X → world X (40 wu + margins), projected into light
    // space — the fitted frustum must span at least that.
    expect(cam.right - cam.left).toBeGreaterThan(42);
    expect(r.light.shadow.autoUpdate).toBe(false);
    expect(r.light.shadow.needsUpdate).toBe(true);
    // A huge camera jump must not move the light or re-arm the map.
    const px = r.light.position.x;
    r.light.shadow.needsUpdate = false;
    r.update(100, 100);
    expect(r.light.position.x).toBe(px);
    expect(r.light.shadow.needsUpdate).toBe(false);
  });

  it('keeps recentring on the non-frozen path', () => {
    const r = rig(false, false);
    expect(r.frozen).toBe(false);
    r.resetSnap();                        // clear init-time seed/throttle state
    r.update(0, 0, 1000);                 // seeds the snapped position
    r.light.shadow.needsUpdate = false;
    r.update(10, 10, 1100);               // past the 2 wu dead zone
    expect(r.light.shadow.needsUpdate).toBe(true);
  });

  it('falls back to recentering on malformed score bounds', () => {
    const r = rig(true, true);
    const cam = r.light.shadow.camera;
    const w = cam.right - cam.left;
    r.fitToScore({ contentMinX: 0, contentMinY: 0, totalWidth: NaN, totalHeight: 10 });
    expect(cam.right - cam.left).toBe(w);
    expect(r.frozen).toBe(false);
  });
});
