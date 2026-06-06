'use strict';
// T003 — Theme registry (feature 004-appearance-themes).
// Single source of truth for which themes exist in this build. Pure data;
// no functions on the descriptor itself — themes are appearance-only by
// construction (FR-008). See specs/004-appearance-themes/contracts/theme-registry.md.
const QuranThemes = (() => {
  // Ordered: this is the display order in the Appearance picker.
  const list = [
    // Mihrab is the fresh-install default — the current published UI ships
    // this look. "Minimal" is a neutral alternative for users who prefer a
    // less decorative, lower-contrast appearance.
    { id: 'mihrab',  displayName: 'Mihrab',  displayNameAr: 'المحراب', defaultFor: 'fresh-install' },
    { id: 'minimal', displayName: 'Minimal', displayNameAr: 'بسيط',    defaultFor: 'never' },
  ];

  const ids = new Set(list.map(t => t.id));
  const byId = new Map(list.map(t => [t.id, t]));

  function defaultId() {
    const d = list.find(t => t.defaultFor === 'fresh-install');
    return d ? d.id : 'default';
  }

  function isValidId(id) {
    return typeof id === 'string' && ids.has(id);
  }

  function get(id) {
    return byId.get(id) || null;
  }

  return { list, ids, defaultId, isValidId, get };
})();

// CommonJS export so the Node-side registry test can require it (mirrors prefs.js).
// Harmless in the browser/service-worker (no `module`).
if (typeof module !== 'undefined' && module.exports) module.exports = QuranThemes;
