import { describe, it, expect } from 'vitest';
import { LodGate } from '../../../src/renderer/worker/LodGate.js';

/** Minimal mesh stub — LodGate only reads `isMesh`/`userData` and
 *  writes `castShadow`/`visible`. */
function mesh(userData = {}) {
  return { isMesh: true, userData, castShadow: true, visible: true };
}
function rootOf(meshes) {
  return { traverse(fn) { for (const m of meshes) fn(m); } };
}

describe('LodGate caster suppression', () => {
  it('permanently drops detail casters on constrained platforms', () => {
    const detail = mesh({ lodDetail: true });
    const sized = mesh({ lodSize: 2 });   // structural, still a caster
    const plain = mesh({});               // untagged — not managed at all
    const gate = new LodGate();
    gate.constrained = true;
    gate.collect(rootOf([detail, sized, plain]));
    expect(detail.castShadow).toBe(false);
    expect(sized.castShadow).toBe(true);   // structural casters stay
    expect(plain.castShadow).toBe(true);
    expect(gate.castersHidden).toBe(true);
    // Pressure churn must not flip them back on.
    gate.updateCasters(0);
    expect(detail.castShadow).toBe(false);
  });

  it('leaves casters alone on non-constrained platforms at rest', () => {
    const detail = mesh({ lodDetail: true });
    const sized = mesh({ lodSize: 2 });
    const gate = new LodGate();
    gate.collect(rootOf([detail, sized]));
    expect(detail.castShadow).toBe(true);
    expect(gate.castersHidden).toBe(false);
  });

  it('gates detail casters under pressure with hysteresis', () => {
    const detail = mesh({ lodDetail: true });
    const sized = mesh({ lodSize: 2 });
    const gate = new LodGate();
    gate.collect(rootOf([detail, sized]));
    gate.updateCasters(0.4);
    expect(detail.castShadow).toBe(true);   // below the 0.55 engage point
    gate.updateCasters(0.6);
    expect(detail.castShadow).toBe(false);
    expect(sized.castShadow).toBe(true);    // only lodDetail is affected
    gate.updateCasters(0.4);
    expect(detail.castShadow).toBe(false);  // hysteresis holds it off
    gate.updateCasters(0.2);
    expect(detail.castShadow).toBe(true);   // recovered below 0.30
  });
});

function cameraAt(distance) {
  return { fov: 45, position: { distanceTo: () => distance } };
}
function lookingAt(x) {
  return { target: { x, y: 0, z: 0 } };
}
/** Detail chunk centred at score X. */
function chunk(x, radius, userData) {
  return {
    isMesh: true,
    visible: true,
    castShadow: true,
    count: 4,
    userData,
    boundingSphere: { center: { x }, radius },
    position: { x: 0, y: 0, z: 0 },
  };
}

describe('LodGate distance order', () => {
  it('keeps the playhead stem when zoom would previously hide every stem', () => {
    const near = chunk(10, 1, { lodDetail: true, lodSize: 0.007 });
    const far = chunk(40, 1, { lodDetail: true, lodSize: 0.007 });
    const gate = new LodGate();
    gate.collect(rootOf([near, far]));
    gate.snapGovernor(6);
    // Camera is 20 wu from the target — the old rule hid all detail
    // past 12 wu, and full pressure shrank that to 3.6.
    gate.apply(cameraAt(20), lookingAt(10), 1, 800, 1);
    expect(near.visible).toBe(true);
    expect(far.visible).toBe(false);
    expect(gate.nearHiddenCount).toBe(0);
  });

  it('does not sub-pixel-cull a stem sitting on the playhead', () => {
    const stem = chunk(0, 0.5, { lodDetail: true, lodSize: 0.007 });
    const gate = new LodGate();
    gate.collect(rootOf([stem]));
    gate.snapGovernor(36);
    gate.apply(cameraAt(40), lookingAt(0), 1, 100, 1);
    expect(stem.visible).toBe(true);
  });

  it('never hides a chunk with no anchor', () => {
    const stem = mesh({ lodDetail: true, lodSize: 0.007 });
    const gate = new LodGate();
    gate.collect(rootOf([stem]));
    gate.snapGovernor(6);
    gate.apply(cameraAt(30), lookingAt(100), 1, 800, 1);
    expect(stem.visible).toBe(true);
  });

  it('sub-pixel-culls a far glyph and keeps a near one', () => {
    const near = chunk(0, 0.2, { lodDetail: false, lodSize: 0.001 });
    const far = chunk(30, 0.2, { lodDetail: false, lodSize: 0.001 });
    const gate = new LodGate();
    gate.collect(rootOf([near, far]));
    gate.apply(cameraAt(20), lookingAt(0), 1, 800, 0);
    expect(near.visible).toBe(true);
    expect(far.visible).toBe(false);
  });
});
