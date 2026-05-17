# Contract: `chrome.storage.local` keyspace

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md) | **Model**: [../data-model.md](../data-model.md)

Two top-level key families: `prefs.v1` (user preferences, indefinite) and `persisted.v1.*` (per-URL corrections + dismissals, 30-day TTL). Per FR-013 and FR-024, nothing here leaves the device.

The `.v1` namespace is the schema version. Any breaking change (renamed key, dropped field) bumps to `.v2` and a one-shot migration runs at service worker activation.

---

## `prefs.v1`

Single object. Schema-driven; absent fields fall back to defaults.

```jsonc
{
  "master": {
    "authenticTextReplacement": true            // FR-009 default
  },
  "perColor": {                                  // FR-009 defaults: all four non-red ON
    "green":     true,
    "lightBlue": true,
    "yellow":    true,
    "orange":    true,
    "red":       false                           // FR-015: red is fixed false
  },
  "font": "uthmaniHafs",                         // FR-009: one of uthmaniHafs | indoPak | simplified
  "scanTrigger": "manual",                       // FR-026: manual | autoscan
  "panelSurface": "popup",                       // FR-010: popup | sidebar
  "panelFilter": {                               // FR-010 default: orange only
    "orange":    true,
    "green":     false,
    "lightBlue": false,
    "yellow":    false,
    "red":       false
  }
}
```

**Validation on read** (defensive; in case storage was hand-edited):

- `perColor.red` MUST be `false` (clamped). If found `true`, normalize to `false` and emit a console warning.
- `font` MUST be one of the three known values; otherwise reset to `uthmaniHafs`.
- `scanTrigger` MUST be `manual` or `autoscan`; otherwise reset to `manual`.
- `panelSurface` MUST be `popup` or `sidebar`; otherwise reset to `popup`.

**Default fill on read**: any missing leaf is filled with the default above before the consumer sees the object.

---

## `persisted.v1.byUrl.<urlKey>`

Per-URL array of persisted entries. Lazily pruned on read.

`urlKey` derivation:

```js
function urlKey(rawUrl) {
  const u = new URL(rawUrl);
  u.hash = "";                       // strip #fragment
  const params = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(params).toString();
  return u.toString();
}
```

Wire format:

```jsonc
{
  "v": 1,                            // entry-schema version; tied to the .v1 prefix
  "entries": [
    {
      "compositeKey": "<Finding.id>",        // see data-model.md > Finding > Identity
      "kind": "correction",                  // "correction" | "dismissal"
      "at": "2026-05-17T12:34:56Z"           // ISO-8601 UTC; entry expires at at + 30 days
    },
    // ...
  ]
}
```

**TTL enforcement** (FR-024, 30-day):

- On every `PERSIST_READ` for a `urlKey`, the background worker filters out entries where `Date.parse(at) + 30 * 86400 * 1000 < Date.now()` and writes the filtered array back if any were dropped.
- On every `PERSIST_WRITE`, the same prune runs in the same transaction so the store doesn't grow unbounded for URLs the user visits repeatedly.
- `prunedCount` is included in `PERSIST_READ` responses for telemetry-free debug visibility (logged to console only when an internal `DEBUG_PERSIST` flag is set; never sent anywhere).

**Bulk clear** (FR-024):

- `CLEAR_PERSISTED` removes every `persisted.v1.byUrl.*` key and resets `persisted.v1.index` to `[]`.
- The `prefs.v1` object is NOT touched by `CLEAR_PERSISTED` — preferences and persisted per-URL state have independent lifetimes.

---

## `persisted.v1.index`

A flat list of `urlKey` strings that have at least one persisted entry. Used to enumerate the persisted store for `CLEAR_PERSISTED` without scanning the whole `chrome.storage.local` keyspace.

```jsonc
["https://www.islamweb.net/ar/article/174389/", "https://dorar.net/..."]
```

Maintained by every `PERSIST_WRITE`: add `urlKey` if not present. Pruned by every `PERSIST_READ` that empties an entry: remove `urlKey` if its array drops to zero after TTL pruning.

---

## Size considerations

`chrome.storage.local` has a 10 MB per-extension quota by default (5 MB if quota was not requested in the manifest; we will request `unlimitedStorage` for headroom only if persistence grows beyond a few thousand entries — V1 doesn't need it).

Per-entry footprint: composite key sha1 (40 chars) + kind (≤ 11 chars) + ISO timestamp (24 chars) + JSON overhead ≈ 120 bytes. 1000 corrections + dismissals = ~120 KB. Well under quota even at heavy use.

---

## Migration policy

When the schema needs a breaking change:

1. The new code reads the old key (`prefs.v1` → reads `prefs.v1`, then writes the migrated shape under `prefs.v2`, then deletes `prefs.v1` in a single transaction).
2. The old key is preserved for one extension version after the migration ships, so a downgrade doesn't lose user state catastrophically.
3. The persisted-per-URL store can be migrated lazily on the first `PERSIST_READ` per `urlKey` to avoid a startup scan.

No migrations are needed for V1 — this is the first schema version.

---

## Cross-references

- Identity rule for `compositeKey`: [../data-model.md](../data-model.md) > Finding > Identity.
- Preferences defaults at first install: [../spec.md](../spec.md) FR-009; [../research.md](../research.md) Decision 7.19.
- TTL rationale: [../spec.md](../spec.md) FR-024; [../research.md](../research.md) Decision 7.10.
- Local-only storage stance: [../spec.md](../spec.md) FR-013, FR-024.
