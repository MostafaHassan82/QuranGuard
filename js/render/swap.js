'use strict';
// T058 — Authentic-text swap engine. Replaces the visible text of a highlight
// wrapper with the verified Quran wording (full tashkeel) in the user's font.
//
// FR-008 absorption rules:
//   - Only modify CSS *inside* the highlight span.
//   - Rendered line-box MUST NOT exceed 1.5× the surrounding line-box.
//   - No outside-span CSS modifications, ever.
//
// Reversal is fully lossless: the original textContent is stashed on the span
// itself and restored verbatim when revertSwap runs (or when prefs flip).
const QuranSwap = (() => {
  const ATTR_ORIG_TEXT  = 'data-quran-orig-text';
  const ATTR_ORIG_FONT  = 'data-quran-orig-font-family';
  const ATTR_ORIG_SIZE  = 'data-quran-orig-font-size';
  const ATTR_ORIG_LH    = 'data-quran-orig-line-height';
  const CSS_CLASS       = 'quran-swap';

  // T058a — the text we actually paint into the page: the authentic wording
  // for ONLY the cited span (excerpt shape preserved). Falls back to the full
  // ayah if the verifier couldn't produce an aligned excerpt. The full ayah
  // continues to live in finding.authenticText for the panel + copy/share.
  function swapTextFor(finding) {
    return finding.authenticExcerpt || finding.authenticText || '';
  }

  // A match too shaky to safely replace the page text with. Replacing text on a
  // wrong match silently corrupts a possibly-correct citation, so we refuse:
  //  - `*`-separated excerpts that resolved to a SINGLE verse (the separator
  //    means the excerpt spans ayahs, so a one-verse match likely collapsed it
  //    onto the wrong verse — e.g. "أحد * الله" wrongly matched to a single ayah);
  //  - ambiguous matches (the text is found at more than one reference).
  function isShakyMatch(finding) {
    const text = String(finding.text || finding.rawText || '');
    const matchedRef = String(finding.matchedRef || finding.matchedReference || '');
    if (text.includes('*') && matchedRef && !matchedRef.includes('-')) return true;
    if (Array.isArray(finding.matchedRefs) && finding.matchedRefs.length > 1) return true;
    return false;
  }

  function isEligible(finding, prefs) {
    if (!finding || finding.color === 'red') return false; // FR-015
    if (!prefs?.master?.authenticTextReplacement) return false; // FR-009 master
    // lightGreen is a provenance color (a corrected, now-verified citation); it
    // follows green's per-color swap setting rather than needing its own toggle.
    const swapKey = finding.color === 'lightGreen' ? 'green' : finding.color;
    if (prefs.perColor?.[swapKey] !== true) return false; // FR-009 per-color
    if (isShakyMatch(finding)) return false; // don't replace text on an unreliable match
    if (!swapTextFor(finding)) return false;
    return true;
  }

  // Returns the highlight wrapper element for a Finding id, or null.
  function findSpan(findingId) {
    if (!findingId) return null;
    try { return document.querySelector(`[data-finding-id="${cssEscape(findingId)}"]`); }
    catch (_) { return null; }
  }
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // T058b — sizing. The legacy placeholder (uthmaniHafs / me_quran) renders
  // ~25-30% larger than body text, so it gets a `0.8em` + `line-height: 1`
  // downscale to land near the surrounding flow. The real bundled fonts are
  // metrically well-behaved and the user wants them at natural size, so for
  // every font EXCEPT uthmaniHafs we restore the span's original size/line-
  // height instead of shrinking.
  function applyBoundedSizing(span, font) {
    if (font === 'uthmaniHafs') {
      span.style.fontSize = '0.8em';
      span.style.lineHeight = '1';
    } else {
      span.style.fontSize = span.getAttribute(ATTR_ORIG_SIZE) || '';
      span.style.lineHeight = span.getAttribute(ATTR_ORIG_LH) || '';
    }
  }

  function applySwap(finding, prefs) {
    if (!isEligible(finding, prefs)) return false;
    const span = findSpan(finding.id);
    if (!span) return false;
    if (span.classList.contains(CSS_CLASS)) {
      // Already swapped — update font + sizing in case prefs.font changed
      // (switching to/from uthmaniHafs toggles the downscale).
      span.style.fontFamily = QuranFonts.familyFor(prefs.font);
      applyBoundedSizing(span, prefs.font);
      return true;
    }

    // Stash the originals BEFORE any mutation so reversal is exact.
    span.setAttribute(ATTR_ORIG_TEXT, span.textContent);
    span.setAttribute(ATTR_ORIG_FONT, span.style.fontFamily || '');
    span.setAttribute(ATTR_ORIG_SIZE, span.style.fontSize || '');
    span.setAttribute(ATTR_ORIG_LH,   span.style.lineHeight || '');

    span.textContent = swapTextFor(finding);
    span.classList.add(CSS_CLASS);
    span.style.fontFamily = QuranFonts.familyFor(prefs.font);
    applyBoundedSizing(span, prefs.font);
    return true;
  }

  function revertSwap(finding) {
    const span = findSpan(finding?.id);
    if (!span || !span.classList.contains(CSS_CLASS)) return false;
    const orig = span.getAttribute(ATTR_ORIG_TEXT);
    if (orig != null) span.textContent = orig;
    span.style.fontFamily = span.getAttribute(ATTR_ORIG_FONT) || '';
    span.style.fontSize   = span.getAttribute(ATTR_ORIG_SIZE) || '';
    span.style.lineHeight = span.getAttribute(ATTR_ORIG_LH)   || '';
    span.removeAttribute(ATTR_ORIG_TEXT);
    span.removeAttribute(ATTR_ORIG_FONT);
    span.removeAttribute(ATTR_ORIG_SIZE);
    span.removeAttribute(ATTR_ORIG_LH);
    span.classList.remove(CSS_CLASS);
    return true;
  }

  // Bulk operation called from content.js after PREFS_CHANGED — for each
  // finding, apply or revert to match the new prefs state. Cheap because
  // the per-span check short-circuits when state already matches.
  function reconcile(findings, prefs) {
    if (!Array.isArray(findings)) return;
    for (const f of findings) {
      if (isEligible(f, prefs)) applySwap(f, prefs);
      else revertSwap(f);
    }
  }

  return { applySwap, revertSwap, reconcile, isEligible };
})();
