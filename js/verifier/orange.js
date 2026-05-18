'use strict';
// T031 — Orange (reference-mismatch) pipeline.
// Constitution Principle III + FR-004 + FR-016: orange is the flagship signal —
// the text IS Quran but at a DIFFERENT ayah than the page claims. This module
// owns the decision: given a candidate that didn't match its claimed ayah, does
// it match an unrelated ayah globally? If yes → orange.
//
// Search helpers (findExactGlobal, findOrderedContiguousGlobal) and the indexes
// live in background.js's closure; we receive them as a `searchAPI` parameter so
// orange.js stays a pure module.
const QuranOrange = (() => {

  // Returns an array of records that match candidate text EXACTLY (full or
  // contiguous-subsequence) but are NOT at the claimed ref. Empty if no
  // elsewhere-match exists.
  //
  // searchAPI: { findExactGlobal, findOrderedContiguousGlobal }
  // resolved : { surahNum, ayahNums } from QuranReferences.resolve()
  function findElsewhere(t1, words, resolved, searchAPI) {
    const claimedKeys = new Set(resolved.ayahNums.map(n => `${resolved.surahNum}:${n}`));
    let recs = searchAPI.findExactGlobal(t1);
    if (recs.length === 0) recs = searchAPI.findOrderedContiguousGlobal(words);
    return recs.filter(r => !claimedKeys.has(`${r.surahNum}:${r.ayahNum}`));
  }

  // High-level entry point. Returns null if no orange-worthy mismatch found,
  // or a sorted-by-surah array of records that ARE real Quran at other ayahs.
  // Caller (background.js) wraps the first record into a makeResult({color:'orange',...}).
  //
  // FR-016 confidence gate: only attempt orange when the candidate came in with
  // high confidence (i.e. brace-bounded or strong lead-in extraction). Low-
  // confidence candidates with elsewhere-matches are too noisy and should fall
  // through to a quieter path.
  function classify(t1, words, resolved, candidateConfidence, searchAPI) {
    if (candidateConfidence !== 'high') return null;
    const elsewhere = findElsewhere(t1, words, resolved, searchAPI);
    if (elsewhere.length === 0) return null;
    return elsewhere.slice().sort(
      (a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum
    );
  }

  return { classify, findElsewhere };
})();
