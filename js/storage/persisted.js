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
    // T005 (contracts/storage.md > Backward compatibility): entries written by
    // feature 001 before the V1.2 correction work carry no `kind`. They predate
    // every kind except orange's reference rewrite, so they are read as
    // 'ref-edit'. Lazy migration only — the explicit field is rewritten on the
    // next mutation of that entry (see write/remove); no eager batch rewrite.
    const live = stored.entries
      .filter(e => !isExpired(e))
      .map(e => (e.kind ? e : { ...e, kind: 'ref-edit' }));
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
  // `kind` is a CorrectionKind ('ref-edit'|'text-replace'|'reference-attribution')
  // or 'dismissal' (contracts/storage.md). Absent kind defaults to 'ref-edit' for
  // symmetry with the read-path legacy normalization. `payload` is the kind-shaped
  // record Revert reads back (e.g. text-replace carries {authenticExcerpt,
  // originalCitedText}); omitted when the kind needs no restore payload.
  async function write({ urlKey: key, compositeKey, kind, at, payload }) {
    if (!kind) kind = 'ref-edit';
    const storageKey = byUrlStorageKey(key);
    const result = await chrome.storage.local.get([storageKey, INDEX_KEY]);
    const stored = result[storageKey];

    let entries = (stored && Array.isArray(stored.entries)) ? stored.entries : [];

    // Prune expired and prune duplicates (same compositeKey+kind)
    entries = entries.filter(e => !isExpired(e) && !(e.compositeKey === compositeKey && e.kind === kind));
    const entry = { compositeKey, kind, at };
    if (payload !== undefined) entry.payload = payload;
    entries.push(entry);

    const index = Array.isArray(result[INDEX_KEY]) ? result[INDEX_KEY] : [];
    if (!index.includes(key)) index.push(key);

    await chrome.storage.local.set({
      [storageKey]: { v: 1, entries },
      [INDEX_KEY]: index,
    });
  }

  // Remove a single entry (urlKey, compositeKey, kind). Used by FR-006 Revert and
  // FR-025 dismissal-restore. Drops the byUrl key + index entry when the last
  // record is removed. Returns whether a matching entry was actually deleted
  // (T052: callers surface "could not find persisted entry" cleanly).
  async function remove({ urlKey: key, compositeKey, kind }) {
    if (!kind) kind = 'ref-edit';
    const storageKey = byUrlStorageKey(key);
    const result = await chrome.storage.local.get([storageKey, INDEX_KEY]);
    const stored = result[storageKey];
    if (!stored || !Array.isArray(stored.entries)) return { removed: false };

    // Legacy entries with no `kind` are 'ref-edit' (read-path normalization).
    const matches = (e) => e.compositeKey === compositeKey && (e.kind || 'ref-edit') === kind;
    const removed = stored.entries.some(e => !isExpired(e) && matches(e));
    const entries = stored.entries.filter(e => !isExpired(e) && !matches(e));
    const index = Array.isArray(result[INDEX_KEY]) ? result[INDEX_KEY] : [];
    if (entries.length === 0) {
      await chrome.storage.local.remove(storageKey);
      await chrome.storage.local.set({ [INDEX_KEY]: index.filter(k => k !== key) });
    } else {
      await chrome.storage.local.set({ [storageKey]: { v: 1, entries } });
    }
    return { removed };
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

  return { urlKey, read, write, remove, clearAll };
})();
