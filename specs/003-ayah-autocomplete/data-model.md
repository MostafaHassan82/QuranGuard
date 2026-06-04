# Phase 1 Data Model — Writer-Side Ayah Autocomplete

All entities are in-memory (content-script world) except **Autocomplete settings**, which persists in `chrome.storage.local` under `prefs.v1.autocomplete` (see [contracts/storage.md](./contracts/storage.md)). No new persisted keyspace is introduced.

## Entities

### CitationInProgress
The span of recognized citation text currently being typed/edited at the caret.

| Field | Type | Notes |
|---|---|---|
| `text` | string | The recognized citation text (Arabic), excluding the detection prefix. |
| `surface` | enum `input` \| `textarea` \| `contenteditable` | Determines text-only vs markup-capable behavior (FR-002, FR-018b). |
| `element` | reference | The host editable element/node. |
| `spanStart` / `spanEnd` | offsets | Citation boundaries within the field (input: char offsets; contenteditable: Range anchor/focus). |
| `caretOffset` | int | Caret position within the citation (used for narrowing + replacement). |
| `wordCount` | int | Arabic word count; matching is gated until `wordCount >= settings.minWords` (FR-003). |
| `isComposing` | bool | True during IME composition; matching is suppressed (research §3). |

State: a field has at most one active CitationInProgress at a time (multiple citations in one field are handled sequentially, FR edge case).

### Candidate
A verse proposed for the active CitationInProgress.

| Field | Type | Notes |
|---|---|---|
| `ref` | Reference | Surah:ayah (reuses feature-001 Reference). |
| `authenticText` | string | Full authentic ayah wording (mushaf). |
| `tier` | enum `exact` \| `wordLevel` \| `fuzzy` | Maps to green / yellow / red verdicts (FR-007). |
| `coverage` | number | How much of the verse the typed text spans (used within-tier as a secondary signal; ordering primary is tier then mushaf order). |
| `rank` | int | Final order: **tier first, then mushaf order** (ascending surah #, then ayah #) — FR-013. |

Rules: candidates are produced by `matchPartial` (contracts/messaging.md). The **first** (rank 0) candidate is inserted on a blind accept (FR-013). Cascade: if no `exact`, offer `wordLevel`; if none, offer `fuzzy`; if none, no candidates → not-recognized (FR-008).

### InsertionScope
The chosen extent of inserted text, selected from the second menu (FR-012a/015).

| Field | Type | Notes |
|---|---|---|
| `kind` | enum `whole` \| `typedPortion` \| `startToEndWord` \| `multiAyahs` \| `surahEnd` | FR-015. |
| `endWord` | string \| null | For `startToEndWord`: a single word or contiguous phrase (1+ words) at which to stop. If no run of soft-equal words is found after the start, insertion is refused with a message (FR-016). (Amended 2026-06-03 — see spec.md Amendments.) |
| `ayahCount` | int \| null | For `multiAyahs`: how many ayahs to span (matched ayah + the next N−1 in the same surah). Asked inline at insertion time; integer ≥2. Not persisted. (Added 2026-06-03.) |

Resulting inserted text is always **authentic wording** (FR-017) + a reference formatted per settings (FR-014). For `multiAyahs` and `surahEnd`, the reference is rendered as a range (e.g. `(البقرة:255-257)`); both scopes are refused inline if the total word count would exceed `AutocompleteSettings.multiAyahsWordCap` (FR-016).

### AutocompleteSettings  *(persisted: `prefs.v1.autocomplete`)*

| Field | Type | Default | Clamp/validation |
|---|---|---|---|
| `enabled` | bool | `true` | non-bool → default |
| `liveRender` | bool | `true` | non-bool → default (FR-018/019) |
| `refFormat` | enum `arabicName` \| `number` | `arabicName` | unknown → `arabicName` (FR-014) |
| `refPlacement` | enum `after` \| `before` | `after` | unknown → `after` (FR-014) |
| `minWords` | int | `2` | clamp to [1, 5] (FR-003 performance gate) |
| `maxCandidates` | int | `8` | dropdown row budget; 0 = unlimited; otherwise clamp to [1, 50] |
| `multiAyahsWordCap` | int | `200` | clamp to [20, 2000]; word ceiling for `multiAyahs` / `surahEnd` scopes (FR-015 / FR-016, added 2026-06-03) |

## State machine — suggestion/insertion lifecycle

```text
idle
  └─(focusin on editable + typing)→ detecting
detecting
  ├─(no citation prefix / not Arabic)──────────────→ idle
  └─(citation recognized, wordCount ≥ minWords)────→ suggesting
suggesting   (dropdown shown; candidates narrow live; Tab/Enter captured)
  ├─(type past citation / caret moves away)────────→ classified(fallthrough)  // FR-011 instance dismiss → FR-011a
  ├─(no exact/wordLevel/fuzzy match)───────────────→ classified(red)          // FR-008
  └─(Tab/Enter accept candidate)───────────────────→ scopeMenu
scopeMenu    (second menu: whole / typedPortion / startToEndWord / multiAyahs / surahEnd)
  ├─(startToEndWord, end word/phrase not in verse)─→ scopeMenu (message; no truncate)  // FR-016
  ├─(multiAyahs)────────────────────────────────────→ ayahCountPrompt (asks N≥2)
  ├─(multiAyahs/surahEnd, body exceeds wordCap)────→ scopeMenu (message; no truncate)  // FR-016
  └─(scope confirmed)──────────────────────────────→ inserted
inserted     (authentic wording + reference written; FR-014/017)
  └─→ classified(green|lightBlue|yellow|orange|red as applicable; lightGreen if a correction-style provenance applies)
classified   (verdict highlight applied via feature-001 classifier; Quran font if matched & liveRender on; FR-018)
  └─(further typing)──────────────────────────────→ detecting
```

Notes:
- `classified` is the terminal rendering state for any recognized citation, whether resolved via the dropdown or fallen through (FR-011a). It reuses `js/verifier/classify.js` — no new color (Principle II).
- Pre-existing citations present on focus enter directly at `classified` (rendered) but never at `suggesting` (no dropdown/insertion for pre-existing text) — FR-018a.
- Plain `input`/`textarea` surfaces perform `inserted` (text only) but skip the styling in `classified` (FR-018b).
