import { SETTINGS, applyToSceneConfig, readFromSceneConfig } from './settingsRegistry.js';
import { loadStoredSettings, saveStoredSettings, clearStoredSettings } from './SettingsPersistence.js';

/**
 * Floating settings popover anchored to the gear button.
 *
 * Renders the entries declared in `settingsRegistry.js` as a single
 * scrollable popover; live-applyable settings push an `updateConfig`
 * message to the worker on every change, reparse-required settings
 * are debounced so dragging a slider doesn't fire a reload per pixel.
 *
 * **Lifecycle ordering**
 *
 * The panel splits its setup into two methods because some work
 * needs to happen *before* the first scene is built and some after:
 *
 *   1. `new SettingsPanel()` — constructor calls `_hydrate()`
 *      synchronously, copying any persisted values out of
 *      localStorage and into `SceneConfig` on the main thread.  The
 *      construction site in `main.js` runs this BEFORE
 *      `app.init()`, so the first scene build sees the user's
 *      preferences (notation visibility, camera framing, …) without
 *      any visible flash of defaults.
 *
 *   2. `attach(app, gearBtn, popover)` — called AFTER `app.init()`
 *      has finished.  Renders the panel UI, binds the gear button,
 *      and pushes the live-applyable settings to the worker via
 *      `updateConfig` so the worker's own `SceneConfig` copy
 *      (separate ESM realm) matches the main thread's hydrated
 *      values.  Reparse-required settings don't need to be pushed
 *      because they were applied during the first scene build.
 */
export class SettingsPanel {
  /** @type {import('../LuminoirApp.js').LuminoirApp | null} */
  _app = null;
  /** @type {HTMLButtonElement | null} */
  _gearBtn = null;
  /** @type {HTMLElement | null} */
  _popover = null;
  /** Debounce timer for reparse-required settings. */
  _reparseTimer = 0;
  /** Map of setting id → control element so we can re-sync on Reset. */
  _controls = new Map();
  _open = false;
  _onDocClick = null;
  _onKeydown = null;

  constructor() {
    this._hydrate();
  }

  /**
   * Read persisted values out of localStorage and apply them to the
   * main thread's `SceneConfig` synchronously.  Runs from the
   * constructor so callers can do `new SettingsPanel()` before
   * `app.init()` and have the first scene build pick up the
   * user's preferences.
   */
  _hydrate() {
    const stored = loadStoredSettings();
    for (const setting of SETTINGS) {
      if (stored[setting.id] !== undefined) {
        applyToSceneConfig(setting, stored[setting.id]);
      }
    }
  }

  /**
   * Wire the panel to the running app.  Renders the popover UI,
   * binds the gear button, and syncs the worker's `SceneConfig`
   * copy to the main thread's hydrated values.
   *
   * Call this AFTER `app.init()` has resolved — the worker needs to
   * be alive to receive the initial `updateConfig` sync, and the
   * gear button is `hidden` until we toggle it visible here so the
   * user doesn't see a non-functional gear during loading.
   */
  attach(app, gearBtn, popover) {
    this._app = app;
    this._gearBtn = gearBtn;
    this._popover = popover;

    this._render();
    this._bindGear();

    // Reveal the gear now that it actually opens something.
    gearBtn.classList.remove('hidden');

    // Sync live-applyable settings to the worker so its own
    // `SceneConfig` copy matches the main thread's hydrated values.
    // Reparse-applied settings don't need to be pushed — the first
    // scene build (which already happened by now in `app.init`)
    // applied them via the parser/builder reading the main thread's
    // SceneConfig.
    //
    // `playbackSpeed` is special-cased because it's a main-thread
    // setting (MIDI scheduling) — `LuminoirApp.init` already seeds
    // the MIDI player from SceneConfig.playbackSpeed, so we don't
    // need to do anything more here for it.
    const liveUpdates = {};
    for (const setting of SETTINGS) {
      if (setting.apply !== 'live') continue;
      if (setting.id.startsWith('notation.show.')) continue;
      if (setting.id === 'playbackSpeed') continue;
      liveUpdates[setting.id] = readFromSceneConfig(setting);
    }
    if (Object.keys(liveUpdates).length) {
      this._app.render.updateConfig(liveUpdates);
    }
  }

  /* ---------------------------- Rendering ---------------------------- */

  _render() {
    const popover = this._popover;
    popover.innerHTML = '';
    this._controls.clear();

    // Group settings by section, preserving registry order.
    const bySection = new Map();
    for (const s of SETTINGS) {
      if (!bySection.has(s.section)) bySection.set(s.section, []);
      bySection.get(s.section).push(s);
    }

    const header = document.createElement('div');
    header.className = 'settings-header';
    const title = document.createElement('h2');
    title.id = 'settings-title';
    title.textContent = 'Settings';
    header.appendChild(title);
    popover.appendChild(header);

    for (const [section, entries] of bySection) {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'settings-section';
      const h = document.createElement('h3');
      h.textContent = section;
      sectionEl.appendChild(h);
      for (const entry of entries) {
        sectionEl.appendChild(this._buildControl(entry));
      }
      popover.appendChild(sectionEl);
    }

    // Renderer section — shows the active 3D backend and a button to
    // switch to the other one (which reloads the page with the
    // inverse `?renderer=` URL parameter).  Lives between the regular
    // settings and About so it reads as "advanced display options"
    // without mixing into the persisted-config registry.
    popover.appendChild(this._buildRendererSection());

    // About section — sits between the regular settings and the
    // reset button so it reads as the last block of "informational"
    // content before the destructive action.  Pure HTML; no
    // controls, no persistence.
    popover.appendChild(this._buildAboutSection());

    const footer = document.createElement('div');
    footer.className = 'settings-footer';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'settings-reset';
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.addEventListener('click', () => this._resetAll());
    footer.appendChild(resetBtn);
    popover.appendChild(footer);
  }

  _buildControl(setting) {
    const wrap = document.createElement('div');
    wrap.className = 'settings-row';

    const labelEl = document.createElement('label');
    labelEl.className = 'settings-label';
    const labelText = document.createElement('span');
    labelText.textContent = setting.label;
    labelEl.appendChild(labelText);
    wrap.appendChild(labelEl);

    if (setting.apply === 'reparse') {
      const tag = document.createElement('span');
      tag.className = 'settings-reparse-tag';
      tag.textContent = 'reloads';
      tag.title = 'Changing this setting reloads the score (≈0.1 s).';
      labelEl.appendChild(tag);
    }

    const current = readFromSceneConfig(setting);

    if (setting.type === 'range') {
      const row = document.createElement('div');
      row.className = 'settings-control-range';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(setting.min);
      input.max = String(setting.max);
      input.step = String(setting.step);
      input.value = String(current);
      const readout = document.createElement('span');
      readout.className = 'settings-readout';
      readout.textContent = formatValue(setting, current);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        readout.textContent = formatValue(setting, v);
        this._onChange(setting, v);
      });
      row.appendChild(input);
      row.appendChild(readout);
      wrap.appendChild(row);
      this._controls.set(setting.id, { type: 'range', input, readout });
    } else if (setting.type === 'checkbox') {
      const row = document.createElement('div');
      row.className = 'settings-control-checkbox';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!current;
      const id = `setting_${setting.id.replace(/\./g, '_')}`;
      input.id = id;
      labelEl.htmlFor = id;
      input.addEventListener('change', () => {
        this._onChange(setting, input.checked);
      });
      row.appendChild(input);
      wrap.appendChild(row);
      this._controls.set(setting.id, { type: 'checkbox', input });
    }

    if (setting.description) {
      const desc = document.createElement('div');
      desc.className = 'settings-desc';
      desc.textContent = setting.description;
      wrap.appendChild(desc);
    }

    return wrap;
  }

  /**
   * Build the "Renderer" section — surfaces the active 3D backend
   * (WebGPU vs WebGL) and, when a choice is available, a button that
   * reloads the page on the inverse `?renderer=` URL parameter.
   *
   * `app.render.rendererKind` is populated by the worker's `ready`
   * message and is therefore guaranteed to be set by the time this
   * panel `attach()`es.  `navigator.gpu` is the same WebGPU
   * availability proxy the old top-bar badge used: present on
   * Chrome/Edge/Safari TP on secure origins, absent on Firefox /
   * insecure origins / Tesla-style embedded Chromium with no WebGPU.
   * When it's absent we render the active backend as plain text and
   * skip the switch button — there's nothing to switch to.
   */
  _buildRendererSection() {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'settings-section settings-renderer';

    const h = document.createElement('h3');
    h.textContent = 'Renderer';
    sectionEl.appendChild(h);

    const current = (this._app && this._app.render && this._app.render.rendererKind)
      || 'unknown';
    const webgpuAvailable = typeof navigator !== 'undefined' && !!navigator.gpu;

    const row = document.createElement('div');
    row.className = 'settings-renderer-row';

    const activeLabel = document.createElement('span');
    activeLabel.className = 'settings-renderer-active';
    activeLabel.textContent = current;
    row.appendChild(activeLabel);

    if (webgpuAvailable) {
      const otherName = current === 'WebGPU' ? 'WebGL' : 'WebGPU';
      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'settings-renderer-switch';
      switchBtn.textContent = `Switch to ${otherName}`;
      switchBtn.title = 'Reloads the page';
      switchBtn.addEventListener('click', () => {
        const url = new URL(window.location.href);
        if (current === 'WebGPU') {
          url.searchParams.set('renderer', 'webgl');
        } else {
          url.searchParams.delete('renderer');
        }
        // Cache-bust so Vite's dev server doesn't serve a stale
        // worker bundle after the URL param flips (it fingerprints
        // on path, not query).  Harmless in production.
        url.searchParams.set('cb', Date.now().toString());
        window.location.href = url.toString();
      });
      row.appendChild(switchBtn);
    }

    sectionEl.appendChild(row);

    const desc = document.createElement('p');
    desc.className = 'settings-renderer-desc';
    desc.textContent = webgpuAvailable
      ? 'WebGPU is faster on supported browsers; WebGL is the universal fallback.  Try the other if rendering looks wrong on this device.'
      : 'WebGPU isn\u2019t available in this browser/context, so Luminoir is locked to WebGL.';
    sectionEl.appendChild(desc);

    return sectionEl;
  }

  /**
   * Build the "About" section — a static informational block that
   * names Luminoir and credits the open-source projects bundled
   * with it.
   *
   * Three credits, one per dependency.  They sit at the bottom of
   * the settings popover, above the reset button, so users have to
   * scroll past the actually-useful controls to find them — exactly
   * the right level of prominence for an acknowledgments block.
   *
   * Each credit links to the project's homepage (or repo for
   * smaller libraries that don't have a dedicated site) and lists
   * its license tag in plain text — clicking out is opt-in,
   * skimming names + licenses is the default experience.
   */
  _buildAboutSection() {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'settings-section settings-about';

    const h = document.createElement('h3');
    h.textContent = 'About';
    sectionEl.appendChild(h);

    const intro = document.createElement('p');
    intro.className = 'settings-about-intro';
    intro.textContent =
      'Luminoir is a 3D sheet-music visualisation that turns a static page into a glowing landscape of light balls and shadow-cast notation.  Built on the shoulders of these open-source projects:';
    sectionEl.appendChild(intro);

    /** @type {Array<{ name: string, role: string, url: string, license: string }>} */
    const credits = [
      {
        name: 'Verovio',
        role: 'music notation engraving from MusicXML / MEI',
        url: 'https://www.verovio.org',
        license: 'LGPL-3.0',
      },
      {
        name: 'Three.js',
        role: 'WebGL & WebGPU 3D rendering',
        url: 'https://threejs.org',
        license: 'MIT',
      },
      {
        name: 'smplr',
        role: 'sample-based MIDI playback through Web Audio',
        url: 'https://github.com/danigb/smplr',
        license: 'MIT',
      },
    ];

    const list = document.createElement('ul');
    list.className = 'settings-about-credits';
    for (const c of credits) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = c.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'settings-about-credit-name';
      link.textContent = c.name;
      li.appendChild(link);
      const lic = document.createElement('span');
      lic.className = 'settings-about-credit-license';
      lic.textContent = c.license;
      li.appendChild(lic);
      const role = document.createElement('div');
      role.className = 'settings-about-credit-role';
      role.textContent = c.role;
      li.appendChild(role);
      list.appendChild(li);
    }
    sectionEl.appendChild(list);

    return sectionEl;
  }

  /* ------------------------ Change handling -------------------------- */

  _onChange(setting, value) {
    const changed = applyToSceneConfig(setting, value);
    if (!changed) return;
    this._persist();
    if (setting.apply === 'live') {
      this._pushLive(setting, value);
    } else {
      this._scheduleReparse();
    }
  }

  _pushLive(setting, value) {
    if (setting.id.startsWith('notation.show.')) {
      // Should never happen — notation.* is always reparse — but be
      // defensive in case someone changes the registry.
      this._scheduleReparse();
      return;
    }
    if (setting.id === 'playbackSpeed') {
      // Special-case: playback speed lives on the main thread (the
      // MIDI player schedules audio there).  Route through
      // `LuminoirApp.setPlaybackSpeed`, which also re-anchors the
      // worker's clock so the visual playhead and camera adopt the
      // new pace at the same instant the audio does.  We deliberately
      // do NOT additionally postMessage the value to the worker — the
      // re-anchored clock carries the new tempoScale on its own.
      this._app.setPlaybackSpeed(value);
      return;
    }
    this._app.render.updateConfig({ [setting.id]: value });
  }

  _scheduleReparse() {
    if (this._reparseTimer) clearTimeout(this._reparseTimer);
    this._reparseTimer = setTimeout(() => {
      this._reparseTimer = 0;
      this._app.reloadCurrentScore();
    }, 300);
  }

  _persist() {
    // Re-read each setting's current effective value out of
    // SceneConfig and persist the whole map.  Cheap (≈15 entries),
    // and avoids any drift between what's in localStorage and what's
    // actually in `SceneConfig`.
    const map = {};
    for (const s of SETTINGS) {
      map[s.id] = readFromSceneConfig(s);
    }
    saveStoredSettings(map);
  }

  /* ------------------------- Reset behaviour ------------------------- */

  _resetAll() {
    clearStoredSettings();
    const liveUpdates = {};
    let needsReparse = false;
    let resetPlaybackSpeed = false;
    for (const setting of SETTINGS) {
      const changed = applyToSceneConfig(setting, setting.default);
      if (!changed) continue;
      if (setting.apply === 'reparse') {
        needsReparse = true;
      } else if (setting.id === 'playbackSpeed') {
        // Don't pile playbackSpeed into the worker-bound batch — it's
        // a main-thread setting; we apply it via app below.
        resetPlaybackSpeed = true;
      } else if (!setting.id.startsWith('notation.show.')) {
        liveUpdates[setting.id] = setting.default;
      }
    }
    // Resync the controls visually.
    for (const setting of SETTINGS) {
      const ctrl = this._controls.get(setting.id);
      if (!ctrl) continue;
      const current = readFromSceneConfig(setting);
      if (ctrl.type === 'range') {
        ctrl.input.value = String(current);
        ctrl.readout.textContent = formatValue(setting, current);
      } else if (ctrl.type === 'checkbox') {
        ctrl.input.checked = !!current;
      }
    }
    if (Object.keys(liveUpdates).length) {
      this._app.render.updateConfig(liveUpdates);
    }
    if (resetPlaybackSpeed) {
      this._app.setPlaybackSpeed(readFromSceneConfig({ id: 'playbackSpeed' }));
    }
    if (needsReparse) {
      this._scheduleReparse();
    }
  }

  /* ----------------------- Open / close logic ------------------------ */

  _bindGear() {
    this._gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggle();
    });
    this._onDocClick = (e) => {
      if (!this._open) return;
      if (this._popover.contains(e.target) || this._gearBtn.contains(e.target)) return;
      this._close();
    };
    document.addEventListener('mousedown', this._onDocClick);
    this._onKeydown = (e) => {
      if (e.key === 'Escape' && this._open) this._close();
    };
    document.addEventListener('keydown', this._onKeydown);
  }

  _toggle() {
    if (this._open) this._close();
    else this._openPopover();
  }

  _openPopover() {
    this._popover.classList.add('open');
    this._gearBtn.classList.add('active');
    this._open = true;
  }

  _close() {
    this._popover.classList.remove('open');
    this._gearBtn.classList.remove('active');
    this._open = false;
  }
}

function formatValue(setting, value) {
  const fmt = setting.format
    ? setting.format(value)
    : (Number.isInteger(value) ? String(value) : Number(value).toFixed(2));
  return setting.unit ? `${fmt}${setting.unit}` : fmt;
}
