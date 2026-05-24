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
    autoCorrectOrange: false,
    refLinks: true,
    // Whether the cited reference is visually highlighted on the page (gold
    // marker). Independent of refLinks (clickability) and of the hover tooltip,
    // which both remain available when this is off.
    refHighlight: true,
    lang: 'ar',
    panelPosition: 'auto',                  // auto | left | right | float; auto follows lang dir (ar→right, en→left)
    floatAnchor: 'auto',                    // float mode: which edge to anchor to (auto | left | right)
    panelFilter: { orange: true, green: false, lightBlue: false, lightGreen: false, yellow: false, red: false },
    // Per-category on-page highlight style: 'highlight' (colored background),
    // 'underline' (colored underline only), or 'off' (no visual mark). The
    // tooltip is ALWAYS available regardless (the span stays focusable). red may
    // not be 'off' — a not-in-Quran finding must remain visible.
    highlightStyle: { green: 'highlight', lightBlue: 'highlight', lightGreen: 'highlight', yellow: 'highlight', orange: 'highlight', red: 'highlight' },
    // Writer-side ayah autocomplete (feature 003). enabled + liveRender default
    // ON; the feature toggle is the ONLY way to turn autocomplete off (no Esc).
    // refFormat/refPlacement shape the inserted reference; minWords is the
    // performance gate before matching starts.
    autocomplete: { enabled: true, liveRender: true, refFormat: 'arabicName', refPlacement: 'after', minWords: 2 },
  };

  const VALID_REF_FORMATS = new Set(['arabicName', 'number']);
  const VALID_REF_PLACEMENTS = new Set(['after', 'before']);

  const VALID_FONTS = new Set(['uthmaniHafs', 'qpcHafs', 'qpcV2', 'qpcV4Tajweed', 'digitalKhattIndopak', 'digitalKhattV1', 'digitalKhattV2', 'indopakNastaleeq', 'kfgqpcNastaleeq']);
  const VALID_SCAN_TRIGGERS = new Set(['manual', 'autoscan']);
  const VALID_LANGS = new Set(['ar', 'en']);
  const VALID_PANEL_POSITIONS = new Set(['auto', 'left', 'right', 'float']);
  const VALID_FLOAT_ANCHORS = new Set(['auto', 'left', 'right']);
  const VALID_HIGHLIGHT_STYLES = new Set(['highlight', 'underline', 'off']);

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
    if (typeof p.autoCorrectOrange !== 'boolean') p.autoCorrectOrange = DEFAULTS.autoCorrectOrange;
    if (typeof p.refLinks !== 'boolean') p.refLinks = DEFAULTS.refLinks;
    if (typeof p.refHighlight !== 'boolean') p.refHighlight = DEFAULTS.refHighlight;
    if (!VALID_LANGS.has(p.lang)) p.lang = DEFAULTS.lang;
    if (!VALID_PANEL_POSITIONS.has(p.panelPosition)) p.panelPosition = DEFAULTS.panelPosition;
    if (!VALID_FLOAT_ANCHORS.has(p.floatAnchor)) p.floatAnchor = DEFAULTS.floatAnchor;

    if (!p.panelFilter || typeof p.panelFilter !== 'object') p.panelFilter = {};
    for (const color of ['orange', 'green', 'lightBlue', 'lightGreen', 'yellow', 'red']) {
      if (typeof p.panelFilter[color] !== 'boolean') p.panelFilter[color] = DEFAULTS.panelFilter[color];
    }

    if (!p.highlightStyle || typeof p.highlightStyle !== 'object') p.highlightStyle = {};
    for (const color of ['green', 'lightBlue', 'lightGreen', 'yellow', 'orange', 'red']) {
      if (!VALID_HIGHLIGHT_STYLES.has(p.highlightStyle[color])) p.highlightStyle[color] = DEFAULTS.highlightStyle[color];
    }

    // Autocomplete sub-object (feature 003): default-fill + clamp-on-read.
    if (!p.autocomplete || typeof p.autocomplete !== 'object') p.autocomplete = {};
    if (typeof p.autocomplete.enabled !== 'boolean') p.autocomplete.enabled = DEFAULTS.autocomplete.enabled;
    if (typeof p.autocomplete.liveRender !== 'boolean') p.autocomplete.liveRender = DEFAULTS.autocomplete.liveRender;
    if (!VALID_REF_FORMATS.has(p.autocomplete.refFormat)) p.autocomplete.refFormat = DEFAULTS.autocomplete.refFormat;
    if (!VALID_REF_PLACEMENTS.has(p.autocomplete.refPlacement)) p.autocomplete.refPlacement = DEFAULTS.autocomplete.refPlacement;
    {
      let mw = parseInt(p.autocomplete.minWords, 10);
      if (!Number.isFinite(mw)) mw = DEFAULTS.autocomplete.minWords;
      p.autocomplete.minWords = Math.min(5, Math.max(1, mw));
    }

    // Clamp: red MUST be false
    if (p.perColor.red !== false) {
      console.warn('[QuranPrefs] perColor.red clamped to false');
      p.perColor.red = false;
    }
    // Clamp: red + yellow highlights may not be turned off — a not-in-Quran (red)
    // and a word-level deviation (yellow) are the two highest-severity findings
    // (severity: red > yellow > orange) and must stay visible. They may still be
    // switched between 'highlight' and 'underline', just never 'off'.
    for (const lockedColor of ['red', 'yellow']) {
      if (p.highlightStyle[lockedColor] === 'off') {
        console.warn(`[QuranPrefs] highlightStyle.${lockedColor} clamped from off to highlight`);
        p.highlightStyle[lockedColor] = 'highlight';
      }
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

// CommonJS export so the Node prefs-validation test can require it (mirrors
// js/shared/i18n.js). Harmless in the browser/service-worker (no `module`).
if (typeof module !== 'undefined' && module.exports) module.exports = QuranPrefs;
