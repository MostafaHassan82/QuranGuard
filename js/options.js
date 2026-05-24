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

async function applyPrefsToUI(prefs) {
  applyLang(QuranI18n.detect(prefs.lang));
  const langSel = document.getElementById('lang-select');
  if (langSel) langSel.value = QuranI18n.getLang();

  syncSwapControls(prefs);

  const auto = document.getElementById('autocorrect-orange');
  if (auto) auto.checked = prefs?.autoCorrectOrange === true;

  const refLinks = document.getElementById('ref-links');
  if (refLinks) refLinks.checked = prefs?.refLinks !== false;

  const posSel = document.getElementById('panel-position-select');
  if (posSel) posSel.value = prefs?.panelPosition || 'auto';
  const anchorSel = document.getElementById('float-anchor-select');
  if (anchorSel) {
    anchorSel.value = prefs?.floatAnchor || 'auto';
    anchorSel.disabled = (prefs?.panelPosition || 'auto') !== 'float';  // only relevant when floating
  }

  const collapsed = await loadSidebarCollapsed();
  const elState = document.getElementById(collapsed ? 'state-collapsed' : 'state-expanded');
  if (elState) elState.checked = true;
}

document.addEventListener('DOMContentLoaded', async () => {
  const prefs = await loadPrefs();
  await applyPrefsToUI(prefs);

  // Language (T096) — persist via prefs.lang → PREFS_CHANGED re-localizes the
  // open sidebar; the options page re-localizes itself immediately.
  document.getElementById('lang-select').addEventListener('change', (e) => {
    applyLang(e.target.value);
    savePrefs({ lang: e.target.value });
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

  // Auto-correct all orange (reference-mismatch) findings.
  document.getElementById('autocorrect-orange').addEventListener('change', (e) => {
    savePrefs({ autoCorrectOrange: e.target.checked });
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
