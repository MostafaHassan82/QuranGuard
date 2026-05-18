'use strict';
// T030 — Five-color decision helpers + result builder.
// The verifier's branching logic lives in background.js (it needs closure access
// to indexes and the search helpers). This module owns the *taxonomy* contract:
// the canonical 5 categories (FR-002), the result shape, and the FR-015/017/018
// guard rails. Loaded via importScripts in the service worker.
const QuranClassify = (() => {
  // Constitution Principle II + FR-002: exactly five categories. Anything outside
  // this set MUST not appear in any VerificationResult.
  const CATEGORIES = Object.freeze(['green', 'lightBlue', 'yellow', 'orange', 'red']);
  const CATEGORY_SET = new Set(CATEGORIES);

  // Confidences that may legitimately produce green per FR-017.
  // Anything else — wordLevel, skeletonOnly, none — is fuzzier and MUST NOT
  // be promoted to green by any caller.
  const GREEN_DEVIATIONS = Object.freeze(['none', 'tashkeelOnly', 'spellingDrift']);
  const GREEN_DEVIATION_SET = new Set(GREEN_DEVIATIONS);

  function assertCategory(color) {
    if (color === null) return null;
    if (!CATEGORY_SET.has(color)) {
      throw new Error(`[QuranClassify] Invalid category: ${color}. Allowed: ${CATEGORIES.join(', ')}`);
    }
    return color;
  }

  // FR-017: a green result requires the deviation to be one of the green-eligible set.
  // Any caller asking for green with a non-eligible deviation is a bug we want loud.
  function assertGreenAllowed(color, deviation) {
    if (color === 'green' && deviation && !GREEN_DEVIATION_SET.has(deviation)) {
      throw new Error(`[QuranClassify] Green requires deviation in ${GREEN_DEVIATIONS.join('|')}, got '${deviation}'`);
    }
  }

  function makeResult(o) {
    const color = assertCategory(o.color ?? null);
    assertGreenAllowed(color, o.deviation);
    return {
      color,
      matchedRef: o.matchedRef ?? null,
      matchedRefs: o.matchedRefs ?? [],
      claimedRef: o.claimedRef ?? null,
      authenticText: o.authenticText ?? null,
      deviation: o.deviation ?? null,
      candidateConfidence: o.candidateConfidence ?? 'medium',
      matchType: o.matchType ?? 'none',
      allExactRefs: o.allExactRefs ?? [],
      allPartialRefs: o.allPartialRefs ?? [],
    };
  }

  // FR-018: when no signals AND no match, drop the candidate silently rather than
  // emitting a finding. Callers use this for the "low confidence + no global hit"
  // path. The badge / panel will see no entry, which is the intended behavior.
  function silentDrop(candidateConfidence) {
    return makeResult({ color: null, candidateConfidence, matchType: 'none' });
  }

  return { CATEGORIES, GREEN_DEVIATIONS, makeResult, silentDrop, assertCategory };
})();
