/**
 * Bytes of InstancedMesh instanceMatrix / instanceColor storage
 * allocated and not yet disposed.
 *
 * Three.js frees those GPU buffers only when `InstancedMesh.dispose()`
 * runs. Dropping the mesh from the scene leaves the WebGL buffer
 * orphaned, and `renderer.info.memory.geometries` does not count it.
 * The score-switch bench reads `instanceBytesOutstanding()` to prove
 * the buffers come back down with the live score.
 */
let outstanding = 0;

/** @param {import('three').InstancedMesh} mesh */
export function retainInstanceBuffers(mesh) {
  const bytes = (mesh.instanceMatrix?.array?.byteLength || 0)
    + (mesh.instanceColor?.array?.byteLength || 0);
  mesh.userData.instanceBytes = bytes;
  outstanding += bytes;
}

/** @param {import('three').InstancedMesh} mesh */
export function releaseInstanceBuffers(mesh) {
  const bytes = mesh.userData?.instanceBytes || 0;
  if (!bytes) return;
  outstanding -= bytes;
  mesh.userData.instanceBytes = 0;
}

export function instanceBytesOutstanding() {
  return outstanding;
}
