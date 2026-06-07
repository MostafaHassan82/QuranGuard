'use strict';
// T094/T096 — Options page. Home for global, persistent settings: UI language,
// authentic-text swap defaults (master + per-color + font), the initial panel
// state, and "clear remembered corrections and dismissals". Every change is
// persisted via PREFS_WRITE, which broadcasts PREFS_CHANGED so an open sidebar
// reconciles live (no reload needed). Loaded after messaging.js + i18n.js.

// Shared with popup.js + sidebar-surface.js — the sidebar's persisted UI state.
const SIDEBAR_UI_KEY = 'quran.sidebar.ui';

async function loadPrefs() {
  try {
    const resp = await QuranMsg.sendRequest('PREFS_READ', {});
    return resp?.payload?.result || {};
  } catch (_) { return {}; }
}

async function savePrefs(patch) {
  try { await QuranMsg.sendRequest('PREFS_WRITE', { patch }); } catch (_) {}
}

async function loadSidebarCollapsed() {
  try {
    const r = await chrome.storage.local.get(SIDEBAR_UI_KEY);
    return !!(r?.[SIDEBAR_UI_KEY]?.collapsed);
  } catch (_) { return false; }
}

async function saveSidebarCollapsed(collapsed) {
  try {
    const r = await chrome.storage.local.get(SIDEBAR_UI_KEY);
    const ui = r?.[SIDEBAR_UI_KEY] || {};
    ui.collapsed = collapsed;
    await chrome.storage.local.set({ [SIDEBAR_UI_KEY]: ui });
  } catch (_) {}
}

// Switch the catalog, flip dir/lang on <html>, refill all [data-i18n] nodes.
function applyLang(lang) {
  QuranI18n.setLang(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = QuranI18n.dir(lang);
  QuranI18n.applyDom(document);
}

function syncSwapControls(prefs) {
  const master = document.getElementById('swap-master');
  if (master) master.checked = prefs?.master?.authenticTextReplacement !== false;
  const perColor = prefs?.perColor || {};
  document.querySelectorAll('[data-swap-color]').forEach(cb => {
    const c = cb.dataset.swapColor;
    if (c === 'red') { cb.checked = false; cb.disabled = true; return; } // FR-015
    cb.checked = perColor[c] !== false;
  });
  const fontSel = document.getElementById('font-select');
  if (fontSel) fontSel.value = prefs?.font || 'uthmaniHafs';
}

// Item 5 — per-category highlight style selects. Each carries highlight /
// underline / off, except red which omits 'off' (a not-in-Quran finding must
// stay visible — also clamped in prefs.js). Options are (re)built on every
// sync so a language switch re-localizes the option labels.
function syncHighlightStyles(prefs) {
  const styles = prefs?.highlightStyle || {};
  const OPTS = [
    ['highlight', 'hl_style_highlight'],
    ['underline', 'hl_style_underline'],
    ['off',       'hl_style_off'],
  ];
  document.querySelectorAll('.hl-style-select').forEach(sel => {
    const color = sel.dataset.hlColor;
    // red + yellow omit 'off' — the two highest-severity findings stay visible.
    const opts = (color === 'red' || color === 'yellow') ? OPTS.filter(([v]) => v !== 'off') : OPTS;
    sel.innerHTML = '';
    for (const [value, key] of opts) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = QuranI18n.t(key);
      sel.appendChild(o);
    }
    sel.value = styles[color] || 'highlight';
  });
}

async function applyPrefsToUI(prefs) {
  applyLang(QuranI18n.detect(prefs.lang));
  const langSel = document.getElementById('lang-select');
  if (langSel) langSel.value = QuranI18n.getLang();

  syncSwapControls(prefs);
  syncHighlightStyles(prefs);

  const ac = prefs?.autoCorrect || {};
  const auto = document.getElementById('autocorrect-orange');
  if (auto) auto.checked = ac.orange === true;
  const autoLB = document.getElementById('autocorrect-lightblue');
  if (autoLB) autoLB.checked = ac.lightBlue === true;
  const autoY = document.getElementById('autocorrect-yellow');
  if (autoY) autoY.checked = ac.yellow === true;
  const autoR = document.getElementById('autocorrect-red');
  if (autoR) autoR.checked = ac.red === true;

  const refLinks = document.getElementById('ref-links');
  if (refLinks) refLinks.checked = prefs?.refLinks !== false;

  const refHighlight = document.getElementById('ref-highlight');
  if (refHighlight) refHighlight.checked = prefs?.refHighlight !== false;

  const posSel = document.getElementById('panel-position-select');
  if (posSel) posSel.value = prefs?.panelPosition || 'auto';
  const anchorSel = document.getElementById('float-anchor-select');
  if (anchorSel) {
    anchorSel.value = prefs?.floatAnchor || 'auto';
    anchorSel.disabled = (prefs?.panelPosition || 'auto') !== 'float';  // only relevant when floating
  }

  // Ayah autocomplete (feature 003). Defaults: enabled/liveRender on,
  // arabicName/after, minWords 2 — mirrors prefs.js DEFAULTS.autocomplete.
  // (Named `acomp` rather than `ac` to avoid colliding with the autoCorrect
  // alias above; both used to be `ac` in the same function scope.)
  const acomp = prefs?.autocomplete || {};
  const acEnable = document.getElementById('ac-enable');
  if (acEnable) acEnable.checked = acomp.enabled !== false;
  const acLiveRender = document.getElementById('ac-live-render');
  if (acLiveRender) acLiveRender.checked = acomp.liveRender !== false;
  const acRefFormat = document.getElementById('ac-ref-format');
  if (acRefFormat) acRefFormat.value = acomp.refFormat === 'number' ? 'number' : 'arabicName';
  const acRefPlacement = document.getElementById('ac-ref-placement');
  if (acRefPlacement) acRefPlacement.value = acomp.refPlacement === 'before' ? 'before' : 'after';
  const acMinWords = document.getElementById('ac-min-words');
  if (acMinWords) acMinWords.value = String(Math.min(5, Math.max(1, parseInt(acomp.minWords, 10) || 2)));
  // Dropdown size — 0 means "unlimited". If a user previously had an unusual
  // value not in the select's option set, the assignment becomes a no-op and
  // the select keeps its first option ("5"); that's acceptable cosmetic drift
  // because the live setting still reflects the persisted value.
  const acMaxCand = document.getElementById('ac-max-candidates');
  if (acMaxCand) {
    const mc = parseInt(acomp.maxCandidates, 10);
    acMaxCand.value = String(Number.isFinite(mc) && mc >= 0 ? mc : 8);
  }
  const acMaCap = document.getElementById('ac-multi-ayahs-cap');
  if (acMaCap) acMaCap.value = String(Math.min(2000, Math.max(20, parseInt(acomp.multiAyahsWordCap, 10) || 200)));

  const collapsed = await loadSidebarCollapsed();
  const elState = document.getElementById(collapsed ? 'state-collapsed' : 'state-expanded');
  if (elState) elState.checked = true;
}

// T017/T018 — Appearance picker (feature 004). Renders one card per registered
// theme. Click → write prefs.appearance.theme and immediately reflect the change
// on the options page (the page IS its own live preview). Bootstrap-handled
// onChanged listener then propagates the change to popup + sidebar if they are
// open in another window (FR-004 live cross-surface update guarantee).
function renderAppearancePicker(activeId) {
  const picker = document.getElementById('appearance-picker');
  if (!picker || typeof QuranThemes === 'undefined') return;
  // Per-theme name + one-line blurb (US5 / T039). Spans are tagged with
  // data-i18n so QuranI18n.applyDom() re-translates them when the user
  // flips the language without needing to rebuild the picker.
  picker.innerHTML = '';
  for (const t of QuranThemes.list) {
    const label = document.createElement('label');
    label.className = 'theme-card';
    label.dataset.themeId = t.id;
    label.innerHTML = `
      <input type="radio" name="theme" value="${t.id}" ${t.id === activeId ? 'checked' : ''}>
      <span class="theme-card-swatch" aria-hidden="true"></span>
      <span class="theme-card-text">
        <span class="theme-card-name" data-i18n="theme_${t.id}_name"></span>
        <span class="theme-card-desc" data-i18n="theme_${t.id}_desc"></span>
      </span>
    `;
    picker.appendChild(label);
  }
  if (typeof QuranI18n !== 'undefined' && typeof QuranI18n.applyDom === 'function') {
    QuranI18n.applyDom(picker);
  }
}

function setActiveThemeCard(id) {
  document.querySelectorAll('#appearance-picker .theme-card').forEach(card => {
    const isActive = card.dataset.themeId === id;
    card.classList.toggle('is-active', isActive);
    const input = card.querySelector('input[type=radio]');
    if (input) input.checked = isActive;
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const prefs = await loadPrefs();
  await applyPrefsToUI(prefs);

  // Appearance picker initial render. Read the live attribute (bootstrap set
  // it from prefs.appearance.theme) so the picker stays in sync with what the
  // user actually sees, even if the prefs read above races the bootstrap.
  const activeTheme = document.documentElement.dataset.theme
    || (prefs && prefs.appearance && prefs.appearance.theme)
    || (typeof QuranThemes !== 'undefined' ? QuranThemes.defaultId() : 'default');
  renderAppearancePicker(activeTheme);
  setActiveThemeCard(activeTheme);

  document.getElementById('appearance-picker').addEventListener('change', (e) => {
    const target = e.target;
    if (!target || target.name !== 'theme') return;
    const id = target.value;
    if (typeof QuranThemes !== 'undefined' && !QuranThemes.isValidId(id)) return;
    document.documentElement.dataset.theme = id;
    setActiveThemeCard(id);
    savePrefs({ appearance: { theme: id } });
  });

  // Language (T096) — persist via prefs.lang → PREFS_CHANGED re-localizes the
  // open sidebar; the options page re-localizes itself immediately.
  document.getElementById('lang-select').addEventListener('change', (e) => {
    applyLang(e.target.value);
    // Rebuild the dynamically-populated highlight-style option labels in the new
    // language, preserving each select's current value.
    const current = {};
    document.querySelectorAll('.hl-style-select').forEach(s => { current[s.dataset.hlColor] = s.value; });
    syncHighlightStyles({ highlightStyle: current });
    savePrefs({ lang: e.target.value });
  });

  // Item 5 — per-category highlight style.
  document.querySelectorAll('.hl-style-select').forEach(sel => {
    sel.addEventListener('change', () => {
      savePrefs({ highlightStyle: { [sel.dataset.hlColor]: sel.value } });
    });
  });

  // Swap master toggle.
  document.getElementById('swap-master').addEventListener('change', (e) => {
    savePrefs({ master: { authenticTextReplacement: e.target.checked } });
  });

  // Swap per-color overrides (red is locked off — FR-015).
  document.querySelectorAll('[data-swap-color]').forEach(cb => {
    if (cb.dataset.swapColor === 'red') return;
    cb.addEventListener('change', () => {
      savePrefs({ perColor: { [cb.dataset.swapColor]: cb.checked } });
    });
  });

  // Font picker.
  document.getElementById('font-select').addEventListener('change', (e) => {
    savePrefs({ font: e.target.value });
  });

  // Auto-correct all orange (reference-mismatch) findings → autoCorrect.orange.
  document.getElementById('autocorrect-orange').addEventListener('change', (e) => {
    savePrefs({ autoCorrect: { orange: e.target.checked } });
  });
  // Auto-surface the resolved lightBlue reference (panel/tooltip only, no page
  // edit) → autoCorrect.lightBlue. Yellow (replace drifted ayah text with the
  // authentic mushaf wording) and red (accept verifier's near-match when one
  // exists) are opt-in toggles, default OFF.
  const lbEl = document.getElementById('autocorrect-lightblue');
  if (lbEl) lbEl.addEventListener('change', (e) => savePrefs({ autoCorrect: { lightBlue: e.target.checked } }));
  const yEl = document.getElementById('autocorrect-yellow');
  if (yEl) yEl.addEventListener('change', (e) => savePrefs({ autoCorrect: { yellow: e.target.checked } }));
  const rEl = document.getElementById('autocorrect-red');
  if (rEl) rEl.addEventListener('change', (e) => savePrefs({ autoCorrect: { red: e.target.checked } }));

  // Highlight the cited reference on the page (gold marker).
  document.getElementById('ref-highlight').addEventListener('change', (e) => {
    savePrefs({ refHighlight: e.target.checked });
  });

  // Make references clickable quran.com links.
  document.getElementById('ref-links').addEventListener('change', (e) => {
    savePrefs({ refLinks: e.target.checked });
  });

  // Panel docking position (auto / left / right / float). PREFS_CHANGED
  // re-docks any open sidebar live.
  document.getElementById('panel-position-select').addEventListener('change', (e) => {
    savePrefs({ panelPosition: e.target.value });
    const anchorSel = document.getElementById('float-anchor-select');
    if (anchorSel) anchorSel.disabled = e.target.value !== 'float';
  });

  // Floating anchor side (auto / left / right). Only meaningful in float mode.
  document.getElementById('float-anchor-select').addEventListener('change', (e) => {
    savePrefs({ floatAnchor: e.target.value });
  });

  // Initial sidebar state (collapsed / expanded).
  document.querySelectorAll('input[name="panelInitialState"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) saveSidebarCollapsed(radio.value === 'collapsed');
    });
  });

  // Ayah autocomplete (feature 003 / FR-019). Each control patches the
  // prefs.autocomplete sub-object; PREFS_CHANGED reaches the content script's
  // compose orchestrator live (no reload).
  document.getElementById('ac-enable').addEventListener('change', (e) => {
    savePrefs({ autocomplete: { enabled: e.target.checked } });
  });
  document.getElementById('ac-live-render').addEventListener('change', (e) => {
    savePrefs({ autocomplete: { liveRender: e.target.checked } });
  });
  document.getElementById('ac-ref-format').addEventListener('change', (e) => {
    savePrefs({ autocomplete: { refFormat: e.target.value } });
  });
  document.getElementById('ac-ref-placement').addEventListener('change', (e) => {
    savePrefs({ autocomplete: { refPlacement: e.target.value } });
  });
  document.getElementById('ac-min-words').addEventListener('change', (e) => {
    savePrefs({ autocomplete: { minWords: parseInt(e.target.value, 10) } });
  });
  const acMaxCandEl = document.getElementById('ac-max-candidates');
  if (acMaxCandEl) acMaxCandEl.addEventListener('change', (e) => {
    savePrefs({ autocomplete: { maxCandidates: parseInt(e.target.value, 10) } });
  });
  const acMaCapEl = document.getElementById('ac-multi-ayahs-cap');
  if (acMaCapEl) acMaCapEl.addEventListener('change', (e) => {
    savePrefs({ autocomplete: { multiAyahsWordCap: parseInt(e.target.value, 10) } });
  });

  // Clear remembered corrections + dismissals (T072 / FR-024).
  document.getElementById('btn-clear-persisted').addEventListener('click', async () => {
    const btn = document.getElementById('btn-clear-persisted');
    const status = document.getElementById('persist-status');
    btn.disabled = true;
    try {
      const resp = await QuranMsg.sendRequest('CLEAR_PERSISTED', {});
      const pruned = resp?.payload?.result?.prunedCount ?? 0;
      status.textContent = QuranI18n.t('persist_cleared', { n: pruned });
    } catch (_) {
      status.textContent = QuranI18n.t('persist_clear_failed');
    } finally {
      btn.disabled = false;
    }
  });
});
