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
  };

  function familyFor(prefKey) {
    return REGISTRY[prefKey]?.family || REGISTRY.uthmaniHafs.family;
  }

  // Inject one <style> tag with three @font-face rules so the swap span can
  // render in any of the three families. Idempotent — re-running is a no-op.
  function ensureLoaded() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('__quran-ext-fonts')) return;
    if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return;
    const rules = Object.values(REGISTRY).map(r =>
      `@font-face { font-family: '${r.family}'; src: url('${chrome.runtime.getURL(r.path)}') format('truetype'); font-display: swap; }`
    ).join('\n');
    const style = document.createElement('style');
    style.id = '__quran-ext-fonts';
    style.textContent = rules;
    (document.head || document.documentElement).appendChild(style);
  }

  return { familyFor, ensureLoaded, REGISTRY };
})();
