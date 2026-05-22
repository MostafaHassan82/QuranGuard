# Data Model: Arabic Quran Citation Auditor (V1)

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

Five entities, two pieces of persisted state, two state machines.

---

## Entities

### Citation Candidate

A span of page text that resembles a Quran quote based on contextual signals.

| Field | Type | Source | Notes |
|---|---|---|---|
| `rawText` | string | content script | Raw substring of the virtual concatenated text |
| `domPath` | string | content script | Stable path through the live DOM (parent chain + child indices); used for Finding identity |
| `nodeRefs` | array of `{node, offsetStart, offsetEnd}` | content script | Live text-node references for wrap-back |
| `citedReference` | string \| null | extractor | Page-stated reference next to the citation, if any (e.g., `البقرة:106`) |
| `signals` | object | extractor | Which contextual signals fired (leadInPhrase, braces, explicitRef, …) — used by FR-018 |
| `extractionStrategy` | enum | extractor | Which of the candidate-extraction strategies produced it |

Validation rules:
- `rawText` MUST NOT be empty.
- `nodeRefs` MUST resolve back to live nodes (offset map invariant).
- A candidate that triggered no signals AND produces no verifiable match MUST be dropped silently per FR-018 (not promoted to red).

### Verification Result

The verifier's verdict on a candidate.

| Field | Type | Source | Notes |
|---|---|---|---|
| `category` | enum: `green` \| `lightBlue` \| `yellow` \| `orange` \| `red` | classifier | Per FR-002 |
| `matchedReference` | `Reference` \| null | classifier | For green/lightBlue/yellow: the verified verse; for orange: the *true* reference |
| `citedReferenceParsed` | `Reference` \| null | classifier | Normalized parse of `Candidate.citedReference` |
| `notes` | object | classifier | `{driftAccepted, wordsMissing, wordsAdded, wordsSubstituted, matchStrategy}` |
| `confidence` | enum: `exact` \| `tashkeelDriftOnly` \| `spellingDrift` \| `wordLevel` \| `skeletonOnly` \| `none` | classifier | Used by FR-017 (only the first three may promote to green) |

Validation rules (constitution + FR mapping):
- `category === "green"` ⇒ `confidence ∈ {exact, tashkeelDriftOnly, spellingDrift}` (FR-017).
- `category === "red"` ⇒ `matchedReference === null` AND signals indicate a probable citation (FR-006, FR-018).
- `category === "orange"` ⇒ `matchedReference !== null` AND `citedReferenceParsed !== null` AND they disagree (FR-004, FR-016).
- `category === "lightBlue"` ⇒ `matchedReference !== null` AND `citedReferenceParsed === null` (Edge Cases).

### Finding

A user-facing record. Surfaces in the per-highlight tooltip and the findings panel.

| Field | Type | Source | Notes |
|---|---|---|---|
| `id` | string | derived | Composite key serialization (see Identity below) |
| `candidate` | `CitationCandidate` | content | The originating candidate |
| `verification` | `VerificationResult` | content | The verdict |
| `priorFindingId` | string \| null | FR-022 | Back-reference for successor Findings produced by correct-in-place; `null` otherwise |
| `color` | enum: the 5 `category` values **plus** `lightGreen` | content/UI | The rendered highlight color. Equals `verification.category` except for correct-in-place successors whose verdict is green, which render as `lightGreen` (provenance — constitution Principle II). `lightGreen` is a verified/clean state and follows green's swap setting. |
| `correctedFromRef` | string \| null | FR-012/FR-024a | On a `lightGreen` successor, the prior (wrong) reference that was replaced, so the tooltip/panel can show "was X → now Y". `null` otherwise |
| `panelState` | `PanelState` | panel | UI-side state (see Panel State below); not persisted; lives for the page session |

Note: `lightGreen` is a **provenance** color applied by the correction pathway, never emitted by the classifier — so `VerificationResult.category` stays one of the five verdicts.

#### Identity (FR-021 + Key Entities > Finding)

```
id = sha1(
  normalize(candidate.rawText) + "|" +
  normalize(candidate.citedReference ?? "") + "|" +
  (verification.matchedReference?.toString() ?? "") + "|" +
  candidate.domPath
)
```

- During the incremental re-scans of FR-019, any Finding with an unchanged `id` retains its `panelState`.
- Any change in the composite key yields a new Finding and discards the prior Finding's `panelState` (FR-021).
- `priorFindingId` is OPTIONAL and never participates in `id` derivation. It only annotates a successor produced by FR-022 so the panel can render before/after context inside the "Recently corrected" section.

#### Panel State

| Field | Type | Notes |
|---|---|---|
| `focused` | boolean | Keyboard focus position (FR-030) |
| `scrollAnchor` | DOM ref \| null | Bound highlight for jump-to-highlight (FR-011a) |
| `inFlightAction` | `null \| "copy" \| "share" \| "report" \| "correctInPlace" \| "dismiss" \| "copyAsJson"` | At most one action per Finding may be in flight at a time |
| `recentlyCorrected` | boolean | True if this Finding is pinned in the "Recently corrected" section for the current page session (FR-022) |
| `dismissedThisSession` | boolean | True if dismissed via FR-025 in the current page session |

### Reference

A Quran address.

| Field | Type | Notes |
|---|---|---|
| `surah` | int (1..114) | |
| `ayahStart` | int (≥ 1) | |
| `ayahEnd` | int (≥ ayahStart) \| null | Null = single-ayah; non-null = range (`فصلت:3-4`) |
| `subRange` | object \| null | For partial-ayah refs (rare in V1 corpus) |

Validation: `(surah, ayahStart)` MUST resolve via `Verse` (no orphan refs).

### Verse

The authentic text of one ayah, sourced from `resources/quran-uthmani_desc-v2.json`. Read-only, single source of truth (constitution + FR-013).

| Field | Type | Notes |
|---|---|---|
| `ref` | `Reference` | Single-ayah only |
| `textUthmani` | string | Full tashkeel, Uthmanic orthography |
| `textNormalized` | string | Tashkeel-stripped + drift-normalized (per FR-003 rules); built once at index time |
| `words` | array of string | For yellow's word-level diff |
| `skeletonWords` | array of string | For the skeleton-only fallback (FR-017 negative: never promotes to green) |

---

## Persisted State

All persisted state lives in `chrome.storage.local` (see [contracts/storage.md](./contracts/storage.md)). Nothing leaves the device.

### Preferences (`prefs.v1`)

Persists indefinitely.

```
{
  master: { authenticTextReplacement: true },          // FR-009 default
  perColor: {
    green: true, lightBlue: true, yellow: true,
    orange: true, red: false                            // red is fixed false per FR-015
  },                                                    // FR-009 defaults
  font: "uthmaniHafs",                                  // FR-009 default
  scanTrigger: "manual",                                // FR-026 default
  panelSurface: "popup",                                // FR-010 default
  panelFilter: { orange: true, green: false, lightBlue: false, lightGreen: false, yellow: false, red: false }  // FR-010 default
}
```

### Persisted per-URL store (`persisted.v1.byUrl.<urlKey>`)

30-day TTL per entry. Lazily pruned on read. See [contracts/storage.md](./contracts/storage.md) for the wire format. Each entry:

```
{
  compositeKey: <Finding.id>,                         // FR-024 keys by URL + compositeKey
  kind: "correction" | "dismissal",                   // FR-024 categories
  at: "2026-05-17T12:34:56Z"                          // ISO-8601 timestamp; entry expires at at + 30d
}
```

`urlKey` is the URL with `#fragment` stripped and query parameters sorted (so trivial reorderings don't fork the store).

---

## State Machines

### Finding lifecycle

```
        ┌─────────────┐
        │   created   │  ← initial scan or incremental re-scan (FR-019)
        └──────┬──────┘
               │
       (any of these branches may fire)
               │
   ┌───────────┼───────────────┐
   │           │               │
   ▼           ▼               ▼
[active]   [dismissed]   [corrected]
   │           │               │
   │      (FR-025 +        (FR-022)
   │       FR-024)             │
   │                           │
   │           │               │
   │           │               ▼
   │           │      [successor created]   ← new Finding under new composite key
   │           │               │             (priorFindingId = this Finding.id)
   │           │               ▼
   │           │      [recentlyCorrected]   ← pinned for page session
   │           │               │
   │           │       (page reload OR
   │           │        "Re-scan all")
   │           │               │
   │           │               ▼
   │           │      [re-evaluated]
   │           │               │
   │           ▼               ▼
   │     [previouslyDismissed]  [previouslyCorrected]
   │       (FR-024 badge)         (FR-024 badge,
   │                               not suppressed)
   │
   ▼
[stale]   ← composite key changed via DOM mutation (FR-021); panelState discarded
```

### Persisted-entry lifecycle

```
[written] ──(30 days elapse)──> [expired] ──(read pass)──> [pruned]
    │
    └──(user clicks "Clear remembered…")──> [bulk-pruned]
    │
    └──(for a dismissal: user restores from "Dismissed (this session)")──> [removed early]
```

### Scan lifecycle (per page-load × tab)

```
[idle ●]
   │
   │ (FR-026 trigger: Manual click OR Autoscan on load)
   │
   ▼
[language check (FR-029)]
   │
   ├──(not Arabic)──> [zero-finding outcome] ──> badge ✓, popup "Page not in Arabic", panel suppressed (FR-027)
   │
   ▼
[scanning ●]  ←─────────────────────────┐
   │                                     │
   │ (FR-023 progressive reveal:         │
   │  findings stream into panel,        │
   │  highlights paint live,             │
   │  badge updates as defects appear)   │
   │                                     │
   ├──(500-finding cap hit, FR-031)──> [cap-stopped]
   │                                     │
   │                                ("Continue scanning")
   │                                     │
   │                                     └──> [scanning, cap lifted for this page]
   │
   ▼
[scan complete]
   │
   ├──(zero findings)──> badge ✓, popup "No Quran citations…", panel suppressed (FR-027)
   ├──(verified-only)──> badge ✓, panel available
   └──(any defects)──> badge ! colored by max(orange, red, yellow), panel available

   │
   │ (FR-019 DOM mutation: subtree change)
   │
   ▼
[incremental re-scan of mutated subtree (debounced 500 ms)]
   │
   ▼
back to [scanning ●] flow with retained Findings (FR-021)
```

---

## Cross-references

- Identity rule: [spec.md](./spec.md) FR-021, Key Entities > Finding.
- Correct-in-place successor pattern: [spec.md](./spec.md) FR-022 + Decision 7.8 in [research.md](./research.md).
- Drift-as-green normalization: [spec.md](./spec.md) FR-003, FR-017; constitution Principle II.
- Color severity ordering for badge: [spec.md](./spec.md) FR-028 (red > yellow > orange).
- Preferences defaults at first install: [spec.md](./spec.md) FR-009, Decision 7.19 in [research.md](./research.md).
