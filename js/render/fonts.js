'use strict';
// T059 — Font registry. Maps the three prefs.font enum values to (a) the CSS
// font-family name used by `.quran-swap`, (b) the bundled .ttf asset, and
// (c) ensures the @font-face rules are registered once per page so the
// content script can swap text into any host page.
//
// All three fonts ship with the extension (FR-008 / FR-013 — no network).
const QuranFonts = (() => {
  // CSS family names must NOT collide with anything the host page might use;
  // prefix with `quran-` so we control them exclusively.
  const REGISTRY = {
    uthmaniHafs: { family: 'quran-uthmani-hafs', path: 'resources/fonts/uthmani-hafs.ttf' },
    indoPak:     { family: 'quran-indo-pak',     path: 'resources/fonts/indo-pak.ttf' },
    simplified:  { family: 'quran-simplified',   path: 'resources/fonts/simplified.ttf' },
    // Additional bundled Quran fonts (added 2026-05-20). Filenames keep spaces/
    // parentheses; ensureLoaded() encodes the URL so they resolve.
    qpcHafs:            { family: 'quran-qpc-hafs',            path: 'resources/QPC Hafs (Official Uthmani script font) - TTF.ttf' },
    qpcV2:              { family: 'quran-qpc-v2',              path: 'resources/QPC V2 (King Fahd Complex for the Printing of the Holy Quran) - WOFF2.woff2' },
    qpcV4Tajweed:       { family: 'quran-qpc-v4-tajweed',      path: 'resources/QPC V4 Tajweed - TTF.ttf' },
    digitalKhattIndopak:{ family: 'quran-digital-khatt-indopak', path: 'resources/Digital Khatt Indopak - OTF.otf' },
    digitalKhattV1:     { family: 'quran-digital-khatt-v1',    path: 'resources/Digital Khatt V1 - OTF.otf' },
    digitalKhattV2:     { family: 'quran-digital-khatt-v2',    path: 'resources/Digital Khatt V2 - OTF.otf' },
    indopakNastaleeq:   { family: 'quran-indopak-nastaleeq',   path: 'resources/Indopak Nastaleeq - TTF.ttf' },
    kfgqpcNastaleeq:    { family: 'quran-kfgqpc-nastaleeq',    path: 'resources/KFGQPC Nastaleeq - TTF.ttf' },
    meQuran:            { family: 'quran-me-quran',            path: 'resources/Me Quran - TTF.ttf' },
  };

  function familyFor(prefKey) {
    return REGISTRY[prefKey]?.family || REGISTRY.uthmaniHafs.family;
  }

  // CSS @font-face `format()` hint from the file extension.
  function formatFor(path) {
    const ext = path.split('.').pop().toLowerCase();
    return ext === 'otf' ? 'opentype' : ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : 'truetype';
  }

  // Inject one <style> tag with a @font-face rule per font so the swap span can
  // render in any family. Idempotent — re-running is a no-op.
  function ensureLoaded() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('__quran-ext-fonts')) return;
    if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return;
    const rules = Object.values(REGISTRY).map(r =>
      `@font-face { font-family: '${r.family}'; src: url('${encodeURI(chrome.runtime.getURL(r.path))}') format('${formatFor(r.path)}'); font-display: swap; }`
    ).join('\n');
    const style = document.createElement('style');
    style.id = '__quran-ext-fonts';
    style.textContent = rules;
    (document.head || document.documentElement).appendChild(style);
  }

  return { familyFor, ensureLoaded, REGISTRY };
})();
