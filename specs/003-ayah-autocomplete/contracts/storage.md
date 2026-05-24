# Contract — Storage (Writer-Side Autocomplete)

This feature extends the existing `prefs.v1` object in `chrome.storage.local` with one new sub-object, `autocomplete`. **No new top-level key, no new keyspace, and no `prefs` version bump** — the field is default-filled on read and clamped, the same forward-compatible pattern feature 001 used for the font set.

## `prefs.v1.autocomplete`

```jsonc
{
  "prefs": {
    // ... existing feature-001 prefs (master, perColor, font, highlightStyle, lang, autoCorrectOrange, ...) ...
    "autocomplete": {
      "enabled": true,            // FR-019 — master on/off for the whole feature
      "liveRender": true,         // FR-018/019 — Quran-font + verdict styling in editable fields
      "refFormat": "arabicName",  // FR-014 — "arabicName" → (البقرة:255) | "number" → (2:255)
      "refPlacement": "after",    // FR-014 — "after" | "before" the inserted ayah
      "minWords": 2               // FR-003 — Arabic-word gate before matching starts
    }
  }
}
```

## Defaults & clamp-on-read (in `js/storage/prefs.js`)

| Field | Default | Clamp / validation on read |
|---|---|---|
| `enabled` | `true` | non-boolean → `true` |
| `liveRender` | `true` | non-boolean → `true` |
| `refFormat` | `"arabicName"` | not in {`arabicName`,`number`} → `"arabicName"` |
| `refPlacement` | `"after"` | not in {`after`,`before`} → `"after"` |
| `minWords` | `2` | coerce int; clamp to `[1,5]` |

## Migration

- A `prefs.v1` object written by an earlier build has no `autocomplete` key → default-filled on first read; nothing to migrate, no version bump.
- This sub-object is independent of feature-002's `autoCorrect` prefs; both coexist under `prefs.v1`.

## Privacy
All fields are local-only preferences. No field content, candidate, or insertion is ever written to storage or transmitted (Principle I; FR-004).
