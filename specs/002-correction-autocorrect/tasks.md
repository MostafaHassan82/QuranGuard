---
description: "Task list for feature 002-correction-autocorrect (V1.2)"
---

# Tasks: Correction & Autocorrect for lightBlue · yellow · red (V1.2)

**Feature**: 002-correction-autocorrect | **Branch**: `002-correction-autocorrect`
**Input**: Design documents from `specs/002-correction-autocorrect/`
**Prerequisites**: plan.md, spec.md (22 FRs, 8 SCs, 4 user stories P1–P4), research.md, data-model.md, contracts/messaging.md, contracts/storage.md, quickstart.md
**Foundation**: feature 001 (reader-side V1, shipped)

**Tests**: Acceptance fixture sets (SC-002/003/004/007) are mandated by the spec — fixture-creation tasks are included as quality gates, not TDD tests. No unit-test scaffolding is required by the spec.

## Format

```text
- [ ] [TaskID] [P?] [Story?] Description with file path
```

- `[P]` = parallelizable (different files, no incomplete deps)
- `[USx]` = belongs to user story x (US1=yellow, US2=lightBlue, US3=red, US4=controls/undo)
- Setup / Foundational / Polish phases have no story label

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Branch hygiene and reconciliation with the partial implementation that landed on `003-ayah-autocomplete` (research.md §3). No new tooling — vanilla JS, no build step.

- [ ] T001 Read `specs/001-arabic-citation-auditor/v1.2-correction-design.md` and confirm divergences from spec are catalogued (research.md §2): lightBlue must be tooltip-only (NOT `ref-insert`); yellow diff is always-on inline; lightBlue autocorrect defaults ON.
- [ ] T002 Inventory the implementation that landed on `003-ayah-autocomplete` (commits `9ba93fe`…`1b014f1`) against this spec; record per-FR keeper/adjust/missing status in a comment block at the top of `specs/002-correction-autocorrect/tasks.md` under this task, or in a temporary `reconciliation.md` next to this file. Focus areas per research.md §3: (a) lightBlue presentation (any `ref-insert` path must be removed), (b) Revert-clears-persistence (FR-006), (c) lightBlue autocorrect default-ON (FR-018), (d) `autoCorrectOrange` → `autoCorrect{orange,lightBlue}` migration (FR-020).
- [ ] T003 Decide and document the merge/port path in the same reconciliation note: cherry-pick landed commits onto `002-correction-autocorrect`, or formally rebase 002's plan onto 003's history. Block subsequent phases on this decision.

**Checkpoint**: Reconciliation map exists; everyone knows which landed code is a keeper, which needs adjustment, and which is missing.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, contracts, and shared types every user story depends on. MUST complete before any US phase begins.

**⚠️ CRITICAL**: No user story work begins until Phase 2 completes.

- [ ] T004 [P] Define `CorrectionKind = 'ref-edit' | 'text-replace' | 'reference-attribution'` and the new `Finding` optional fields (`alignedDiff`, `nearMatchSuggestion`, `resolvedLightBlueRef`, `candidateLightBlueRefs`, `correctionKind`) in `js/panel/model.js` per data-model.md.
- [ ] T005 [P] Extend `persisted.v1.byUrl.<urlKey>[]` entry shape to include `kind: CorrectionKind | 'dismissal'` in `js/storage/persisted.js` per contracts/storage.md; read legacy entries without `kind` as `kind: 'ref-edit'`.
- [ ] T006 Implement two prefs paths in `js/storage/prefs.js` per contracts/storage.md: (a) **migrate path** — when legacy `autoCorrectOrange` exists, write `autoCorrect: { orange: <legacy value>, lightBlue: true }` and delete the legacy key (one-way, idempotent, on first read after upgrade); (b) **fresh-install path** — when neither legacy nor new key exists, write `autoCorrect: { orange: false, lightBlue: true }` on first read. T047 verifies both paths against fixtures. Covers FR-018, FR-020.
- [ ] T007 [P] Add new message types to the envelope per contracts/messaging.md in `js/background.js` message dispatch: extend `CORRECT_IN_PLACE` payload with `kind: CorrectionKind` (default `ref-edit` for backward compat), add `REVERT_CORRECTION { compositeKey }`, add `ACCEPT_NEAR_MATCH { compositeKey, candidateRef }` (server-side converts to `CORRECT_IN_PLACE` with `kind:"text-replace"`). All handlers MUST `return true`.
- [ ] T008 [P] Generalize `correctInPlace` in `js/panel/actions.js` to dispatch on `kind`: route `ref-edit` to existing orange path; create stubs for `text-replace` and `reference-attribution` to be implemented in US1 / US2 phases.
- [ ] T008a [P] Add a defensive payload-source assertion in the `CORRECT_IN_PLACE` handler in `js/background.js`: every correction payload MUST be sourced from a known `VerificationResult` field (`matchedRef`, `matchedRefs[]`, `authenticText`, `authenticExcerpt`, `nearMatchSuggestion.candidateText`, or `nearMatchSuggestion.candidateRef`). Reject payloads carrying arbitrary text not traceable to one of these fields with `ok:false, reason:'unverified-payload'`. Hardens NON-NEGOTIABLE Principle I + FR-004 against future regressions where a caller might attempt to write reader-guessed content.
- [ ] T009 [P] Add localized strings for diff labels ("Missing", "Extra", "Substituted"), "Did you mean …?", "No automatic correction", "Fix in place", "Revert", per-color action labels, AND the manual-choice list strings introduced by FR-010 (lightBlue "Choose a reference", "Multiple matches") and FR-015 tie/near-tie (red "Choose a candidate", ranked-list labels) in `js/shared/i18n.js` for every supported language. T053 verifies coverage (FR-022, SC-008).

**Checkpoint**: Data shapes, storage migration, message envelope, action dispatcher, and i18n strings are in place. User story phases can now proceed in parallel.

---

## Phase 3: User Story 1 — Reader fixes a near-miss quote (yellow → corrected) (Priority: P1) 🎯 MVP

**Goal**: For a yellow finding, present an aligned word-level diff automatically inline on the page and in the panel; let the reader "Fix in place" to permanently write the authentic mushaf excerpt with strike/highlight markup; let them Revert.

**Independent Test**: Load `tests/fixtures/yellow-drift/<case>/page.html`, scan, observe the inline diff overlay; click "Fix in place", observe the lightGreen corrected successor; click Revert, observe the page restores and the persisted entry is cleared. (Quickstart §US1.)

### Verifier — yellow

- [ ] T010 [P] [US1] Create `js/verifier/alignedDiff.js` exporting `computeAlignedDiff(citedWords, authenticWords) → DiffSegment[]` with ops `'keep' | 'missing' | 'extra' | 'sub'` per data-model.md `DiffSegment`. Validation: `keep`/`sub` require both fields; `missing` forbids `cited`; `extra` forbids `authentic`.
- [ ] T011 [US1] Wire `alignedDiff` into the yellow branch of `js/verifier/classify.js`: when a yellow verdict is emitted against a single-ayah match, populate `Finding.alignedDiff` once — **including** boundary-spanning (`*`) excerpts and ambiguous matches. For unsafe-to-rewrite cases, also set `Finding.unsafeToRewrite = true` so T018 can withhold the Fix-in-place affordance while T015/T016 still render the diff (spec US1 Acceptance Scenario 4: "the diff is shown but 'Fix in place' is withheld"). FR-011, FR-014.
- [ ] T012 [P] [US1] Add fixture set `tests/fixtures/yellow-drift/` with at least: one single-word-missing case, one single-word-extra case, one substitution case, and one boundary-spanning (`*`-joined) case. Each `expected.json` MUST include the expected `alignedDiff` ops sequence. (SC-002, SC-001.)

### Render — yellow inline diff overlay

- [ ] T013 [US1] Extend `js/render/swap.js` with a `markupKind: 'diff'` rendering mode that wraps removed words in `<del class="diff-del">` and inserted/corrected words in `<ins class="diff-ins">` while staying within the span-local 1.5× line-box absorption bound from feature 001 FR-008 (FR-012, FR-013, SC-007).
- [ ] T014 [P] [US1] Add `.diff-del` (strike-through) and `.diff-ins` (highlighted) styles inside the existing yellow highlight span in `css/content.css`. Preserve the lightGreen provenance styling for corrected successors unchanged.
- [ ] T015 [US1] In the highlight-render pipeline (called from the content script after classify), render the inline diff overlay automatically for every yellow finding with `alignedDiff` set (FR-012). Overlay is visual only — no DOM text edit until Fix-in-place.

### Panel — yellow row

- [ ] T016 [P] [US1] Render the aligned diff in the panel's yellow row in `js/panel/popup-surface.js` (before/after presentation using `alignedDiff`).
- [ ] T017 [P] [US1] Mirror the yellow row rendering in `js/panel/sidebar-surface.js`.
- [ ] T018 [US1] Add a "Fix in place" affordance to the panel yellow row; gate it off when `alignedDiff` is absent or the match is unsafe to rewrite (FR-014), surfacing the explanation in its place.

### Action — yellow Fix-in-place + Revert

- [ ] T019 [US1] Implement the `kind: 'text-replace'` branch in `js/panel/actions.js`: send `CORRECT_IN_PLACE { kind:'text-replace', compositeKey, authenticExcerpt, originalCitedText }`. On success, replace the on-page span via `swap.js` `markupKind:'diff'`, emit a lightGreen corrected successor with `priorFindingId` + `correctionKind:'text-replace'` (FR-002, FR-003, FR-013).
- [ ] T020 [US1] Implement non-editable / locked DOM fallback in the `text-replace` path: copy the corrected citation to clipboard with a user-visible explanation (FR-005, mirroring feature 001 FR-012). For cross-origin / sandboxed iframes (where the content script cannot reach the span at all), the clipboard write MUST be invoked from the popup/sidebar context — not the content script — and the explanation MUST name the iframe boundary as the reason (spec Edge Case "Locked / non-editable DOM").
- [ ] T021 [US1] Persist the correction in `js/storage/persisted.js` with `kind:'text-replace'` and payload `{ authenticExcerpt, originalCitedText, compositeKey }`. Inherits the 30-day TTL from feature 001 FR-024.
- [ ] T022 [US1] Implement Revert for `text-replace`: handle `REVERT_CORRECTION` in `js/background.js` → restore the recorded `originalCitedText` into the span (where it still exists), delete the matching `persisted.v1` entry by `compositeKey + kind`, return the finding to its yellow verdict (FR-006). Where the span no longer exists, surface the "could not restore automatically" explanation per spec edge case.
- [ ] T023 [P] [US1] Bind Revert and Fix-in-place to keyboard shortcuts in `js/panel/keyboard.js` for the yellow row.

### Revisit — yellow

- [ ] T024 [US1] In the scan pipeline (`js/background.js` post-classify), look up `persisted.v1` for `kind:'text-replace'`; when present and the target span still resolves, re-apply the correction and surface the "previously corrected" badge (FR-021). Reverted findings (no entry) re-classify fresh.
- [ ] T024a [US1] Add a fixture-driven assertion under `tests/fixtures/yellow-drift/<revert-roundtrip>/` that exercises FR-021's negative case: apply a yellow `text-replace` correction → revert → reload → confirm the finding re-classifies as the original yellow verdict (NOT re-corrected) AND no "previously corrected" badge appears. Covers FR-006 + FR-021's "MUST NOT be re-applied on revisit" clause. Mirror the same assertion for lightBlue under `tests/fixtures/lightblue-resolution/single/` and reference it from T036.

**Checkpoint**: US1 is end-to-end testable in isolation: detect → inline diff overlay → Fix in place → lightGreen successor → Revert → reload → re-classified fresh. SC-001 (≤2 interactions), SC-002 (≥95% diff accuracy), SC-005 (revert), SC-007 (layout-safety) are exercised by `tests/fixtures/yellow-drift/` + `tests/fixtures/layout-safety/`.

---

## Phase 4: User Story 2 — Reader supplies the missing reference (lightBlue → corrected) (Priority: P2)

**Goal**: For a lightBlue finding, surface the verifier-resolved reference in the highlight tooltip and panel row (NEVER inserted into page body); on accept, flip to a lightGreen corrected successor carrying that reference. Disambiguate multi-resolution lightBlue via adjacent attributed-finding context; never auto-select when ambiguous.

**Independent Test**: Load the three lightBlue fixtures (single, multi-with-context, multi-ambiguous) and verify the tooltip-only behavior, the adjacency-context resolution, and the manual-choice list. (Quickstart §US2.)

### Verifier — lightBlue resolution

- [ ] T025 [US2] In `js/verifier/classify.js`, when the verdict is lightBlue: set `Finding.resolvedLightBlueRef` if `matchedRefs.length === 1`, else leave absent and populate `Finding.candidateLightBlueRefs` from `matchedRefs` (data-model.md, FR-008, FR-010).
- [ ] T026 [US2] Implement adjacency-context disambiguation in `js/verifier/classify.js` (or a small helper in `js/verifier/references.js`): for lightBlue findings with `matchedRefs.length > 1`, examine the previous and next Finding in document (DOM) order within a bounded distance, regardless of block boundaries; if exactly one neighbor is currently green / lightGreen-corrected / orange-corrected AND its surah is in `matchedRefs`, adopt that surah as `resolvedLightBlueRef` (FR-009, clarification session 2026-05-29).
- [ ] T027 [P] [US2] Add fixture set `tests/fixtures/lightblue-resolution/` with subdirs `single/`, `multi-with-context/`, `multi-ambiguous/`. Each `expected.json` MUST include `resolvedLightBlueRef` (when applicable) and/or `candidateLightBlueRefs` (when ambiguous). (SC-003.)

### Render — lightBlue tooltip

- [ ] T028 [US2] In the highlight-render pipeline, surface `resolvedLightBlueRef` (or "ambiguous — choose in panel") in the lightBlue span's tooltip. **MUST NOT** insert reference text into the page body (FR-007, research.md §2 override of design-predecessor `ref-insert`).
- [ ] T029 [US2] Grep/remove any `ref-insert` code path that may have landed on `003-ayah-autocomplete` (depends on T002 reconciliation map identifying the call sites); confirm no DOM mutation occurs for lightBlue presentation. If T002 found no `ref-insert` landed, mark T029 N/A.

### Panel — lightBlue row

- [ ] T030 [P] [US2] In `js/panel/popup-surface.js`, render the lightBlue row in two shapes: (a) when `resolvedLightBlueRef` is set, show the resolved ref + an "Accept" affordance; (b) when `candidateLightBlueRefs` is set, render the candidate list with a manual-choice affordance per candidate (FR-010).
- [ ] T031 [P] [US2] Mirror in `js/panel/sidebar-surface.js`.

### Action — lightBlue accept + Revert

- [ ] T032 [US2] Implement the `kind: 'reference-attribution'` branch in `js/panel/actions.js`: send `CORRECT_IN_PLACE { kind:'reference-attribution', compositeKey, resolvedRef }`. On success, recolor the span to green + lightGreen provenance, update the tooltip to carry the resolved ref, emit a corrected successor with `priorFindingId` + `correctionKind:'reference-attribution'`. **NO DOM text edit** (FR-007, FR-008). FR-005's locked-DOM clipboard fallback is N/A for this kind — there is no DOM edit to fall back from; failure modes (e.g., span gone) reuse `ok:false, reason:'span-missing'` from the messaging contract.
- [ ] T033 [US2] Persist the lightBlue correction in `js/storage/persisted.js` with `kind:'reference-attribution'` and payload `{ resolvedRef, compositeKey }`.
- [ ] T034 [US2] Implement Revert for `reference-attribution` in `js/background.js`: delete the matching `persisted.v1` entry, recolor back to lightBlue, drop the tooltip ref (FR-006). No DOM text to restore.
- [ ] T035 [US2] Implement manual-choice acceptance for ambiguous lightBlue: when the user picks one of `candidateLightBlueRefs`, route through the same `reference-attribution` path with that ref as `resolvedRef`.

### Revisit — lightBlue

- [ ] T036 [US2] Extend the scan-time re-apply path (T024) to handle `kind:'reference-attribution'`: re-apply tooltip + recolor, surface "previously corrected" badge (FR-021). Verify that T024a's lightBlue mirror-assertion fixture (under `tests/fixtures/lightblue-resolution/single/`) still passes against the wired US2 reference-attribution path — i.e., T024a authors the fixture, T036 confirms US2 wiring keeps it green. Covers FR-006 + FR-021 negative case for lightBlue.

**Checkpoint**: US2 is end-to-end testable in isolation. SC-003 (100% single-resolution; never auto-resolve multi without context) is exercised by `tests/fixtures/lightblue-resolution/`.

---

## Phase 5: User Story 3 — Reader rescues a typo'd citation, or learns it can't be fixed (red → suggestion) (Priority: P3)

**Goal**: For a red finding, run a fuzzy near-match probe **during the scan** and present "Did you mean …?" when within threshold; on accept, route through the yellow `text-replace` path. When no candidate within threshold, label "No automatic correction" (not an error). On a tie/near-tie, surface a manual-choice list.

**Independent Test**: Load `tests/fixtures/red-near-match/within-threshold/` and `…/beyond-threshold/`; verify "Did you mean …?" vs. "No automatic correction"; accept a suggestion and verify the lightGreen corrected successor. (Quickstart §US3.)

### Verifier — red near-match probe

- [ ] T037 [P] [US3] Create `js/verifier/nearMatch.js` exporting `probeNearMatch(citedText, indexes) → NearMatchSuggestion | null` using the existing `wordLevelMatchGlobal` and soft-subsequence helpers in `js/background.js`. Returns `null` when no candidate is within the established near-match threshold; otherwise returns `{ candidateRef, candidateText, distance, withinThreshold: true }` (data-model.md). Out-of-threshold candidates are NOT emitted.
- [ ] T038 [US3] In `js/verifier/nearMatch.js`, populate `NearMatchSuggestion.rivalCandidates` (now defined in data-model.md) on a tie or near-tie within threshold: the outer suggestion is the top-ranked rival; the array carries the remaining rivals in descending-confidence order. Auto-accept MUST NOT fire on any rival (clarification session 2026-05-29, FR-015).
- [ ] T039 [US3] Wire `probeNearMatch` into the red branch of `js/verifier/classify.js`: every red Finding is probed **during the scan** (FR-015); cache result on `Finding.nearMatchSuggestion`. MUST stay within feature 001 SC-012 scan budget (~5 s for a 5,000-word page).
- [ ] T040 [P] [US3] Add fixture set `tests/fixtures/red-near-match/` with subdirs `within-threshold/`, `beyond-threshold/`, `tie/`. Each `expected.json` MUST include `nearMatchSuggestion` (or `null`) and, for `tie/`, the expected rival-candidates list. (SC-004.)

### Panel — red row

- [ ] T041 [P] [US3] In `js/panel/popup-surface.js`, render the red row in three shapes: (a) suggestion present → "Did you mean `<candidateRef>`?" + Accept affordance; (b) rival candidates present → ranked manual-choice list; (c) no suggestion → "No automatic correction" label (FR-015, FR-017).
- [ ] T042 [P] [US3] Mirror in `js/panel/sidebar-surface.js`.

### Action — red accept

- [ ] T043 [US3] Handle `ACCEPT_NEAR_MATCH` in `js/background.js`: re-fetch the candidate's authentic text, run the verifier's diff against the cited text, then dispatch `CORRECT_IN_PLACE { kind:'text-replace', authenticExcerpt, originalCitedText }` reusing the US1 path (FR-016). Result is a lightGreen corrected successor with `correctionKind:'text-replace'`.
- [ ] T044 [US3] Bind Accept-suggestion to a keyboard shortcut in `js/panel/keyboard.js` for the red row.

### Autocorrect safety — red is always manual

- [ ] T045 [US3] Add an explicit assertion in the autocorrect dispatcher (T050) that no red finding is ever auto-corrected regardless of preferences (FR-018, SC-006). Verified by a fixture-driven assertion in `tests/fixtures/red-near-match/within-threshold/` with autocorrect toggles ON.

**Checkpoint**: US3 is end-to-end testable in isolation. SC-004 (≥90% correct candidate within threshold; zero incorrect auto-edits beyond threshold) is exercised by `tests/fixtures/red-near-match/`.

---

## Phase 6: User Story 4 — Reader controls automation and can always undo (Priority: P4)

**Goal**: Expose the generalized `autoCorrect: { orange, lightBlue }` preference in the popup; auto-apply safe corrections on scan; ensure universal Revert (any color); ensure yellow/red are never auto-corrected.

**Independent Test**: Toggle the new preferences in the popup; load a mixed-finding fixture; verify only safe orange + lightBlue are auto-corrected and yellow/red are not; apply and revert any correction; reload and verify revert sticks. (Quickstart §US4.)

### Options surface

- [ ] T046 [P] [US4] Replace the existing single "Autocorrect orange" toggle in the popup options with two toggles ("Autocorrect orange", "Autocorrect lightBlue") wired to `prefs.v1.autoCorrect.orange` and `prefs.v1.autoCorrect.lightBlue` respectively. Update labels via `js/shared/i18n.js` (FR-018, FR-022).
- [ ] T047 [US4] Verify default-state behavior on a fresh profile: lightBlue ON, orange OFF (FR-018). Verify legacy `autoCorrectOrange: true` profile migrates to `{ orange: true, lightBlue: true }` per T006 + FR-020.

### Autocorrect dispatcher

- [ ] T048 [US4] In `js/background.js` post-classify pass, implement the safety predicate from data-model.md §Autocorrect safety gate: `canAutoCorrect(finding) = (color==='orange' && prefs.orange && unambiguous) || (color==='lightBlue' && prefs.lightBlue && resolvedLightBlueRef set)`. Yellow and red never satisfy; ambiguous matches never satisfy (FR-018, FR-019, SC-006).
- [ ] T049 [US4] For each finding satisfying `canAutoCorrect`, dispatch the matching `CORRECT_IN_PLACE` (`ref-edit` for orange — already exists; `reference-attribution` for lightBlue — T032) during scan.
- [ ] T050 [US4] Enforce the red-never-auto rule (T045) and yellow-never-auto rule as assertions in the dispatcher with a clear log message when a preference key for yellow/red is encountered (it shouldn't exist; defense-in-depth).

### Universal Revert affordance

- [ ] T051 [P] [US4] Surface the Revert affordance uniformly across panel rows for every corrected successor (orange `ref-edit`, yellow `text-replace`, lightBlue `reference-attribution`) in `js/panel/popup-surface.js` and `js/panel/sidebar-surface.js`. All routes go through `REVERT_CORRECTION` (T022, T034 + the existing orange Revert).
- [ ] T051a [US4] Ensure corrected successors (every `correctionKind`) render in the panel's "corrected" section **regardless of the active verdict-color filter** (FR-002). Audit the filter logic in `js/panel/popup-surface.js` and `js/panel/sidebar-surface.js`: the corrected section's visibility predicate MUST be independent of the per-color filters used by the main findings list. Add a fixture-based assertion that toggles the filters off for green/lightBlue/yellow/orange/red and confirms the corrected section still shows every applied correction.

### Persistence guarantees

- [ ] T052 [US4] Confirm that every `REVERT_CORRECTION` handler clears the matching `persisted.v1` entry by `compositeKey + kind` (FR-006). Add a single assertion site in `js/storage/persisted.js` that returns whether the deletion happened, so callers can surface "could not find persisted entry" cleanly.

**Checkpoint**: US4 is end-to-end testable in isolation. SC-005 (revertable for every color), SC-006 (zero yellow/red auto, zero ambiguous auto) are exercised by `tests/fixtures/red-near-match/` (with autocorrect ON) and a small mixed-finding fixture under `tests/fixtures/yellow-drift/` or a new `tests/fixtures/autocorrect-safety/` directory.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T053 [P] Localization audit: verify every correction-related string from T009 renders in each supported language with no missing-translation fallback (SC-008). Run the existing i18n coverage check from feature 001.
- [ ] T054 [P] Layout-safety regression: run `python tests/run_tests.py tests/fixtures/layout-safety` to confirm no inline diff overlay, recolor, or text-replace causes a shift beyond the span-local 1.5× line-box bound (SC-007).
- [ ] T055 [P] Performance check: run a 5,000-word fixture with red findings present and confirm the in-scan near-match probe keeps the end-to-end scan within feature 001 SC-012 (~5 s).
- [ ] T055a [P] Tune the red near-match threshold against `tests/fixtures/red-near-match/`: pick the bound that maximizes SC-004 correct-candidate rate (≥90% within threshold) while preserving SC-006 (zero incorrect auto-edits — N/A here since red is manual, but still record beyond-threshold false-positive count). Record the chosen value as a named constant in `js/verifier/nearMatch.js` with a comment citing the SC-004 fixture set.
- [ ] T056 Update `CLAUDE.md` SPECKIT block if needed (already pointed at 002 per current diff). No-op if it already matches.
- [ ] T057 Run the full quickstart walkthrough end-to-end (US1 → US2 → US3 → US4) on a real Chrome profile to validate the integrated experience.
- [ ] T058 Confirm constitution non-negotiables hold in the final code: Principle I (only authentic mushaf wording or verifier-resolved reference written, never a guess — FR-004) and Principle V (porting discipline: aligned diff and lightBlue adjacency were designed in-place, not ported from the advanced copy).

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: No deps. Start immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1. BLOCKS all user stories.
- **Phase 3 (US1) / Phase 4 (US2) / Phase 5 (US3) / Phase 6 (US4)**: All depend on Phase 2. After Phase 2:
  - US1, US2, US3 can proceed in parallel.
  - US4 depends on US1 (for `text-replace` revert), US2 (for `reference-attribution` dispatcher), and US3 (for the red-never-auto assertion site). Schedule US4 last or after US1+US2 at minimum.
- **Phase 7 (Polish)**: Depends on all desired user stories being complete.

### Within each user story

- Verifier output first → Render → Panel surface → Action → Persistence → Revisit.
- Fixtures (`[P]`-marked) can be authored in parallel with the verifier work since they only constrain `expected.json`.

### Parallel opportunities

- T004, T005, T007, T008, T009 in Phase 2 are all `[P]` against different files.
- After Phase 2, US1 / US2 / US3 can be staffed in parallel (US4 last).
- Within US1: T010 (verifier), T012 (fixtures), T014 (CSS), T016/T017 (popup/sidebar surfaces), T023 (keyboard) are independent.
- Within US2: T027 (fixtures), T030/T031 (surfaces) are independent.
- Within US3: T037 (verifier module), T040 (fixtures), T041/T042 (surfaces) are independent.
- Within US4: T046 (options UI), T051 (revert affordance) are independent.
- Phase 7 polish tasks T053–T055 are independent.

---

## Parallel Example: User Story 1

```text
# In parallel after T010 (alignedDiff module exists):
Task T012: Author tests/fixtures/yellow-drift/ cases with expected.json
Task T014: Add .diff-del / .diff-ins styles to css/content.css
Task T016: Render aligned diff in js/panel/popup-surface.js
Task T017: Mirror rendering in js/panel/sidebar-surface.js
Task T023: Bind keyboard shortcuts in js/panel/keyboard.js
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (US1: yellow inline diff + Fix-in-place + Revert).
2. **STOP and VALIDATE**: SC-001, SC-002, SC-005 (yellow portion), SC-007. Demo the yellow diff overlay — the headline experience of this feature.

### Incremental Delivery

1. MVP (US1) → demo → ship.
2. Add US2 (lightBlue tooltip + adjacency context) → demo → ship.
3. Add US3 (red near-match in-scan + suggestion) → demo → ship.
4. Add US4 (autocorrect toggles + universal Revert UI) → demo → ship.
5. Phase 7 polish, then close the feature.

### Parallel Team Strategy

- Phase 1 + Phase 2 done together.
- Developer A → US1; Developer B → US2; Developer C → US3.
- US4 last (cross-cutting), once US1+US2 land.

---

## Notes

- `[P]` tasks touch different files with no incomplete deps.
- Every user story emits a lightGreen corrected successor with `priorFindingId` + `correctionKind` per FR-002/FR-003. No new highlight color is introduced (Principle II).
- Every correction writes ONLY authentic mushaf wording (text fixes) OR a verifier-resolved reference (reference fixes) — never a guess (FR-004, Principle I).
- Yellow and red are manual by rule (FR-018) — no preference can enable autocorrect for them; ambiguous matches of any color are never auto-corrected (FR-019).
- Revert (FR-006) is symmetric across all three new `kind`s and clears the persisted entry so the revert sticks across reloads.
- Reconciliation with the partial implementation on `003-ayah-autocomplete` (T001–T003) is a hard prerequisite — do not skip.
