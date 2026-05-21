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
    // Bundled Quran fonts (added 2026-05-20). Clean filenames (no spaces/parens)
    // so chrome.runtime.getURL + web_accessible_resources resolve reliably.
    qpcHafs:            { family: 'quran-qpc-hafs',             path: 'resources/fonts/qpc-hafs.ttf' },
    qpcV2:              { family: 'quran-qpc-v2',               path: 'resources/fonts/qpc-v2.woff2' },
    qpcV4Tajweed:       { family: 'quran-qpc-v4-tajweed',       path: 'resources/fonts/qpc-v4-tajweed.ttf' },
    digitalKhattIndopak:{ family: 'quran-digital-khatt-indopak', path: 'resources/fonts/digital-khatt-indopak.otf' },
    digitalKhattV1:     { family: 'quran-digital-khatt-v1',     path: 'resources/fonts/digital-khatt-v1.otf' },
    digitalKhattV2:     { family: 'quran-digital-khatt-v2',     path: 'resources/fonts/digital-khatt-v2.otf' },
    indopakNastaleeq:   { family: 'quran-indopak-nastaleeq',    path: 'resources/fonts/indopak-nastaleeq.ttf' },
    kfgqpcNastaleeq:    { family: 'quran-kfgqpc-nastaleeq',     path: 'resources/fonts/kfgqpc-nastaleeq.ttf' },
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
