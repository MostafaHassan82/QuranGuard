'use strict';
/*
 * Async decoration for .quran-ref-marker spans.
 *
 * Each pipeline does the structural wrap on its own (text-node-based in the
 * reader, Range-based via QuranDecoration.wrapRefMarker in the writer). After
 * the wrap lands, this module resolves the cited reference against the verse
 * index and writes the runtime metadata that powers:
 *   - the hover tooltip (dataset.tooltip = the resolved ayah text)
 *   - the document-level click handler that opens quran.com
 *     (dataset.quranSurah / quranAyahFirst / quranAyahLast)
 *   - the .quran-ref-link class that signals clickability (gated by prefs)
 *   - the per-marker font CSS variable used by the tooltip
 *
 * Dependencies (prefs + a Promise-returning sendToBackground) are injected so
 * the module has no module-level state — reader passes STATE.prefs and its
 * own sendToBackground; writer passes its cached prefs and a chrome.runtime
 * .sendMessage Promise wrapper.
 *
 * Exposed as the QuranRefDecoration global.
 */
const QuranRefDecoration = (() => {
  async function decorate(marker, refString, deps) {
    if (!marker || !refString || !deps || typeof deps.sendToBackground !== 'function') return;
    const { sendToBackground, prefs } = deps;
    let resolved = null;
    try {
      resolved = await sendToBackground({ type: 'resolveReference', ref: refString });
    } catch (_) {}
    if (!resolved || !resolved.surahNum || !Array.isArray(resolved.ayahNums) || resolved.ayahNums.length === 0) {
      return;
    }
    const texts = Array.isArray(resolved.ayahTexts) ? resolved.ayahTexts.filter(Boolean) : [];
    if (texts.length) marker.dataset.tooltip = texts.join(' ۝ ');
    // Render the resolved ayah text in the user's selected Quran font
    // (independent of authentic-text swap). The tooltip CSS reads this var.
    if (typeof QuranFonts !== 'undefined') {
      marker.style.setProperty('--quran-ref-tooltip-font', QuranFonts.familyFor(prefs && prefs.font));
    }
    marker.dataset.quranFont = (prefs && prefs.font) || 'uthmaniHafs';
    marker.dataset.quranSurah = String(resolved.surahNum);
    marker.dataset.quranAyahFirst = String(resolved.ayahNums[0]);
    marker.dataset.quranAyahLast = String(resolved.ayahNums[resolved.ayahNums.length - 1]);
    if (!prefs || prefs.refLinks !== false) marker.classList.add('quran-ref-link');
    if (prefs && prefs.refHighlight === false) marker.classList.add('quran-ref-style-off');
    else marker.classList.remove('quran-ref-style-off');
  }
  return { decorate };
})();
