import { releaseInstanceBuffers } from './instanceLedger.js';

/**
 * Tear down one score's scene graph without freeing geometries and
 * materials the builder reuses on the next load.
 *
 * Shared extruded glyphs live in `SVG3DBuilder._geometryCache` and the
 * box-line geometry is the shared `_unitBox`. Disposing those here
 * leaves the cache pointing at zombie GPU buffers, and the next
 * `builder.build()` draws stray glyphs. Paper, title, legacy box
 * lines, and cloned per-note materials are NOT in that set — they
 * are created for this score and must be disposed or the program /
 * geometry counts climb on every switch.
 *
 * `InstancedMesh.dispose()` is what frees the WebGL instance-matrix
 * and instance-colour buffers. Removing the mesh from the scene does
 * not. On WebGPU, r172 keys each `count > 1` instanced mesh's pipeline
 * on `object.uuid`, and that pipeline stays in a strong cache until
 * the render object is disposed — `disposeRenderObject(mesh)` does
 * that without disposing the shared material.
 *
 * @param {import('three').Object3D} root
 * @param {{ geometries: Set<import('three').BufferGeometry>, materials: Set<import('three').Material> }} shared
 * @param {(mesh: import('three').Object3D) => void} [disposeRenderObject]
 */
export function disposeScoreSubtree(root, shared, disposeRenderObject) {
  const geometries = shared?.geometries || new Set();
  const materials = shared?.materials || new Set();
  root.traverse((node) => {
    if (!node.isMesh) return;
    if (node.isInstancedMesh) {
      releaseInstanceBuffers(node);
      if (typeof node.dispose === 'function') node.dispose();
    }
    if (typeof disposeRenderObject === 'function') disposeRenderObject(node);
    const geo = node.geometry;
    if (geo && !geometries.has(geo)) geo.dispose();
    const list = Array.isArray(node.material) ? node.material : [node.material];
    for (const mat of list) {
      if (mat && !materials.has(mat)) mat.dispose();
    }
  });
}

/**
 * Drop extruded geometries the score just built did not use.
 * Call after the new scene has been emitted and the previous
 * meshes have been removed, so a disposed geometry is not still
 * drawn. Returns how many geometries were released.
 *
 * @param {Map<string, import('three').BufferGeometry>} cache
 * @param {Set<string>} usedKeys
 * @returns {number}
 */
export function releaseUnusedGeometries(cache, usedKeys) {
  if (!cache || !usedKeys) return 0;
  let released = 0;
  for (const [key, geo] of cache) {
    if (usedKeys.has(key)) continue;
    geo.dispose();
    cache.delete(key);
    released++;
  }
  return released;
}
