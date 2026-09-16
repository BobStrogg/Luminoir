import * as THREE from 'three';
import { SceneConfig } from './SceneConfig.js';
import { addPaper, addTitle } from './PaperAndTitle.js';

/**
 * Pre-optimisation build path: one `THREE.Mesh` per SVG element.
 *
 * This is a correctness baseline — slow, but uses the exact same
 * geometry that the bucketed path does, with no instance matrices,
 * no chunking, no stem dedup, and no shared unit-box.  If a visual
 * regression reproduces on the bucketed path but clears here, we
 * know the bug lives in one of the bucketing helpers.
 *
 * Also populates `noteMeshMap` so the fallback supports the same
 * played-note colouring as the bucketed path — each notehead gets
 * its own cloned `_noteHeadMat` and we track the material.
 *
 * @param {import('./SVG3DBuilder.js').SVG3DBuilder} builder
 * @param {THREE.Group} root
 * @param {import('../verovio/SVGSceneParser.js').ParsedScene} parsed
 * @param {Map<string, { mesh: THREE.Mesh, index: number, material?: THREE.Material }>} noteMeshMap
 */
export function buildOneMeshPerElement(builder, root, parsed, noteMeshMap) {
  const addGlyph = (pathD, depth, material, kind, x, y, z, noteId = null, rotation = 0) => {
    const geometry = builder.makeExtrudedGeometry(pathD, depth, kind);
    if (!geometry) return;
    // Clone the material for noteheads so each one can be coloured
    // independently during playback.
    const perMeshMat = (material === builder._noteHeadMat && noteId)
      ? material.clone()
      : material;
    const mesh = new THREE.Mesh(geometry, perMeshMat);
    if (perMeshMat !== material) {
      perMeshMat.color.setRGB(
        SceneConfig.noteColor.r, SceneConfig.noteColor.g, SceneConfig.noteColor.b,
      );
    }
    mesh.position.set(x, y, z);
    if (rotation) mesh.rotation.z = rotation;
    // Match the bucketed path: frustum culling disabled on every
    // content mesh to work around a Chromium WebGPU culling bug.
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    root.add(mesh);
    if (noteId && noteMeshMap) {
      noteMeshMap.set(noteId, { mesh, index: -1, material: perMeshMat });
    }
  };

  const addBoxLine = (material, x1, y1, x2, y2, widthAcross, depth, zElevation) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;
    const geo = new THREE.BoxGeometry(len, widthAcross, depth);
    const mesh = new THREE.Mesh(geo, material);
    // Position in world space: X/Y from the line midpoint, Z from
    // the caller-supplied elevation.  See `InstanceBucketer.addBoxLine`
    // for the history behind this parameter — it used to be misnamed
    // as a Y offset and put stems on the paper plane instead of at
    // the note's hover height.
    mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, zElevation);
    if (Math.abs(dy) > 0.0001) mesh.rotation.z = Math.atan2(dy, dx);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    root.add(mesh);
  };

  // Notes
  for (const note of parsed.notes) {
    if (note.glyphPath) {
      addGlyph(note.glyphPath, SceneConfig.extrusionDepth, builder._noteHeadMat,
        'glyph', note.x, note.y, SceneConfig.noteElevation, note.id);
    }
    const offX = (note.ancestorX ?? 0) - note.x;
    const offY = (note.ancestorY ?? 0) - note.y;
    for (const d of note.childPaths) {
      addGlyph(d, SceneConfig.extrusionDepth * 0.5, builder._noteMat,
        'path', note.x + offX, note.y + offY, SceneConfig.noteElevation);
    }
  }

  // Other elements
  for (const el of parsed.otherElements) {
    if (el.glyphPath) {
      addGlyph(el.glyphPath, SceneConfig.extrusionDepth * 0.8, builder._otherMat,
        'glyph', el.x, el.y, SceneConfig.otherElementsElevation, null, el.rotation || 0);
    } else if (el.d) {
      addGlyph(el.d, SceneConfig.extrusionDepth * 0.5, builder._otherMat,
        'path', el.x, el.y, SceneConfig.otherElementsElevation, null, el.rotation || 0);
    }
  }

  // Staff lines
  for (const sl of parsed.staffLines) {
    if (sl.isLine) {
      addBoxLine(builder._staffMat, sl.x1, sl.y1, sl.x2, sl.y2,
        SceneConfig.staffLineThickness,
        SceneConfig.staffLineThickness * 0.5,
        SceneConfig.staffLineElevation);
    } else if (sl.d) {
      addGlyph(sl.d, 16, builder._staffMat, 'path', sl.x || 0, sl.y || 0,
        SceneConfig.staffLineElevation);
    }
  }

  // Bar lines
  for (const bl of parsed.barLines) {
    if (bl.isLine) {
      addBoxLine(builder._barMat, bl.x1, bl.y1, bl.x2, bl.y2,
        SceneConfig.barLineWidth,
        SceneConfig.barLineWidth * 0.5,
        SceneConfig.barLineElevation);
    } else if (bl.d) {
      addGlyph(bl.d, 20, builder._barMat, 'path', bl.x || 0, bl.y || 0,
        SceneConfig.barLineElevation);
    }
  }

  // Paper backdrop
  addPaper(root, parsed);
  if (parsed.title) {
    // Matches the original `_buildOneMeshPerElement` behaviour: it
    // called `_addTitle` without a layout argument, which early-returns
    // — the fallback path never draws the title.
    addTitle(root, parsed, null, builder._otherMat);
  }
}
