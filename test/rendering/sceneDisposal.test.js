import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { disposeScoreSubtree, releaseUnusedGeometries } from '../../src/rendering/sceneDisposal.js';

function disposed(obj) {
  let n = 0;
  obj.addEventListener('dispose', () => { n++; });
  return () => n;
}

describe('disposeScoreSubtree', () => {
  it('frees per-score resources and keeps the shared cache', () => {
    const sharedGeo = new THREE.BufferGeometry();
    const sharedMat = new THREE.MeshBasicMaterial();
    const paperGeo = new THREE.PlaneGeometry(1, 1);
    const paperMat = new THREE.MeshBasicMaterial();
    const cloneMat = sharedMat.clone();
    const root = new THREE.Group();

    const paper = new THREE.Mesh(paperGeo, paperMat);
    paper.name = 'paper';
    root.add(paper);

    const instanced = new THREE.InstancedMesh(sharedGeo, sharedMat, 4);
    const instancedDispose = vi.spyOn(instanced, 'dispose');
    root.add(instanced);

    const single = new THREE.Mesh(sharedGeo, cloneMat);
    root.add(single);

    const sharedGeoDisposed = disposed(sharedGeo);
    const sharedMatDisposed = disposed(sharedMat);
    const paperGeoDisposed = disposed(paperGeo);
    const paperMatDisposed = disposed(paperMat);
    const cloneDisposed = disposed(cloneMat);
    const renderDisposals = [];

    disposeScoreSubtree(root, {
      geometries: new Set([sharedGeo]),
      materials: new Set([sharedMat]),
    }, (mesh) => renderDisposals.push(mesh));

    expect(instancedDispose).toHaveBeenCalledTimes(1);
    expect(sharedGeoDisposed()).toBe(0);
    expect(sharedMatDisposed()).toBe(0);
    expect(paperGeoDisposed()).toBe(1);
    expect(paperMatDisposed()).toBe(1);
    expect(cloneDisposed()).toBe(1);
    expect(renderDisposals).toEqual([paper, instanced, single]);
  });
});

describe('releaseUnusedGeometries', () => {
  it('disposes cache entries the latest score did not use', () => {
    const keep = new THREE.BufferGeometry();
    const drop = new THREE.BufferGeometry();
    const cache = new Map([['keep', keep], ['drop', drop]]);
    const dropped = disposed(drop);
    const kept = disposed(keep);
    const n = releaseUnusedGeometries(cache, new Set(['keep']));
    expect(n).toBe(1);
    expect(dropped()).toBe(1);
    expect(kept()).toBe(0);
    expect([...cache.keys()]).toEqual(['keep']);
  });
});
