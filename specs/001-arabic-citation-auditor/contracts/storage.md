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
  "font": "uthmaniHafs",                         // see font set below; default uthmaniHafs
  "lang": "ar",                                  // T087: ar | en (default browser ar/en, else en)
  "scanTrigger": "manual",                       // FR-026: manual | autoscan
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
- `font` MUST be one of the known font keys (see below); otherwise reset to `uthmaniHafs`.
- `lang` MUST be `ar` or `en`; otherwise reset to `ar`.
- `scanTrigger` MUST be `manual` or `autoscan`; otherwise reset to `manual`.

**Default fill on read**: any missing leaf is filled with the default above before the consumer sees the object.

### Font set (updated 2026-05-21)

`font` is one of the nine bundled-font keys (all under `resources/fonts/`, all
local — no network per FR-008): `uthmaniHafs` (default), `qpcHafs`, `qpcV2`,
`qpcV4Tajweed`, `digitalKhattIndopak`, `digitalKhattV1`, `digitalKhattV2`,
`indopakNastaleeq`, `kfgqpcNastaleeq`. Source of truth: `QuranFonts.REGISTRY`
in `js/render/fonts.js`; the validator's `VALID_FONTS` set mirrors it.

The original three-value enum (`uthmaniHafs | indoPak | simplified`) shipped
with placeholder font files that were **byte-identical** to one another, so
`indoPak` and `simplified` were never visually distinct fonts. They were
removed on 2026-05-21 when real fonts were added. **No schema version bump**:
the change is additive for the new keys, and the two dropped values clamp to
`uthmaniHafs` on read — which rendered identically to those placeholders anyway,
so no user-visible state is lost.

### Removed: `panelSurface` (2026-05-21)

Earlier schemas carried `panelSurface: "popup" | "sidebar"` (FR-010's two-surface
choice). The product converged on the **page-injected sidebar as the only panel
surface** (the popup is scan/controls only), so the field is no longer written
or read. It was dropped from defaults + validation; any stored value is inert.
No version bump — removing an unread field changes no behavior. See `AGENTS.md`
and the FR-010 implementation note in `spec.md`.

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
