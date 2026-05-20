'use strict';
// T007 — prefs.v1 read/write/patch with default-fill on read and clamp-on-read.
// Exported as QuranPrefs global.
const QuranPrefs = (() => {
  const STORAGE_KEY = 'prefs.v1';

  const DEFAULTS = {
    master: { authenticTextReplacement: true },
    perColor: { green: true, lightBlue: true, yellow: true, orange: true, red: false },
    font: 'uthmaniHafs',
    scanTrigger: 'manual',
    panelSurface: 'popup',
    lang: 'ar',
    panelFilter: { orange: true, green: false, lightBlue: false, yellow: false, red: false },
  };

  const VALID_FONTS = new Set(['uthmaniHafs', 'indoPak', 'simplified']);
  const VALID_SCAN_TRIGGERS = new Set(['manual', 'autoscan']);
  const VALID_PANEL_SURFACES = new Set(['popup', 'sidebar']);
  const VALID_LANGS = new Set(['ar', 'en']);

  function applyDefaults(raw) {
    const p = raw ? JSON.parse(JSON.stringify(raw)) : {};

    if (!p.master || typeof p.master !== 'object') p.master = {};
    if (typeof p.master.authenticTextReplacement !== 'boolean')
      p.master.authenticTextReplacement = DEFAULTS.master.authenticTextReplacement;

    if (!p.perColor || typeof p.perColor !== 'object') p.perColor = {};
    for (const color of ['green', 'lightBlue', 'yellow', 'orange', 'red']) {
      if (typeof p.perColor[color] !== 'boolean') p.perColor[color] = DEFAULTS.perColor[color];
    }

    if (!VALID_FONTS.has(p.font)) p.font = DEFAULTS.font;
    if (!VALID_SCAN_TRIGGERS.has(p.scanTrigger)) p.scanTrigger = DEFAULTS.scanTrigger;
    if (!VALID_PANEL_SURFACES.has(p.panelSurface)) p.panelSurface = DEFAULTS.panelSurface;
    if (!VALID_LANGS.has(p.lang)) p.lang = DEFAULTS.lang;

    if (!p.panelFilter || typeof p.panelFilter !== 'object') p.panelFilter = {};
    for (const color of ['orange', 'green', 'lightBlue', 'yellow', 'red']) {
      if (typeof p.panelFilter[color] !== 'boolean') p.panelFilter[color] = DEFAULTS.panelFilter[color];
    }

    // Clamp: red MUST be false
    if (p.perColor.red !== false) {
      console.warn('[QuranPrefs] perColor.red clamped to false');
      p.perColor.red = false;
    }

    return p;
  }

  async function read() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return applyDefaults(result[STORAGE_KEY]);
  }

  async function write(prefs) {
    await chrome.storage.local.set({ [STORAGE_KEY]: applyDefaults(prefs) });
  }

  // Shallow-merge patch into existing prefs, then write back.
  async function patch(partial) {
    const current = await read();
    const merged = Object.assign({}, current);
    for (const key of Object.keys(partial)) {
      if (partial[key] !== null && typeof partial[key] === 'object' && !Array.isArray(partial[key])) {
        merged[key] = Object.assign({}, current[key] || {}, partial[key]);
      } else {
        merged[key] = partial[key];
      }
    }
    const validated = applyDefaults(merged);
    await chrome.storage.local.set({ [STORAGE_KEY]: validated });
    return validated;
  }

  return { read, write, patch, DEFAULTS };
})();
