# Data Model — Correction & Autocorrect (V1.2)

**Feature**: 002-correction-autocorrect
**Date**: 2026-05-29
**Status**: Phase 1 of `/speckit-plan`. Extends feature 001's data model (see `specs/001-arabic-citation-auditor/data-model.md` for the base shape — Citation Candidate, Verification Result, Finding, Reference, Verse).

## New entities

### DiffSegment

A single word-level position in the aligned diff between a yellow citation and its matched ayah.

| Field | Type | Notes |
|---|---|---|
| `op` | `'keep' \| 'missing' \| 'extra' \| 'sub'` | `keep`: word present in both; `missing`: in authentic, not in cited (insertion needed); `extra`: in cited, not in authentic (strike-through); `sub`: paired substitution |
| `cited` | `string?` | The word as written on the page; omitted for `missing` |
| `authentic` | `string?` | The word from the matched ayah; omitted for `extra` |

**Where it lives**: emitted in the verifier (new module `js/verifier/alignedDiff.js`) and cached on the Finding as `Finding.alignedDiff: DiffSegment[]`. Computed once per yellow Finding; not recomputed on panel render.

**Validation**: `op === 'keep'` requires both `cited` and `authentic`. `op === 'missing'` requires `authentic`, forbids `cited`. `op === 'extra'` requires `cited`, forbids `authentic`. `op === 'sub'` requires both.

### NearMatchSuggestion

The fuzzy-probe result for a red finding.

| Field | Type | Notes |
|---|---|---|
| `candidateRef` | `string` | The reference of the suggested ayah (e.g., `البقرة:255`) |
| `candidateText` | `string` | The authentic ayah text (full or excerpt) the candidate represents |
| `distance` | `number` | Edit-distance-like score returned by the fuzzy helper |
| `withinThreshold` | `boolean` | True iff `distance` is within the established near-match threshold (an implementation/tuning parameter validated against SC-004) |
| `rivalCandidates` | `NearMatchSuggestion[]?` | On a tie or near-tie within threshold (FR-015 clarification, session 2026-05-29), the ranked list of rival candidates the user must choose between. When set, the outer suggestion is treated as the top-ranked rival and the panel renders a manual-choice list rather than auto-offering a single "Did you mean …?". Absent on unambiguous within-threshold matches. |

**Where it lives**: emitted in the verifier (new module `js/verifier/nearMatch.js`) **during the scan** (FR-015) and cached on the Finding as `Finding.nearMatchSuggestion: NearMatchSuggestion | null`. `null` for any red finding with no candidate within threshold (drives the "No automatic correction" label per FR-017).

**Validation**: when present, `withinThreshold` MUST be `true` — out-of-threshold candidates are not emitted (the suggestion is omitted entirely so the panel renders the "No automatic correction" label without ambiguity). When `rivalCandidates` is set, every entry MUST also be within threshold; the rival list MUST NOT include the outer (top-ranked) suggestion as a duplicate; auto-accept MUST NOT fire on any candidate (FR-015 — manual choice only on tie/near-tie).

## Extended entities

### Finding (extends feature 001)

Existing fields preserved. New optional fields:

| Field | Type | Applies to | Notes |
|---|---|---|---|
| `alignedDiff` | `DiffSegment[]?` | yellow | FR-011. Always populated when the verdict is yellow and the match is unambiguous. |
| `nearMatchSuggestion` | `NearMatchSuggestion?` | red | FR-015. Populated on red verdict at scan time; `null` if no candidate within threshold. |
| `resolvedLightBlueRef` | `string?` | lightBlue | FR-008/FR-009. Populated when `matchedRefs.length === 1` OR adjacency-context (see below) resolves to a single surah. NEVER populated when ambiguous-and-unresolved — those findings drive the manual-selection list per FR-010. |
| `candidateLightBlueRefs` | `string[]?` | lightBlue | FR-010. Populated only when `resolvedLightBlueRef` is absent and `matchedRefs.length > 1`; lists the candidates the user must choose between. |
| `correctionKind` | `CorrectionKind?` | corrected successors only | FR-002. Discriminates how the correction was applied (see `CorrectionKind` below). |
| `priorFindingId` | (existing) | corrected successors only | FR-002. Back-reference to the original finding. Unchanged from feature 001. |

### CorrectionKind

```text
CorrectionKind = 'ref-edit' | 'text-replace' | 'reference-attribution'
```

- **`ref-edit`** — existing orange path (FR-012 from feature 001). Rewrites the on-page reference to the verifier-resolved one. Edits the page DOM.
- **`text-replace`** — yellow Fix-in-place (FR-013) and red accepted-near-match (FR-016). Replaces the cited text with the authentic mushaf excerpt, rendered with removed wording struck through and inserted/corrected wording highlighted (FR-013). Edits the page DOM. Subject to the swap engine's eligibility gate (FR-014: boundary-spanning `*` excerpts and ambiguous matches are withheld).
- **`reference-attribution`** — lightBlue (FR-007, FR-008). Recolors the finding to a lightGreen corrected successor and surfaces the resolved reference in the highlight tooltip and panel row. **Does NOT edit the page DOM** — no ref marker is inserted into the page body (this is the spec's explicit override of the v1.2 design predecessor's `ref-insert` proposal; see `research.md` §2).

### Adjacency-context disambiguation (lightBlue, FR-009)

For a lightBlue finding with `matchedRefs.length > 1`, the adjacency check examines the previous and next findings in document order. If exactly one of those neighbors is currently classified as green / lightGreen-corrected / orange-corrected AND its surah ∈ this finding's `matchedRefs`, that surah's reference is adopted as `resolvedLightBlueRef`. Otherwise the finding is treated as ambiguous (`resolvedLightBlueRef` left absent; `candidateLightBlueRefs` populated).

### AutoCorrectPrefs (replaces `prefs.v1.autoCorrectOrange`)

```text
AutoCorrectPrefs = {
  orange:    boolean   // default: carry forward from legacy autoCorrectOrange (or false on true fresh install)
  lightBlue: boolean   // default: true on fresh install (FR-018, lightBlue never edits page text)
}
```

**Migration rule** (one-way, idempotent, runs on first read after upgrade):
```text
if legacy autoCorrectOrange exists:
    autoCorrect.orange    = legacy autoCorrectOrange value
    autoCorrect.lightBlue = true
    delete legacy autoCorrectOrange
```

There is no `autoCorrect.yellow` and no `autoCorrect.red` field — FR-018 makes yellow and red manual by rule. Adding the keys later would be a constitution-significant change and is out of scope for this feature.

### PersistedCorrection (extends feature 001's `persisted.v1.byUrl.<urlKey>[]` entry)

| Field | Type | Notes |
|---|---|---|
| `compositeKey` | `string` | Existing (feature 001 FR-021). Identifies the finding within a URL. |
| `at` | `ISO8601 string` | Existing. Drives the 30-day TTL eviction (feature 001 FR-024). |
| `kind` | `CorrectionKind \| 'dismissal'` | **NEW.** Discriminates correction kind so Revert (FR-006) can clear precisely the matching entry. Legacy entries with no `kind` field are read as `kind: 'ref-edit'` for backward compatibility. |
| `payload` | object | Existing. Shape varies by `kind`: `ref-edit` carries the resolved reference; `text-replace` carries the authentic excerpt and original cited text (so Revert can restore the original); `reference-attribution` carries the resolved reference (no DOM payload to restore — Revert just removes the entry); `dismissal` carries nothing. |

## State transitions

### Finding lifecycle (extends feature 001's lifecycle)

```text
                                ┌──────────────────────────────────────────────┐
                                │                                              ↓
   [classifier emits verdict] → original → correction applied → corrected ──[Revert]──→ original
                                                                  (lightGreen        (verdict restored,
                                                                   successor with     persisted entry
                                                                   priorFindingId)    cleared per FR-006)
```

- **Original → corrected**: triggered by user invoking Fix-in-place / Accept-suggestion / Accept-attribution, OR by autocorrect on next scan for safe orange/lightBlue findings per the active `AutoCorrectPrefs`. Emits a successor Finding with `priorFindingId`, `correctionKind`, lightGreen provenance + underlying green verdict (FR-002, FR-003). Persists per `PersistedCorrection`.
- **Corrected → original (Revert, FR-006)**: restores the reader-supplied original content (where the target span still exists; per SC-005). Returns the finding to its pre-correction verdict. **Clears the persisted entry** so the revert sticks across reloads and autocorrect treats the finding as a normal finding thereafter. A reverted finding may be re-corrected later (manual or automatic) — there is no "do not re-correct" marker; the user simply chose not to keep it this time.
- **Revisit (FR-021)**: a corrected finding that is still within the 30-day TTL re-applies on next visit (consistent with feature 001 FR-024a) and surfaces as a "previously corrected" successor. A reverted finding (no persisted entry) re-classifies fresh on revisit.

### Autocorrect safety gate (FR-018, FR-019, summarized)

```text
canAutoCorrect(finding) =
    finding.color === 'orange'    && prefs.autoCorrect.orange    && finding.match is unambiguous
 || finding.color === 'lightBlue' && prefs.autoCorrect.lightBlue && finding.resolvedLightBlueRef is set
```

`yellow` and `red` never satisfy this predicate, regardless of preferences (FR-018, SC-006). Ambiguous matches of any color never satisfy this predicate (FR-019, SC-006).
