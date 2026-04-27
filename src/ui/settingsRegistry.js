import { SceneConfig } from '../rendering/SceneConfig.js';

/**
 * Single source of truth for every setting exposed in the settings
 * panel.  Each entry describes both the UI control to render and how
 * the value should be applied (live-vs-reparse, where it lives in
 * `SceneConfig`).
 *
 * Why a registry instead of hand-coded UI per setting?
 *   • Adding a new setting is one entry, no UI changes needed.
 *   • Persistence (localStorage) and Reset-to-Defaults work
 *     uniformly across every entry — the panel just iterates the
 *     registry and reads/writes by id.
 *   • The registry is the only place that knows which settings are
 *     live-applyable vs reparse-required, so the panel doesn't have
 *     to special-case each one.
 *
 * **Field reference** (per entry):
 *   id        — dot-path key into SceneConfig.  For sliders this is
 *               the leaf to read/write.  For the special
 *               `notation.hidden.<class>` entries, the registry
 *               translates between the boolean and an array
 *               operation on `SceneConfig.notation.hiddenClasses`.
 *   label     — short label shown above the control.
 *   description — long-form caption shown beneath; explains the
 *               sign convention or the visual effect.
 *   type      — 'range' (slider) | 'checkbox'.
 *   min/max/step — numeric bounds (range only).
 *   default   — used by both the initial state and Reset-to-Defaults.
 *               Read live from `SceneConfig` when this module loads
 *               so the registry stays in sync with the codebase
 *               default — change one place, both update.
 *   unit      — display suffix on the value readout (e.g. '°', ' ms').
 *   format    — optional `(value) => string` for the value readout
 *               (defaults to value.toString()).
 *   apply     — 'live' | 'reparse'.  Drives whether the panel pushes
 *               an `updateConfig` message to the worker (live) or
 *               calls `app.reloadCurrentScore()` (reparse).
 *   section   — top-level grouping in the panel UI.
 *   reverseSign — for `notation.hidden.X` entries, the checkbox UI is
 *               "show", but the underlying flag stores "hidden".
 *               True ↔ class is *not* in `hiddenClasses`.  Without
 *               this flag the checkboxes would be inverted.
 */

/**
 * Helper to read a default value out of `SceneConfig` by dot-path so
 * the registry doesn't drift from the codebase defaults.  If a
 * future contributor changes `camera.pitchDegrees` to 22°, the
 * settings panel's "Reset to Defaults" automatically follows.
 */
function defaultFor(path) {
  const parts = path.split('.');
  let obj = SceneConfig;
  for (const k of parts) {
    if (obj == null) return undefined;
    obj = obj[k];
  }
  return obj;
}

/** Notation class names the user can show/hide. The visible text is
 *  the user-facing name; the class is what `SVGSceneParser` compares
 *  against `<g class="…">` in Verovio's SVG. */
const NOTATION_CLASSES = [
  { class: 'pedal',    label: 'Sustain pedal markings', desc: 'Piano Ped./* brackets below the bass clef.' },
  { class: 'hairpin',  label: 'Hairpins', desc: 'Crescendo / decrescendo wedge marks.' },
  { class: 'octave',   label: 'Octave lines', desc: '8va / 8vb dashed lines above or below the staff.' },
  { class: 'dynam',    label: 'Dynamics', desc: 'p / mf / ff and similar volume markings.' },
  { class: 'tempo',    label: 'Tempo markings', desc: 'BPM and verbal tempo (Allegro, Lento, …) text.' },
  { class: 'arpeg',    label: 'Arpeggio squiggles', desc: 'Vertical wavy lines next to chords.' },
  { class: 'fermata',  label: 'Fermatas', desc: 'Hold-this-note bird-eye marks.' },
  { class: 'dir',      label: 'Direction text', desc: 'Italic instructions like "rit." or "a tempo".' },
  { class: 'tupletBracket', label: 'Tuplet brackets', desc: 'Brackets grouping triplets / quintuplets.' },
  { class: 'tupletNum', label: 'Tuplet numbers', desc: 'The little 3 / 5 / 6 above tuplet groups.' },
  { class: 'grpSym',   label: 'System brace', desc: 'The {} bracket joining piano grand-staff systems.' },
];

/** Build the per-class "show this notation" registry entries. */
function notationShowEntries() {
  return NOTATION_CLASSES.map((nc) => ({
    id: `notation.show.${nc.class}`,
    _notationClass: nc.class,
    label: nc.label,
    description: nc.desc,
    type: 'checkbox',
    apply: 'reparse',
    section: 'Notation',
    /** Default = NOT in the SceneConfig hidden list at module load. */
    default: !(SceneConfig.notation?.hiddenClasses ?? []).includes(nc.class),
  }));
}

export const SETTINGS = [
  /* --------------------------- PLAYBACK ------------------------------ */
  {
    id: 'playbackSpeed',
    label: 'Playback speed',
    description: '1.0× plays the score at its native tempo (parsed from the MIDI tempo map). 0.5× = half speed, 2.0× = double speed. Changes take effect immediately, even mid-playback.',
    type: 'range',
    min: 0.25, max: 2.0, step: 0.05,
    default: defaultFor('playbackSpeed'),
    format: (v) => `${v.toFixed(2)}×`,
    apply: 'live',
    section: 'Playback',
  },

  /* --------------------------- A/V SYNC ------------------------------ */
  {
    id: 'audioVisualOffsetMs',
    label: 'Audio-visual offset',
    description: '+N shifts visuals N ms earlier in music time (use when audio appears to lag behind the light balls). −N shifts visuals later.',
    type: 'range',
    min: -250, max: 250, step: 5,
    default: defaultFor('audioVisualOffsetMs'),
    unit: ' ms',
    apply: 'live',
    section: 'Audio sync',
  },

  /* --------------------------- SMART CAMERA -------------------------- */
  {
    id: 'smartCamera.enabled',
    label: 'Smart camera',
    description: 'Gently orbits and zooms the camera during playback so the scene doesn\'t feel static. Reacts to note density — subtle during quiet phrases, livelier under dense passages. Mouse drag still wins; the auto-orbit pauses while you interact.',
    type: 'checkbox',
    default: defaultFor('smartCamera.enabled'),
    apply: 'live',
    section: 'Smart camera',
  },
  {
    id: 'smartCamera.orbitStrength',
    label: 'Orbit strength',
    description: 'Peak yaw / pitch swing (radians). 0.25 ≈ ±14° — lively without being motion-sick.',
    type: 'range',
    min: 0, max: 0.5, step: 0.01,
    default: defaultFor('smartCamera.orbitStrength'),
    apply: 'live',
    section: 'Smart camera',
  },
  {
    id: 'smartCamera.orbitSpeed',
    label: 'Orbit speed',
    description: 'Base phase advance (radians/sec). Higher = faster sweeping. Activity multiplies this up to 2× under heavy passages.',
    type: 'range',
    min: 0.05, max: 0.5, step: 0.01,
    default: defaultFor('smartCamera.orbitSpeed'),
    apply: 'live',
    section: 'Smart camera',
  },
  {
    id: 'smartCamera.zoomStrength',
    label: 'Zoom variation',
    description: 'Fractional radius wobble. 0.10 = camera occasionally pulls 10% closer or further out. 0 = no zoom oscillation.',
    type: 'range',
    min: 0, max: 0.3, step: 0.01,
    default: defaultFor('smartCamera.zoomStrength'),
    apply: 'live',
    section: 'Smart camera',
  },

  /* --------------------------- LIGHT BALLS --------------------------- */
  {
    id: 'lightBall.intensity',
    label: 'Light brightness',
    description: 'Intensity of each staff\'s pooled point light.',
    type: 'range',
    min: 0, max: 0.5, step: 0.01,
    default: defaultFor('lightBall.intensity'),
    apply: 'live',
    section: 'Light balls',
  },
  {
    id: 'lightBall.bounceHeight',
    label: 'Bounce height',
    description: 'How high the ball arcs between consecutive notes.',
    type: 'range',
    min: 0, max: 0.25, step: 0.005,
    default: defaultFor('lightBall.bounceHeight'),
    apply: 'live',
    section: 'Light balls',
  },
  {
    id: 'lightBall.pulseScale',
    label: 'Pulse intensity',
    description: 'Scale-up factor when the ball lands on a note.',
    type: 'range',
    min: 1.0, max: 1.6, step: 0.05,
    default: defaultFor('lightBall.pulseScale'),
    apply: 'live',
    section: 'Light balls',
  },
  {
    id: 'lightBall.pulseDuration',
    label: 'Pulse duration',
    description: 'How long the on-hit pulse lasts.',
    type: 'range',
    min: 0.05, max: 0.4, step: 0.01,
    default: defaultFor('lightBall.pulseDuration'),
    unit: ' s',
    format: (v) => v.toFixed(2),
    apply: 'live',
    section: 'Light balls',
  },
  {
    id: 'lightBall.glowRadiusMultiplier',
    label: 'Glow size',
    description: 'Halo sprite diameter multiplier around each ball.',
    type: 'range',
    min: 0.4, max: 1.6, step: 0.05,
    default: defaultFor('lightBall.glowRadiusMultiplier'),
    apply: 'live',
    section: 'Light balls',
  },

  /* --------------------------- PLAYED NOTES -------------------------- */
  {
    id: 'playedNote.glowStrength',
    label: 'Note glow intensity',
    description: 'HDR emissive contribution for played noteheads. Reloads the score.',
    type: 'range',
    min: 0, max: 6, step: 0.1,
    default: defaultFor('playedNote.glowStrength'),
    apply: 'reparse',
    section: 'Played notes',
  },

  /* --------------------------- NOTATION ------------------------------ */
  ...notationShowEntries(),
];

/**
 * Apply a single setting's stored value to `SceneConfig` on the
 * main thread.  Most settings are a straight assignment at the
 * dot-path; the `notation.show.*` family is special because the
 * underlying state is an *array* of hidden class names rather than a
 * boolean per class.
 *
 * Returns true if the value was actually changed (so the panel can
 * skip pushing a no-op update to the worker).
 */
export function applyToSceneConfig(setting, value) {
  if (setting.id.startsWith('notation.show.')) {
    const cls = setting._notationClass;
    if (!SceneConfig.notation) SceneConfig.notation = {};
    if (!Array.isArray(SceneConfig.notation.hiddenClasses)) {
      SceneConfig.notation.hiddenClasses = [];
    }
    const arr = SceneConfig.notation.hiddenClasses;
    const isHidden = arr.includes(cls);
    const shouldHide = !value;
    if (isHidden === shouldHide) return false;
    if (shouldHide) arr.push(cls);
    else arr.splice(arr.indexOf(cls), 1);
    return true;
  }

  const parts = setting.id.split('.');
  let obj = SceneConfig;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (obj[k] === undefined || obj[k] === null) obj[k] = {};
    obj = obj[k];
  }
  const leaf = parts[parts.length - 1];
  if (obj[leaf] === value) return false;
  obj[leaf] = value;
  return true;
}

/** Read the current effective value from `SceneConfig` for a setting. */
export function readFromSceneConfig(setting) {
  if (setting.id.startsWith('notation.show.')) {
    const cls = setting._notationClass;
    return !(SceneConfig.notation?.hiddenClasses ?? []).includes(cls);
  }
  return defaultFor(setting.id);
}
