'use strict';
/*
 * Writer-side autocomplete — insertion builder (feature 003, T013 + T017/T018).
 *
 * Builds the text that replaces the user's typed citation: the AUTHENTIC ayah
 * wording (never the user's drifted text — FR-017) plus a reference formatted
 * per prefs (FR-014).
 *
 * Insertion scope (FR-015) is honored here:
 *   - 'whole'          → the complete authentic verse.
 *   - 'typedPortion'   → only the authentic words the typed fragment aligns to.
 *   - 'startToEndWord' → from the typed start through the authentic word matching
 *                        a user-supplied end word; if that end word is absent from
 *                        the verse after the start, NO truncated insert is made —
 *                        the caller is told instead (FR-016).
 *
 * Alignment is done by Tier-1-normalizing both the typed fragment and the verse
 * words (reusing js/verifier/normalize.js) and locating the contiguous run of
 * verse words the typed words map onto. The ORIGINAL (vocalized) verse words are
 * what gets inserted — normalization is only the comparison key, so the inserted
 * text is always authentic mushaf wording, never the user's typing.
 *
 * Exposed as the QuranComposeInsert global.
 */
const QuranComposeInsert = (() => {

  function norm(s) {
    return (typeof QuranNormalize !== 'undefined') ? QuranNormalize.tier1(String(s || '')) : String(s || '').trim();
  }
  function normWords(s) {
    const n = norm(s);
    return n ? n.split(' ').filter(Boolean) : [];
  }

  function buildReference(candidate, settings) {
    const ayah = candidate.ref.ayah;
    const inner = (settings && settings.refFormat === 'number')
      ? `${candidate.ref.surah}:${ayah}`
      : `${candidate.surahName}:${ayah}`;
    return `(${inner})`;
  }

  // Find the contiguous run of verse words (by index) that the typed fragment
  // aligns to. Returns { start, end } inclusive into `verseWords`, or null when
  // no leading word matches. Greedy: anchors on the first typed word, then walks
  // forward word-for-word while the normalized forms agree.
  function alignSpan(typedText, verseNorm) {
    const typed = normWords(typedText);
    if (!typed.length || !verseNorm.length) return null;
    let best = null;
    for (let s = 0; s < verseNorm.length; s++) {
      let v = s, t = 0;
      while (t < typed.length && v < verseNorm.length && verseNorm[v] === typed[t]) { v++; t++; }
      if (t > 0 && (!best || t > best.matched)) {
        best = { start: s, end: v - 1, matched: t };
        if (t === typed.length) break;           // full alignment, can't do better
      }
    }
    return best;
  }

  function findEndWord(endWord, verseNorm, fromStart) {
    const target = norm(endWord);
    if (!target) return -1;
    for (let i = fromStart; i < verseNorm.length; i++) if (verseNorm[i] === target) return i;
    return -1;
  }

  // Returns { body } with the authentic wording for the chosen scope, or
  // { error } when the scope cannot be satisfied (e.g. end word not found).
  // opts: { typedText, endWord }
  function buildBody(candidate, scope, opts) {
    opts = opts || {};
    const verse = candidate.authenticText;
    if (scope === 'whole' || !opts.typedText) return { body: verse };

    const verseWords = verse.split(/\s+/).filter(Boolean);
    const verseNorm = verseWords.map(norm);
    const span = alignSpan(opts.typedText, verseNorm);
    // No alignment → fall back to the whole authentic verse (still authentic +
    // complete; we never insert the user's drifted text — FR-017).
    if (!span) return { body: verse };

    if (scope === 'typedPortion') {
      return { body: verseWords.slice(span.start, span.end + 1).join(' ') };
    }
    if (scope === 'startToEndWord') {
      if (!opts.endWord) return { error: 'endWordMissing' };
      const endIdx = findEndWord(opts.endWord, verseNorm, span.start);
      if (endIdx < 0) return { error: 'endWordNotFound' };   // FR-016 — no truncated insert
      return { body: verseWords.slice(span.start, endIdx + 1).join(' ') };
    }
    return { body: verse };
  }

  // Returns { text } ready to insert, or { error } (e.g. 'endWordNotFound').
  function buildInsertText(candidate, scope, settings, opts) {
    const r = buildBody(candidate, scope, opts);
    if (r.error) return { error: r.error };
    const ref = buildReference(candidate, settings);
    const text = (settings && settings.refPlacement === 'before')
      ? `${ref} ${r.body}` : `${r.body} ${ref}`;
    return { text };
  }

  return { buildInsertText, buildReference, buildBody };
})();
