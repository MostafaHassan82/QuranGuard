'use strict';
/*
 * Writer-side autocomplete — candidate matching (feature 003, T011).
 *
 * Thin client over the background MATCH_PARTIAL RPC (contracts/messaging.md):
 * the typed citation text → ranked candidate ayahs (tier-first, then mushaf
 * order). The RPC exposes the full cascade exact → wordLevel → fuzzy → none
 * (FR-007); each candidate carries its `tier`, so the dropdown can chip drift
 * candidates and the orchestrator can flag a no-candidate result red (FR-008).
 * Narrowing as the user types (FR-006) is achieved by re-querying with the
 * longer text — a longer fragment necessarily matches fewer verses. A tiny
 * one-entry cache skips a duplicate round-trip when the text is unchanged.
 * (Client-side filtering as a latency optimization is deferred to T030.)
 *
 * Exposed as the QuranComposeMatch global.
 */
const QuranComposeMatch = (() => {
  let cacheKey = null;
  let cachePromise = null;

  async function query(text, limit = 8) {
    const t = String(text || '');
    const key = t + '|' + (limit | 0);
    if (key === cacheKey && cachePromise) return cachePromise;
    cacheKey = key;
    cachePromise = (async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'MATCH_PARTIAL', text: t, limit });
        return (resp && Array.isArray(resp.candidates)) ? resp.candidates : [];
      } catch (_) {
        return [];
      }
    })();
    return cachePromise;
  }

  return { query };
})();
