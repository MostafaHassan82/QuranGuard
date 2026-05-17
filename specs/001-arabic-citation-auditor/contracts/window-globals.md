# Contract: Playwright observability via `window.__quran*`

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md) | **Model**: [../data-model.md](../data-model.md)

Playwright (`tests/run_tests.py`) drives the real extension and reads results off three window globals the content script exposes. This is the existing convention from the rebuild baseline; V1 extends it to cover the new categories and per-Finding fields without changing the names.

These globals are write-only from the content script's perspective and read-only from Playwright's perspective; no production code reads from them.

## `window.__quranScan`

The latest completed scan's summary.

```jsonc
{
  "scanId": "uuid-v4",
  "startedAt": "2026-05-17T12:34:56.123Z",
  "completedAt": "2026-05-17T12:34:58.456Z",
  "durationMs": 2333,
  "totalCount": 24,
  "perCategoryCount": {
    "green":     17,
    "lightBlue":  2,
    "yellow":     3,
    "orange":     1,
    "red":        1
  },
  "finalState": "defects",      // "clean" | "defects" | "notArabic" | "empty"
  "capHit": false,              // FR-031
  "capLifted": false,           // FR-031: set true after "Continue scanning"
  "languageDetected": "ar"      // FR-029
}
```

Updated on `SCAN_COMPLETE`. Cleared on `SCAN_START` (set to `null`). Used by SC-012 timing assertions and by the SC-008/SC-027 empty-state assertions.

## `window.__quranStats`

Performance and debug counters. Stable contract; new counters MAY be added, existing counters MUST NOT be removed or renamed without a contract-version bump.

```jsonc
{
  "candidatesExtracted": 31,
  "candidatesDroppedSilently": 5,     // FR-018
  "verifierCallsByStrategy": {        // from VerificationResult.notes.matchStrategy
    "exact": 18,
    "tashkeelDriftOnly": 4,
    "spellingDrift": 1,
    "wordLevel": 3,
    "skeletonOnly": 2,
    "none": 3
  },
  "swapApplied": 22,                  // FR-008
  "swapSkippedRed": 1,                // FR-015
  "mutationsObserved": 0,             // FR-019
  "mutationRescans": 0,
  "rescanAllInvocations": 0
}
```

## `window.__quranMatches`

Array of every Finding produced by the latest scan, in scan order.

```jsonc
[
  {
    "id": "<Finding.id sha1>",
    "category": "orange",
    "rawText": "ما ننسخ من آية",
    "domPath": "html>body>article#content>p:nth-child(3)>span:nth-child(2)",
    "citedReference": "البقرة:105",
    "matchedReference": "البقرة:106",
    "confidence": "exact",
    "notes": {
      "driftAccepted": false,
      "wordsMissing": 0,
      "wordsAdded": 0,
      "wordsSubstituted": 0,
      "matchStrategy": "exact"
    },
    "priorFindingId": null,
    "persistedBadge": null              // null | "previouslyCorrected" | "previouslyDismissed" (FR-024)
  },
  // ...
]
```

After a `CORRECT_IN_PLACE` action, the successor Finding entry appears in `__quranMatches` with `priorFindingId` set; the predecessor is removed from this array (consistent with FR-021 + FR-022 — prior Finding is discarded from active state). The "Recently corrected" panel section reads from a separate in-memory list, not from `__quranMatches`.

## Test-only shaping rules

- Floats (`durationMs`) MUST be integers in the exposed globals (no `Date` objects, no functions) so Playwright's `page.evaluate(() => window.__quranScan)` round-trips cleanly through structured clone.
- All arrays MUST be plain arrays (no live `NodeList`/`HTMLCollection`).
- All strings MUST be UTF-8 safe (Arabic text round-trips through Playwright fine; verify no `\udc..` lone surrogates from accidentally-substringed surrogate pairs).

## Cross-references

- Fixture runner: `tests/run_tests.py` (untouched by this spec; reads these globals).
- Finding shape: [../data-model.md](../data-model.md) > Finding.
- Constitution rule for window globals: Tech Constraints — "Playwright reads results via three window globals exposed by the content script."
