---

description: "Implementation task list for Writer-Side Ayah Autocomplete (003)"
---

# Tasks: Writer-Side Ayah Autocomplete

**Input**: Design documents from `specs/003-ayah-autocomplete/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md) (20 FRs, 8 SCs, 6 clarifications), [data-model.md](./data-model.md), [contracts/](./contracts/), [research.md](./research.md), [quickstart.md](./quickstart.md), constitution v2.0.0 at `.specify/memory/constitution.md`.

**Tests (fixtures)**: Included per Constitution Principle VI ("Fixtures Are the Quality Gate"). New gate `tests/autocomplete_check.js` drives synthetic typing across `<input>`, `<textarea>`, and contenteditable hosts and asserts off `window.__quranCompose` ([contracts/window-globals.md](./contracts/window-globals.md)). The existing suite (`npm test`) MUST stay green — no regression.

**Organization**: Tasks are grouped by user story (US1 P1 → US4 P4) so each story can be implemented and validated independently (constitution Workflow item 6: phases ship sequentially).

## Format: `- [ ] T### [P?] [Story?] Description (path)`

- **[P]** = parallelizable (different files, no dep on incomplete task)
- **[Story]** = US1 / US2 / US3 / US4 — present only for user-story-phase tasks
- File paths are repo-relative

## Path conventions

Flat Chromium MV3 extension at repo root. New writer-side logic lives in `js/compose/`; matching reuses `js/background.js` + `js/verifier/`. See [plan.md](./plan.md) > Project Structure.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the `js/compose/` skeleton, wire it into the manifest, and add the settings schema. No behavior yet.

- [X] T001 Create `js/compose/` and register the new content scripts in `manifest.json` (`content_scripts[0].js`) and add `css/compose.css` to `content_scripts[0].css`; no new permissions. **Done** — compose scripts registered AFTER `js/content.js` (so `detect.js` can read content.js's shared-scope lead-in constants) + `css/compose.css` added.
- [X] T002 [P] Create `css/compose.css`: namespaced (`.quran-ac-*`, `all: initial` guard) styles for the candidate dropdown + insertion-scope menu, plus the persistent in-editor citation classes that reuse the verdict colors / Quran-font class from `css/content.css`. **Done.**
- [X] T003 [P] Extend `js/storage/prefs.js` with the `prefs.autocomplete` sub-object — defaults `{enabled:true, liveRender:true, refFormat:"arabicName", refPlacement:"after", minWords:2}` with default-fill + clamp-on-read per [contracts/storage.md](./contracts/storage.md) (no `prefs` version bump). **Done** — verified by `autocomplete_check.js` (defaults present) + suite stays 60/60.

**Checkpoint**: Module slots exist and are registered; settings schema validates; nothing functionally new.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Cross-cutting infrastructure every user story depends on — the matching RPC, the editable-surface abstraction, citation detection, the orchestrator shell, the test hook, and harness support. NOTHING in US1–US4 may start until Phase 2 closes.

**⚠️ CRITICAL**: No user-story tasks may begin until Phase 2 is complete.

- [X] T004 Add the `MATCH_PARTIAL` handler in `js/background.js` reusing `findExactGlobal` / `findOrderedContiguousGlobal` (exact tier) + `findOrderedContiguousSoftGlobal` (wordLevel tier); returns ranked `{ref, refLabel, surahName, authenticText, tier, coverage, rank}` candidates, ordered tier-first then mushaf order. **Done** — shipped as a bare internal verifier RPC (reconciled in [contracts/messaging.md](./contracts/messaging.md)); verified by `autocomplete_check.js` 10/10 (any-part-of-any-verse, top-rank, exact tier, empty-in). Fuzzy tier deferred to T021.
- [X] T005 Create `js/compose/editable.js`: surface abstraction (`surfaceOf`/`getContext`/`replaceRange`/`caretRect`) — input/textarea via `selectionStart` + value splicing; contenteditable via `Selection`/`Range`. **Done.**
- [X] T006 Create `js/compose/detect.js`: citation-in-progress detection reusing content.js's `LEAD_IN_RE`/`SECONDARY_LEAD_IN_RE` (shared scope; built-in fallback otherwise) + opening-brace signal; exposes `wordCount`. **Done.**
- [X] T007 Create `js/compose/index.js`: orchestrator — document-level (capture) input/keydown/composition/focusout delegation, debounce, IME guard, min-word gate; loads via manifest (no `content.js` change). **Done.**
- [X] T008 [P] `window.__quranCompose` hook written on every transition + `acceptSelected`/`moveSelection` test drivers, per [contracts/window-globals.md](./contracts/window-globals.md). **Done** — exercised by the gate.
- [X] T009 [P] Add i18n keys (ar + en, parity) to `js/shared/i18n.js` for the dropdown/scope labels, "end word not found", and the not-recognized state (`ac_*` keys). **Done** — `i18n_check` 166 keys ar/en in parity.
- [X] T010 Create `tests/autocomplete_check.js` (system Chromium + MV3 mock + ORIGIN routing), wired into `npm run test:checks`. **Done** — `MATCH_PARTIAL` battery + synthetic-typing across input/contenteditable reading `window.__quranCompose`; 22/22.

**Checkpoint**: A typed citation can be detected and matched, the orchestrator runs with caret tracking and IME guards, and the test gate can drive typing — but no dropdown, insertion, cascade, or rendering exists yet.

---

## Phase 3: User Story 1 — Complete a verse from memory with authentic wording + reference (Priority: P1) 🎯 MVP

**Goal**: After the min-word gate, show a caret-anchored dropdown of candidate ayahs (matched against any part of any verse, narrowing live), accept via Tab/Enter (single match auto-resolves; multiple defaults to the first), and replace the typed text with the authentic ayah + reference.

**Independent Test**: In a contenteditable host, type a recognized prefix + the first words of a known ayah → dropdown appears after the gate, narrows as typing continues, Tab/Enter inserts the authentic ayah + reference; a fragment matching exactly one verse auto-resolves on accept.

- [X] T011 [US1] Create `js/compose/match.js`: call `MATCH_PARTIAL`; one-entry cache; narrowing via re-query with the longer fragment (FR-006); ordering done server-side tier-first/mushaf (FR-005/013). **Done** (client-side filter optimization deferred to T030).
- [X] T012 [US1] Create `js/compose/dropdown.js`: caret-anchored ranked candidate list; mousedown-select; selection state; **Tab/Enter accept handled in index.js while shown** (FR-009/010/012). **Done.**
- [X] T013 [US1] Create `js/compose/insert.js`: build **authentic ayah wording** + reference per `refFormat`/`refPlacement`; authentic-only (FR-014/017). Whole-ayah scope for US1; `buildBody` scope param ready for US2. **Done.**
- [X] T014 [US1] Wire dropdown accept → `insert.js` in `js/compose/index.js`; recomputes the live citation span before replacing; populates `window.__quranCompose.lastInsertion`; blind accept uses rank-0 (FR-012/013). **Done.**
- [X] T015 [P] [US1] Coverage via the assertion gate (mirrors the 001 in-page-host pattern): `tests/autocomplete_check.js` builds input/textarea/contenteditable hosts, derives the ground-truth verse from the shipped index (Principle I), and asserts candidate presence + top-rank (SC-002). **Done** — separate `tests/fixtures/compose/*` HTML files unnecessary given the in-page hosts.
- [X] T016 [US1] Run `node tests/autocomplete_check.js`: **22/22** (typing → dropdown → accept inserts authentic ayah + ref, across input + contenteditable, min-word gate); `npm test` stays 60/60 + all checks green.

**Checkpoint**: The core writer-side value works end-to-end — type → suggest → accept → authentic ayah + reference. A true MVP.

---

## Phase 4: User Story 2 — Choose how much of the verse to insert (Priority: P2)

**Goal**: After a candidate is accepted, a second menu offers insertion scope: whole ayah / only the typed portion / from the typed start to an end word the user then types.

**Independent Test**: Trigger a match as in US1; confirm the second menu offers the three scopes; exercise each and confirm the inserted text matches the chosen scope (authentic wording + reference); a missing end word is reported and not truncated.

- [ ] T017 [US2] Extend `js/compose/dropdown.js` + `js/compose/insert.js` with the **second scope menu** (FR-012a) offering `whole` / `typedPortion` / `startToEndWord`; for `startToEndWord` capture the user-typed end word and slice the authentic verse from the typed start through it (FR-015)
- [ ] T018 [US2] Handle the end-word-not-found case in `js/compose/insert.js`: when the end word is absent from the matched verse after the start, surface the localized "end word not found" message and refuse the truncated insert (FR-016)
- [ ] T019 [P] [US2] Add fixtures `tests/fixtures/compose/scopes.{html,expected.json}` covering all three scopes plus the end-word-not-found path; assert inserted text per scope
- [ ] T020 [US2] Run the gate; iterate until US2 acceptance scenarios pass; `npm test` green

**Checkpoint**: Authors can insert at the granularity they actually quote.

---

## Phase 5: User Story 3 — Drift warning + unrecognized flagging (Priority: P3)

**Goal**: When no exact match exists, offer word-level (yellow) candidates; then fuzzy (red); when nothing matches, mark the recognized citation as not-recognized (red).

**Independent Test**: Type a small-drift fragment → word-level candidates offered; a loosely-similar fragment → fuzzy candidates; unmatched text → marked red where the surface supports styling.

- [ ] T021 [US3] Extend `js/compose/match.js` to expose the **cascade** exact → word-level → fuzzy → none, carrying `tier` per candidate so the dropdown can show drift candidates (FR-007)
- [ ] T022 [US3] In `js/compose/index.js`, when the cascade yields no candidate, set the citation's state to not-recognized so it is marked **red** (delegating the actual styling to `render-editable.js` from US4; minimal red mark if US4 not yet present) (FR-008)
- [ ] T023 [P] [US3] Add fixtures `tests/fixtures/compose/cascade.{html,expected.json}` with a word-level-drift fragment, a fuzzy fragment, and a no-match fragment; assert offered tiers and the not-recognized state
- [ ] T024 [US3] Run the gate; iterate until US3 acceptance scenarios pass; `npm test` green

**Checkpoint**: The prevention half works — drift is surfaced and non-Quran text is flagged before publishing.

---

## Phase 6: User Story 4 — Live Quran-font + verdict rendering, settings, and fall-through (Priority: P4)

**Goal**: Unless disabled, recognized citations render by verdict color + Quran font; rendering persists as markup in contenteditable and is skipped (text-only) in plain inputs; pre-existing citations render on focus; unresolved citations fall through to verdict classification; all gated by the settings.

**Independent Test**: Insert/accept a matched ayah in contenteditable → renders in the Quran font and the markup persists; leave an unmatched citation → red-highlighted; disable the rendering setting → no styling; plain input → insertion works, styling skipped; a citation dismissed by typing-past gets a verdict highlight.

- [ ] T025 [US4] Create `js/compose/render-editable.js`: classify recognized citations via `js/verifier/classify.js` and apply the verdict color + Quran font; **persist markup in contenteditable** (FR-018b), skip styling in plain inputs; render **pre-existing citations on focus** (FR-018a); all gated by `prefs.autocomplete.liveRender` (FR-018)
- [ ] T026 [US4] In `js/compose/dropdown.js` + `js/compose/index.js`, implement **instance dismissal** (type-past / caret-away closes the dropdown, not the feature; no Esc) and route the unresolved citation to `render-editable.js` for **fall-through classification** (FR-011, FR-011a)
- [ ] T027 [US4] Extend `html/options.html` + `js/options.js` with the **Autocomplete settings** section (enable, live-render, reference format, reference placement, min-word gate) wired to `PREFS_WRITE`, localized via `[data-i18n]`, reflecting live via `PREFS_CHANGED` (FR-019)
- [ ] T028 [P] [US4] Add fixtures `tests/fixtures/compose/render.{html,expected.json}` covering contenteditable persistent markup, plain-input text-only skip, pre-existing-on-focus, and fall-through verdict; assert `persistedMarkup` + `lastClassification` (SC-007)
- [ ] T029 [US4] Run the gate; iterate until US4 acceptance scenarios pass; `npm test` green

**Checkpoint**: All four stories work independently; the feature is complete — detect, suggest, insert at scope, warn on drift, render by verdict, all under settings control.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Performance, localization, porting-discipline review, and the final gate.

- [ ] T030 [P] Performance sweep: confirm the min-word gate, debounce, and client-side narrowing keep typing responsive (no per-keystroke background round-trip), satisfying SC-005 on the fixture hosts
- [ ] T031 [P] i18n parity check: every new `t()` key exists in both `ar` and `en` with no missing-translation fallback (SC-008)
- [ ] T032 [P] Porting-discipline pass (Principle V): read the advanced copy's autocomplete at `C:\Users\mosta\PycharmProjects\QuranChromePlugin`, confirm its cases (editor quirks, caret rects, IME, end-word truncation, multi-citation fields) are covered by fixtures, and confirm no implementation was ported verbatim; record notes
- [ ] T033 Final full-suite run: `npm test` (existing suite green — no regression) + `node tests/autocomplete_check.js` (all US1–US4 assertions); confirm SC-001…SC-008 hold simultaneously; stop-the-line on any regression

---

## Dependencies & Execution Order

### Phase dependencies
- **Phase 1 (Setup)**: no dependencies
- **Phase 2 (Foundational)**: depends on Phase 1; BLOCKS all user stories
- **Phase 3 (US1, MVP)**: depends on Phase 2
- **Phase 4 (US2)**: depends on US1 (extends dropdown/insert)
- **Phase 5 (US3)**: depends on Phase 2 (extends match cascade); independent of US2; full red rendering co-depends on US4's `render-editable.js`
- **Phase 6 (US4)**: depends on Phase 2; consumes US1–US3 citation states; provides the rendering US3's red flag uses
- **Phase 7 (Polish)**: depends on all shipped stories

### Within each story
- Modules before fixtures; fixtures with intended output; story "done" when its Independent Test passes and `npm test` stays green.

### Parallel opportunities
- T002 / T003 (Setup)
- T008 / T009 (Foundational — different files)
- T011 vs T015 (US1 — module vs fixture authoring, once T012/T013 land)
- T019 (US2), T023 (US3), T028 (US4) fixtures parallel to their story modules
- T030 / T031 / T032 (Polish)

---

## Implementation Strategy

### MVP first (User Story 1)
1. Phase 1 — Setup
2. Phase 2 — Foundational (CRITICAL — blocks all stories)
3. Phase 3 — US1 until US1 scenarios + SC-002 pass
4. **STOP & VALIDATE**: demo type→suggest→accept→authentic ayah + reference

### Incremental delivery
1. Setup + Foundational → detection + matching RPC ready
2. + US1 → **MVP**: complete a verse with authentic wording + reference
3. + US2 → insertion-scope control
4. + US3 → drift cascade + not-recognized flagging
5. + US4 → live verdict/Quran-font rendering + settings + fall-through
6. Polish → ship gate

## Notes
- **Principle V** governs the matching path: reuse the rebuilt verifier via `MATCH_PARTIAL`; harvest the advanced copy's *cases*, never its implementation.
- **Principle II**: the editor uses the existing five verdicts + lightGreen provenance — no new color, ever.
- **No new permissions / keyspace / color**: content script already runs on `<all_urls>`; settings live under `prefs.v1.autocomplete`.
- Commit after each task or logical group.
- Fixtures encode intended output; never freeze broken output as a regression target.
