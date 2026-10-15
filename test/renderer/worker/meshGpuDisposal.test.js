import { describe, expect, it, vi } from 'vitest';
import { installMeshGpuDisposal } from '../../../src/renderer/worker/meshGpuDisposal.js';

function fakeRenderer() {
  const created = [];
  const renderer = {
    _objects: {
      createRenderObject(nodes, geometries, rendererArg, object) {
        const ro = {
          object,
          onDispose: null,
          dispose() { this.onDispose?.(); },
        };
        created.push(ro);
        return ro;
      },
    },
  };
  return { renderer, created };
}

describe('installMeshGpuDisposal', () => {
  it('disposes every render object for a mesh once', () => {
    const { renderer, created } = fakeRenderer();
    const tracker = installMeshGpuDisposal(renderer);
    const mesh = { name: 'notes' };
    const a = renderer._objects.createRenderObject(null, null, renderer, mesh);
    const b = renderer._objects.createRenderObject(null, null, renderer, mesh);
    const spyA = vi.spyOn(a, 'dispose');
    const spyB = vi.spyOn(b, 'dispose');
    expect(tracker.trackedMeshes).toBe(1);
    expect(tracker.trackedObjects).toBe(2);
    tracker.dispose(mesh);
    tracker.dispose(mesh);
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
    expect(tracker.trackedMeshes).toBe(0);
    expect(tracker.trackedObjects).toBe(0);
    expect(created).toHaveLength(2);
  });

  it('is a no-op on the WebGL renderer', () => {
    const tracker = installMeshGpuDisposal({});
    expect(tracker.installed).toBe(false);
    expect(() => tracker.dispose({})).not.toThrow();
    expect(tracker.trackedMeshes).toBe(0);
  });
});
