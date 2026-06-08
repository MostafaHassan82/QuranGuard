'use strict';
// T003 — Theme registry (feature 004-appearance-themes).
// Single source of truth for which themes exist in this build. Pure data;
// no functions on the descriptor itself — themes are appearance-only by
// construction (FR-008). See specs/004-appearance-themes/contracts/theme-registry.md.
const QuranThemes = (() => {
  // Ordered: this is the display order in the Appearance picker.
  const list = [
    // Default is the neutral base look (matches the pre-Mihrab UI). Mihrab
    // is an opt-in decorative treatment layered on top via [data-theme="mihrab"].
    // swatchA/swatchB feed the two-tone gradient in the picker card swatch.
    // Carrying them here (instead of hardcoding per-id rules in css/options.css)
    // is what makes SC-007 hold: a new theme = registry descriptor + own CSS file,
    // no shared-file edits.
    { id: 'default', displayName: 'Default', displayNameAr: 'الافتراضي', defaultFor: 'fresh-install', swatchA: '#ffffff', swatchB: '#e2e8f0' },
    { id: 'mihrab',  displayName: 'Mihrab',  displayNameAr: 'المحراب',   defaultFor: 'never',         swatchA: '#0a3a26', swatchB: '#c8a24a' },
    { id: 'atelier', displayName: 'Atelier', displayNameAr: 'الأتلييه',  defaultFor: 'never',         swatchA: '#1a1410', swatchB: '#b8860b' },
    { id: 'diwan',   displayName: 'Diwan',   displayNameAr: 'الديوان',   defaultFor: 'never',         swatchA: '#0b5d3b', swatchB: '#5ba87a' },
    { id: 'marakeb', displayName: 'Marakeb', displayNameAr: 'المراكب',   defaultFor: 'never',         swatchA: '#0a0e0c', swatchB: '#6ee7b7' },
    { id: 'tahrir',  displayName: 'Tahrir',  displayNameAr: 'التحرير',   defaultFor: 'never',         swatchA: '#1a1a1a', swatchB: '#0b5d3b' },
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
