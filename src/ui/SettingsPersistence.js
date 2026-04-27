/**
 * localStorage-backed persistence for the settings panel.
 *
 * Stores a JSON object keyed by setting id (`'camera.pitchDegrees'`,
 * `'audioVisualOffsetMs'`, …) along with a schema version so a
 * future change to the registry can decline to load incompatible
 * stored state instead of corrupting the panel.
 *
 * Bump `SCHEMA_VERSION` whenever the shape of a setting's value
 * changes (e.g. switching `audioVisualOffsetMs` from ms to seconds)
 * — old stored entries will be ignored and the panel will fall back
 * to the registry defaults until the user changes something.
 *
 * Adding/removing settings does NOT need a bump; unknown ids are
 * silently ignored on load and missing ids fall back to the
 * registry default.
 */
const STORAGE_KEY = 'luminoir.settings.v1';
const SCHEMA_VERSION = 1;

/** Read all persisted settings as a plain `{ id: value }` map. */
export function loadStoredSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    if (parsed.version !== SCHEMA_VERSION) {
      console.warn(`[Luminoir] Discarding stored settings (schema v${parsed.version}, expected v${SCHEMA_VERSION}).`);
      return {};
    }
    return parsed.values && typeof parsed.values === 'object' ? parsed.values : {};
  } catch (err) {
    // Malformed JSON, quota error in private browsing, etc. — never
    // let a storage hiccup take the whole UI down.
    console.warn('[Luminoir] Failed to read stored settings:', err);
    return {};
  }
}

/** Persist a `{ id: value }` map.  Overwrites; not merged. */
export function saveStoredSettings(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: SCHEMA_VERSION,
      values,
    }));
  } catch (err) {
    console.warn('[Luminoir] Failed to persist settings:', err);
  }
}

/** Drop the persisted blob entirely (used by Reset-to-Defaults). */
export function clearStoredSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[Luminoir] Failed to clear stored settings:', err);
  }
}
