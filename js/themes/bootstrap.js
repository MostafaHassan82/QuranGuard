'use strict';
// T005 — Theme bootstrap (feature 004-appearance-themes).
// Runs from the <head> of popup.html and options.html BEFORE the main
// stylesheet. Synchronously sets a `theme-loading` class so the default CSS
// can hide body until the persisted theme is applied (FOUC guard, FR-006,
// SC-006). Then asynchronously reads prefs and sets the data-theme attribute.
//
// For the sidebar (injected into pages by the content script), the panel
// surface code calls applyThemeAttribute(panelRoot, themeId) directly during
// construction — no FOUC window because the element is not in DOM until
// after the attribute is set.
//
// Depends on QuranThemes (js/themes/registry.js) and QuranPrefs (js/storage/prefs.js).
// Both MUST be loaded before this script.
(() => {
  const root = document.documentElement;

  // Phase 1: synchronous — hide body via the FOUC guard class.
  root.classList.add('theme-loading');

  // Phase 1.5: best-effort instant default. If prefs read is fast (typical
  // 1-5 ms in MV3 chrome.storage.local), the visible attribute below
  // replaces this before paint. If the read somehow stalls, the default
  // stylesheet renders correctly.
  const defaultId = (typeof QuranThemes !== 'undefined' && QuranThemes.defaultId)
    ? QuranThemes.defaultId()
    : 'default';
  root.dataset.theme = defaultId;

  // Phase 2: async — read persisted theme, then reveal.
  function applyAndReveal(themeId) {
    root.dataset.theme = themeId;
    root.classList.remove('theme-loading');
  }

  if (typeof QuranPrefs !== 'undefined' && QuranPrefs.read) {
    QuranPrefs.read().then((prefs) => {
      const stored = prefs && prefs.appearance && prefs.appearance.theme;
      const themeId = (typeof QuranThemes !== 'undefined' && QuranThemes.isValidId(stored))
        ? stored
        : defaultId;
      applyAndReveal(themeId);
    }).catch(() => {
      // On any failure (storage unavailable, etc.) reveal with the default.
      applyAndReveal(defaultId);
    });
  } else {
    // Prefs module not loaded — reveal anyway so we don't leave the body hidden.
    applyAndReveal(defaultId);
  }

  // Live cross-surface update (Clarifications Q1, FR-004): when the user
  // changes the theme on the options page while THIS surface is also open,
  // re-apply within one frame.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const prefsChange = changes['prefs.v1'];
      if (!prefsChange) return;
      const next = prefsChange.newValue && prefsChange.newValue.appearance && prefsChange.newValue.appearance.theme;
      const prev = prefsChange.oldValue && prefsChange.oldValue.appearance && prefsChange.oldValue.appearance.theme;
      if (next && next !== prev) {
        const themeId = (typeof QuranThemes !== 'undefined' && QuranThemes.isValidId(next))
          ? next
          : defaultId;
        root.dataset.theme = themeId;
      }
    });
  }
})();

// Exported helper for the sidebar panel surface to reuse against its panel root
// element (not the documentElement). Attached to globalThis so content-script
// code can call it after registry.js + prefs.js + bootstrap.js have loaded.
(function exposeApplier() {
  function applyThemeAttribute(rootEl, themeId) {
    if (!rootEl || typeof rootEl.setAttribute !== 'function') return;
    const fallback = (typeof QuranThemes !== 'undefined' && QuranThemes.defaultId)
      ? QuranThemes.defaultId()
      : 'default';
    const id = (typeof QuranThemes !== 'undefined' && QuranThemes.isValidId(themeId))
      ? themeId
      : fallback;
    rootEl.dataset.theme = id;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.QuranThemeApply = applyThemeAttribute;
  }
})();
