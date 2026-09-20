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
