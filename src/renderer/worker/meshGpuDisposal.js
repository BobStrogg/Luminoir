/**
 * Track WebGPU render objects per mesh so a score switch can dispose
 * them.
 *
 * Three.js r172 puts `object.uuid` in the pipeline cache key of every
 * `InstancedMesh` with `count > 1`. The node-builder and pipeline maps
 * are strong, and `usedTimes` only falls when `RenderObject.dispose()`
 * runs. That happens from the material's dispose event. Notation
 * meshes share a handful of materials, so disposing the material would
 * also drop the live score. The mesh's own `dispose()` frees WebGL
 * instance buffers but the WebGPU renderer never listens for it.
 *
 * Wrapping `createRenderObject` remembers every render object (main
 * pass and shadow pass) and disposes each one exactly once.
 *
 * @param {object} renderer
 * @returns {{ installed: boolean, dispose: (mesh: object) => void, trackedMeshes: number, trackedObjects: number }}
 */
export function installMeshGpuDisposal(renderer) {
  const objects = renderer?._objects;
  if (!objects || typeof objects.createRenderObject !== 'function') {
    return {
      installed: false,
      dispose() {},
      get trackedMeshes() { return 0; },
      get trackedObjects() { return 0; },
    };
  }

  /** @type {Map<object, Set<object>>} */
  const byMesh = new Map();
  const orig = objects.createRenderObject.bind(objects);
  objects.createRenderObject = function (nodes, geometries, rendererArg, object, ...rest) {
    const ro = orig(nodes, geometries, rendererArg, object, ...rest);
    let set = byMesh.get(object);
    if (!set) {
      set = new Set();
      byMesh.set(object, set);
    }
    set.add(ro);
    const prev = ro.onDispose;
    let disposed = false;
    const origDispose = ro.dispose.bind(ro);
    ro.dispose = () => {
      if (disposed) return;
      disposed = true;
      origDispose();
    };
    ro.onDispose = () => {
      set.delete(ro);
      if (set.size === 0) byMesh.delete(object);
      if (typeof prev === 'function') prev();
    };
    return ro;
  };

  return {
    installed: true,
    dispose(mesh) {
      const set = byMesh.get(mesh);
      if (!set) return;
      for (const ro of [...set]) {
        try { ro.dispose(); } catch { /* already released */ }
      }
      byMesh.delete(mesh);
    },
    get trackedMeshes() { return byMesh.size; },
    get trackedObjects() {
      let n = 0;
      for (const set of byMesh.values()) n += set.size;
      return n;
    },
  };
}
