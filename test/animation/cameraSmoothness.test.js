import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import { CameraController } from '../../src/animation/CameraController.js';
import { SceneConfig } from '../../src/rendering/SceneConfig.js';

function diffSeries(values, dts) {
  const out = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i++) {
    const dt = Math.max(1e-6, dts[i]);
    out[i] = (values[i] - values[i - 1]) / dt;
  }
  return out;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i];
}

describe('CameraController smoothness', () => {
  it('keeps acceleration/jerk near zero on constant-velocity track (60 Hz)', () => {
    // Synthetic linear track: constant velocity → acceleration and jerk ≈ 0
    const times = new Float64Array([0, 1, 2, 3, 4, 5]);
    const xs = new Float64Array([0, 1, 2, 3, 4, 5]);
    // Controls stub
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
    const controls = {
      target: new THREE.Vector3(),
      enableDamping: false,
      dampingFactor: 0.12,
      syncUpdate: () => {},
      update: () => {},
    };
    const ctrl = new CameraController(camera, controls);
    // Score framing not relevant for X follow; set something believable
    ctrl.configureForScore(-1, 1);
    // Inject track directly
    ctrl._track = { times, xs };
    SceneConfig.smartCamera.enabled = false;
    SceneConfig.camera.smoothTargetTrack = true;
    // Snap to start
    ctrl.snapToTarget(new THREE.Vector3(xs[0], 0, 0), xs[0]);

    const hz = 60;
    const dt = 1 / hz;
    const duration = 4; // seconds
    const steps = Math.round(duration * hz);
    const camX = [];
    const dts = [];
    let nowMs = 0;
    for (let i = 0; i < steps; i++) {
      const tSec = nowMs / 1000;
      const xTime = ctrl.xAtTime(tSec);
      ctrl.setTarget(new THREE.Vector3(xTime ?? 0, 0, 0), xTime ?? 0);
      ctrl.update(dt, nowMs);
      camX.push(camera.position.x);
      dts.push(dt);
      nowMs += dt * 1000;
    }
    const v = diffSeries(camX, dts);
    const a = diffSeries(v, dts);
    const j = diffSeries(a, dts);
    const aAbs = a.map(Math.abs);
    const jAbs = j.map(Math.abs);
    const aP95 = Math.abs(percentile(aAbs, 95));
    const jP95 = Math.abs(percentile(jAbs, 95));
    // Print for local tuning if needed
    // eslint-disable-next-line no-console
    console.log({ aP95, jP95 });
    // Guardrails: with a constant-velocity target, smoothing should keep
    // acceleration/jerk bounded without extreme spikes.
    expect(aP95).toBeLessThan(1.0);
    expect(jP95).toBeLessThan(50.0);
  });
});

