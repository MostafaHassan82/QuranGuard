'use strict';
/*
 * Writer-side autocomplete — insertion builder (feature 003, T013).
 *
 * Builds the text that replaces the user's typed citation: the AUTHENTIC ayah
 * wording (never the user's drifted text — FR-017) plus a reference formatted
 * per prefs (FR-014). The insertion scope (FR-015) is parameterized; US1 uses
 * 'whole'. 'typedPortion' and 'startToEndWord' are wired in US2 (T017).
 *
 * Exposed as the QuranComposeInsert global.
 */
const QuranComposeInsert = (() => {

  function buildReference(candidate, settings) {
    const ayah = candidate.ref.ayah;
    const inner = (settings && settings.refFormat === 'number')
      ? `${candidate.ref.surah}:${ayah}`
      : `${candidate.surahName}:${ayah}`;
    return `(${inner})`;
  }

  // scope: 'whole' | 'typedPortion' | 'startToEndWord'
  // For US1 only 'whole' is exercised; the others fall back to whole until T017.
  function buildBody(candidate, scope /*, typedText, endWord */) {
    // US2 (T017) will compute the typed-portion / start-to-end-word slices here.
    return candidate.authenticText;
  }

  function buildInsertText(candidate, scope, settings) {
    const body = buildBody(candidate, scope);
    const ref = buildReference(candidate, settings);
    return (settings && settings.refPlacement === 'before') ? `${ref} ${body}` : `${body} ${ref}`;
  }

  return { buildInsertText, buildReference, buildBody };
})();
