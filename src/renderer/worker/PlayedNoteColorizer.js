import * as THREE from 'three';
import { SceneConfig } from '../../rendering/SceneConfig.js';
import { assignStaffColorIndices } from '../../animation/staffColors.js';

/**
 * Per-note playback colouring: walks the played timeline in whichever
 * direction music time moved, applying staff-colour tints to
 * newly-crossed noteheads and reverting tints on entries that are now
 * in the future.
 */
export class PlayedNoteColorizer {
  /** noteId → { mesh, index, material? } mapping built by SVG3DBuilder.
   *  Populated in `setScene`; used by the per-frame colouring
   *  loop below and reset to null on dispose / scene rebuild. */
  /** @type {Map<string, { mesh: any, index: number, material?: any }> | null} */
  _noteMeshMap = null;

  /** Timeline entries (sorted by time) with `{ time, id, staff, x, y }`.
   *  Used to advance the played-note cursor each frame. */
  /** @type {Array<{ time: number, id: string, staff: number, x: number, y: number }> | null} */
  _playedTimeline = null;

  /** How far through `_playedTimeline` we've already coloured.  On
   *  scrub-back we roll the cursor back and revert each entry. */
  _playedCursor = 0;

  /** staff-number → THREE.Color for the note tint applied when a note
   *  from that staff plays.  Assigned in the same iteration order as
   *  `LightBallController.setEvents()` so the colours visually match
   *  each staff's light ball. */
  /** @type {Map<number, THREE.Color>} */
  _staffColors = new Map();

  /** THREE.Color shared across all un-coloured notes — allocated once
   *  per scene rebuild and mutated with the current `SceneConfig.noteColor`
   *  so a live theme change would propagate without re-alloc. */
  _defaultNoteColor = new THREE.Color(
    SceneConfig.noteColor.r, SceneConfig.noteColor.g, SceneConfig.noteColor.b,
  );

  /** Meshes whose `instanceColor` buffer was written this frame —
   *  we flag `needsUpdate = true` in one pass at the end of each
   *  cursor advance / rollback batch rather than per setColorAt call. */
  _dirtyInstanceMeshes = new Set();

  /** Replace the per-scene note-mesh map.  Previous entries point at
   *  meshes that just got removed from the scene, so they must not
   *  leak into the next score's colour updates. */
  setScene(noteMeshMap) {
    this._noteMeshMap = noteMeshMap;
    this._playedTimeline = null;
    this._playedCursor = 0;
    this._staffColors.clear();
    this._dirtyInstanceMeshes.clear();
    this._defaultNoteColor.setRGB(
      SceneConfig.noteColor.r, SceneConfig.noteColor.g, SceneConfig.noteColor.b,
    );
  }

  /**
   * Build the staff → colour map that the per-frame colouring loop
   * uses, store the timeline, and reset the played cursor so a new
   * score starts fresh.  We don't pre-apply default colours here
   * because every notehead mesh was built with
   * `instanceColor = noteColor` already by SVG3DBuilder.  The render
   * loop will set colours on the fly as the transport advances past
   * each entry.
   *
   * Matching the exact assignment order of
   * `LightBallController.setEvents()` — first-seen staff order from
   * `assignStaffColorIndices`, cycling through
   * `SceneConfig.lightBall.colors` — guarantees a played note's
   * colour matches its light ball.
   *
   * The palette colours are the *bright* hues used by the hovering
   * light ball; on a played notehead we want a darker, muted
   * version so the note stands out from unplayed notes without
   * competing with the moving light ball above it.  `playedNote.
   * darkness` in `SceneConfig` scales each channel down; the
   * `Materials.noteHead` fragment shader adds a per-instance
   * emissive contribution in the same hue so the darker colour
   * reads as a soft inner glow rather than a matte fill.
   */
  setTimeline(timeline) {
    this._staffColors.clear();
    const palette = SceneConfig.lightBall.colors;
    const darkness = SceneConfig.playedNote.darkness;
    for (const [staff, idx] of assignStaffColorIndices(timeline)) {
      const c = palette[idx % palette.length];
      this._staffColors.set(staff, new THREE.Color(c.r * darkness, c.g * darkness, c.b * darkness));
    }
    this._playedTimeline = timeline;
    this._playedCursor = 0;
  }

  /**
   * Apply (or revert to default) the per-note tint on the tracked
   * notehead mesh for `noteId`.
   *
   * For InstancedMesh-backed notes (`index >= 0`) we call
   * `setColorAt(index, color)` and defer the `needsUpdate` flag to
   * `_flushDirtyMeshes()` below.  For the count-1 plain-Mesh fallback
   * (`index === -1`) we update the cloned per-mesh material's
   * `.color` directly — no per-frame upload, it's applied on the
   * next render.
   *
   * @param {string} noteId
   * @param {THREE.Color} color
   */
  _applyNoteColor(noteId, color) {
    const entry = this._noteMeshMap && this._noteMeshMap.get(noteId);
    if (!entry) return;
    if (entry.index >= 0 && entry.mesh && entry.mesh.isInstancedMesh) {
      entry.mesh.setColorAt(entry.index, color);
      this._dirtyInstanceMeshes.add(entry.mesh);
    } else if (entry.material && entry.material.color) {
      entry.material.color.copy(color);
    }
  }

  _flushDirtyMeshes() {
    const count = this._dirtyInstanceMeshes.size;
    for (const mesh of this._dirtyInstanceMeshes) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this._dirtyInstanceMeshes.clear();
    return count;
  }

  /**
   * Walk `_playedTimeline` in whichever direction `musicTime` moved
   * since last frame, applying staff-colour tints to newly-crossed
   * entries and reverting tints on entries that are now in the future
   * (e.g. user scrubbed backward, or transport reset to the start).
   *
   * Cheaper than a full timeline scan per frame — we keep `_playedCursor`
   * as a fast-path pointer and only ever touch the delta from the
   * previous frame.
   */
  sync(musicTime) {
    if (!this._playedTimeline || !this._noteMeshMap || this._playedTimeline.length === 0) return 0;
    const tl = this._playedTimeline;
    // Forward: cursor points at the next *un-played* entry.  Advance
    // while that entry's time is at or before the current music time.
    while (this._playedCursor < tl.length && tl[this._playedCursor].time <= musicTime) {
      const evt = tl[this._playedCursor];
      const col = this._staffColors.get(evt.staff) || this._defaultNoteColor;
      this._applyNoteColor(evt.id, col);
      this._playedCursor++;
    }
    // Backward: cursor has advanced past a point we're now to the left
    // of.  Revert each newly-future entry.  Typical case is transport
    // reset (`musicTime === 0`), which rolls every played note back to
    // the default colour in one frame.
    while (this._playedCursor > 0 && tl[this._playedCursor - 1].time > musicTime) {
      this._playedCursor--;
      const evt = tl[this._playedCursor];
      this._applyNoteColor(evt.id, this._defaultNoteColor);
    }
    return this._flushDirtyMeshes();
  }

  clear() {
    this._noteMeshMap = null;
    this._playedTimeline = null;
    this._playedCursor = 0;
    this._staffColors.clear();
    this._dirtyInstanceMeshes.clear();
  }
}
