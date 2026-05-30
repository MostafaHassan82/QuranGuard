# Storage Contract (Δ) — Correction & Autocorrect

**Feature**: 002-correction-autocorrect
**Status**: Phase 1 of `/speckit-plan`. Delta against `specs/001-arabic-citation-auditor/contracts/storage.md`.

Storage area: `chrome.storage.local` only (constitution Tech Constraints; no `chrome.storage.sync`, no `IndexedDB`).

## `prefs.v1` (modified)

### Field delta

| Field | Type | Status | Notes |
|---|---|---|---|
| `autoCorrectOrange` | `boolean` | **Removed (migrated)** | Legacy field; see migration below. |
| `autoCorrect` | `{ orange: boolean, lightBlue: boolean }` | **NEW** | FR-018, FR-020. lightBlue defaults to `true` on fresh install (lightBlue corrections never edit page text); orange carries forward from the legacy field (or `false` on a true fresh install). |

There is no `autoCorrect.yellow` and no `autoCorrect.red`. FR-018 makes yellow and red manual by rule; adding those keys later would be a constitution-significant change and is out of scope.

### Migration rule (one-way, idempotent, runs on first read after upgrade)

```text
read prefs.v1
if 'autoCorrectOrange' in prefs.v1:
    prefs.v1.autoCorrect = {
        orange:    prefs.v1.autoCorrectOrange,
        lightBlue: true                          // FR-018 default-on for lightBlue
    }
    delete prefs.v1.autoCorrectOrange
    write prefs.v1
```

If `prefs.v1.autoCorrect` already exists, do nothing. The migration runs at most once per profile.

### Default `prefs.v1` for a true fresh install (no legacy field present)

The whole shape is owned by feature 001; this feature only specifies the `autoCorrect` field:

```text
autoCorrect: { orange: false, lightBlue: true }
```

## `persisted.v1.byUrl.<urlKey>` (modified)

Each entry in the per-URL array gains a `kind` discriminator. The TTL (30 days, FR-024 of feature 001) and the index key (`persisted.v1.index`, an array of `urlKey` strings) are unchanged.

### Entry shape

```text
{
  compositeKey: string,                                    // identifies the Finding within the URL
  kind: 'ref-edit' | 'text-replace' | 'reference-attribution' | 'dismissal',
  at: ISO8601 string,                                      // drives 30-day TTL eviction
  payload: {
    // shape depends on kind:
    // kind === 'ref-edit'                : { resolvedRef: string }
    // kind === 'text-replace'            : { authenticExcerpt: string, originalCitedText: string }
    // kind === 'reference-attribution'   : { resolvedRef: string }
    // kind === 'dismissal'               : {}
  }
}
```

### Backward compatibility

Entries from feature 001 written before this feature shipped have no `kind` field. They are read as `kind: 'ref-edit'` (the only correction kind feature 001 supported). They are rewritten with the explicit `kind` field on the next mutation of that entry; lazy migration only (no eager batch rewrite).

### Revert semantics (FR-006)

`REVERT_CORRECTION { compositeKey }` deletes the entry where `entry.compositeKey === compositeKey AND entry.kind ∈ {ref-edit, text-replace, reference-attribution}`. The `dismissal` kind is unaffected by Revert — dismissals are cleared by the existing `CLEAR_PERSISTED` flow from feature 001.

### Why `kind` lives on the entry, not on a separate sub-key

Considered storing corrections vs dismissals under separate sub-keys (`persisted.v1.byUrl.<urlKey>.corrections[]`, `persisted.v1.byUrl.<urlKey>.dismissals[]`). Rejected: it forks the read path and the TTL eviction logic for no integrity gain. A single array with a discriminator field is shape-equivalent and preserves feature 001's eviction/index code unchanged.
