# Contract — Messaging (Writer-Side Autocomplete)

All cross-context messages use the feature-001 typed envelope `{type, requestId, payload}` and every handler MUST `return true` to keep the channel open (constitution Tech Constraints). This feature adds **one** new background message and reuses existing ones.

## New: `MATCH_PARTIAL` (content → background)

Find verses that contain the typed citation fragment anywhere in their text, for the writer-side dropdown.

**Request payload**
```jsonc
{
  "text": "string",      // recognized citation text (Arabic), prefix excluded
  "limit": 8             // max candidates to return (dropdown cap)
}
```

**Response payload**
```jsonc
{
  "ok": true,
  "candidates": [
    {
      "ref": { "surah": 2, "ayah": 255 },
      "authenticText": "string",        // full authentic ayah wording
      "tier": "exact",                  // "exact" | "wordLevel" | "fuzzy"
      "coverage": 0.42,                  // fraction of the verse the fragment spans
      "rank": 0                          // tier-first, then mushaf order (FR-013)
    }
  ]
}
```

**Error payload** (e.g., data unavailable per feature-001 FR-020)
```jsonc
{ "ok": false, "error": "DATA_UNAVAILABLE" }
```

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

## Non-envelope note
`MATCH_PARTIAL` follows the envelope. The existing internal verifier RPCs it leans on (e.g., `getAyahText`) remain bare-shape per the feature-001 messaging contract's "Internal (non-envelope) messages" section; this feature does not change that.
