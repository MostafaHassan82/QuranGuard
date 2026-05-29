'use strict';
/*
 * Writer-side autocomplete — citation-in-progress detection (feature 003, T006).
 *
 * Recognizes that the text ending at the caret is a Quran citation being typed,
 * using the SAME signals as the reader-side scanner (FR-001):
 *   - the primary/secondary lead-in phrases (قال تعالى / قوله …), reused from
 *     content.js's shared-scope LEAD_IN_RE / SECONDARY_LEAD_IN_RE when present;
 *   - an opening citation brace ({ « [ ﴿).
 * The citation text is whatever follows the closest such marker, up to the caret.
 *
 * Exposed as the QuranComposeDetect global.
 */
const QuranComposeDetect = (() => {
  const AR = '[\\u0621-\\u063A\\u0641-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06FA-\\u06FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]';
  const AR_RE = new RegExp(AR, 'u');

  // Fallback lead-ins (used only if content.js's constants aren't in scope).
  const FALLBACK_PRIMARY = [
    'قال الله تعالى', 'قال تعالى', 'وقال تعالى', 'قوله تعالى', 'وقوله تعالى',
    'يقول تعالى', 'ويقول تعالى', 'قال عز وجل', 'قوله عز وجل', 'في قوله تعالى',
  ];
  const FALLBACK_SECONDARY = ['وقوله', 'فقوله', 'قوله'];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function primaryRegexG() {
    if (typeof LEAD_IN_RE !== 'undefined') return new RegExp(LEAD_IN_RE.source, 'gu');
    return new RegExp('(?:' + FALLBACK_PRIMARY.map(esc).join('|') + ')\\s*[:：]?\\s*', 'gu');
  }
  function secondaryRegexG() {
    if (typeof SECONDARY_LEAD_IN_RE !== 'undefined') return new RegExp(SECONDARY_LEAD_IN_RE.source, 'gu');
    return new RegExp('(?:' + FALLBACK_SECONDARY.map(esc).join('|') + ')\\s*[:：]?\\s*', 'gu');
  }

  function lastMatchEnd(re, text) {
    let m, end = -1;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      end = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;        // guard against zero-width loops
    }
    return end;
  }

  // Index just AFTER the last unclosed opening citation brace, or -1.
  // Note the ornate Quran brackets: ﴿ (U+FD3F, ORNATE LEFT) OPENS a quote and
  // ﴾ (U+FD3E, ORNATE RIGHT) CLOSES it — they read open→close in RTL.
  function lastOpenBrace(text) {
    let idx = -1;
    for (const ch of ['{', '«', '[', '﴿']) {
      const i = text.lastIndexOf(ch);
      if (i > idx) idx = i;
    }
    if (idx < 0) return -1;
    if (/[}»\]﴾]/.test(text.slice(idx + 1))) return -1; // a close after it → already closed
    return idx + 1;
  }

  function countArabicWords(s) {
    return s.split(/\s+/).filter(w => w && AR_RE.test(w)).length;
  }

  // Returns { citationText, citeStart, wordCount } or null.
  // `citeStart` is the offset (in the same coordinate space as `textBeforeCaret`)
  // where the citation content begins; the citation ends at the caret.
  function detect(textBeforeCaret) {
    if (!textBeforeCaret) return null;
    const markerEnd = Math.max(
      lastMatchEnd(primaryRegexG(), textBeforeCaret),
      lastMatchEnd(secondaryRegexG(), textBeforeCaret),
      lastOpenBrace(textBeforeCaret)
    );
    if (markerEnd < 0) return null;

    let rest = textBeforeCaret.slice(markerEnd);
    const lead = rest.match(/^[\s:：{«\[ ﴿]+/u);     // strip separators / opening punct
    const citeStart = markerEnd + (lead ? lead[0].length : 0);
    let citationText = textBeforeCaret.slice(citeStart);

    if (/[}»\]﴾]/.test(citationText)) return null;        // citation already closed
    citationText = citationText.replace(/\s+$/u, '');          // trim trailing whitespace for matching
    if (!citationText || !AR_RE.test(citationText)) return null;

    const wordCount = countArabicWords(citationText);
    if (wordCount === 0) return null;
    return { citationText, citeStart, wordCount };
  }

  return { detect, countArabicWords };
})();
