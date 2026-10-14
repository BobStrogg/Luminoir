import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneConfig } from '../../src/rendering/SceneConfig.js';
import { SettingsPanel } from '../../src/ui/SettingsPanel.js';
import { SETTINGS } from '../../src/ui/settingsRegistry.js';

const STORAGE_KEY = 'luminoir.settings.v1';

function setting(id) {
  return SETTINGS.find((s) => s.id === id);
}

function readStored() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw).values : null;
}

function seed(values) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, values }));
}

describe('SettingsPanel ?avoffset= persistence', () => {
  /** @type {{ search: string }} */
  let loc;

  beforeEach(() => {
    const mem = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    });
    loc = { search: '' };
    vi.stubGlobal('location', loc);
    SceneConfig.audioVisualOffsetMs = 0;
    SceneConfig.playbackSpeed = 1;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    SceneConfig.audioVisualOffsetMs = 0;
    SceneConfig.playbackSpeed = 1;
  });

  function panel() {
    const p = new SettingsPanel();
    p._app = {
      setPlaybackSpeed() {},
      reloadCurrentScore() {},
      render: { updateConfig() {} },
    };
    return p;
  }

  it('keeps the saved A/V offset when another setting is changed under ?avoffset=', () => {
    seed({ audioVisualOffsetMs: 40, playbackSpeed: 1 });
    loc.search = '?avoffset=120';
    const p = panel();
    expect(SceneConfig.audioVisualOffsetMs).toBe(120);

    p._onChange(setting('playbackSpeed'), 0.5);

    expect(SceneConfig.audioVisualOffsetMs).toBe(120);
    expect(readStored().audioVisualOffsetMs).toBe(40);
    expect(readStored().playbackSpeed).toBe(0.5);
  });

  it('does not create a stored A/V offset from the URL alone', () => {
    loc.search = '?avoffset=120';
    const p = panel();
    p._onChange(setting('playbackSpeed'), 0.75);

    expect(SceneConfig.audioVisualOffsetMs).toBe(120);
    expect(readStored().audioVisualOffsetMs).toBeUndefined();
    expect(readStored().playbackSpeed).toBe(0.75);
  });

  it('persists a deliberate slider change and then keeps that, not the URL', () => {
    seed({ audioVisualOffsetMs: 40 });
    loc.search = '?avoffset=120';
    const p = panel();
    p._onChange(setting('audioVisualOffsetMs'), -40);

    expect(SceneConfig.audioVisualOffsetMs).toBe(-40);
    expect(readStored().audioVisualOffsetMs).toBe(-40);

    p._onChange(setting('playbackSpeed'), 1.25);
    expect(readStored().audioVisualOffsetMs).toBe(-40);
    expect(readStored().playbackSpeed).toBe(1.25);
  });

  it('does not resurrect the URL offset after reset', () => {
    seed({ audioVisualOffsetMs: 40 });
    loc.search = '?avoffset=120';
    const p = panel();
    p._resetAll();
    expect(SceneConfig.audioVisualOffsetMs).toBe(0);

    p._onChange(setting('playbackSpeed'), 0.5);
    expect(readStored().audioVisualOffsetMs).toBe(0);
  });
});
