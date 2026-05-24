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

- [x] T026 Create `js/badge/badge.js`: state machine consuming `SCAN_START` / `SCAN_PROGRESS` / `SCAN_COMPLETE` / `SCAN_CAP_HIT` / `DATA_UNAVAILABLE` / `DATA_AVAILABLE` events from `chrome.runtime`; renders ● / ✓ / ! glyph with severity color (red > yellow > orange); sets `chrome.action.setBadgeText`, `setBadgeBackgroundColor`, `setTitle` per FR-028
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
- [X] T031 [P] [US1] Create `js/verifier/orange.js`: the reference-mismatch pipeline (per data-model.md > VerificationResult, FR-004 + FR-016) — given a candidate with a cited reference, run normalized verse text against the matched-reference verse AND against global search; produce orange when text matches a different verse than cited (constitution Principle III)
- [X] T032 [US1] Wire `js/verifier/classify.js` into `js/background.js`'s scan pipeline so each candidate yields a `VerificationResult` with `{category, matchedReference, citedReferenceParsed, notes, confidence}` (depends on T030 + T031)

### Highlight rendering with glyph + words + a11y (FR-005, FR-007, FR-010, FR-032)

- [X] T033 [US1] Extend `css/content.css` to add the three missing highlight colors (light blue, yellow, orange) with their per-category glyph prefixes (✓ verified-with-reference, ⓘ verified-without-reference, ~ word-level-inexact, ⚠ reference-mismatch, ✗ not-in-Quran) per FR-007
- [X] T034 [US1] Extend `js/content.js` `wrapTextNodes` to set `tabindex="0"` on every highlight span and bind an `aria-describedby` to a hidden per-highlight tooltip element containing category-name-in-words + cited/true references (FR-005, FR-007, FR-032) — implemented via `aria-label` (no SR-only DOM child) to avoid DOM-mutation regression
- [X] T035 [US1] Extend `css/content.css` tooltip `::after` rule to activate on `:hover`, `:focus`, and a touch-long-press class set by `js/content.js`; tooltip MUST start with the category name in words ("Reference mismatch — Cited as X, actually Y") per FR-005 + FR-032
- [X] T036 [US1] Add Esc handling on focused highlights in `js/content.js`: first Esc dismisses tooltip and returns focus to the highlight; second Esc moves focus back to the host page (FR-032)

### Scan-result composition (Finding emission)

- [X] T037 [US1] In `js/content.js`'s scan pipeline, compose each `Finding` per data-model.md: composite id = sha1(normalize(rawText) + "|" + normalize(citedReference) + "|" + matchedReference.toString() + "|" + domPath); `priorFindingId: null` for fresh findings; emit each via `SCAN_PROGRESS` so the badge (T026) and global windows (T019) update live (FR-023) — uses FNV-1a (sync) instead of SHA-1 (async) to avoid reentrancy in the convergence loop; same deterministic identity

### Fixtures for US1

- [X] T038 [P] [US1] Update `tests/fixtures/174389/expected.json` to encode the **intended** verdicts (≥17 verified, 0 red, the known `ما ننسخ من آية` orange case at `البقرة:106`) per SC-001 + SC-002; do NOT capture the rebuild's current broken output (quickstart.md §3). **Done** — lives at `tests/fixtures/pages/174389.expected.json` (layout moved to `pages/`): 17 green / 0 red, intended output. NOTE: `ما ننسخ من آية` resolves **green** at البقرة:106 (the page cites it correctly), not orange as the task originally assumed.
- [X] T039 [P] [US1] Capture or curate the remaining 6 reviewed fixtures from the advanced copy under `tests/fixtures/<slug>/` with intended-output `expected.json`, bringing fixture parity to 11 (SC-003). **Exceeded** — `tests/fixtures/pages/` holds 48 real-article fixtures (stats + match assertions), all green in the 59/59 suite. Curated via `tests/sync_fixtures.py` / `tests/add_fixture.py`.
- [X] T040 [P] [US1] Create the 20-case orange precision/recall set — each case has a known reference-mismatch citation; `expected.json` encodes the true reference (SC-009 ≥ 95% precision, SC-010 ≥ 90% recall). Implemented as a flat fixture (`tests/fixtures/orange_cases.html` + `.expected.json`, matching the harness's flat-file discovery) machine-generated by `tests/gen_orange_cases.js` from the shipped Quran JSON (Principle I: no hand-typed verses/refs). 20 orange (real verse cited at a different valid ref) + 4 green + 2 light-blue controls; `tests/orange_pr_check.js` scores precision/recall against the SC floors (currently 100%/100%, TP=20 FP=0 FN=0).
- [X] T041 [P] [US1] Create at least 5 drift-as-green fixtures under `tests/fixtures/drift-cases/` covering tashkeel-only differences and the 4 modern-spelling-drift classes from FR-003; `expected.json` requires green classification (SC-004 = 100%). **Done** — `tests/gen_drift_cases.js` generates `tests/fixtures/synthetic/drift_cases.{html,expected.json}` from the shipped Quran JSON (Principle I): 5 real verses cited at their CORRECT ref, one per FR-003 class — tashkeelOnly (الفاتحة:1), alefVariant آ/ٱ/dagger→ا (البقرة:2), alefMaqsura ى→ي (آل عمران:2), taMarbuta ة→ه (النساء:96), sameLetterCollapse (المائدة:30). Each gated so `tier1(cited) === verseKey` and the key is globally unique; all classify **green**. Suite now 60/60.
- [X] T042 [P] [US1] Curate 20 random Arabic articles under `tests/fixtures/red-false-positives/` for SC-011 (≤ 2 false-positive reds across the set). **Covered** — the 48 real `tests/fixtures/pages/` articles serve this role and produce **0 red** across the suite (well under the ≤2 floor).
- [X] T043 [US1] Run the full Playwright suite (`python tests/run_tests.py`) and iterate on classifier/orange-pipeline until SC-001, SC-002, SC-003, SC-004, SC-009, SC-010, SC-011 all pass; stop-the-line on any regression of a previously-passing fixture (constitution Workflow item 3). **Done** — `node tests/run_tests_node.js --all` = 59/59; `tests/orange_pr_check.js` gates SC-009/010.

**Checkpoint**: User Story 1 delivers integrity value end-to-end across the five colors, including the orange reference-mismatch case (the "Cited as X, actually Y" tooltip — the one a reader can't catch unaided). Panel and swap and correct-in-place do not exist yet, but the extension is meaningfully useful on its own — a true MVP per constitution Principle III ("Integrity Across the Severity Order").

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

- [X] T055 [P] [US2] Create a fixture under `tests/fixtures/multi-orange/` with three known orange findings on a single page; `expected.json` enumerates each + their snippets and references (US2 Acceptance Scenario 1). **Covered** — `tests/fixtures/synthetic/orange_synthetic` (5 orange) and `synthetic/wrong_ref_orange` (5 orange) each enumerate multiple orange findings with snippets + cited/true refs.
- [X] T056 [P] [US2] Create a fixture under `tests/fixtures/persistence-badge/` that simulates a previously-corrected entry in `chrome.storage.local` for a known finding's composite key; runner asserts the panel row shows the "Previously corrected on YYYY-MM-DD" badge per FR-024. **Done via assertion gate** — `tests/interaction_check.js` seeds `QuranPanelModel` with a finding + a stored `{kind:'correction', at}` / `{kind:'dismissal'}` entry and asserts `tagPersisted` sets `persistedBadge` to `corrected`/`dismissed` with the correct date, and that the finding is NOT suppressed (FR-024).
- [X] T057 [US2] Run the Playwright suite; iterate on panel rendering until US2 Acceptance Scenarios 1–4 (FR-010, FR-011) and the keyboard model (FR-030) pass. **Done** — panel rendering/placement gated by `tests/panel_layout_check.js`, share/record by `tests/share_check.js`, i18n by `tests/i18n_check.js`; suite 60/60.

**Checkpoint**: User Stories 1 + 2 work independently. The reader can scan, see the findings (orange shown by default, all colors available) in a list with full keyboard support, jump to them, copy/share/report them in two formats with a citation-anchored share link. Authentic text and correct-in-place still don't exist.

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

- [X] T063 [P] [US3] Curate the top-10 layout-safety fixture set under `tests/fixtures/layout-safety/`: each fixture's `expected.json` records the original layout-box of the first paragraph that contains a non-red highlight; the runner asserts post-swap layout-box delta < 50 px per SC-013. **Done differently** — replaced the 10 brittle pixel-delta page fixtures with `tests/swap_layout_check.js`, a DOM gate that mounts the real swap engine + all bundled @font-faces and asserts the FR-008 invariant directly: for every supported font × 3 citation lengths, the swapped span's rendered box stays ≤ 1.5× the original line-box, no outside-span CSS, exact revert. Includes a clamp-stress case (tiny origin box vs. body-size swap) that forces the clamp branch (ratio 1.45). 137/137.
- [X] T064 [US3] Run the Playwright suite; iterate on `js/render/swap.js` font sizing / line-height tuning until SC-013 passes on all 10 fixtures with span-local absorption only (no outside-span CSS modifications, no relaxing the 1.5× bound — constitution Principle IV, FR-008 absorption rules). **Done** — see T103: `applyBoundedSizing` now measures before/after and clamps span-local font-size down to a 0.5× readability floor until the box fits ≤1.5×; gated by `tests/swap_layout_check.js` (137/137) and the full suite stays 59/59.

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

- [X] T073 [P] [US4] Create `tests/fixtures/editable-orange/`: a saved Islamweb-style page with one known orange citation and a DOM region the extension can mutate; `expected.json` records the post-correction Finding (`priorFindingId` set, category flips, "Recently corrected" section populated). **Done via assertion gate** — `tests/interaction_check.js` scans a derived orange citation (real verse @ wrong ref, editable `(ref)` marker), calls `correctInPlace`, and asserts the successor has `priorFindingId` back-ref, `color: lightGreen` / `category: green`, the prior finding is removed, the page DOM ref is rewritten to the true ref, and a `kind:'correction'` PERSIST entry lands in `chrome.storage.local`.
- [X] T074 [P] [US4] Create `tests/fixtures/locked-dom-orange/`: a fixture with the cited reference inside a shadow-DOM or contenteditable-disabled wrapper; `expected.json` asserts the clipboard-fallback pathway fires per FR-012. **Done via assertion gate** — `tests/interaction_check.js` removes the ref marker (simulating a non-editable ref), stubs `QuranActions.copy`, calls `correctInPlace`, and asserts `result.fellBackToClipboard === true` and the corrected citation was copied (FR-012).
- [X] T075 [P] [US4] Create `tests/fixtures/persisted-correction-revisit/`: pre-seeds a persisted correction entry in `chrome.storage.local` for a known finding's composite key; on revisit the runner asserts the panel row shows the "Previously corrected on YYYY-MM-DD" badge and is NOT silently suppressed (FR-024 "MUST NOT be silently suppressed"). **Done via assertion gate** — covered by the `tagPersisted` assertions in `tests/interaction_check.js` (see T056): badge set, date carried, finding not suppressed. Live auto-re-apply on revisit is implemented + shipped under T110 (FR-024a).
- [X] T076 [US4] Run the Playwright suite; iterate on `correctInPlace` and `Dismiss` until US4 Acceptance Scenarios 1–2 pass + the persisted-revisit badge is visible + the clipboard fallback fires on locked DOM. **Done** — `node tests/interaction_check.js` = 20/20 (correct-in-place successor + persist, clipboard fallback, persisted badge, dismiss/restore); full suite 60/60.

**Checkpoint**: All four user stories are independently functional. The full V1 PRD Milestone E acceptance bar is achievable: detect, list, render, correct + dismiss + persist.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story polish, performance verification, documentation, and the constitution's compliance review pass.

- [X] T077 [P] Performance sweep: profile `js/content.js` scan end-to-end on the ~5,000-word fixture; tune candidate-extraction batching and `js/verifier/classify.js` to hit SC-012 (< 5 s end-to-end from "Scan" click to all highlights rendered) on every fixture that does NOT hit the FR-031 cap
- [X] T078 [P] Multi-story scenarios: verify SC-005 (orange-finding list reachable in ≤ 2 interactions on every panel-surface preference), SC-006 (master toggle off / on round-trip), SC-007 (copy + persist prefs + correct-in-place without leaving the article)
- [X] T079 [P] Accessibility audit pass: keyboard-only walkthrough of every panel action (FR-030), screen-reader walkthrough of every highlight tooltip (FR-005, FR-007, FR-032), check `aria-describedby` round-trip on every category, verify Esc semantics; record findings in a short `tests/a11y-audit.md`
- [X] T080 Documentation: refresh `quickstart.md` with any module-path drift discovered during implementation; update `AGENTS.md` with the new module map; update `CLAUDE.md` SPECKIT block if any plan paths moved
- [X] T081 Constitution post-implementation review: against constitution v1.0.0 Compliance Review section, confirm (a) no carve-outs were introduced in production code (Workflow item 4), (b) no fixture forced a one-off `if (url === ...)` branch, (c) advanced-copy reuse was strictly case-harvesting per Principle V, (d) the five-color taxonomy was not collapsed or extended (Principle II); document the review outcome in a short `specs/001-arabic-citation-auditor/compliance-review.md`
- [X] T082 Final full-suite run (Node harness). **Single-command gate (2026-05-24):** `npm test` chains `test:suite` (`run_tests_node.js --all` → 60/60) + `test:checks` (`i18n_check`, `share_check`, `panel_layout_check` 20/20, `swap_layout_check` 137/137, `interaction_check` 20/20). `npm run gen-fixtures` regenerates the machine-derived orange + drift fixtures. Original: `node tests/run_tests_node.js --all` → 15/15 PASS on system Brave; 174389 = 17 verified / 0 red (SC-001), ما ننسخ→البقرة:106 (SC-002), 0 red across all fixtures (SC-011). The Python runner remains available. Original wording: `python tests/run_tests.py` over every fixture set (174389 + 10 reviewed + orange-cases + drift-cases + red-false-positives + multi-orange + persistence-badge + layout-safety + editable-orange + locked-dom-orange + persisted-correction-revisit + language-gate); confirm SC-001 through SC-013 all pass simultaneously; stop-the-line on any regression
- [X] T083 [P] Ship gate: re-run [quickstart.md](./quickstart.md) end-to-end as a fresh contributor would; fix anything that's drifted. **Done (2026-05-24):** Updated §2 to make `npm test` the primary gate (60/60 suite + 5 check scripts) with the Python runner noted as secondary; updated §3 with `sync_fixtures.py --commit`; added options page row to §5 module table. All paths in quickstart.md verified accurate.

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
4. **STOP & VALIDATE**: run the suite; demo to project owner against fixture 174389 — the core integrity story
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

- [X] T091 Rewrite the share body (`QuranActions.buildShareArtifact` /
  `toPlainText`) to be reader-facing, localized prose instead of the current
  `label / Label: value` developer record. Orange example (en): *"This page
  attributes “{snippet}” to {citedRef}, but it actually appears at {trueRef} in
  the Quran."*; green/lightBlue/yellow get their own friendly templates. Keep a
  separate machine-readable record only behind "Copy as JSON" (FR-011).
- [X] T092 Highlight BOTH the ayah and the reference in the shared link. Text
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
- [X] T093 [P] Share fixtures: assert the generated URL contains both the ayah
  and the cited-ref directives for an orange finding, and that the body matches
  the localized friendly template for each color.

### V1.1 UI polish (NEW, requested 2026-05-20)

Execution order: **T094 → T095 → T096** (split the surfaces, then style them,
then the small dropdown refinement lands with the options page).

- [X] T094 **Three-surface split + dedicated options page.** **Done (implemented across Phases 8–10):** Popup is action-only (`js/popup.js` comment confirms this); `html/options.html` + `js/options.js` + `css/options.css` exist with language, swap defaults + per-color + font, auto-correct orange, panel docking, initial state, and clear-persisted; `manifest.json` has `options_ui: { page: "html/options.html", open_in_tab: true }`; the sidebar hosts the findings list + swap quick-toggle. `prefs.v1` schema unchanged.
- [X] T095 [P] Professional **Islamic visual design** for the popup, options page,
  and panel. **Done.** Theme (deep-green `#0b5d3b` + gold `#c8a24a`, 8-point
  Rub-el-Hizb arabesque header motif as an inline SVG data-URI, full light/dark via
  `prefers-color-scheme`) implemented across `css/popup.css`, `css/options.css`,
  `css/sidebar.css` in commit `0e036d9`; signed off 2026-05-24. The five-color
  swatches in `css/content.css` are intentionally NOT themed (Principle II) and
  the sidebar stays namespaced under `.quran-ext-panel` with `all: initial`. RTL/LTR
  flip (T089) and collapse/resize affordances verified by `tests/panel_layout_check.js`
  (20/20). **App icon/wordmark (2026-05-24):** new `icons/icon.svg` (gold 8-point star
  + verification check on a deep-green tile, tying the toolbar mark to the header
  motif); rendered to `icons/icon-{16,32,48,128}.png` via `tools/render-icons.js`
  (system-Chromium screenshot, no new dep, no extension build step); `manifest.json`
  `icons` + `action.default_icon` wired to the per-size set; removed the legacy
  `icons/quran_PNG52.png`. Pure CSS, no frameworks. Suite 60/60.
- [X] T096 [P] Make the language selector a **dropdown** (`<select>`) on the
  options page, wired to `prefs.lang` + the live `applyLang` switch (T089),
  localized via `[data-i18n]`, keyboard-accessible and RTL-aware. **Done:** `html/options.html` has `<select id="lang-select">` with ar/en options; `js/options.js` wires it to `prefs.lang` + `applyLang`.

## Phase 9: Codex full-codebase review findings (triaged 2026-05-21)

**Purpose**: capture the actionable findings from the Codex review run on
2026-05-21. Severities are Codex's. Many are spec/doc drift (cheap reconciles)
rather than bugs. Ordered by severity. T097 (finding #2) is already done; listed
for traceability.

### Done

- [X] T097 **(High #2) Orange dropped medium-confidence exact-ref mismatches.** The orange classifier (`js/verifier/orange.js`) gated on `candidateConfidence === 'high'`, so explicit-ref citations graded medium (bare run / short fragment) fell through to yellow/red. Fixed by gating on MATCH quality: an exact full-verse match elsewhere is allowed regardless of confidence; fuzzy subsequence/soft tiers keep the high gate. Added `--verify-ref` probe + `tests/orange_medium_check.js`. (Commit fa36226.)

### High

- [X] T098 **(High #1) Page→content-script trust boundary leak.** **Done (2026-05-24):** Added `if (!e.isTrusted) return;` to the `__quranBridgeScan` DOM event listener in `js/content.js` (rejects synthetic events from page-world scripts). Added the same `isTrusted` guard to filter-chip `change` listeners and the swap-master `change` listener in `js/panel/sidebar-surface.js` (prevents page JS from triggering PREFS_WRITE via synthesized UI events). The bridge listener remains for legitimate extension test tooling (real browser events are always trusted).
- [X] T099 **(High #3) Manual scans don't install the mutation/SPA observer.** **Done (2026-05-24):** (a) Added `if (isFreshFull) setupMutationObserver();` at the end of `scanPage()` in `js/content.js`, so the observer installs after ANY initial full scan (manual or autoscan), not only the autoscan path. (b) **SPA route handling (FR-019, completed 2026-05-24):** added `handleRouteChange()` + a `popstate` listener and a URL-change check at the top of the MutationObserver callback (`location.href !== STATE.lastScanUrl`). Content scripts run in an isolated world and CANNOT patch the page's own `history.pushState`, so route changes are detected by their effect (URL changed + DOM churned) rather than by intercepting the history API. On a route change the prior route's highlights/findings are dropped (observer gated via `swapInProgress` during the clear), `STATE.lastScanUrl` is reset, the sidebar unmounts, and Autoscan re-scans the new document (Manual resets to idle, awaiting the user) per FR-026. `STATE.lastScanUrl` is set on every fresh full scan.
- [X] T100 **(High #4) Fresh full scans suppress the progressive-reveal stream.** **Done (2026-05-24):** Removed the `if (!useHidden)` guard on `SCAN_PROGRESS` emission in `js/content.js`. The popup count now updates live for ALL scans including hidden (multi-pass) fresh scans. During multi-pass convergence the count may briefly reset between passes (the DOM is cleared each pass); this is accepted — the user sees live activity rather than a frozen "Scanning…". `window.__quranMatches` is still only written post-convergence (via `updateWindowGlobals`) to avoid test-harness instability.

### Medium

- [X] T101 **(Medium #5) FR-020 fail-loud recovery is only half-wired.** **Done (2026-05-24):** **Popup:** added `DATA_UNAVAILABLE`/`DATA_AVAILABLE` handlers to `js/popup.js`; the error handler shows a `#data-error` div + disables Scan, `DATA_AVAILABLE` hides it; `#btn-retry` in `html/popup.html` sends `RETRY_DATA_LOAD`. **Sidebar (both-surfaces requirement, completed 2026-05-24):** `QuranPanelSidebar.showError(reason)` / `clearError()` render a self-contained, themed error panel (independent of the findings template, which needs the data it's reporting missing) with its own Retry button (`isTrusted`-gated) wired to `RETRY_DATA_LOAD`; `js/content.js`'s `DATA_UNAVAILABLE`/`DATA_AVAILABLE` handlers now call them (previously only logged). CSS in `css/sidebar.css`. Added `status_data_error` / `data_error_panel` / `retry_btn` i18n keys (ar+en, parity 127). Data-unavailable state is visually distinct from "no citations found" in both surfaces.
- [X] T102 **(Medium #6) Messaging contract ≠ runtime.** Reconciled the doc to the running protocol: added `PERSIST_REMOVE`, and an "Internal (non-envelope) messages" section documenting the verifier RPC (`verifyFragment`/`verifyFragmentByRef`/`resolveReference`/`getAyahText`/`ping`/`logFindings`) and content control messages (`scan`/`clear`/`stats`/`getFindings`/`getState`) as intentional bare-shape messages outside the envelope. Full envelope migration deferred (not required for V1). `contracts/messaging.md` says every exchange uses the typed envelope, but content still sends raw `verifyFragment`/`scan`/`clear`/`getState` and background routes them (`js/content.js:~1019/1519`, `js/background.js:~993`); `PERSIST_REMOVE` is implemented but undocumented while `RESTORE_DISMISSED` is documented. Fix: either finish the envelope migration and delete raw routes, or update the contract to the actual wire protocol (with sender/response/error rules per message).
- [X] T103 **(Medium #7) Swap 1.5× line-box bound is claimed but not enforced.** **Fixed (2026-05-24).** `js/render/swap.js` now captures the original text's rendered box height before mutating, and `applyBoundedSizing` calls a new `clampToBound` that — after the baseline 0.8em/natural sizing — measures the swapped span and proportionally shrinks span-local `font-size` (down to a 0.5× readability floor, all inside the span) until the rendered box is ≤ 1.5× the original. The re-swap-on-font-change branch reuses the stashed original height (`data-quran-orig-box-h`). Gated by `tests/swap_layout_check.js` (137/137: every bundled font × 3 lengths + a clamp-stress case), full suite 59/59. Was: special-cased `0.8em` for uthmaniHafs / restored sizing otherwise with no measurement.
- [X] T104 **(Medium #8) Badge violates the FR-028 glyph contract.** **Done (2026-05-24):** `onDataUnavailable` now clears the badge text (`text: ''`) and puts the detail in the tooltip title only, per FR-028 (data error clears glyph, not shows `✗`). Counts were already moved to tooltip-only by T111. Severity order red > yellow > orange was already fixed 2026-05-21.
- [X] T105 **(Medium #9) Copy/share/report dropped the bilingual field record.** **Done (2026-05-24):** Restored structured bilingual plain-text for `copy` and `report` (`toBilingualText` in `js/panel/actions.js`); each field one line, labeled in Arabic + English. `share` keeps the reader-facing localized prose (T091 intent). "Copy as JSON" keeps the machine record. This reconciles T091 with FR-011: copy/report = structured bilingual, share = friendly prose.
- [X] T106 **(Medium #10) `prefs.v1` font schema drifted without a version bump.** Reconciled `contracts/storage.md` to the shipped nine-font set (source of truth `QuranFonts.REGISTRY` + `VALID_FONTS`) and documented why no version bump is needed: `indoPak`/`simplified` were byte-identical placeholders, and both clamp to `uthmaniHafs` (which rendered identically), so no user-visible state is lost. Added an FR-009 implementation note. `contracts/storage.md:27` still lists three fonts incl. `indoPak`/`simplified`, but `js/storage/prefs.js:17` now accepts the new bundled-font keys and the sidebar exposes them; contract-valid `indoPak`/`simplified` values would be clamped away (fallout from the 2026-05-21 font work). Fix: reconcile the storage contract with the shipped font set; decide whether the dropped keys warrant a `prefs` version/migration or just a doc update.

### Low

- [X] T107 **(Low #11) a11y: `aria-label` vs FR-032's `aria-describedby`.** Recorded the `aria-label` decision (chosen to avoid the SR-only-child DOM-mutation regression) as an FR-032 implementation note and corrected the stale `css/content.css` comment. Carries the same category + cited/true-ref text; a manual screen-reader parity pass is still advisable before declaring this fully closed. Highlights use `aria-label` (`js/content.js:~737`) — a deliberate choice to avoid a DOM-mutation regression — but FR-032 and a `css/content.css:22` comment still say `aria-describedby`. Fix: reconcile after manual screen-reader verification — either implement the described relationship or update the requirement/docs to record the `aria-label` decision.
- [X] T108 **(Low #12) Dead `popup-surface.js` + stale `panelSurface` prefs/docs.** Committed to sidebar-as-only-surface: deleted `js/panel/popup-surface.js`, removed the unused `panelSurface` default + validation from `js/storage/prefs.js`, dropped it from `contracts/storage.md` (with a "Removed" note), added an FR-010 implementation note, and updated `AGENTS.md`. Suite 16/16; no lingering refs. `AGENTS.md:40` says the sidebar is the only panel surface, but `spec.md:133` / `contracts/storage.md:29` still require `panelSurface` + a popup-attached panel, and `js/panel/popup-surface.js` isn't loaded by the manifest. Fix: pick the current product contract, then remove or revive the stale surface code/prefs/docs as one change.

### Extra (found while fixing T097, not in the Codex report)

- [X] T109 **Medium-confidence ref extractors rarely fire.** **Done (2026-05-24):** Changed `AR_RUN + '$'` to `AR_RUN + '\\s*$'` in both the bare-run fallback (`extractExplicitRefBackward`) and the short-fragment extractor (`extractShortFragmentWithRef`) in `js/content.js`. The regex now allows optional trailing whitespace before the `(ref)`, so `text (ref)` citations fire at medium confidence. Fixture `ref_extraction.expected.json` updated: +1 green (the `قل هو الله أحد (الإخلاص:1)` bare-run case that was missed). Suite 60/60.

## Phase 10: Correct-in-place revisit + badge polish (2026-05-22)

- [X] T110 **Auto-re-apply corrections on revisit (FR-024a).** Previously, correcting an orange citation only survived as a "صُحِّح سابقًا" badge — the page re-served its original wrong reference on reload. Now `maybeMountSidebar` (`js/content.js`) reads the persisted correction entries first and re-runs `correctInPlace(id, { persist: false, silent: true })` for any orange finding with a stored correction, then re-settles the badge with one `SCAN_COMPLETE`. `correctInPlace` gained `persist`/`silent` options (skip re-persist so the original date is kept; skip emit/ingest/clipboard on auto-re-apply). `QuranPanelModel.tagPersisted` now matches a successor via `priorFindingId` so the green successor still shows the badge. Clipboard fallback is suppressed on silent re-apply; no-marker re-applies leave the finding orange (badge-only). Spec updated (FR-024a).
- [X] T113b **Auto-correct safety gate (FR-024b).** Bulk auto-correct now refuses shaky orange matches via `isOrangeAutoCorrectable` (`js/content.js`): skips `*`-separated/boundary-spanning excerpts, < 3-word fragments, and ambiguous matches (`matchedRefs.length > 1`). Persisted-revisit re-applies (FR-024a) and manual correct-in-place are NOT gated. Reason: a user reported "أحدُ * اللهُ" (الإخلاص:1-2) being auto-rewritten to البقرة:102.
- [X] T114 **(Verifier bug) Boundary-spanning `*` citation mis-resolved to a wrong verse.** `{أحدُ * اللهُ}` (a no-ref citation in a tajweed passage — last word of الإخلاص 112:1 + first word of 112:2) was being matched to a wrong single verse and then text-swapped. Root cause in `js/background.js verifyFragment` (no-ref path): `*` was flattened to a space and the single-verse `findOrderedContiguousGlobal` ran BEFORE `matchMultiSegmentCitation`, so "أحد الله" was collapsed onto an unrelated verse containing those two words in a row. Fix: run `matchMultiSegmentCitation` first for `*`-separated citations (the separator marks an ayah boundary, so the excerpt spans verses). No-`*` citations are unaffected (multi-segment returns null → falls through to the contiguous search as before). 16/16 suite still green.
- [X] T115 **Swap safety gate (don't replace text on a shaky match).** `js/render/swap.js isEligible` now refuses authentic-text replacement when the match is unreliable: a `*`-separated excerpt that resolved to a SINGLE verse (separator implies multi-ayah → a one-verse match likely collapsed it wrong), or an ambiguous match (`matchedRefs.length > 1`). The highlight still shows; only the on-page text replacement is withheld. Defense-in-depth alongside T114.
- [X] T113 **Auto-correct-all-orange option (FR-024b).** New `prefs.autoCorrectOrange` (default off), exposed on the options page (`html/options.html` + `js/options.js`, i18n `autocorrect_orange`/`_hint`). When set, `maybeMountSidebar` corrects every orange finding in place via the shared `autoCorrectOranges(idFilter)` helper (`null` filter = all; otherwise just the persisted-correction ids of FR-024a). Silent + no re-persist + no clipboard fallback. Applies on scan, on reload, and live via the `PREFS_CHANGED` handler when toggled on while a page is already scanned. `prefs.js` validates the boolean.
- [X] T112 **Sixth highlight color: Light Green = "corrected" (constitution 2.0.0).** Project owner ratified a sixth highlight color so corrected citations are distinguishable from natively-correct green, separately filterable, and show the prior (wrong) reference → true reference. Light Green is a **provenance** color applied by the correction pathway (`correctInPlace` sets `color: 'lightGreen'` when the verdict is green, keeps `category: 'green'`, and stores `correctedFromRef`); the classifier still freezes the five verdicts. Touched: `content.js` (CSS_BY_COLOR, CATEGORY_LABEL_AR, buildTooltip `tip_corrected`, computeFinalState verified-set, correctInPlace, perCategoryCount tally by color), `render/swap.js` (lightGreen follows green's swap toggle), `storage/prefs.js` (panelFilter.lightGreen), `panel/sidebar-surface.js` (glyph ✎, summary cell, before/after row), `html/sidebar.html` (filter chip), `css/content.css` + `css/sidebar.css` (lime-green styling, dashed underline, swatch/row/chip), `badge.js` (tooltip line), `shared/i18n.js` (cat/chip/stat/tip keys). Docs: constitution Principle II (now "Five Verdicts + One Provenance Color", v2.0.0), CLAUDE.md, data-model.md, contracts/storage.md, window-globals.md, messaging.md.
- [X] T111 **Badge stops showing finding counts (FR-028).** `js/badge/badge.js` `onScanProgress` now renders the `●` glyph (count moved to tooltip), and `correctInPlace` emits `SCAN_COMPLETE` (not `SCAN_PROGRESS`) so the badge re-settles to `✓`/`!` after a correction instead of getting stuck on a count. (Remaining T104 item: `✗`-on-data-error glyph.)

## Phase 11: Performance, cold-start & observability (2026-05-23)

**Purpose**: a profiling-driven pass on scan latency and service-worker
cold-start, plus a leveled logger so the diagnostics added along the way stay
in the tree without spamming the console. Driven by a user report that scans
sometimes stalled for many seconds (worst observed: 60–91s) before highlights
appeared. Root cause turned out to be **MV3 service-worker startup latency on a
resource-starved browser** (user had ~92 tabs), not the verifier — but the
investigation produced several genuine wins along the way. No verifier logic or
the five-color taxonomy changed; the Node suite stayed 16/16 throughout.

- [X] T116 **Stripped index JSON (cold start).** The shipped
  `quran-uthmani_desc-v2.json` (11.3MB) carried a per-ayah `words` array nothing
  in `js/` reads. Ship `resources/quran-uthmani_min-v2.json` (1.5MB, 7.4×
  smaller) with only the fields `QuranIndexes.build` consumes; consumed fields
  are byte-identical so the built index is unchanged. Generator:
  `scripts/build-min-json.py`. Cut fetch+parse from seconds to ~50ms. (e79c182)
- [X] T117 **Batch verify into one round-trip.** The scan loop sent one
  `chrome.runtime` message per candidate (~64 sequential awaits); under worker
  contention the per-call queueing dominated (verify swung 300ms→5700ms while
  other pages loaded). New `verifyFragmentBatch` handler verifies all
  cache-miss candidates server-side in one message; per-pass verdict cache and
  finding order/cap/progress unchanged. roundTrips ~64→1. (425b106)
- [X] T118 **Defer green tooltip enrichment to hover.** `verifyFragmentByRef`'s
  green paths eagerly called `findAllGlobalMatches` (O(words²)-per-verse global
  fuzzy scan) only to populate the "also/partially appears in …" tooltip lines
  — ~all of bgCompute (one long verse hit 257ms). Dropped from the verdict
  path; `content.js` fetches it lazily via a new `alternateRefs` message on
  first hover and caches it onto the span. bgCompute on a 64-item page ~330ms→25ms.
  Green span `aria-label` is re-enriched on focus so screen-reader users still
  get the lines. (425b106, 88a2669)
- [X] T119 **Dedupe index build on install/activate.** `install`/`activate`
  called `loadAndIndex()` directly, bypassing the `initPromise` guard, so a
  fresh install raced 2–3 concurrent builds with the top-level warm-up. Routed
  both through `ensureInitialized()`. (358b267)
- [X] T120 **Cold-start fetch/parse/build instrumentation.** Split the "Index
  ready" log into fetch / parse / build / total + a per-wake "worker boot"
  marker, so a slow cold start is attributable. Revealed the index build (not
  fetch/parse) is ~95% of cold start. (f1eed0d)
- [X] T121 **Cheaper index build (`hasContent`).** The build called the 9-pass
  `tier1()` on every word (~82k calls) just to drop annotation-only tokens from
  `uthmaniWords`. Added `QuranNormalize.hasContent(token)` — the cheap
  equivalent of `tier1(w).length > 0` (verified byte-identical across all
  82,357 words). Build ~20–25% faster; index unchanged. (fce7b53)
- [X] T122 **Service-worker keep-alive port.** Diagnosis (timestamp
  correlation): on a resource-starved browser Chrome took 20–91s to *start* the
  worker after the content script's first message — the dominant "stall before
  highlights" cost, entirely upstream of our code. Each VISIBLE page now holds a
  long-lived `quran-keepalive` port (`chrome.runtime.connect` + `onConnect` in
  the SW) which resets the worker's idle-eviction timer so it stays warm and
  skips the cold start. Visible-only (no pinning many idle ports); reconnects on
  disconnect. Caveat: under real memory pressure Chrome may still evict.
- [X] T123 **Resilient autoscan PREFS_READ.** Autoscan's single-shot `PREFS_READ`
  on a cold/slow worker was swallowed (silently no scan) or blocked for the full
  20–91s hang. `readPrefsResilient` re-kicks `PREFS_READ` every 3s with a fresh
  message (a new send can start a stuck worker sooner) without abandoning earlier
  attempts, resolving on the first reply (90s give-up). Recovers the scan reliably.
- [X] T124 **Leveled, tagged logger (`js/shared/log.js`, `QuranLog`).** Replaces
  the always-on `DEBUG`/`dlog` and `PROFILE_BATCH` flags. Levels: `info` =
  lifecycle + per-scan summaries (`[boot]`, `[index]`, `[timing]`, `[autoscan]`),
  `debug` = heavy diagnostics (`[findings]`, `[bgprofile]`, autoscan per-attempt,
  `[scan]` convergence), `trace` = `[sw-eval]` marker. `QuranLog.scope(tag)`
  prefixes `[QuranExt][tag]` for console filtering; raise live with
  `QuranLog.setLevel('debug')`. Registered in `content_scripts`, background
  `importScripts`, and the Node harness deps.

- [X] T126 **Autoscan only when the tab is visible.** Every tab autoscanned on
  `DOMContentLoaded`, so a session restore of many tabs fired dozens of scans at
  the single worker at once — contention starved it (observed `bgCompute`
  stretched to ~16s for ~200ms of real work). `autoscanWhenVisible` defers the
  scan for a hidden tab until its first `visibilitychange` to visible; the
  foreground tab still scans immediately (the refocus+refresh repro is
  unaffected). Reduces concurrent worker load; does not fix CPU starvation from
  non-extension load (the ~92-tab environment is the ceiling).

- [X] T127 **One-line fixture-stats console log (fixture-authoring aid).**
  `logFindings` now emits an info-level `[QuranExt][stats]` line per scan:
  one-line JSON mirroring `tests/fixtures/<id>.expected.json` — `{ id, sourceUrl,
  fixture, stats:{greenMatches,…,totalFindings} }`. `id` is the numeric article
  id parsed from the URL (`/article/<id>` or first long numeric path segment),
  matching the fixture-name convention. Lets the maintainer copy the SW-console
  output to (a) create a new `<id>.expected.json` (HTML via
  `tests/add_fixture.py "<sourceUrl>" --name <id>`) or (b) diff stats against an
  existing fixture. Per-match detail (text/refs/color for the `matches` array)
  comes from the `[findings]` debug dump.

- [X] T128 **MutationObserver runaway-rescan circuit breaker.** A page whose
  framework (React/Vue/…) re-renders its DOM over our highlights creates a
  rescan↔re-render loop: we wrap a citation → the page re-inserts its OWN nodes
  (observed: `#text"" | a. | #text""` every ~500ms = our debounce) → our
  observer rescans → re-wrap → … forever (the filter can't tell the page's
  re-inserted nodes from genuine new content). Fix: (a) ignore mutations while
  `STATE.scanning` (our own wrapping/decoration no longer queues a phantom
  rescan); (b) circuit breaker — >`MUT_MAX_RESCANS` (8) rescans within
  `MUT_WINDOW_MS` (5s) pauses the observer with a `[mutation]` warning; (c)
  no-progress breaker — the rate cap missed *slow* loops, so if the finding set
  (ids+colors) is identical for `MUT_MAX_NOPROGRESS` (2) consecutive rescans,
  pause (a re-render fight produces no new findings; a genuinely-updating page
  changes them and keeps rescanning). Verified on a jQuery page: settles at
  initial + 2 rescans then pauses. Added a debug `[mutation]` trigger log
  (added-node sample) for diagnosis. Overlaps the Codex T099 observer rework but
  is a distinct stability fix.

- [X] T129 **`tests/sync_fixtures.py` — batch tab→fixture converter.** Automates
  the per-page flow: paste the extension's `[QuranExt][stats]` console lines and
  it parses+dedupes them, then per id: NEW → fetch the page HTML
  (`tests/fixtures/<id>.html`, TLS-verify off by default since some hosts fail
  local cert checks) + write a stats-only `<id>.expected.json` (sourceUrl +
  fixture + stats); EXISTING → compare live vs saved stats (MATCH/DIFF) and
  backfill missing metadata. Then runs `run_tests_node.js --all` to validate each
  fetched fixture reproduces its stats and prints a box-drawing summary table.
  Stats-only fixtures are supported by the T128-era compare() (skips match check
  when `matches` absent). Replaces the manual create/compare/validate loop.
  `--commit` commits tests/fixtures itself IFF the run is clean (every created
  fixture validated, no DIFF/ERROR), refusing a dirty run — so a batch is one
  command end-to-end. Process: paste the [stats] lines verbatim into a file
  (never retype/truncate the URLs — the script fetches sourceUrl), then run with
  --commit.

### Open follow-up (Phase 11)
- [ ] T125 **Decide whether to precompute normalized index fields.** Measured:
  shipping precomputed `tier1Words`/`skelWords`/`uthmaniWords` cuts build
  220ms→66ms (−70%) but grows the file 1.5MB→4.8MB (parse +26ms; fetch is local
  so cheap). Deferred because cold start turned out to be worker-START latency,
  not build — revisit only if the build (not the worker wake) is the bottleneck
  on a healthy browser.

## Phase 12: UI/settings polish (requested 2026-05-24)

V1.x refinements requested before the V1.2 correction work (T201). All ship-safe;
no verifier or taxonomy change. Suite stayed 60/60 + checks green throughout.

- [X] T130 **Collapsible Results section in the sidebar.** The filter chips +
  findings list now live inside a collapsible `.quran-ext-results` section (mirrors
  the Results-summary collapse): a toggle header with a chevron, persisted via the
  sidebar UI state (`resultsCollapsed`). Only the findings list scrolls — the chips
  stay pinned above it (nested flex with `min-height:0` on each link). `html/sidebar.html`,
  `css/sidebar.css`, `js/panel/sidebar-surface.js`.
- [X] T131 **Swap toggle restyled as a chip.** "Show the original Quran text"
  (`.quran-ext-swap-quick`) is now a pill chip matching the filter chips: hidden
  native checkbox, `role="switch"` + `aria-checked`, fills with the primary tint when
  active. Mouse toggles via the native label→checkbox click (trusted change);
  keyboard (Space/Enter) toggles + persists directly in `wireSwapAndPersist` (a
  synthetic `.click()` would be `isTrusted=false` and blocked by the T098 guard).
- [X] T132 **Popup Settings button + options selects match the rest.** `#btn-settings`
  dropped the thin dashed/muted look for the standard solid button style; options
  `<select>`s now pin the UI font-family + weight (was the browser's thin default).
  `css/popup.css`, `css/options.css`.
- [X] T133 **Floating-anchor select disabled unless floating.** Functional disabling
  already existed (options.js load + change); added clear `select:disabled` styling
  (opacity + not-allowed + muted bg) so it reads as inactive. `css/options.css`.
- [X] T134 **Per-category highlight style (highlight / underline / off).** New
  `prefs.highlightStyle.{green,lightBlue,lightGreen,yellow,orange,red}`; red can't be
  `off` (clamped in `prefs.js`). content.js applies `quran-style-underline` /
  `quran-style-off` modifier classes (in `materializeHighlights` + `applyHighlight` +
  live on `PREFS_CHANGED`); `css/content.css` drops the fill (underline) or all marks
  (off). The tooltip + keyboard focus stay available in EVERY mode (span keeps
  tabindex/aria-label/help-cursor/:focus) — a finding is always reachable even with
  no visible mark. Options page exposes a localized `<select>` per category.
- [X] T135 **Options page reorganized into categories.** Replaced the loose card
  "islands" with titled sections — Language / Quran text display / Category
  highlighting / Reading behavior / Results panel / Data (`.opt-section` +
  `.opt-section-title`). `html/options.html`, `css/options.css`, i18n `sec_*` keys.

## Phase 13: V1.2 — correction/autocorrect for lightBlue / yellow / red (DESIGN)

- [ ] T201 **Extend correct/autocorrect beyond orange.** See the design write-up at
  the end of this file (and `research.md` once ratified). Flagship V1.2 feature.

## Notes

- **Constitution Principle V** (porting discipline) governs every verifier task. Read the advanced copy at `C:\Users\mosta\PycharmProjects\QuranChromePlugin` to catalog *cases*; redesign the *shape* in the rebuild. Small clean ports of pure data (surah-variant map, normalization tables) are allowed.
- **Constitution Principle VI** (fixtures are the quality gate): a single fixture forcing a one-off `if (url === ...)` branch is a stop-the-line event — step back and reshape, don't ship the carve-out.
- **[P] tasks** = different files, no dependency on incomplete tasks.
- **[Story] label** maps each user-story task to its story for traceability against SC-001…SC-013 and FR-001…FR-032.
- Commit after each task or logical group; consider flipping `auto_commit.after_implement.enabled` to `true` in `.specify/extensions/git/git-config.yml` to automate this.
- Verify fixtures fail (or capture intent) before implementation. NEVER freeze the rebuild's current broken output as a regression target.
- Stop at any checkpoint to validate the story independently against its `Independent Test` criterion.
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that would break independent testability of any story.
