/**
 * Wires up the HTML controls to the LuminoirApp.
 * @param {import('../LuminoirApp.js').LuminoirApp} app
 */
import { DemoScores } from '../data/DemoScores.js';

export function initControls(app) {
  const bar = document.getElementById('controls-bar');
  const btnPlay = document.getElementById('btn-play');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const btnStop = document.getElementById('btn-stop');
  const scoreSelect = document.getElementById('score-select');
  const scoreMenu = document.getElementById('score-menu');
  const scoreLoading = document.getElementById('score-loading');
  const btnImport = document.getElementById('btn-import');
  const fileInput = document.getElementById('file-input');
  const fpsBadge = document.getElementById('fps-badge');

  if (!bar || !btnPlay || !btnStop) {
    console.warn('[Luminoir] Controls DOM elements not found — skipping UI wiring');
    return;
  }

  /* ---------------------- Custom score dropdown ---------------------- */

  // Populate the menu with one entry per demo score.  Each row gets a
  // bold title line and (when the score has a credit) a smaller dimmer
  // composer/artist line — matches the on-paper title block, which
  // also shows two lines of attribution stacked top-left.
  function populateMenu() {
    if (!scoreMenu) return;
    scoreMenu.innerHTML = '';
    for (const [id, entry] of Object.entries(DemoScores)) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('data-value', id);
      const title = document.createElement('span');
      title.className = 'score-menu-title';
      title.textContent = entry.title;
      li.appendChild(title);
      if (entry.composer) {
        const sub = document.createElement('span');
        sub.className = 'score-menu-composer';
        sub.textContent = entry.composer;
        li.appendChild(sub);
      }
      li.addEventListener('click', () => {
        if (li.classList.contains('disabled')) return;
        selectScore(id);
        closeMenu();
      });
      scoreMenu.appendChild(li);
    }
  }

  // Update the dropdown's display lines when a score is picked.  The
  // selection is the source of truth: `scoreSelect.dataset.value`
  // holds the id, the two child spans hold the rendered text.
  function setSelectionLabel(id, customTitle = null, customComposer = null) {
    if (!scoreSelect) return;
    scoreSelect.dataset.value = id;
    const titleEl = scoreSelect.querySelector('.score-select-title');
    const subEl = scoreSelect.querySelector('.score-select-composer');
    if (id === '__custom') {
      if (titleEl) titleEl.textContent = customTitle || 'Imported file';
      if (subEl) subEl.textContent = customComposer || '';
      return;
    }
    const entry = DemoScores[id];
    if (!entry) return;
    if (titleEl) titleEl.textContent = entry.title;
    if (subEl) subEl.textContent = entry.composer || '';
    // Highlight the active row in the menu.
    if (scoreMenu) {
      for (const li of scoreMenu.querySelectorAll('li')) {
        li.classList.toggle('selected', li.dataset.value === id);
      }
    }
  }

  async function selectScore(id) {
    setSelectionLabel(id);
    app.stop();
    await app.loadDemoScore(id);
  }

  function openMenu() {
    if (!scoreMenu) return;
    scoreMenu.classList.remove('hidden');
    scoreSelect.setAttribute('aria-expanded', 'true');
    // Scroll the active item into view so the user lands on context.
    const sel = scoreMenu.querySelector('li.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function closeMenu() {
    if (!scoreMenu) return;
    scoreMenu.classList.add('hidden');
    scoreSelect.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu() {
    if (!scoreMenu) return;
    if (scoreMenu.classList.contains('hidden')) openMenu();
    else closeMenu();
  }

  if (scoreSelect && scoreMenu) {
    populateMenu();
    setSelectionLabel('albatross');
    scoreSelect.addEventListener('click', (e) => {
      if (scoreSelect.classList.contains('disabled')) return;
      e.stopPropagation();
      toggleMenu();
    });
    document.addEventListener('mousedown', (e) => {
      if (scoreMenu.classList.contains('hidden')) return;
      if (scoreMenu.contains(e.target) || scoreSelect.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !scoreMenu.classList.contains('hidden')) closeMenu();
    });
  }

  // Show controls once app is ready
  app.onReady = () => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.classList.add('fade-out');
      setTimeout(() => (overlay.style.display = 'none'), 700);
    }
    bar.classList.remove('hidden');
    initFpsBadge(fpsBadge, app.render);
  };

  // Loading indicator: the score worker fires onLoadStart when a
  // load (or reparse) begins and onLoadEnd when it finishes.  We
  // show a small spinner over the score-select chevron and disable
  // the dropdown + import button so the user can't queue up
  // overlapping loads.  The `.disabled` class fades the dropdown
  // and switches the cursor to `not-allowed` (since the new
  // dropdown is a <button>, not a native <select> with a
  // built-in `:disabled` style).
  app.onLoadStart = () => {
    if (scoreLoading) scoreLoading.classList.remove('hidden');
    if (scoreSelect) scoreSelect.classList.add('disabled');
    if (btnImport) btnImport.disabled = true;
  };
  app.onLoadEnd = () => {
    if (scoreLoading) scoreLoading.classList.add('hidden');
    if (scoreSelect) scoreSelect.classList.remove('disabled');
    if (btnImport) btnImport.disabled = false;
  };

  // Play / Pause toggle
  btnPlay.addEventListener('click', () => app.togglePlayPause());

  // Stop
  btnStop.addEventListener('click', () => app.stop());

  // Update play/pause icon
  app.onStateChange = (isPlaying) => {
    if (iconPlay) iconPlay.classList.toggle('hidden', isPlaying);
    if (iconPause) iconPause.classList.toggle('hidden', !isPlaying);
  };

  // Import file
  if (btnImport && fileInput) {
    btnImport.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (file) {
        await app.loadFile(file);
        // Show the file name as a custom selection so the user
        // can see what's loaded.  We don't add it to the menu —
        // re-importing is via the import button each time.
        setSelectionLabel('__custom', file.name, '');
        // Reset so the same file can be re-imported
        fileInput.value = '';
      }
    });
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        app.togglePlayPause();
        break;
      case 'KeyR':
        app.stop();
        break;
      case 'KeyF':
        // Toggle the FPS debug badge.  Available any time the app
        // is loaded, so a slowdown can be diagnosed in-place without
        // reloading with `?fps=1`.
        if (fpsBadge) fpsBadge.classList.toggle('hidden');
        break;
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Debug FPS badge                                                    */
/* ------------------------------------------------------------------ */

/**
 * Subscribe the FPS badge to periodic `stats` posts from the render
 * worker.  Two-line readout:
 *
 *   `60 fps`           ← 1000 / mean rAF interval over the last ~60 frames
 *   `4.2 / 7.0 ms`     ← render-submit p50 / p95 over the same window
 *
 * The first line answers "is the user experience smooth?" — it
 * includes GPU execution time (which `renderer.render()`'s submit-side
 * doesn't capture).  The second answers "is the bottleneck on
 * CPU-side submit, or somewhere downstream of submit?" — large p95
 * with low fps suggests CPU-side stalls; small submit time with low
 * fps suggests GPU-bound or compositor-bound.
 *
 * Hidden by default; toggle with `F`.  Visible automatically when
 * the URL has `?fps=1`.
 *
 * @param {HTMLElement | null} badge
 * @param {import('../renderer/RenderClient.js').RenderClient} renderClient
 */
function initFpsBadge(badge, renderClient) {
  if (!badge) return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('fps') === '1' || params.get('fps') === 'true') {
    badge.classList.remove('hidden');
  }
  // Smooth the badge's tier classification so a single noisy frame
  // doesn't flash red — keep the worst-case tier seen in the last
  // ~2 seconds visible until samples consistently improve.
  let tier = 'tier-good';
  let tierStableCount = 0;
  renderClient.onStats = (s) => {
    const fps = Math.round(s.fps);
    const submit = `${s.renderMs.toFixed(1)} / ${s.renderMsP95.toFixed(1)} ms`;
    badge.textContent = `${fps} fps\n${submit}`;
    // Tiering: green ≥55, amber ≥45, red < 45.  Latch on worst-case
    // for ~4 ticks so transient single-frame stalls don't strobe.
    let next;
    if (fps >= 55) next = 'tier-good';
    else if (fps >= 45) next = 'tier-warn';
    else next = 'tier-bad';
    if (tierRank(next) > tierRank(tier)) {
      tier = next;
      tierStableCount = 0;
    } else if (next === tier) {
      tierStableCount = 0;
    } else if (++tierStableCount >= 4) {
      tier = next;
      tierStableCount = 0;
    }
    badge.classList.remove('tier-good', 'tier-warn', 'tier-bad');
    badge.classList.add(tier);
  };
}

/** Higher = worse, used to latch on degraded tiers. */
function tierRank(t) {
  return t === 'tier-bad' ? 2 : t === 'tier-warn' ? 1 : 0;
}
