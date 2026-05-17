# Implementation Plan: Arabic Quran Citation Auditor (V1)

**Branch**: `main` (feature work targeted at `001-arabic-citation-auditor`) | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-arabic-citation-auditor/spec.md` (32 FRs, 13 SCs, 20 clarifications across 4 sessions)

## Summary

Reader-side Chromium MV3 extension that scans Arabic web pages, classifies each detected Quran citation into the fixed five-color taxonomy (green / light blue / yellow / orange / red), surfaces reference-mismatch (orange) findings in a panel with two surfaces (popup-attached default, page-injected sidebar), replaces verified spans with authentic Quran text in three user-selectable fonts, and lets the user act on findings (jump, copy, share via Chrome text-fragment URL, report, correct-in-place, dismiss). All work is local-only (no network after install). The technical approach extends the existing vanilla-JS MV3 codebase (`js/background.js`, `js/content.js`, `js/popup.js`) by adding three categories that don't exist today (yellow, light blue, orange), a swap engine, a findings panel with two surfaces, a persisted preferences + per-URL TTL store, and a stateful action badge — all under the constitution's porting discipline (harvest *cases* from the advanced copy at `..\QuranChromePlugin`, not implementation).

## Technical Context

**Language/Version**: Vanilla JavaScript (ES2022), no transpiler, no build step.

**Primary Dependencies**: Chromium Manifest V3 APIs (`chrome.runtime`, `chrome.storage.local`, `chrome.action`, `chrome.scripting`, `chrome.tabs`), browser-native `MutationObserver`, `TreeWalker`, `Intl.Segmenter` for Arabic word boundaries where useful. No third-party JS/CSS frameworks.

**Storage**: `chrome.storage.local` for (a) user preferences (master + per-color replacement toggles, font choice, scan-trigger mode, panel surface, panel filter selection) and (b) per-URL persisted corrections/dismissals with 30-day TTL (FR-024). No `chrome.storage.sync` in V1 (size limits + cross-profile semantics not needed). No `IndexedDB` (per constitution: Quran index is rebuilt on each service worker activation from the local JSON, ~50–100 ms).

**Testing**: Playwright via the existing `tests/run_tests.py` runner that drives the real extension JS against saved HTML fixtures; results read off `window.__quranScan`, `window.__quranStats`, `window.__quranMatches`. New fixtures added per the V1 PRD (5 → 11 parity, plus a hand-curated 20-case orange precision/recall set for SC-009/SC-010 and a top-10 layout-safety set for SC-013).

**Target Platform**: Chrome and other Chromium-based browsers (Edge, Brave, Arc, Opera) with Manifest V3. Firefox and Safari out of V1 scope.

**Project Type**: Browser extension — MV3 service worker (background) + content script (per-frame, `<all_urls>`) + popup + page-injected sidebar.

**Performance Goals**:
- SC-012: full scan of ~5,000-word typical Islamweb article in < 5 s end-to-end (Scan click → all highlights rendered) — unchanged by FR-023 progressive reveal.
- FR-019: incremental re-scan of mutated subtrees only, with ~500 ms debounce.
- Service worker index rebuild: ~50–100 ms on activation (per constitution).
- FR-031: hard cap 500 findings per scan; manual "Continue scanning" lifts the cap on the current page only.

**Constraints**:
- Local-only after install (FR-013): no network calls for Quran data, verification, fonts, or rendering.
- Vanilla JS, no build step (constitution).
- Five-color taxonomy is fixed (constitution principle II): no collapsing, relabeling, or extending.
- Authentic-text replacement scope is span-local: line-box ≤ 1.5× original; no CSS outside the highlighted span may be modified (FR-008 + SC-013).
- 30-day TTL for per-URL persisted state (FR-024); preferences persist indefinitely.
- All five categories MUST carry an icon glyph + category-name word alongside color (FR-005, FR-007, FR-010, FR-028) — no color-only signaling anywhere.
- All highlights MUST be keyboard-focusable (`tabindex="0"`, FR-032) with hover + focus + long-press tooltip activation and `aria-describedby` for screen readers.

**Scale/Scope**:
- 32 functional requirements (FR-001 through FR-032), 13 measurable success criteria, 5 key entities, 4 user stories (P1–P4 prioritized), 8 edge cases.
- Reference fixture: ≥17 verified matches and 0 red on fixture 174389 (currently 6/16 in the rebuild baseline per research.md).
- Bundle size: 3 Quran fonts (Uthmanic Hafs default + Indo-Pak + simplified) — must fit comfortably under Chrome Web Store 100 MB cap; expected total bundle (Quran JSON + 3 fonts + icons + JS/CSS/HTML) well under 50 MB.

## Constitution Check

*GATE: Must pass before Phase 0 research and again after Phase 1 design.*

### Pre-design check (against constitution v1.0.0)

| Principle | Spec coverage | Status |
|---|---|---|
| I. Integrity Is the Only North Star | Every FR/SC is in service of reader-side audit. Authentic-text replacement (FR-008) and orange detection (FR-004/FR-005) carry the integrity mission directly. Writer-side assist explicitly deferred (Users & Personas Researcher/Editor V2+). | ✅ Pass |
| II. Five-Color Taxonomy Is Fixed | FR-002 names exactly the five categories with the canonical meanings. No FR adds a sixth color or remaps an existing one. FR-003 enshrines drift-as-green (the constitution's anti-downgrade rule). | ✅ Pass |
| III. Orange Is the Product's Flagship Signal | FR-004/FR-005/FR-016 define orange; FR-010 makes orange the default panel filter; FR-028 lists orange first in defect-severity ordering for the badge. SC-002, SC-005, SC-009, SC-010 are orange-specific quality bars. | ✅ Pass |
| IV. Authentic-Text Replacement Is the Default Render | FR-008 says default-on; FR-009 confirms all four non-red defaults are ON at first install; FR-015 keeps red exempt. SC-006, SC-013 measure the replacement's correctness and layout safety. | ✅ Pass |
| V. Porting Discipline From the Advanced Copy | Plan explicitly designs new modules (verifier expansion for orange/yellow/blue, swap engine, panel, storage) rather than copying. Existing research.md section 3 ("Cross-Reference Operational Discipline") encodes the discipline. | ✅ Pass |
| VI. Fixtures Are the Quality Gate | SC-001 (fixture 174389 parity), SC-003 (no regression on 11 reviewed fixtures), SC-009/SC-010 (new 20-case orange set), SC-011 (20 random articles), SC-013 (top-10 layout-safety set). | ✅ Pass |

### Tech constraints alignment

| Constraint | Plan compliance | Status |
|---|---|---|
| MV3 only | Manifest already MV3; no plan to move off | ✅ Pass |
| Vanilla JS, no build step | Plan extends existing vanilla JS; no bundler, no framework | ✅ Pass |
| Service worker index rebuild ~50–100 ms | Plan retains the on-activation rebuild; no `IndexedDB` introduced | ✅ Pass |
| `chrome.runtime.onMessage` handlers `return true` | All new async handlers will conform | ✅ Pass |
| Single Quran JSON authoritative | `resources/quran-uthmani_desc-v2.json` remains sole source | ✅ Pass |
| TreeWalker + virtual text + offset map | Plan retains this strategy and extends it incrementally (FR-019) | ✅ Pass |
| Playwright tests against real JS | Plan adds new fixtures/expected.json files; no Python verifier reimplementation | ✅ Pass |

**Pre-design gate: PASS — no violations, no Complexity Tracking required.**

### Post-design re-check

After writing Phase 1 artifacts (data-model.md, contracts/, quickstart.md), re-evaluated:
- No new module weakens the five-color taxonomy.
- Storage schema keeps preferences and per-URL TTL in `chrome.storage.local`; no off-device transmission.
- Message contracts maintain `return true` async discipline.
- Panel/badge designs encode category in glyph + word, not color alone.
- Identity model (FR-021) and lifecycle (FR-022) reconciled — successor Finding carries `prior_finding_id` back-reference.

**Post-design gate: PASS — no new violations introduced by the design.**

## Project Structure

### Documentation (this feature)

```text
specs/001-arabic-citation-auditor/
├── plan.md              # This file
├── research.md          # Phase 0 — baseline inventory, gap analysis, porting discipline (already existed; appended Session 4 decisions)
├── data-model.md        # Phase 1 — entities, fields, state machines (Findings lifecycle, persistence TTL)
├── contracts/           # Phase 1 — message contracts (content↔background↔popup) + storage schemas
│   ├── messaging.md     # chrome.runtime.onMessage envelope + every message type
│   ├── storage.md       # chrome.storage.local key schema (preferences + per-URL TTL store)
│   └── window-globals.md # window.__quranScan / __quranStats / __quranMatches for Playwright
├── quickstart.md        # Phase 1 — load unpacked, run fixtures, add a fixture, dev workflow
├── checklists/          # (pre-existing, untouched by /speckit-plan)
└── tasks.md             # Phase 2 output — /speckit-tasks (NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
js/
├── background.js              # Service worker: load JSON, build 5 indexes, expose verifier RPC; routes new message types from contracts/messaging.md
├── content.js                 # Per-frame content script: TreeWalker virtual text builder; scan orchestrator; MutationObserver (FR-019); progressive reveal (FR-023); 500-cap (FR-031); language gate (FR-029)
├── popup.js                   # Popup: scan trigger, preferences UI, font picker, Re-scan All, Continue scanning, Clear remembered corrections/dismissals (FR-024)
├── verifier/                  # NEW — split out of background.js so it stays under control
│   ├── normalize.js           # Tashkeel/drift normalization (FR-003); ported clean from advanced copy
│   ├── indexes.js             # Build byRef / surahNameIndex / normalizedVerseIndex / wordIndex / skeletonWordIndex
│   ├── classify.js            # The five-color decision function (green / blue / yellow / orange / red), enforcing FR-017 / FR-018 / FR-015
│   ├── orange.js              # NEW: explicit-ref vs global-search disagreement detector — the V1 headline pipeline
│   └── references.js          # Reference parsing (surah:ayah, ranges, surah-name variants)
├── render/                    # NEW — authentic-text swap engine (FR-008)
│   ├── swap.js                # Wrap/unwrap; bounded line-box absorption (≤ 1.5×); reversible on toggle
│   └── fonts.js               # Quran-font @font-face registration for the three bundled fonts
├── panel/                     # NEW — findings panel, both surfaces
│   ├── model.js               # Finding entity, composite key, prior_finding_id, panel sections (Recently corrected / Dismissed / Previously dismissed)
│   ├── popup-surface.js       # Renders panel into the popup
│   ├── sidebar-surface.js     # Injects sidebar/overlay into the page (FR-010)
│   ├── actions.js             # Jump / copy / share / report / correct-in-place / dismiss / Copy-as-JSON
│   └── keyboard.js            # FR-030 keyboard model (Tab + Arrows + Enter + C/S/R/F/D/J + Esc)
├── storage/                   # NEW — preferences + per-URL persisted store
│   ├── prefs.js               # Master toggle, per-color toggles, font, scan-trigger mode, panel surface, panel filter
│   └── persisted.js           # FR-024: per-URL corrections + dismissals with 30-day TTL; "Clear remembered" action
├── badge/                     # NEW — toolbar action icon badge
│   └── badge.js               # Stateful glyph ● / ✓ / ! per FR-028; tooltip text with per-category counts; FR-020 error state
└── shared/
    └── messaging.js           # Typed message envelope helpers (see contracts/messaging.md)

html/
├── popup.html                 # Existing — extended with preferences, font picker, panel container, scan controls
└── sidebar.html               # NEW — page-injected sidebar surface markup (loaded by sidebar-surface.js)

css/
├── content.css                # Existing — highlight styles + tooltip pseudo-element; extended with three new colors (light blue / yellow / orange), category glyphs, swap span layout absorption
├── popup.css                  # Existing — popup styles extended for preferences UI + panel
├── sidebar.css                # NEW — page-injected sidebar (scoped to extension UI to avoid host-page bleed)
└── fonts.css                  # NEW — @font-face declarations for the three bundled Quran fonts

resources/
├── quran-uthmani_desc-v2.json # Existing — single source of truth (constitution Tech Constraints)
├── me_quran.ttf               # Existing — kept until replaced by the bundled-three set below
└── fonts/                     # NEW
    ├── uthmani-hafs.ttf       # Default per FR-009
    ├── indo-pak.ttf
    └── simplified.ttf

tests/
├── run_tests.py               # Existing Playwright runner (untouched)
├── add_fixture.py             # Existing
├── run_live_url.py            # Existing
└── fixtures/                  # Existing; new fixtures added:
    ├── 174389/                # Reference fixture — parity gate (SC-001, SC-003)
    ├── orange-cases/          # NEW — hand-curated 20-case set for SC-009 (precision) and SC-010 (recall)
    ├── layout-safety/         # NEW — top-10 fixtures for SC-013 (no > 50 px content jump)
    └── language-gate/         # NEW — Arabic vs non-Arabic fixtures for FR-029
```

**Structure Decision**: Single MV3 extension at repository root. The current flat `js/{background,content,popup}.js` layout absorbed too much logic in three files; the new structure splits along **clear domain boundaries** (`verifier/`, `render/`, `panel/`, `storage/`, `badge/`) without introducing a build step. Each module is a plain `<script>` (for popup/sidebar HTML) or imported via `importScripts(...)` (in the service worker) per MV3 conventions. No bundler. This directly addresses Constitution Principle V (the advanced copy's 1300-line `background.js` and 1883-line `content.js` are the anti-pattern this layout exists to prevent).

## Phase 0 — Research (delta)

`research.md` already exists from spec writing (sections 1–6: Phase 1 baseline, gap analysis, cross-reference discipline, prior-art notes, planner inputs, out-of-V1 threads). **No NEEDS CLARIFICATION items remain** — the 20 clarifications in spec.md resolved every functional ambiguity the planner would otherwise have to research.

This plan appends a **Section 7 — Session-4 design decisions** to research.md capturing the post-clarification choices that affect implementation shape (e.g., bundled 3-font set; Chrome text-fragment share link; `prior_finding_id` back-reference; 500-cap with manual override). Done as part of Phase 1 output.

## Phase 1 — Design Artifacts

**Generated:**

1. **`data-model.md`** — Citation Candidate, Verification Result, Finding (with composite key + `prior_finding_id`), Reference, Verse; state machines for Finding lifecycle (initial → corrected → recently-corrected → previously-corrected) and persisted-store TTL eviction; preferences shape.

2. **`contracts/messaging.md`** — Every `chrome.runtime.onMessage` envelope used: `SCAN_START`, `SCAN_PROGRESS` (per-finding stream for FR-023), `SCAN_COMPLETE`, `SCAN_CAP_HIT` (FR-031), `MUTATION_RESCAN` (FR-019), `CORRECT_IN_PLACE` (FR-012/FR-022), `DISMISS_FINDING` (FR-025), `RESCAN_ALL`, `CONTINUE_SCANNING` (FR-031), `CLEAR_PERSISTED`, `PREFS_CHANGED`, `DATA_UNAVAILABLE` (FR-020). Each carries an envelope `{type, requestId, payload}`; handlers `return true` to keep channel open.

3. **`contracts/storage.md`** — `chrome.storage.local` keyspace:
   - `prefs.v1` — single object with all preferences
   - `persisted.v1.byUrl.<urlKey>` — array of `{compositeKey, kind: "correction"|"dismissal", at: ISO8601}`; entries older than 30 days are pruned lazily on read
   - `persisted.v1.index` — flat list of `urlKey` strings for the "Clear remembered…" action

4. **`contracts/window-globals.md`** — `window.__quranScan` / `__quranStats` / `__quranMatches` shape (Playwright contract) updated for the new categories + Finding fields.

5. **`quickstart.md`** — Load-unpacked instructions, `python tests/run_tests.py` workflow, `python tests/add_fixture.py <url>` workflow, where each module lives, how to add a fixture with intended expected.json (not captured-output), and the constitution's porting discipline reminder.

6. **`CLAUDE.md` update** — Replace the placeholder between `<!-- SPECKIT START -->` and `<!-- SPECKIT END -->` with a pointer to this plan and the design artifacts.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
