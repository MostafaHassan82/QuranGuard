# Contract — Messaging (Writer-Side Autocomplete)

The envelope messages this feature consumes (PREFS_*) use the feature-001 typed envelope `{type, requestId, payload}` with `return true`. The new matching call, `MATCH_PARTIAL`, ships as a **bare-shape internal verifier RPC** (like `verifyFragment`/`getAyahText`), routed through `background.js`'s `ensureInitialized()` switch per the messaging contract's "Internal (non-envelope) messages" section.

## New: `MATCH_PARTIAL` (content → background) — bare shape

Find verses that contain the typed citation fragment anywhere in their text, for the writer-side dropdown.

**Request**
```jsonc
{ "type": "MATCH_PARTIAL", "text": "string", "limit": 8 }
```

**Response**
```jsonc
{
  "candidates": [
    {
      "ref": { "surah": 2, "ayah": 255 },
      "refLabel": "البقرة:255",          // surahName:ayah for display
      "surahName": "البقرة",
      "authenticText": "string",        // full authentic ayah wording
      "tier": "exact",                  // "exact" | "wordLevel" | "fuzzy"
      "coverage": 0.42,                  // fraction of the verse the fragment spans
      "rank": 0                          // tier-first, then mushaf order (FR-013)
    }
  ]
}
```
Empty `candidates` (or `{ "error": "..." }` when the index is unavailable) ⇒ not-recognized (FR-008).

**Semantics**
- Reuses the existing global ordered-contiguous / multi-segment / fuzzy-subsequence search (research §1). No new matching logic.
- `tier` maps to reader-side verdicts: `exact`→green, `wordLevel`→yellow, `fuzzy`→red.
- `candidates` are pre-sorted by `rank` (tier first, then mushaf order). Empty array ⇒ not-recognized (FR-008).
- Pure read; no state mutation; no off-device transmission (Principle I).

## Reused messages (no change)

| Type | Direction | Use here |
|---|---|---|
| `PREFS_READ` | content → background | Read `prefs.v1.autocomplete` on init. |
| `PREFS_WRITE` | options/content → background | Persist autocomplete settings changes. |
| `PREFS_CHANGED` | background → all content | Live-apply enable/liveRender/refFormat/minWords without reload. |
| `getAyahText` / verifier RPC | content → background | Fetch authentic wording for insertion scope shaping (whole / typed-portion / start-to-end-word). |
| `getAyahRange` / verifier RPC | content → background | Added 2026-06-03 for the `multiAyahs` / `surahEnd` scopes. Bare-shape: `{ type: 'getAyahRange', surahNum, fromAyah, toAyah }`; `toAyah === -1` means "to surah end". Returns `{ texts: string[], surahLastAyah: int }`. |

## Non-envelope note
`MATCH_PARTIAL` follows the envelope. The existing internal verifier RPCs it leans on (e.g., `getAyahText`, `getAyahRange`) remain bare-shape per the feature-001 messaging contract's "Internal (non-envelope) messages" section; this feature does not change that.
