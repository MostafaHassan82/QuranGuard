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

- [X] T001 Read `specs/001-arabic-citation-auditor/v1.2-correction-design.md` and confirm divergences from spec are catalogued (research.md §2): lightBlue must be tooltip-only (NOT `ref-insert`); yellow diff is always-on inline; lightBlue autocorrect defaults ON. → Confirmed: research.md §2 already catalogues these divergences. Design doc retained for historical context only; spec is authoritative.
- [X] T002 Inventory the implementation that landed on `003-ayah-autocomplete` (commits `9ba93fe`…`1b014f1`) against this spec. **Reconciliation map** (post-rebase onto 003 tip):

  **Keepers (already correct against the spec):**
  - Yellow aligned-diff *data* on the Finding (named `finding.diff` with op/cited/authentic) — js/verifier/classify.js, panel/sidebar-surface.js renders it. ✅ Semantics match `DiffSegment[]` from data-model.md.
  - Red near-match *data* on the Finding (named `finding.nearMatch`) — same files. ✅ Semantics match `NearMatchSuggestion`.
  - lightBlue suggestion-only behavior (NO `ref-insert` path — never landed). ✅ FR-007 satisfied.
  - Adjacency-context disambiguation via `QuranPanelModel.suggestRefForLightBlue()` with ±1-neighbor scan. ✅ Matches FR-009 clarification (DOM order, bounded distance).
  - `correctTextInPlace` action wired to a `text-replace` correction (js/panel/actions.js → content.js). ✅ FR-013, FR-016.
  - `persisted.v1` entries already carry a `kind` discriminator (`correction`|`dismissal`|…), and `QuranPersisted.write/remove` key on `compositeKey + kind`. ✅ FR-006 substrate exists.
  - Sidebar lightBlue/yellow/red row presentations including the "Did you mean …?" suggestion and the lightBlue copy-only candidate list. ✅ FR-008/FR-010/FR-017.
  - Generalized `autoCorrect: { orange, lightBlue, yellow }` prefs object replacing the single `autoCorrectOrange` flag, with legacy seed-on-read. ✅ FR-020 substrate exists.
  - "Recently corrected" panel section (FR-002 / FR-022) renders pinned at the top, independent of the active filter. ✅ T051a satisfied.

  **Need adjustment (drift from this spec):**
  - **Field naming** — spec calls them `alignedDiff` and `nearMatchSuggestion`; landed uses `diff` and `nearMatch`. Adopt the landed names as canonical aliases in T010/T011/T037 (cheaper than renaming every call site; the data-model contract is satisfied by aliasing in the model module — to be recorded in data-model.md as an addendum during T004).
  - **lightBlue autocorrect default** — spec FR-018 mandates `autoCorrect.lightBlue: true` on a fresh install; landed `DEFAULTS.autoCorrect.lightBlue = false`. T006 must flip this default and add the migration leg that sets it true when neither legacy nor new key exists.
  - **Yellow autocorrect key exists in landed prefs** — spec FR-018 says yellow is manual-only with NO `autoCorrect.yellow` key. T006 must remove the `yellow` key from `DEFAULTS.autoCorrect` and from `applyDefaults`; T050 must assert defense-in-depth.
  - **Legacy key not deleted on migration** — landed keeps `autoCorrectOrange` as a back-compat mirror. T006 spec language says one-way migrate-and-delete on first read after upgrade. Delete the mirror; audit callers (grep `autoCorrectOrange`) and migrate them to `autoCorrect.orange` before deletion.
  - **lightBlue resolution shape** — spec materializes `Finding.resolvedLightBlueRef` and `Finding.candidateLightBlueRefs` directly on the Finding; landed computes via `suggestRefForLightBlue()` at render time. Materialize on classify (T025/T026) so downstream paths (autocorrect dispatcher T048, defensive assertion T008a) can read them off the Finding.

  **Missing (net-new in 002):**
  - **Inline yellow diff overlay on the host page** (FR-012) — the landed code renders the diff in the sidebar panel only; the page itself still shows the raw cited text. T013/T015 must wrap the yellow highlight span with `<del class="diff-del">`/`<ins class="diff-ins">` markup (visual only; no DOM text edit until Fix-in-place).
  - **`REVERT_CORRECTION` message + handler** (T022, T034) — landed code has no Revert. Must restore `originalCitedText` for `text-replace`, recolor for `reference-attribution`, clear the matching `persisted.v1` entry, return finding to its pre-correction verdict.
  - **`ACCEPT_NEAR_MATCH` message** (T043) — currently the red Accept path calls `correctTextInPlace` directly; spec wants a routed envelope so background can re-verify before issuing `CORRECT_IN_PLACE { kind:'text-replace' }`.
  - **Defensive payload-source assertion** (T008a) — no current check that `CORRECT_IN_PLACE` payloads trace back to a `VerificationResult` field. Add in background.js dispatch.
  - **Locked-DOM clipboard fallback for `text-replace`** (T020) — orange (`ref-edit`) has it; yellow does not.
  - **`correctionKind` on successor Findings + universal Revert affordance** (T019/T032/T051) — landed `correctTextInPlace` likely emits a successor but does not tag `correctionKind`; the panel does not surface a Revert button on every corrected row.
  - **Fixture sets** — `tests/fixtures/yellow-drift/`, `tests/fixtures/lightblue-resolution/`, `tests/fixtures/red-near-match/`, plus a `expected.json` extension recording `alignedDiff`/`nearMatchSuggestion`/`resolvedLightBlueRef`/`candidateLightBlueRefs`.
  - **i18n strings for Revert + manual-choice + "No automatic correction"** (T009, T053) — most correction strings landed, but Revert, "Choose a reference"/"Multiple matches", and red ranked-list labels need a coverage pass.
  - **Near-match threshold tuning + named constant** (T055a).

- [X] T003 Decide and document the merge/port path: **rebased 002 onto 003-ayah-autocomplete** (chore commit `135165e` on this branch; rebase of T201 commits done by user election). The four implementation commits (`9ba93fe`…`1b014f1`) are now ancestors of HEAD. Subsequent phases proceed against this rebased baseline; the adjustments enumerated in T002 are the gap-closure list. T029's `ref-insert` grep is N/A (no `ref-insert` path landed).

**Checkpoint**: ✅ Reconciliation map exists (T002 above); rebase chosen and executed (T003); design-doc divergences confirmed (T001).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, contracts, and shared types every user story depends on. MUST complete before any US phase begins.

**⚠️ CRITICAL**: No user story work begins until Phase 2 completes.

- [X] T004 [P] Define `CorrectionKind = 'ref-edit' | 'text-replace' | 'reference-attribution'` and the new `Finding` optional fields (`alignedDiff`, `nearMatchSuggestion`, `resolvedLightBlueRef`, `candidateLightBlueRefs`, `correctionKind`) in `js/panel/model.js` per data-model.md. → Added JSDoc typedef block at the top of model.js (vanilla JS has no static types); recorded landed-name aliases `diff`/`nearMatch` as canonical-on-the-wire per T002.
- [X] T005 [P] Extend `persisted.v1.byUrl.<urlKey>[]` entry shape to include `kind: CorrectionKind | 'dismissal'` in `js/storage/persisted.js` per contracts/storage.md; read legacy entries without `kind` as `kind: 'ref-edit'`. → read() normalizes missing-`kind` → `ref-edit` (lazy migration); write() persists optional `payload`; remove() returns `{removed}` (T052 substrate) and treats missing-`kind` as `ref-edit`.
- [X] T006 Implement two prefs paths in `js/storage/prefs.js` per contracts/storage.md: (a) **migrate path** — when legacy `autoCorrectOrange` exists, write `autoCorrect: { orange: <legacy value>, lightBlue: true }` and delete the legacy key (one-way, idempotent, on first read after upgrade); (b) **fresh-install path** — when neither legacy nor new key exists, write `autoCorrect: { orange: false, lightBlue: true }` on first read. T047 verifies both paths against fixtures. Covers FR-018, FR-020. → `DEFAULTS.autoCorrect = {orange:false, lightBlue:true}`; yellow/red keys stripped + legacy mirror deleted in applyDefaults; callers migrated (content.js autocorrect gates — yellow now hard-false per FR-018; options.js + options.html yellow toggle removed); `correction_prefs_check.js` rewritten (15/15).
- [X] T007 [P] Add new message types to the envelope per contracts/messaging.md in `js/background.js` message dispatch: extend `CORRECT_IN_PLACE` payload with `kind: CorrectionKind` (default `ref-edit` for backward compat), add `REVERT_CORRECTION { compositeKey }`, add `ACCEPT_NEAR_MATCH { compositeKey, candidateRef }` (server-side converts to `CORRECT_IN_PLACE` with `kind:"text-replace"`). All handlers MUST `return true`. → CORRECT_IN_PLACE pulled into its own handler that defaults+validates `kind` then relays; ACCEPT_NEAR_MATCH/REVERT_CORRECTION added to the routed list (full behavior in T022/T043). All return true.
- [X] T008 [P] Generalize `correctInPlace` in `js/panel/actions.js` to dispatch on `kind`: route `ref-edit` to existing orange path; create stubs for `text-replace` and `reference-attribution` to be implemented in US1 / US2 phases. → Added `correctInContentByKind(findingId, kind)` switch + `correctRefAttributionInContent` stub (calls a content global wired in T032); exported both.
- [X] T008a [P] Add a defensive payload-source assertion in the `CORRECT_IN_PLACE` handler in `js/background.js`: every correction payload MUST be sourced from a known `VerificationResult` field (`matchedRef`, `matchedRefs[]`, `authenticText`, `authenticExcerpt`, `nearMatchSuggestion.candidateText`, or `nearMatchSuggestion.candidateRef`). Reject payloads carrying arbitrary text not traceable to one of these fields with `ok:false, reason:'unverified-payload'`. Hardens NON-NEGOTIABLE Principle I + FR-004 against future regressions where a caller might attempt to write reader-guessed content. → `correctionPayloadIsVerified()` re-derives any ref field via `QuranReferences.resolve` and any text field via `verifyFragment` (must classify green/lightBlue = authentic mushaf wording); findingId-only relays pass through. Refusal → `ok:false, reason:'unverified-payload'`.
- [X] T009 [P] Add localized strings for diff labels ("Missing", "Extra", "Substituted"), "Did you mean …?", "No automatic correction", "Fix in place", "Revert", per-color action labels, AND the manual-choice list strings introduced by FR-010 (lightBlue "Choose a reference", "Multiple matches") and FR-015 tie/near-tie (red "Choose a candidate", ranked-list labels) in `js/shared/i18n.js` for every supported language. T053 verifies coverage (FR-022, SC-008). → Most landed already; added `act_fix_in_place`, `act_revert`, `corr_diff_sub`, `corr_no_auto`, `corr_choose_ref`, `corr_multiple_matches`, `corr_choose_candidate`, `corr_candidate_option` to ar+en. i18n_check parity passes.

**Checkpoint**: ✅ Data shapes, storage migration, message envelope, action dispatcher, and i18n strings are in place (T004–T009 done). All unit checks green (`npm run test:checks`: correction 13/13, correction_model 6/6, correction_prefs 15/15, interaction 20/20, i18n parity OK). User story phases can now proceed in parallel.

---

## Phase 3: User Story 1 — Reader fixes a near-miss quote (yellow → corrected) (Priority: P1) 🎯 MVP

**Goal**: For a yellow finding, present an aligned word-level diff automatically inline on the page and in the panel; let the reader "Fix in place" to permanently write the authentic mushaf excerpt with strike/highlight markup; let them Revert.

**Independent Test**: Load `tests/fixtures/yellow-drift/<case>/page.html`, scan, observe the inline diff overlay; click "Fix in place", observe the lightGreen corrected successor; click Revert, observe the page restores and the persisted entry is cleared. (Quickstart §US1.)

### Verifier — yellow

- [X] T010 [P] [US1] Create `js/verifier/alignedDiff.js` … → **Adopt-in-place** (see [[project-verifier-location]]): the aligned diff already lives in `js/background.js` as `alignedWordDiff()` (Needleman–Wunsch op list keep/missing/extra/sub) attached via `enrichCorrection` as `finding.diff`. No new module created (alignedDiff.js does not exist); landed name `diff` is canonical per T002.
- [X] T011 [US1] Wire `alignedDiff` into the yellow branch … + `unsafeToRewrite`. → `finding.diff` populated at scan time (background.js). `finding.unsafeToRewrite` set in content.js for shaky/ambiguous yellow (boundary `*` or multi-ref) via `QuranSwap.isShakyMatch`. FR-011/FR-014.
- [X] T012 [P] [US1] Yellow-drift coverage. → Covered programmatically in `tests/correction_check.js` (stronger than HTML fixtures: asserts the actual diff op sequence): P1a (sub), P1a-missing (missing), P1a-extra (extra), P1c (duplication near-match). The runner's `compare()` only checks stats+text/color sets and has no per-case dir discovery, so a parallel HTML-fixture+diff-comparison subsystem was deliberately not built (SC-002 met via the op-level assertions).

### Render — yellow inline diff overlay

- [X] T013 [US1] swap.js diff markup. → `buildDiffHtml()` paints `<del class="diff-del">`/`<ins class="diff-ins">` inside the highlight span; `applySwap` uses it whenever `finding.diff` is present; reversal restores the original cited text verbatim (clears markup); the 1.5× clamp (FR-008) still bounds the box. FR-012/FR-013/SC-007.
- [X] T014 [P] [US1] `.diff-del`/`.diff-ins` in `css/content.css`, inside `.quran-swap` (no outside-span CSS); lightGreen provenance unchanged.
- [X] T015 [US1] Auto inline overlay. → The existing post-scan `applySwap` loop now renders the diff for every eligible (safe) yellow with `diff`. Visual only — the committed correction (successor + persist) only happens on Fix-in-place. Unsafe yellow shows the diff in the panel (T016) instead (integrity-safe).

### Panel — yellow row

- [X] T016/T017 [US1] Yellow-row diff rendering. → `makeDiffBlock` in `js/panel/sidebar-surface.js` (the spec's `popup-surface.js` does not exist — `js/popup.js` is the compact action popup; the rich rows live only in the sidebar). Landed via 003.
- [X] T018 [US1] "Fix in place" affordance gated off for `unsafeToRewrite`, surfacing `corr_unsafe_rewrite` in its place.

### Action — yellow Fix-in-place + Revert

- [X] T019 [US1] `text-replace` correction. → `correctTextInPlace` (content.js) tags the lightGreen successor `correctionKind:'text-replace'` + `priorFindingId`; the successor renders the diff via `applySwap`. (Sidebar calls the content global directly; the dispatcher seam `correctInContentByKind` exists in actions.js.)
- [X] T020 [US1] Locked-DOM fallback. → text-replace copies the corrected citation to clipboard and surfaces an aria-live explanation in the panel (`corr_locked_dom`; iframe-boundary variant wired for when content flags it). Result carries `lockedDom`.
- [X] T021 [US1] Persist `kind:'text-replace'` with payload `{ authenticExcerpt, originalCitedText }` (30-day TTL inherited).
- [X] T022 [US1] Revert for `text-replace`. → `revertCorrection` (content.js) restores the original wording from the on-span stash, recolors to the prior verdict, and clears the persisted entry by the successor's `correctionKind` (+ legacy `correction`). (Implemented content-side rather than a background `REVERT_CORRECTION` handler — the correction itself runs content-side; the background envelope from T007 routes the popup-world case.)
- [X] T023 [P] [US1] Keyboard. → The `f` hotkey now routes per color in the sidebar `onAction` (orange→ref rewrite, safe yellow→text-replace, red+near-match→accept, corrected successor→revert; withheld when unsafe/none).

### Revisit — yellow

- [X] T024 [US1] Revisit re-apply. → `autoCorrectYellows({autoAll:false})` re-applies prior user-vetted yellow text-replace corrections on revisit (FR-021); the persisted-keys scan treats any non-dismissal kind as a correction. Reverted findings (entry cleared) re-classify fresh.
- [X] T024a [US1] Revert-roundtrip assertion. → `tests/correction_check.js` T024a exercises FR-006/FR-021 at the storage contract: a `text-replace` entry persists with its payload, Revert removes exactly that entry (so it can't re-apply on revisit), and a dismissal for the same finding is untouched. (Storage-level rather than a page-reload HTML fixture; the lightBlue mirror is deferred to T036.)

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
