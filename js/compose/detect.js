'use strict';
/*
 * Writer-side autocomplete — citation-in-progress detection (feature 003, T006).
 *
 * Recognizes that the text ending at the caret is a Quran citation being typed,
 * using the SAME signals as the reader-side scanner (FR-001):
 *   - the primary/secondary lead-in phrases (قال تعالى / قوله …), reused from
 *     content.js's shared-scope LEAD_IN_RE / SECONDARY_LEAD_IN_RE when present;
 *   - an opening quote/bracket: { ( [ « ﴿ " ' “ ‘ — any quoting mark a writer
 *     uses to set off a citation.
 * The citation text is whatever follows the closest such marker, up to the caret.
 *
 * Exposed as the QuranComposeDetect global.
 */
const QuranComposeDetect = (() => {
  const AR = '[\\u0621-\\u063A\\u0641-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06FA-\\u06FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]';
  const AR_RE = new RegExp(AR, 'u');

  // Opening quote/bracket → its matching closer. Symmetric quotes (" ') map to
  // themselves. The ornate Quran brackets read open→close in RTL: ﴿ (U+FD3F)
  // OPENS and ﴾ (U+FD3E) CLOSES. Keep this the single source of truth — the
  // regexes and the dangling-opener logic below are all derived from it, and the
  // inserter balances the pair from the closer carried on detect()'s result.
  const CLOSER_FOR = {
    '{': '}', '(': ')', '[': ']', '«': '»', '﴿': '﴾',
    '"': '"', "'": "'", '“': '”', '‘': '’',
  };
  const OPENERS = Object.keys(CLOSER_FOR);
  const CLOSERS = OPENERS.map(o => CLOSER_FOR[o]);
  // Escape the chars that are special INSIDE a regex character class (] \ ^ -).
  const escCC = s => s.replace(/[\]\\^-]/g, '\\$&');
  const OPEN_CC = escCC(OPENERS.join(''));
  const CLOSE_CC = escCC(CLOSERS.join(''));
  const CLOSE_RE = new RegExp('[' + CLOSE_CC + ']');               // any closer
  const LEAD_STRIP_RE = new RegExp('^[\\s:：' + OPEN_CC + ']+', 'u'); // separators + opening punct

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

  // Index just AFTER the last unclosed opening quote/bracket, or -1.
  function lastOpenBrace(text) {
    let idx = -1;
    for (const ch of OPENERS) {
      const i = text.lastIndexOf(ch);
      if (i > idx) idx = i;
    }
    if (idx < 0) return -1;
    if (CLOSE_RE.test(text.slice(idx + 1))) return -1;     // a close after it → already closed
    return idx + 1;
  }

  function countArabicWords(s) {
    return s.split(/\s+/).filter(w => w && AR_RE.test(w)).length;
  }

  // Returns { citationText, citeStart, wordCount, openBracket, closeBracket,
  // citeBraceStart } or null. `citeStart` is the offset (same coordinate space as
  // `textBeforeCaret`) where the citation content begins; it ends at the caret.
  // When the citation was opened with a quote/bracket, `openBracket`/`closeBracket`
  // are the pair and `citeBraceStart` is the opener's offset, so the inserter can
  // replace FROM the opener and emit a balanced pair (no dangling opener).
  function detect(textBeforeCaret) {
    if (!textBeforeCaret) return null;
    const markerEnd = Math.max(
      lastMatchEnd(primaryRegexG(), textBeforeCaret),
      lastMatchEnd(secondaryRegexG(), textBeforeCaret),
      lastOpenBrace(textBeforeCaret)
    );
    if (markerEnd < 0) return null;

    let rest = textBeforeCaret.slice(markerEnd);
    const lead = rest.match(LEAD_STRIP_RE);     // strip separators / opening punct
    const stripped = lead ? lead[0] : '';
    const citeStart = markerEnd + stripped.length;

    // If a quote/bracket opened the citation, record which one and where, so the
    // insert replaces FROM the opener and emits a balanced pair.
    let openBracket = null, citeBraceStart = citeStart;
    const prev = markerEnd > 0 ? textBeforeCaret[markerEnd - 1] : '';
    if (prev && OPENERS.indexOf(prev) >= 0) {
      // lastOpenBrace was the rightmost marker: the opener sits just before markerEnd.
      openBracket = prev; citeBraceStart = markerEnd - 1;
    } else {
      // a lead-in was the marker: the opener (if any) is in the stripped separators.
      let at = -1, ob = null;
      for (const ch of OPENERS) {
        const i = stripped.lastIndexOf(ch);
        if (i > at) { at = i; ob = ch; }
      }
      if (at >= 0) { openBracket = ob; citeBraceStart = markerEnd + at; }
    }
    const closeBracket = openBracket ? CLOSER_FOR[openBracket] : null;
    let citationText = textBeforeCaret.slice(citeStart);

    if (CLOSE_RE.test(citationText)) return null;        // citation already closed
    citationText = citationText.replace(/\s+$/u, '');          // trim trailing whitespace for matching
    if (!citationText || !AR_RE.test(citationText)) return null;

    const wordCount = countArabicWords(citationText);
    if (wordCount === 0) return null;
    return { citationText, citeStart, wordCount, openBracket, closeBracket, citeBraceStart };
  }

  return { detect, countArabicWords };
})();
