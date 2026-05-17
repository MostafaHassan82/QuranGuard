'use strict';
// T009 — Per-URL persisted corrections + dismissals with 30-day TTL.
// Exported as QuranPersisted global.
const QuranPersisted = (() => {
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const INDEX_KEY = 'persisted.v1.index';

  function urlKey(rawUrl) {
    const u = new URL(rawUrl);
    u.hash = '';
    const params = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b));
    u.search = new URLSearchParams(params).toString();
    return u.toString();
  }

  function byUrlStorageKey(key) {
    return `persisted.v1.byUrl.${key}`;
  }

  function isExpired(entry) {
    return Date.parse(entry.at) + TTL_MS < Date.now();
  }

  // Read entries for a urlKey, pruning expired ones lazily.
  // Returns {entries, prunedCount}.
  async function read(key) {
    const storageKey = byUrlStorageKey(key);
    const result = await chrome.storage.local.get([storageKey, INDEX_KEY]);
    const stored = result[storageKey];

    if (!stored || !Array.isArray(stored.entries)) {
      return { entries: [], prunedCount: 0 };
    }

    const before = stored.entries.length;
    const live = stored.entries.filter(e => !isExpired(e));
    const prunedCount = before - live.length;

    if (prunedCount > 0) {
      if (live.length === 0) {
        await chrome.storage.local.remove(storageKey);
        const index = Array.isArray(result[INDEX_KEY]) ? result[INDEX_KEY] : [];
        await chrome.storage.local.set({ [INDEX_KEY]: index.filter(k => k !== key) });
      } else {
        await chrome.storage.local.set({ [storageKey]: { v: 1, entries: live } });
      }
    }

    return { entries: live, prunedCount };
  }

  // Write (upsert) a single persisted entry. Idempotent per (urlKey, compositeKey, kind).
  async function write({ urlKey: key, compositeKey, kind, at }) {
    const storageKey = byUrlStorageKey(key);
    const result = await chrome.storage.local.get([storageKey, INDEX_KEY]);
    const stored = result[storageKey];

    let entries = (stored && Array.isArray(stored.entries)) ? stored.entries : [];

    // Prune expired and prune duplicates (same compositeKey+kind)
    entries = entries.filter(e => !isExpired(e) && !(e.compositeKey === compositeKey && e.kind === kind));
    entries.push({ compositeKey, kind, at });

    const index = Array.isArray(result[INDEX_KEY]) ? result[INDEX_KEY] : [];
    if (!index.includes(key)) index.push(key);

    await chrome.storage.local.set({
      [storageKey]: { v: 1, entries },
      [INDEX_KEY]: index,
    });
  }

  // Remove all persisted.v1.byUrl.* keys and reset the index.
  async function clearAll() {
    const result = await chrome.storage.local.get(INDEX_KEY);
    const index = Array.isArray(result[INDEX_KEY]) ? result[INDEX_KEY] : [];
    const keysToRemove = index.map(byUrlStorageKey);
    if (keysToRemove.length > 0) await chrome.storage.local.remove(keysToRemove);
    await chrome.storage.local.set({ [INDEX_KEY]: [] });
    return { prunedCount: keysToRemove.length };
  }

  return { urlKey, read, write, clearAll };
})();
