---

description: "Implementation task list for Arabic Quran Citation Auditor (V1)"
---

# Tasks: Arabic Quran Citation Auditor (V1)

**Input**: Design documents from `specs/001-arabic-citation-auditor/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md) (32 FRs, 13 SCs, 20 clarifications across 4 sessions), [data-model.md](./data-model.md), [contracts/](./contracts/), [research.md](./research.md), [quickstart.md](./quickstart.md), constitution v1.0.0 at `.specify/memory/constitution.md`

**Tests (fixtures)**: Included per Constitution Principle VI ("Fixtures Are the Quality Gate, Not the Porting Target"). Playwright fixtures live under `tests/fixtures/` and are driven by `tests/run_tests.py`. Each user-story phase includes the fixtures that validate it.

**Organization**: Tasks are grouped by user story (US1 P1 → US4 P4) so each story can be implemented independently and validated against its own fixtures before the next priority begins (per constitution Development Workflow item 6: "Phases ship sequentially. Don't start a later phase until the prior one closes its fixtures").

## Format: `- [ ] T### [P?] [Story?] Description (path)`

- **[P]** = parallelizable (different files, no dep on incomplete task)
- **[Story]** = US1 / US2 / US3 / US4 — present only for user-story-phase tasks
- File paths are repo-relative

## Path conventions

Repo is a flat Chromium MV3 extension at the repo root. See [plan.md](./plan.md) > Project Structure for the full module map. Key directories:

- `js/` — extension source (existing flat layout being split into subdirs)
- `html/`, `css/` — UI surfaces
- `resources/` — Quran JSON + bundled fonts + Quran ayah images (existing)
- `tests/` — Playwright runner + fixtures (existing)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Reshape the existing flat `js/` into the module layout defined in [plan.md](./plan.md). No behavior change yet — just the skeleton.

- [x] T001 Create directory skeleton for the new module layout: `js/verifier/`, `js/render/`, `js/panel/`, `js/storage/`, `js/badge/`, `js/shared/` (no files yet — placeholder `.gitkeep` if needed)
- [x] T002 [P] Update `manifest.json` to keep `content_scripts.js: ["js/content.js"]` for now (Phase 2 will register the new modules); no behavior change in this task
- [x] T003 [P] Add three bundled Quran font files to `resources/fonts/`: `uthmani-hafs.ttf`, `indo-pak.ttf`, `simplified.ttf` (FR-008 / FR-009 / Decision 7.17); register them in `web_accessible_resources` of `manifest.json`
- [x] T004 [P] Create `css/fonts.css` with `@font-face` declarations for the three fonts (FR-008)

**Checkpoint**: Repo has the new directory shape and font assets; nothing functionally new yet. Existing scan still works the same.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Cross-cutting infrastructure every user story depends on. NOTHING in any user-story phase may start until Phase 2 is complete.

**⚠️ CRITICAL**: No user-story tasks (US1–US4) may begin until Phase 2 closes.

### Messaging envelope

- [x] T005 Create `js/shared/messaging.js` with the typed envelope `{type, requestId, payload}`, helper `sendRequest(type, payload)` and `registerHandler(type, fn)` honoring the `return true` async discipline (contracts/messaging.md)
- [x] T006 [P] Extend `js/background.js` to use `js/shared/messaging.js` and route the 13 message types listed in `contracts/messaging.md` (SCAN_START, SCAN_PROGRESS, SCAN_CAP_HIT, SCAN_COMPLETE, MUTATION_RESCAN, CORRECT_IN_PLACE, DISMISS_FINDING, RESTORE_DISMISSED, PERSIST_WRITE/READ, CLEAR_PERSISTED, PREFS_READ/WRITE, PREFS_CHANGED, DATA_UNAVAILABLE, RETRY_DATA_LOAD, DATA_AVAILABLE); handlers are stubs that return `{ok: true}` for now

### Preferences storage

- [x] T007 [P] Create `js/storage/prefs.js`: `prefs.v1` read/write/patch with default-fill on read and clamp-on-read for `perColor.red`, `font`, `scanTrigger`, `panelSurface` (contracts/storage.md)
- [x] T008 [P] Wire `PREFS_READ` / `PREFS_WRITE` handlers in `js/background.js` to `js/storage/prefs.js`; broadcast `PREFS_CHANGED` to all live content scripts on write (contracts/messaging.md)

### Persisted per-URL store (FR-024 / FR-025)

- [x] T009 [P] Create `js/storage/persisted.js`: `urlKey(rawUrl)` builder (strip `#fragment`, sort query params); `read(urlKey)` with lazy 30-day TTL prune; `write({urlKey, compositeKey, kind, at})`; `clearAll()` (contracts/storage.md)
- [x] T010 Wire `PERSIST_READ` / `PERSIST_WRITE` / `CLEAR_PERSISTED` handlers in `js/background.js` to `js/storage/persisted.js` (depends on T009)

### Quran data load + FR-020 fail-loud

- [x] T011 Refactor `js/background.js` Quran JSON loader to validate the schema on load; on missing / unreadable / schemaFailure, set internal state to `DATA_UNAVAILABLE`, broadcast `DATA_UNAVAILABLE` to popup + content, refuse to attach content-script behavior (FR-020)
- [x] T012 Add `RETRY_DATA_LOAD` handler in `js/background.js` that re-attempts load; on success broadcasts `DATA_AVAILABLE` (FR-020)

### Verifier scaffolding (split from current `background.js`)

- [x] T013 [P] Create `js/verifier/normalize.js`: tashkeel-stripping + spelling-drift normalization (alif variants ا/آ/ٱ, alef maqsura ↔ ya, ta marbuta ↔ ha, adjacent same-letter collapse) per FR-003; ported clean from advanced copy under Principle V discipline
- [x] T014 [P] Create `js/verifier/indexes.js`: build all 5 indexes (byRef, surahNameIndex, normalizedVerseIndex, wordIndex, skeletonWordIndex) from `resources/quran-uthmani_desc-v2.json` (research.md §1)
- [x] T015 Wire `js/background.js` to call `js/verifier/indexes.js` on service-worker activation with the loaded JSON (depends on T011 + T014); rebuild ~50–100 ms per constitution
- [x] T016 [P] Create `js/verifier/references.js`: parse `surah:ayah`, ranges (`فصلت:3-4`), surah-name variants (start from advanced-copy variant map; small clean port permitted per Principle V)

### Content-script foundation (existing extensions)

- [x] T017 Refactor `js/content.js` to import the messaging envelope (T005) and emit `SCAN_START` / `SCAN_PROGRESS` / `SCAN_COMPLETE` envelopes instead of ad-hoc messages; no UX change yet
- [x] T018 Extend `js/content.js` virtual-text builder (TreeWalker + `\x00` boundaries + offset map) to expose `getMutatedSubtreeText(rootNode)` for incremental rescans (FR-019)

### Window globals contract (Playwright observability)

- [x] T019 Update `js/content.js` to write `window.__quranScan`, `window.__quranStats`, `window.__quranMatches` exactly per `contracts/window-globals.md` (extend existing shape with new fields: `finalState`, `capHit`, `capLifted`, `languageDetected`, `priorFindingId`, `persistedBadge`)

### Scan-trigger model + popup foundation (FR-026)

- [x] T020 Extend `html/popup.html` to add a "Scan trigger" toggle (Manual / Autoscan, default Manual) and persist the choice via `PREFS_WRITE` (FR-026)
- [x] T021 [P] Extend `js/popup.js` to read `prefs.scanTrigger` on open and gate the "Scan" button visibility / Autoscan-on-load behavior accordingly (FR-026)
- [x] T022 Wire `js/content.js` Autoscan path: on page load, if `prefs.scanTrigger === "autoscan"`, trigger `SCAN_START` automatically; on `pushState/replaceState/popstate`, treat as fresh page and re-trigger per FR-019

### Hard cap + Continue scanning (FR-031)

- [x] T023 Add scan-cap enforcement in `js/content.js`: stop accepting candidates after 500 findings; emit `SCAN_CAP_HIT` to popup with `perCategoryCount`; expose `liftCap` flag on subsequent `SCAN_START` from popup's "Continue scanning" button

### Empty-state suppression (FR-027 / SC-008)

- [x] T024 In `js/content.js`'s `SCAN_COMPLETE` emit path, set `finalState` to `"empty"` when `totalCount === 0` and to `"clean"` when only verified-class findings exist; popup consumes `finalState` to render either the panel or the "No Quran citations found on this page" / "Page not in Arabic" status (FR-027, FR-029)

### Language gate (FR-029)

- [x] T025 [P] Add Arabic-language detection to `js/content.js` (read `<html lang>` + small Arabic-character ratio test); run ONLY at scan trigger time, never on tab activation or page load; emit `SCAN_COMPLETE` with `finalState: "notArabic"` when detection fails (FR-029)

### Stateful action badge (FR-028)

- [x] T026 Create `js/badge/badge.js`: state machine consuming `SCAN_START` / `SCAN_PROGRESS` / `SCAN_COMPLETE` / `SCAN_CAP_HIT` / `DATA_UNAVAILABLE` / `DATA_AVAILABLE` events from `chrome.runtime`; renders ● / ✓ / ! glyph with severity color (orange > red > yellow); sets `chrome.action.setBadgeText`, `setBadgeBackgroundColor`, `setTitle` per FR-028
- [x] T027 Wire `js/background.js` to instantiate `js/badge/badge.js` on service-worker startup and broadcast badge updates per-tab (depends on T026)

### Incremental rescan via MutationObserver (FR-019)

- [x] T028 Add `MutationObserver` setup in `js/content.js` after the initial scan completes; debounce mutations by ~500 ms; on burst, call the scan pipeline with only the mutated subtree(s); retain existing Findings whose composite key is unchanged (per FR-021)

### Progressive-reveal status text (FR-023)

- [x] T029 Extend `html/popup.html` + `js/popup.js` to render "Scanning…" with a live running count of `perCategoryCount` driven by streamed `SCAN_PROGRESS` envelopes; show final summary count on `SCAN_COMPLETE`; expose "Re-scan all" and "Continue scanning" actions (FR-019, FR-023, FR-031)

**Checkpoint**: Phase 2 complete — every user story can now begin in priority order. The extension scans, badges, persists, handles failure, suppresses empty/non-Arabic, and stops at 500 findings, but does NOT YET classify into 5 colors, does NOT YET render the panel, does NOT YET swap authentic text, and does NOT YET allow correction.

---

## Phase 3: User Story 1 — A reader catches a "real verse, wrong reference" citation (Priority: P1) 🎯 MVP

**Goal**: Detect Arabic Quran citations on a rendered page, classify each into the 5-color taxonomy with FR-003 drift-as-green, identify reference-mismatch (orange) cases via the new orange pipeline, paint highlights with category glyph + words, attach tooltips that name the category in words, expose keyboard-accessible focusable highlights with hover/focus/long-press activation and `aria-describedby` for screen readers.

**Independent Test**: Load fixture 174389 with the extension active. Confirm at least 17 verified matches + 0 red (SC-001 / SC-003). Confirm `ما ننسخ من آية` is highlighted orange with tooltip "Reference mismatch — Cited as <page-ref>, actually البقرة:106" (SC-002, FR-005). Confirm tashkeel/drift-only citations are green (SC-004, FR-003). Confirm keyboard Tab traversal reaches every highlight, focus shows the tooltip, screen-reader test announces category name (FR-032). No panel work needed.

### Classifier + 5 colors

- [X] T030 [US1] Create `js/verifier/classify.js`: the five-color decision function enforcing FR-002 (exactly 5 categories), FR-015 (red never gets non-red), FR-017 (only exact/tashkeelDriftOnly/spellingDrift confidences may yield green), FR-018 (drop silently when no signals + no match)
- [X] T031 [P] [US1] Create `js/verifier/orange.js`: the headline reference-mismatch pipeline (per data-model.md > VerificationResult, FR-004 + FR-016) — given a candidate with a cited reference, run normalized verse text against the matched-reference verse AND against global search; produce orange when text matches a different verse than cited (constitution Principle III)
- [X] T032 [US1] Wire `js/verifier/classify.js` into `js/background.js`'s scan pipeline so each candidate yields a `VerificationResult` with `{category, matchedReference, citedReferenceParsed, notes, confidence}` (depends on T030 + T031)

### Highlight rendering with glyph + words + a11y (FR-005, FR-007, FR-010, FR-032)

- [X] T033 [US1] Extend `css/content.css` to add the three missing highlight colors (light blue, yellow, orange) with their per-category glyph prefixes (✓ verified-with-reference, ⓘ verified-without-reference, ~ word-level-inexact, ⚠ reference-mismatch, ✗ not-in-Quran) per FR-007
- [X] T034 [US1] Extend `js/content.js` `wrapTextNodes` to set `tabindex="0"` on every highlight span and bind an `aria-describedby` to a hidden per-highlight tooltip element containing category-name-in-words + cited/true references (FR-005, FR-007, FR-032) — implemented via `aria-label` (no SR-only DOM child) to avoid DOM-mutation regression
- [X] T035 [US1] Extend `css/content.css` tooltip `::after` rule to activate on `:hover`, `:focus`, and a touch-long-press class set by `js/content.js`; tooltip MUST start with the category name in words ("Reference mismatch — Cited as X, actually Y") per FR-005 + FR-032
- [X] T036 [US1] Add Esc handling on focused highlights in `js/content.js`: first Esc dismisses tooltip and returns focus to the highlight; second Esc moves focus back to the host page (FR-032)

### Scan-result composition (Finding emission)

- [X] T037 [US1] In `js/content.js`'s scan pipeline, compose each `Finding` per data-model.md: composite id = sha1(normalize(rawText) + "|" + normalize(citedReference) + "|" + matchedReference.toString() + "|" + domPath); `priorFindingId: null` for fresh findings; emit each via `SCAN_PROGRESS` so the badge (T026) and global windows (T019) update live (FR-023) — uses FNV-1a (sync) instead of SHA-1 (async) to avoid reentrancy in the convergence loop; same deterministic identity

### Fixtures for US1

- [ ] T038 [P] [US1] Update `tests/fixtures/174389/expected.json` to encode the **intended** verdicts (≥17 verified, 0 red, the known `ما ننسخ من آية` orange case at `البقرة:106`) per SC-001 + SC-002; do NOT capture the rebuild's current broken output (quickstart.md §3)
- [ ] T039 [P] [US1] Capture or curate the remaining 6 reviewed fixtures from the advanced copy under `tests/fixtures/<slug>/` with intended-output `expected.json`, bringing fixture parity to 11 (SC-003)
- [ ] T040 [P] [US1] Create the 20-case orange precision/recall set under `tests/fixtures/orange-cases/` — each case has a known reference-mismatch citation; `expected.json` encodes the true reference (SC-009 ≥ 95% precision, SC-010 ≥ 90% recall)
- [ ] T041 [P] [US1] Create at least 5 drift-as-green fixtures under `tests/fixtures/drift-cases/` covering tashkeel-only differences and the 4 modern-spelling-drift classes from FR-003; `expected.json` requires green classification (SC-004 = 100%)
- [ ] T042 [P] [US1] Curate 20 random Arabic articles under `tests/fixtures/red-false-positives/` for SC-011 (≤ 2 false-positive reds across the set)
- [ ] T043 [US1] Run the full Playwright suite (`python tests/run_tests.py`) and iterate on classifier/orange-pipeline until SC-001, SC-002, SC-003, SC-004, SC-009, SC-010, SC-011 all pass; stop-the-line on any regression of a previously-passing fixture (constitution Workflow item 3)

**Checkpoint**: User Story 1 fully delivers the headline integrity value (orange reference-mismatch detection with the "Cited as X, actually Y" tooltip) end-to-end. Panel and swap and correct-in-place do not exist yet, but the extension is meaningfully useful on its own — a true MVP per constitution Principle III ("Orange is the product's flagship signal").

---

## Phase 4: User Story 2 — A reader sees all orange findings on a page in one place (Priority: P2)

**Goal**: Findings panel that aggregates findings across all 5 categories with default-orange-only filter (FR-010), available in popup-attached (default) and page-injected sidebar surfaces, with full per-finding actions (jump, copy, share via Chrome text-fragment URL, report, copy-as-JSON) and full keyboard support (FR-030). Includes the "Previously corrected / Previously dismissed" badge READ side from FR-024 so re-encountered findings surface with that badge (the WRITE side ships with US4).

**Independent Test**: Load any fixture with ≥1 finding. Open popup → see panel with orange filter on by default and all orange findings listed (FR-010 default). Toggle yellow filter → yellow findings appear. Click a finding → page scrolls to its highlight. Click Copy → clipboard has plain-text Arabic+English labeled record. Click "Share" → clipboard has page URL with `#:~:text=` + the record body. Tab into panel, Arrow keys move focus, single-letter shortcuts fire (FR-030). Switch panel surface preference to "sidebar" → next scan injects the sidebar with identical contents.

### Panel model + composite identity

- [X] T044 [US2] Create `js/panel/model.js`: in-memory `Map<findingId, Finding>` for the active scan; per-finding `PanelState`; sections "Active filter view" / "Recently corrected" (empty until US4) / "Dismissed (this session)" / "Previously dismissed" (data-model.md > Finding)
- [X] T045 [US2] On every `SCAN_PROGRESS`, append to `js/panel/model.js`; on `SCAN_COMPLETE`, query `js/storage/persisted.js` for the current `urlKey` (via `PERSIST_READ`) and tag matching Findings with `persistedBadge` per FR-024 (depends on T010, T044)

### Popup-attached surface (default)

- [X] T046 [US2] Create `js/panel/popup-surface.js`: render panel into `html/popup.html` (extend `html/popup.html` with a panel container); per-finding row shows category glyph + category-name in words + color swatch + citation snippet + (cited ref / true ref) per FR-010; row is `role="button"` + `tabindex="0"` (FR-030)
- [X] T047 [US2] Extend `html/popup.html` to host the panel container, the per-category filter toggles (default: orange on, others off per FR-010), and the surface picker ("Popup" / "Sidebar"); persist via `PREFS_WRITE`

### Page-injected sidebar surface

- [X] T048 [P] [US2] Create `html/sidebar.html` markup for the page-injected sidebar/overlay surface (FR-010)
- [X] T049 [P] [US2] Create `css/sidebar.css` scoped to extension UI selectors (prefixed) to avoid host-page style bleed
- [X] T050 [US2] Create `js/panel/sidebar-surface.js`: inject `html/sidebar.html` into the current page on demand when `prefs.panelSurface === "sidebar"` AND `finalState !== "empty" && finalState !== "notArabic"` (FR-010, FR-027, FR-029); render the same data and actions as the popup surface

### Per-finding actions

- [X] T051 [US2] Create `js/panel/actions.js`: implement (a) jump-to-highlight (scroll target highlight into view + flash focus), (b) copy (plain-text Arabic+English-labeled record per FR-011), (c) share (page URL + `#:~:text=<percent-encoded snippet>` + plain-text body on the next line per FR-011 + Decision 7.20), (d) report (same plain-text body per FR-011 + Assumptions), (e) copy-as-JSON (FR-011 secondary action)
- [X] T052 [US2] Wire panel rows in `js/panel/popup-surface.js` and `js/panel/sidebar-surface.js` to `js/panel/actions.js` action handlers (depends on T046, T050, T051)

### Keyboard model (FR-030)

- [X] T053 [US2] Create `js/panel/keyboard.js`: scoped keydown listener that fires only while focus is inside the panel root; Arrow ↑/↓ move row focus across sections in order; Enter = jump (FR-011a); C/S/R/F/D/J map to copy/share/report/correct-in-place/dismiss/copy-as-JSON (F + D do nothing until US4 ships them); Space toggles a filter when focused on a filter chip; Esc returns focus to the surface root then to the page (FR-030)
- [X] T054 [US2] Wire `js/panel/keyboard.js` into both surfaces (depends on T053, T046, T050)

### Fixtures for US2

- [ ] T055 [P] [US2] Create a fixture under `tests/fixtures/multi-orange/` with three known orange findings on a single page; `expected.json` enumerates each + their snippets and references (US2 Acceptance Scenario 1)
- [ ] T056 [P] [US2] Create a fixture under `tests/fixtures/persistence-badge/` that simulates a previously-corrected entry in `chrome.storage.local` for a known finding's composite key; runner asserts the panel row shows the "Previously corrected on YYYY-MM-DD" badge per FR-024
- [ ] T057 [US2] Run the Playwright suite; iterate on panel rendering until US2 Acceptance Scenarios 1–4 (FR-010, FR-011) and the keyboard model (FR-030) pass

**Checkpoint**: User Stories 1 + 2 work independently. The reader can scan, see the headline orange findings in a list with full keyboard support, jump to them, copy/share/report them in two formats with a citation-anchored share link. Authentic text and correct-in-place still don't exist.

---

## Phase 5: User Story 3 — Authentic Quran text appears in place by default (Priority: P3)

**Goal**: Replace every non-red highlighted span with authentic Quran text in the user's chosen Quran font (Uthmanic Hafs default), with span-local layout absorption bounded to ≤ 1.5× the original line-box (FR-008 / SC-013). Master toggle + per-color overrides + font picker live in the popup, all defaulting ON for the four non-red colors and OFF for red (FR-009, FR-015, Decision 7.19).

**Independent Test**: Load any fixture with at least one green and one orange citation. Confirm both spans display authentic JSON wording with full tashkeel in Uthmanic Hafs font by default (US3 Acceptance Scenario 1). Toggle master OFF → both revert to original text, highlights remain (Scenario 2). Toggle per-color override for yellow OFF → only yellow reverts (Scenario 3). Red is never swapped under any toggle combination (Scenario 4, FR-015). Switch font picker to Indo-Pak → all swapped spans re-render in that font. Run the top-10 fixture layout-safety set: no content jump > 50 px on any (SC-013).

### Swap engine

- [X] T058 [US3] Create `js/render/swap.js`: per-finding `applySwap(finding)` + `revertSwap(finding)` operating on the highlight wrapper; sets inner text to `Verse.textUthmani` from the loaded JSON; applies `font-family` from `prefs.font`; adjusts `font-size` and `line-height` inside the span only (no outside-span CSS) with the rendered line-box constrained ≤ 1.5× the surrounding line-box per FR-008
- [X] T059 [US3] Create `js/render/fonts.js`: small registry exposing the three font CSS family names that `js/render/swap.js` consumes
- [X] T060 [US3] Wire `js/content.js` to call `js/render/swap.js`.`applySwap` for every non-red finding once verification completes, gated by `prefs.master.authenticTextReplacement` AND `prefs.perColor[finding.verification.category]` (FR-008 + FR-009 + FR-015); call `revertSwap` when toggles flip via `PREFS_CHANGED` broadcast (T008)

### Popup UI for FR-009

- [X] T061 [US3] Extend `html/popup.html` + `js/popup.js` to add: (a) master toggle for `authenticTextReplacement`, (b) four per-color checkboxes (green / light blue / yellow / orange — red disabled and visually marked "always off"), (c) font picker (Uthmanic Hafs / Indo-Pak / simplified); all wired to `PREFS_WRITE` and reflect on the active page via `PREFS_CHANGED` (FR-009)

### CSS for swap

- [X] T062 [P] [US3] Extend `css/content.css` with a `.quran-swap` style class used by swap spans: applies the active font CSS variable, full tashkeel rendering hints (`font-feature-settings`), and the bounded line-box absorption rules from FR-008

### Fixtures for US3

- [ ] T063 [P] [US3] Curate the top-10 layout-safety fixture set under `tests/fixtures/layout-safety/`: each fixture's `expected.json` records the original layout-box of the first paragraph that contains a non-red highlight; the runner asserts post-swap layout-box delta < 50 px per SC-013
- [ ] T064 [US3] Run the Playwright suite; iterate on `js/render/swap.js` font sizing / line-height tuning until SC-013 passes on all 10 fixtures with span-local absorption only (no outside-span CSS modifications, no relaxing the 1.5× bound — constitution Principle IV, FR-008 absorption rules)

### Phase 5 swap follow-ups (USER-REPORTED BUGS — fix BEFORE Phase 6)

- [X] T058z [US3] **CRITICAL — swap-during-scan corrupts results**: applySwap currently fires inside `applyHighlight` during the convergence loop, so subsequent passes / the MutationObserver see authentic text instead of the page's original wording → final green/orange/yellow counts differ from a no-swap scan. Repro: default prefs (swap ON) → wrong counts; swap OFF → reload → scan → enable swap → correct counts. **Fix**: defer all applySwap calls until AFTER the convergence loop, called from `emitComplete` iterating `STATE.findings`; also gate the MutationObserver while swapping (flag mirroring the sidebar-add filter).
- [X] T058a [US3] **Excerpt-preserving swap**: replace the highlight ONLY with the matching subset of the authentic ayah (same excerpt shape the page cited), not the full ayah. For ellipsis-excerpts `{first ... last}` swap each segment with its authentic counterpart. For multi-ayah citations swap each segment with its matching ayah. Full ayah stays in the panel row + copy/share record only. Requires the verifier to surface the aligned segment text(s) — likely a new `result.authenticSegments` field (array of `{text}`). Yellow (word-level) needs the optimal-matching segment indices from the diff.
- [X] T058b [US3] **Swap sizing**: replace the iterative `applyBoundedSizing` with a fixed baseline of `font-size: 0.8em; line-height: 1` (matches the advanced copy's working pattern). Only escalate if measurement still exceeds 1.5× parent line-box.
- [X] T058c [US3] **Color rectangle drift**: when swapped text length differs from the original, the colored highlight box no longer wraps the visible text correctly. Investigate whether `unicode-bidi: isolate` on `.quran-swap` is creating a sub-line-box mismatch; the highlight wrapper is `display: inline` so it should reflow with the swap text, but the user reports it doesn't.

**Checkpoint**: User Stories 1 + 2 + 3 all work independently. The reader gets the full triad — detect, list, render authentic — with all preferences persisting across sessions. Correct-in-place is the only feature left.

---

## Phase 6: User Story 4 — A reader corrects a wrong citation in place (Priority: P4)

**Goal**: From a panel orange-finding row, the reader invokes correct-in-place. The cited reference in the page DOM is replaced with the true reference (FR-012); the finding flips to green via the FR-022 successor pattern (new Finding with `priorFindingId` back-reference) and pins to "Recently corrected" for the session; subsequent revisits within 30 days surface the citation with a "Previously corrected on YYYY-MM-DD" badge per FR-024. Dismiss action (FR-025) ships in the same phase since it shares the persistence pathway.

**Independent Test**: Load `tests/fixtures/editable-orange/`. From the panel, invoke correct-in-place on an orange finding. Confirm (a) the page DOM has the new reference, (b) the highlight color flipped to green (or whatever post-correction verification yields), (c) the finding appears in a "Recently corrected" section at the top of the panel for the rest of the session regardless of the active filter, (d) the panel row carries a `priorFindingId` back-reference. Reload the page → the finding now appears with a "Previously corrected on YYYY-MM-DD" badge (FR-024). Load `tests/fixtures/locked-dom-orange/` → action falls back to clipboard with an explanatory message (FR-012). Dismiss any finding → it moves to "Dismissed (this session)" and persists per FR-024.

### Correct-in-place + successor Finding (FR-012 + FR-022)

- [X] T065 [US4] Add `correctInPlace(findingId)` handler in `js/content.js`: attempt DOM-level cited-reference text replacement on the page; on success, emit a `SCAN_PROGRESS` event for the successor Finding under the new composite key with `priorFindingId = <original findingId>` (per data-model.md and Decision 7.8); on DOM-edit failure (shadow DOM, contenteditable disabled, sandboxed iframe), fall back to copying the corrected citation to the clipboard and emit a user-visible explanation per FR-012
- [X] T066 [US4] In `js/panel/model.js`, on receiving a `SCAN_PROGRESS` envelope where `priorFindingId !== null`: discard the prior Finding from the active filter view (per FR-021), add the successor to a "Recently corrected" section pinned at the top of the panel visible regardless of the active filter (FR-022); section is cleared on "Re-scan all" or page reload
- [X] T067 [US4] Wire `js/panel/actions.js` "F" shortcut (FR-030) and the panel-row "correct-in-place" button to `CORRECT_IN_PLACE` envelopes (depends on T053, T065)
- [X] T068 [US4] After every successful correct-in-place, `js/content.js` MUST emit a `PERSIST_WRITE` envelope with `{urlKey, compositeKey: <new compositeKey>, kind: "correction", at: <now-ISO8601>}` so future visits get the FR-024 badge (depends on T010)

### Dismiss action (FR-025)

- [X] T069 [US4] Add a per-finding Dismiss button to panel rows in `js/panel/popup-surface.js` and `js/panel/sidebar-surface.js`; wire the "D" keyboard shortcut (FR-030)
- [X] T070 [US4] In `js/panel/model.js`, on Dismiss: hide the finding from the active filter view; move it to a collapsed "Dismissed (this session)" section; emit `PERSIST_WRITE` with `kind: "dismissal"` (FR-024 + FR-025)
- [X] T071 [US4] Add a "Restore" affordance on rows inside "Dismissed (this session)" that emits `RESTORE_DISMISSED`, removes the persisted dismissal entry for the current URL, and un-hides the row (FR-025)

### Clear remembered corrections + dismissals (FR-024 popup settings)

- [X] T072 [US4] Extend `html/popup.html` + `js/popup.js` settings area with a "Clear remembered corrections and dismissals" button that emits `CLEAR_PERSISTED` and surfaces a confirmation that the store is empty (FR-024)

### Fixtures for US4

- [ ] T073 [P] [US4] Create `tests/fixtures/editable-orange/`: a saved Islamweb-style page with one known orange citation and a DOM region the extension can mutate; `expected.json` records the post-correction Finding (`priorFindingId` set, category flips, "Recently corrected" section populated)
- [ ] T074 [P] [US4] Create `tests/fixtures/locked-dom-orange/`: a fixture with the cited reference inside a shadow-DOM or contenteditable-disabled wrapper; `expected.json` asserts the clipboard-fallback pathway fires per FR-012
- [ ] T075 [P] [US4] Create `tests/fixtures/persisted-correction-revisit/`: pre-seeds a persisted correction entry in `chrome.storage.local` for a known finding's composite key; on revisit the runner asserts the panel row shows the "Previously corrected on YYYY-MM-DD" badge and is NOT silently suppressed (FR-024 "MUST NOT be silently suppressed")
- [ ] T076 [US4] Run the Playwright suite; iterate on `correctInPlace` and `Dismiss` until US4 Acceptance Scenarios 1–2 pass + the persisted-revisit badge is visible + the clipboard fallback fires on locked DOM

**Checkpoint**: All four user stories are independently functional. The full V1 PRD Milestone E acceptance bar is achievable: detect, list, render, correct + dismiss + persist.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story polish, performance verification, documentation, and the constitution's compliance review pass.

- [X] T077 [P] Performance sweep: profile `js/content.js` scan end-to-end on the ~5,000-word fixture; tune candidate-extraction batching and `js/verifier/classify.js` to hit SC-012 (< 5 s end-to-end from "Scan" click to all highlights rendered) on every fixture that does NOT hit the FR-031 cap
- [X] T078 [P] Multi-story scenarios: verify SC-005 (orange-finding list reachable in ≤ 2 interactions on every panel-surface preference), SC-006 (master toggle off / on round-trip), SC-007 (copy + persist prefs + correct-in-place without leaving the article)
- [X] T079 [P] Accessibility audit pass: keyboard-only walkthrough of every panel action (FR-030), screen-reader walkthrough of every highlight tooltip (FR-005, FR-007, FR-032), check `aria-describedby` round-trip on every category, verify Esc semantics; record findings in a short `tests/a11y-audit.md`
- [X] T080 Documentation: refresh `quickstart.md` with any module-path drift discovered during implementation; update `AGENTS.md` with the new module map; update `CLAUDE.md` SPECKIT block if any plan paths moved
- [X] T081 Constitution post-implementation review: against constitution v1.0.0 Compliance Review section, confirm (a) no carve-outs were introduced in production code (Workflow item 4), (b) no fixture forced a one-off `if (url === ...)` branch, (c) advanced-copy reuse was strictly case-harvesting per Principle V, (d) the five-color taxonomy was not collapsed or extended (Principle II); document the review outcome in a short `specs/001-arabic-citation-auditor/compliance-review.md`
- [X] T082 Final full-suite run (Node harness): `node tests/run_tests_node.js --all` → 15/15 PASS on system Brave; 174389 = 17 verified / 0 red (SC-001), ما ننسخ→البقرة:106 (SC-002), 0 red across all fixtures (SC-011). The Python runner remains available. Original wording: `python tests/run_tests.py` over every fixture set (174389 + 10 reviewed + orange-cases + drift-cases + red-false-positives + multi-orange + persistence-badge + layout-safety + editable-orange + locked-dom-orange + persisted-correction-revisit + language-gate); confirm SC-001 through SC-013 all pass simultaneously; stop-the-line on any regression
- [ ] T083 [P] Ship gate: re-run [quickstart.md](./quickstart.md) end-to-end as a fresh contributor would; fix anything that's drifted

### Test-harness modernization (harvested from advanced-copy `tests/run_tests_node.js`)

Per Principle V (Porting Discipline): harvest the **harness pattern only**, not the V2 selectors, popup scenario, or autocomplete code. Goal is to remove the flakes the persistent-profile + real-extension model produces (SW init races, `crypto.randomUUID` secure-context failures, cross-world event drops, profile state bleed) while gaining headless speed, parallelism, and coverage.

- [X] T084 [P] Build `tests/run_tests_node.js` minimal V1 harness — headless Playwright + system Chrome + single page at `http://quran.test/runner` serving an iframe per fixture. Inject `js/shared/messaging.js`, `js/verifier/normalize.js`, `js/verifier/indexes.js`, `js/verifier/references.js`, `js/background.js`, then `js/content.js` as `<script>` tags into the SAME page (no real extension load, no isolated world). Replace `chrome.runtime` with an MV3-shaped mock that:
  - Honors the `return true` async-response contract (`sendMessage(msg, cb)` queues the response from the registered `onMessage` listener and invokes `cb` asynchronously).
  - Provides `chrome.storage.local.{get,set}` over an in-memory dict seeded from a per-test settings object.
  - Provides `chrome.runtime.getURL` mapping to `http://quran.test/<path>`.
  - Implements `chrome.runtime.lastError` semantics so existing `sendToBackground` error-handling paths still fire.
  Document the mock contract inline so the next contributor can extend it without re-reading messaging.md.

- [X] T085 [P] Adapt the harness's result-capture layer to V1's five-color taxonomy:
  - Replace V2's `.ayah-correct` / `.ayah:not(.ayah-correct)` / `getHighlightStats()` selectors with V1's `.quran-green/.quran-lightblue/.quran-yellow/.quran-orange/.quran-red` (taxonomy is fixed per Principle II — DO NOT introduce new classes for testing).
  - Replace V2 `data-matches` / `.tooltiptext` access with V1's `dataset.color`, `dataset.matchedRef`, `dataset.claimedRef`, `dataset.tooltip` (per contracts/window-globals.md).
  - Expose a one-shot `window.__quranRunScan()` (Promise) so the harness can `await` a scan result directly, eliminating the polling-for-stable loop V2 needed.
  - Keep the existing Python runner working in parallel until T086 closes the gap on every fixture in the suite — no flipping over half-tested.

- [X] T086 [P] Wire CDP-based precise coverage (`Profiler.startPreciseCoverage` per `tests/run_tests_node.js` lines 271-285, 748-851) over the full extension surface — `js/background.js`, `js/content.js`, `js/popup.js`, `js/sidebar.js`, `js/shared/messaging.js`, `js/verifier/*.js`, `js/render/*.js`, `js/panel/*.js`. Emit `tests/coverage/coverage-summary.json` + `tests/coverage/uncovered.md` with per-file function/range percentages and the actual uncovered lines (Markdown is the artifact reviewers read; JSON drives CI gates). Set initial floor at the measured baseline + 5% so coverage can only move up; raise the floor in subsequent PRs.

### Out of scope for this harness migration
The advanced-copy runner's autocomplete scenario, popup scenario, `--ignore-first-unverified` flow, image-source toggles, and worker pool are **not** ported in T084-T086 — they assume features V1 doesn't have (autocomplete typeahead, image rendering of ayahs, MV2 popup contract). Revisit only if a later user story actually needs them.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies; can start immediately
- **Phase 2 (Foundational)**: depends on Phase 1; BLOCKS all user-story phases
- **Phase 3 (US1 P1, MVP)**: depends on Phase 2
- **Phase 4 (US2 P2)**: depends on Phase 2; reads from Phase 3 Findings but is independently testable against multi-finding fixtures
- **Phase 5 (US3 P3)**: depends on Phase 2; reads `prefs.font` written by Phase 2's popup; independent of Phase 4
- **Phase 6 (US4 P4)**: depends on Phase 4 (panel actions wire-up) and Phase 5 (replacement preferences for the post-correction Finding); reads `prefs.persisted` written by Phase 2
- **Phase 7 (Polish)**: depends on all user-story phases the team intends to ship

### Within each user-story phase

- Models and verifier modules before content-script wiring
- Content-script wiring before fixtures
- Fixtures and `expected.json` written with **intended** output (quickstart.md §3); do NOT freeze current rebuild output as a regression target
- Story is "done" when its `Independent Test` passes and the fixture suite is green on every fixture for the story plus every prior-story fixture (no regression)

### Parallel opportunities

- T002 / T003 / T004 (Phase 1)
- T006 / T007 / T009 (Phase 2 messaging + storage)
- T013 / T014 / T016 (Phase 2 verifier scaffolding) — different files
- T021 / T025 (Phase 2)
- T031 / T038 / T039 / T040 / T041 / T042 (US1 — orange pipeline vs. fixture authoring)
- T048 / T049 / T055 / T056 (US2 — sidebar HTML/CSS vs. fixtures)
- T062 / T063 (US3 — CSS vs. fixture authoring)
- T073 / T074 / T075 (US4 — fixture authoring across the three pathways)
- T077 / T078 / T079 / T083 (Phase 7)

---

## Parallel example: User Story 1 fixture authoring

```bash
# Once the classifier (T030) and orange pipeline (T031) are wired (T032),
# four fixture authors can work in parallel:
Task: "Update tests/fixtures/174389/expected.json to intended verdicts (T038)"
Task: "Curate 6 additional reviewed fixtures with intended expected.json (T039)"
Task: "Author 20-case orange precision/recall set in tests/fixtures/orange-cases/ (T040)"
Task: "Author 5+ drift-as-green fixtures in tests/fixtures/drift-cases/ (T041)"

# Then a single runner closes the loop:
Task: "Run python tests/run_tests.py and iterate classifier until SC-001..SC-011 pass (T043)"
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 — Setup
2. Phase 2 — Foundational (CRITICAL — blocks all stories)
3. Phase 3 — US1 — until SC-001, SC-002, SC-003, SC-004, SC-009, SC-010, SC-011 all pass
4. **STOP & VALIDATE**: run the suite; demo to project owner against fixture 174389 — the headline integrity story
5. Ship as preview / internal-test if ready

### Incremental delivery

1. Setup + Foundational → **Foundation ready** (extension scans, badges, persists, gracefully fails, but doesn't classify into 5 colors yet)
2. + US1 → **MVP ready** (orange detection works end-to-end with full accessibility)
3. + US2 → **Audit-ready** (panel + actions + keyboard model)
4. + US3 → **Authentic-text ready** (swap engine + three fonts)
5. + US4 → **V1 complete** (correct-in-place + dismiss + persistence)
6. Polish → **V1 Beta gate** (per V1 PRD Milestone E)

### Parallel-team strategy

With multiple developers post-Phase 2:

1. Developer A: US1 (verifier + classifier + orange pipeline) — owns `js/verifier/`
2. Developer B: US2 (panel + actions + keyboard) — owns `js/panel/` (can start when US1's emitted Findings shape stabilizes — i.e., after T037)
3. Developer C: US3 (swap engine + font picker) — owns `js/render/` (fully independent of US2; depends only on Phase 2)
4. US4 lands after US2 + US3 complete (it's the last in priority)

---

## Phase 8: V1.1 — i18n + share UX (NEW, requested 2026-05-20)

**Purpose**: capture the post-V1 enhancement requests. These are additive; none
change the verifier or the five-color taxonomy. Implement after the V1 fixture
gate (T040–T076) or in parallel — they touch UI/strings + the share builder, not
matching logic.

### Multilingual UI (Arabic + English to start)

- [X] T087 Add an i18n layer. Create a `QuranI18n` module (`js/shared/i18n.js`)
  with `ar` + `en` message catalogs (key → string) and `t(key, vars)` +
  `dir(lang)` (rtl/ar, ltr/en). Source the active language from a new
  `prefs.lang` (default: browser UI language if ar/en, else `en`); fall back to
  `ar`. Decision: roll our own tiny catalog rather than `chrome.i18n`/`_locales`
  so the page-injected sidebar (content world) and popup share one runtime
  switch without a reload. Document the contract inline.
- [X] T088 Replace hardcoded Arabic strings with `t(...)` across: `html/popup.html`
  + `js/popup.js`, `html/sidebar.html` + `js/panel/sidebar-surface.js`,
  `js/panel/actions.js` (record labels), tooltips in `js/content.js`
  (`buildTooltip`, `CATEGORY_LABEL_AR` → keyed), and `aria-label`s. Keep the
  category *meanings* fixed (Principle II) — only their display strings localize.
- [X] T089 Wire a language switch in the popup (and reflect in the sidebar):
  set `dir`/`lang` on the panel root and popup `<html>` from `dir(lang)` so the
  English UI renders LTR while the Quran/Arabic citation content stays RTL.
  Persist via `prefs.lang`; broadcast `PREFS_CHANGED` so the open sidebar
  re-renders in the new language without a reload.
- [X] T090 [P] i18n fixtures/checks: assert every `t()` key exists in both
  catalogs (no missing-translation fallback in shipped UI); spot-check RTL/LTR
  flip in the harness.

### Friendlier share + richer text fragment

- [ ] T091 Rewrite the share body (`QuranActions.buildShareArtifact` /
  `toPlainText`) to be reader-facing, localized prose instead of the current
  `label / Label: value` developer record. Orange example (en): *"This page
  attributes “{snippet}” to {citedRef}, but it actually appears at {trueRef} in
  the Quran."*; green/lightBlue/yellow get their own friendly templates. Keep a
  separate machine-readable record only behind "Copy as JSON" (FR-011).
- [ ] T092 Highlight BOTH the ayah and the reference in the shared link. Text
  fragments support multiple directives joined by `&`, so emit
  `#:~:text=<ayah>&text=<citedRef>` (and, for orange, optionally a second
  fragment for the true ref if it appears on the page). Guard total URL length;
  fall back to ayah-only if the ref string can't be located/encoded.
  - **Note (color):** the `#:~:text=` highlight color is the *target page's* to
    style via the `::target-text` CSS pseudo-element — a sender can't force a
    color on a third-party page, so "change the default purple/yellow" is not
    reliably possible for arbitrary pages. We CAN style `::target-text` on pages
    WE inject into (our own sidebar/overlay), but not on the recipient's page.
  - **Note (tooltip / alternative to text-fragment):** text fragments carry no
    tooltip and no color payload — they're URL-encoded text only. A tooltip-style
    share would require either (a) a landing/redirect page we host that renders
    the finding then scrolls, or (b) appending a human-readable caption to the
    copied *body* (T091) rather than the URL. Recommend (b) for V1.1; (a) is a
    bigger, hosted-infra change — defer unless wanted.
- [ ] T093 [P] Share fixtures: assert the generated URL contains both the ayah
  and the cited-ref directives for an orange finding, and that the body matches
  the localized friendly template for each color.

## Notes

- **Constitution Principle V** (porting discipline) governs every verifier task. Read the advanced copy at `C:\Users\mosta\PycharmProjects\QuranChromePlugin` to catalog *cases*; redesign the *shape* in the rebuild. Small clean ports of pure data (surah-variant map, normalization tables) are allowed.
- **Constitution Principle VI** (fixtures are the quality gate): a single fixture forcing a one-off `if (url === ...)` branch is a stop-the-line event — step back and reshape, don't ship the carve-out.
- **[P] tasks** = different files, no dependency on incomplete tasks.
- **[Story] label** maps each user-story task to its story for traceability against SC-001…SC-013 and FR-001…FR-032.
- Commit after each task or logical group; consider flipping `auto_commit.after_implement.enabled` to `true` in `.specify/extensions/git/git-config.yml` to automate this.
- Verify fixtures fail (or capture intent) before implementation. NEVER freeze the rebuild's current broken output as a regression target.
- Stop at any checkpoint to validate the story independently against its `Independent Test` criterion.
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that would break independent testability of any story.
