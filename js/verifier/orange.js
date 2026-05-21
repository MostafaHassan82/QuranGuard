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

  // Returns an array of records that match candidate text (full or
  // contiguous-subsequence) but are NOT at the claimed ref. Empty if no
  // elsewhere-match exists.
  //
  // Search escalates from strict to soft so cited text with normal Uthmani
  // drift (e.g. cited "تري" vs Quran "تريا") still triggers orange when the
  // text matches an unrelated verse — without this, drift would silently
  // downgrade a wrong-reference into red.
  //
  // searchAPI: { findExactGlobal, findOrderedContiguousGlobal,
  //              findOrderedContiguousSoftGlobal? }
  function findElsewhere(t1, words, resolved, searchAPI) {
    const claimedKeys = new Set(resolved.ayahNums.map(n => `${resolved.surahNum}:${n}`));
    let recs = searchAPI.findExactGlobal(t1);
    if (recs.length === 0) recs = searchAPI.findOrderedContiguousGlobal(words);
    if (recs.length === 0 && searchAPI.findOrderedContiguousSoftGlobal) {
      recs = searchAPI.findOrderedContiguousSoftGlobal(words);
    }
    return recs.filter(r => !claimedKeys.has(`${r.surahNum}:${r.ayahNum}`));
  }

  function sortRecs(recs) {
    return recs.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
  }

  // High-level entry point. Returns null if no orange-worthy mismatch found,
  // or a sorted-by-surah array of records that ARE real Quran at other ayahs.
  // Caller (background.js) wraps the first record into a makeResult({color:'orange',...}).
  //
  // FR-016 confidence gate, refined: the gate is really about MATCH quality, not
  // the extractor's a-priori confidence label. An EXACT full-verse match
  // elsewhere is self-validating — the candidate text is verbatim a complete
  // ayah, so the extraction boundary was correct and the wrong-reference
  // accusation is justified even for a medium-confidence explicit-ref candidate
  // (a bare Arabic run before a ref, or a short fragment). The fuzzier
  // subsequence/soft tiers carry real boundary ambiguity, so they stay gated to
  // high-confidence candidates to protect orange precision.
  function classify(t1, words, resolved, candidateConfidence, searchAPI) {
    const claimedKeys = new Set(resolved.ayahNums.map(n => `${resolved.surahNum}:${n}`));
    const notClaimed = r => !claimedKeys.has(`${r.surahNum}:${r.ayahNum}`);

    const exact = searchAPI.findExactGlobal(t1).filter(notClaimed);
    if (exact.length > 0) return sortRecs(exact);

    if (candidateConfidence !== 'high') return null;
    let recs = searchAPI.findOrderedContiguousGlobal(words);
    if (recs.length === 0 && searchAPI.findOrderedContiguousSoftGlobal) {
      recs = searchAPI.findOrderedContiguousSoftGlobal(words);
    }
    recs = recs.filter(notClaimed);
    return recs.length ? sortRecs(recs) : null;
  }

  return { classify, findElsewhere };
})();
