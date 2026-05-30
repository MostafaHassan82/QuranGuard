# Quickstart — Correction & Autocorrect (V1.2)

**Feature**: 002-correction-autocorrect

This is the new-contributor on-ramp for the V1.2 correction work. Feature 001's quickstart (`specs/001-arabic-citation-auditor/quickstart.md`) is the prerequisite — load-unpacked instructions, the Playwright runner, and the fixture conventions live there. This file covers only what's specific to V1.2.

## Reproduce each user story

### US1 — yellow → corrected (P1)

1. Load `tests/fixtures/yellow-drift/<case>/page.html` in a browser with the extension loaded.
2. Trigger a scan. The yellow finding's on-page highlight should show the **aligned diff overlay automatically** (FR-012): removed wording struck through, inserted/corrected wording highlighted. No DOM text edit yet.
3. Open the panel. The yellow row shows the same aligned diff in a before/after presentation.
4. Click **Fix in place**. The page DOM is updated to the authentic excerpt with strike/highlight markup intact (FR-013), the finding becomes a lightGreen corrected successor with `priorFindingId` back-reference, and a **Revert** affordance appears (FR-006).
5. Click **Revert**. The page returns to the reader-supplied original wording, the finding returns to its original yellow verdict, AND the persisted correction entry is cleared (FR-006) — confirmed by reloading the page and observing the finding re-classify as yellow (no auto-re-apply).
6. Try a boundary-spanning (`*`-joined) yellow finding. The diff is shown but **Fix in place** is withheld with an explanation (FR-014).

### US2 — lightBlue → corrected (P2)

1. Load `tests/fixtures/lightblue-resolution/single/page.html`. The lightBlue finding's text resolves to exactly one reference.
2. Open the panel. The resolved reference is shown in the highlight **tooltip** and the panel row (FR-007). **The page body text is NOT modified** — no ref marker is injected.
3. Accept the correction. The finding becomes a lightGreen corrected successor carrying the resolved reference (FR-008). Revert restores the original lightBlue verdict (FR-006).
4. Load `tests/fixtures/lightblue-resolution/multi-with-context/page.html`. The lightBlue text occurs in multiple places, but an adjacent already-attributed finding shares one of the surahs.
5. Open the panel. That surah's reference is adopted (FR-009 adjacency disambiguation).
6. Load `tests/fixtures/lightblue-resolution/multi-ambiguous/page.html`. The text is multi-resolution with no disambiguating context.
7. Open the panel. The candidate references are listed and nothing is auto-selected (FR-010). The reader must choose.

### US3 — red → suggestion (P3)

1. Load `tests/fixtures/red-near-match/within-threshold/page.html`. The red finding is one or two edits away from a real ayah.
2. Trigger a scan. The panel row shows a **"Did you mean …?"** suggestion with the candidate ayah and reference (FR-015). The probe ran during the scan — there is no per-finding wait.
3. Accept the suggestion. The correction runs the yellow `text-replace` path (FR-016) and produces a lightGreen corrected successor.
4. Load `tests/fixtures/red-near-match/beyond-threshold/page.html`. The red finding has no near-match.
5. Open the panel. The row is labelled **"No automatic correction"** (FR-017). No edit is offered.
6. Enable every autocorrect toggle. Scan again. **No red finding is auto-edited**, ever (FR-018, SC-006).

### US4 — controls & undo (P4)

1. Open the popup options. Confirm the `autoCorrect` preference exposes **orange** and **lightBlue** toggles only — no yellow, no red (FR-018).
2. On a fresh profile, confirm **lightBlue autocorrect defaults ON** and **orange autocorrect defaults OFF** (FR-018).
3. On a profile that had `autoCorrectOrange: true` set under feature 001, upgrade and confirm the migrated `autoCorrect: { orange: true, lightBlue: true }` (FR-020 + FR-018 default-on for lightBlue).
4. Apply a correction (any color). Reload. Confirm the corrected successor re-applies with a "previously corrected" indicator (FR-021).
5. Revert that correction. Reload. Confirm the persisted entry is gone — the finding re-classifies fresh, NOT re-corrected (FR-006).

## Add a fixture

Use the existing `python tests/sync_fixtures.py` flow from feature 001. Place the new fixture under the appropriate subdirectory:

- `tests/fixtures/yellow-drift/<case>/` — single-ayah word-level drift cases (SC-002, SC-001).
- `tests/fixtures/lightblue-resolution/<case>/` — single, multi-with-context, multi-ambiguous (SC-003).
- `tests/fixtures/red-near-match/<case>/` — within-threshold, beyond-threshold (SC-004).

The `expected.json` for each new fixture must include:
- `alignedDiff` for yellow findings (the expected ops sequence).
- `nearMatchSuggestion` for red findings (the expected `candidateRef` + `withinThreshold`, or `null`).
- `resolvedLightBlueRef` and/or `candidateLightBlueRefs` for lightBlue findings.

## Run the SC gates

```text
python tests/run_tests.py tests/fixtures/yellow-drift          # SC-001, SC-002
python tests/run_tests.py tests/fixtures/lightblue-resolution  # SC-003
python tests/run_tests.py tests/fixtures/red-near-match        # SC-004
python tests/run_tests.py tests/fixtures/layout-safety         # SC-007 (inherited fixture set from feature 001)
```

Revert correctness (SC-005), autocorrect safety (SC-006), and localization coverage (SC-008) are exercised by dedicated assertion gates inside the fixtures above plus the existing i18n coverage check from feature 001.

## Reconciling with what landed on `003-ayah-autocomplete`

A partial implementation of V1.2 (commits `9ba93fe`…`1b014f1`) landed on the `003-ayah-autocomplete` branch against the **earlier** v1.2 design predecessor (`specs/001-arabic-citation-auditor/v1.2-correction-design.md`), not against the finalized spec. Before writing tasks (`/speckit-tasks`), verify against the spec:

1. **lightBlue is tooltip-only** — confirm no `ref-insert` code path landed (the design proposed it; FR-007 rejected it).
2. **Revert clears persistence** — confirm `REVERT_CORRECTION` deletes the matching `persisted.v1.byUrl` entry (FR-006).
3. **lightBlue autocorrect defaults ON** on fresh install (FR-018).
4. **Migration of legacy `autoCorrectOrange`** preserves the user's prior orange preference (FR-020) and sets lightBlue to ON (FR-018).

These four items are the most likely deltas between "what landed against the predecessor design" and "what the spec requires." `/speckit-tasks` will turn these into the first tasks of P1–P4.
