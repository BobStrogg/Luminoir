import * as THREE from 'three';
import { OPTIMIZATIONS } from './Optimizations.js';

/**
 * Emit a single plain `THREE.Mesh` for the count-1 fast path.
 *
 * Three.js 0.172 WebGPU bug: `InstancedMesh` with `count === 1`
 * renders with the instance matrix effectively ignored (the single
 * instance appears at world origin with its raw geometry, not at
 * `setMatrixAt(0, ...)`).  Root cause: `InstanceNode` wraps the
 * instance-matrix array in a UBO for count ≤ 1000 but never reuploads
 * it for the count-1 fast path.  Workaround: emit a plain `Mesh`
 * instead — no perf cost because the bucket only has one draw-call
 * either way.
 */
export function emitSingleMesh(root, geometry, material, matrix, noteId, defaultInstanceColor, noteMeshMap, tagLod) {
  // Clone the material for a single notehead so it can be
  // recoloured independently of any shared material — otherwise
  // every notehead using this path-d would change colour at once.
  const perMeshMat = (noteId && defaultInstanceColor)
    ? material.clone()
    : material;
  if (perMeshMat !== material && defaultInstanceColor) {
    perMeshMat.color.copy(defaultInstanceColor);
  }
  const mesh = new THREE.Mesh(geometry, perMeshMat);
  mesh.applyMatrix4(matrix);
  // Chromium WebGPU + `InstancedMesh.frustumCulled` interact
  // badly on some drivers: the per-mesh bounding sphere is
  // computed correctly but the rasteriser sporadically treats
  // chunks as outside the view volume at oblique camera angles,
  // leaving notes popping in and out as the user orbits.  Safari
  // WebKit's WebGPU doesn't repro.  Disabling frustum culling
  // entirely on the score content is a safe trade — with chunking
  // off we already draw every bucket every frame anyway, so we
  // lose no cullable draw calls.
  mesh.frustumCulled = false;
  // Every notation mesh casts a shadow onto the paper.  The
  // paper itself opts in to `receiveShadow` in `addPaper`.
  mesh.castShadow = true;
  tagLod(mesh);
  root.add(mesh);
  if (noteId && noteMeshMap) {
    noteMeshMap.set(noteId, { mesh, index: -1, material: perMeshMat });
  }
}

/**
 * Emit one `InstancedMesh` covering `items` (`{ m, noteId }` entries).
 * `frustumCulled` stays caller-controlled: the un-chunked path
 * disables it (the bucket spans the whole score so culling never
 * helps), while the chunked path leaves it on so Three.js can skip
 * off-screen chunks.
 */
function emitInstancedMesh(root, geometry, material, items, defaultInstanceColor, noteMeshMap, tagLod, frustumCulled) {
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  for (let i = 0; i < items.length; i++) mesh.setMatrixAt(i, items[i].m);
  mesh.instanceMatrix.needsUpdate = true;
  // `computeBoundingSphere` here walks every instance matrix and
  // unions the per-instance sphere — essential for the chunked path,
  // because the default sphere is the single-instance geometry
  // sphere centred at the origin, which would mis-cull everything
  // drawn more than a note-head's width from (0,0,0).
  mesh.computeBoundingSphere();
  mesh.frustumCulled = frustumCulled;
  mesh.castShadow = true;
  // Pre-seed the instance-colour buffer so unplayed notes render
  // at noteColor even with the white-base material.  `setColorAt`
  // lazily allocates `mesh.instanceColor` on first call.
  if (defaultInstanceColor) {
    for (let i = 0; i < items.length; i++) mesh.setColorAt(i, defaultInstanceColor);
    mesh.instanceColor.needsUpdate = true;
  }
  // Build noteId → (mesh, index) entries for the render worker.
  if (noteMeshMap) {
    for (let i = 0; i < items.length; i++) {
      const id = items[i].noteId;
      if (id) noteMeshMap.set(id, { mesh, index: i });
    }
  }
  tagLod(mesh);
  root.add(mesh);
}

/**
 * Emit one or more `InstancedMesh`es from a list of instance
 * matrices, partitioning the instances by X chunk so Three.js's
 * per-mesh frustum culling also does coarse horizontal culling.
 *
 * With a single un-chunked `InstancedMesh` the bounding sphere
 * spans the entire score, so all instances are always drawn.
 * Chunking to ~4 world units per mesh lets the renderer skip 95 %+
 * of instances on a Sylvia-Suite-sized score.
 *
 * @param {THREE.Group} root
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} material
 * @param {THREE.Matrix4[]} matrices
 * @param {number} chunkWidth
 * @param {THREE.Color=} defaultInstanceColor  Default per-instance
 *   tint to pre-populate on the InstancedMesh's `instanceColor`
 *   buffer.  Non-null for noteheads (using the white-base
 *   `_noteHeadMat`): we init all instances to noteColor so unplayed
 *   notes render identically to the other, dark-material meshes.
 * @param {(string|null)[]=} noteIds  Parallel to `matrices`; the
 *   stable SVG id of the note that owns each instance, or null for
 *   non-note instances.  Only populated for notehead buckets.
 * @param {Map<string, { mesh: THREE.Mesh, index: number, material?: THREE.Material }>=} noteMeshMap
 *   Output map; populated with a `(mesh, index)` entry for every
 *   entry in `noteIds` that is a stable note id.  When the bucket
 *   collapses to a single plain `THREE.Mesh` (count === 1 fast
 *   path) the material is cloned so the single note can still be
 *   recoloured without affecting the shared `_noteHeadMat`, and
 *   `{ mesh, index: -1, material }` is stored instead.
 * @param {{ lodSize?: number, lodDetail?: boolean }=} lodInfo
 */
export function emitInstancedChunks(
  root, geometry, material, matrices, chunkWidth,
  defaultInstanceColor = null, noteIds = null, noteMeshMap = null,
  lodInfo = null,
) {
  if (matrices.length === 0) return;
  // Stamp the LOD metadata on every mesh this call emits.  The render
  // worker collects meshes with a `lodSize`/`lodDetail` tag after each
  // scene build and gates their `.visible` from camera distance — see
  // `LodGate` in the render worker (LOD_DISTANT_ELEMENTS /
  // DISTANCE_CLIP_GLYPHS).
  const tagLod = (mesh) => {
    if (lodInfo && (lodInfo.lodSize > 0 || lodInfo.lodDetail)) {
      mesh.userData.lodSize = lodInfo.lodSize;
      mesh.userData.lodDetail = lodInfo.lodDetail;
    }
  };
  if (matrices.length === 1) {
    emitSingleMesh(root, geometry, material, matrices[0],
      noteIds ? noteIds[0] : null, defaultInstanceColor, noteMeshMap, tagLod);
    return;
  }
  if (!OPTIMIZATIONS.CHUNK_BUCKETS_BY_X) {
    // One InstancedMesh per bucket, no horizontal chunking.  The
    // whole bucket always passes the frustum test because its
    // bounding sphere spans the entire score, so we draw every
    // instance every frame — but we keep draw-call count == bucket
    // count (usually 20-50 for SMuFL music).
    const items = new Array(matrices.length);
    for (let i = 0; i < matrices.length; i++) {
      items[i] = { m: matrices[i], noteId: noteIds ? noteIds[i] : null };
    }
    emitInstancedMesh(root, geometry, material, items,
      defaultInstanceColor, noteMeshMap, tagLod, false);
    return;
  }
  // Group matrices by X-chunk.  Matrix4 stores translation in
  // `.elements[12..14]`, so `elements[12]` is tx (world X).
  /** @type {Map<number, { m: THREE.Matrix4, noteId: string|null }[]>} */
  const byChunk = new Map();
  for (let i = 0; i < matrices.length; i++) {
    const m = matrices[i];
    const tx = m.elements[12];
    const chunk = Math.floor(tx / chunkWidth);
    let arr = byChunk.get(chunk);
    if (!arr) { arr = []; byChunk.set(chunk, arr); }
    arr.push({ m, noteId: noteIds ? noteIds[i] : null });
  }
  for (const arr of byChunk.values()) {
    // Same WebGPU count=1 workaround as in emitSingleMesh.
    if (arr.length === 1) {
      emitSingleMesh(root, geometry, material, arr[0].m,
        arr[0].noteId, defaultInstanceColor, noteMeshMap, tagLod);
      continue;
    }
    emitInstancedMesh(root, geometry, material, arr,
      defaultInstanceColor, noteMeshMap, tagLod, true);
  }
}
