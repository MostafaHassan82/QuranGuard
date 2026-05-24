# Implementation Plan: Writer-Side Ayah Autocomplete

**Branch**: `003-ayah-autocomplete` | **Date**: 2026-05-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-ayah-autocomplete/spec.md` (20 FRs incl. sub-FRs, 8 SCs, 6 clarifications across 2 sessions)

## Summary

Writer-side companion to the reader-side auditor (feature 001). As the user types Arabic into any editable surface (`<input>`, `<textarea>`, or contenteditable), the extension recognizes an emerging Quran citation using the **same detection signals** as the reader-side scanner, waits a minimum number of words (performance gate), then matches the typed text against **any part of any verse** via the existing background verifier. A caret-anchored dropdown offers ranked candidate ayahs (narrowing live as the user types); on Tab/Enter accept, a second menu picks the insertion scope (whole ayah / typed portion / start-to-end-word) and the typed text is replaced with the **authentic mushaf wording plus a (configurable) reference**. Any recognized citation the user does not resolve via the dropdown falls through to feature-001's **five-verdict classification** and is highlighted by its verdict color; matched text renders in the configured **Quran font**, applied as **persistent markup** in contenteditable. The feature is local-only, has no Esc dismissal (typing past / caret-away closes a dropdown instance; a settings toggle is the only feature-level off switch), and adds no new highlight color.

The technical approach adds one new module directory — `js/compose/` — that orchestrates editable-field detection, caret tracking, the suggestion dropdown, and insertion, while **reusing** the existing verifier RPC (`js/background.js`), normalization/indexes/references, the classifier (`js/verifier/classify.js`), the Quran-font registry (`js/render/fonts.js`), i18n (`js/shared/i18n.js`), messaging envelope (`js/shared/messaging.js`), and preferences store (`js/storage/prefs.js`). No new matching logic is invented — "any part of any verse" reuses the background global contiguous/subsequence search already used for no-reference citations.

## Technical Context

**Language/Version**: Vanilla JavaScript (ES2022), no transpiler, no build step.

**Primary Dependencies**: Chromium Manifest V3 APIs (`chrome.runtime`, `chrome.storage.local`, `chrome.scripting`), browser-native `Selection`/`Range`, `MutationObserver`, `CompositionEvent`/`InputEvent`, `Intl.Segmenter` (Arabic word boundaries). Reuses feature-001 modules (verifier RPC, normalize, indexes, references, classify, fonts, i18n, messaging, prefs). No third-party JS/CSS.

**Storage**: `chrome.storage.local` only. Extends the existing `prefs.v1` object with an `autocomplete` sub-object (feature on/off, live-rendering on/off, reference format/placement, min-word gate). No new keyspace; no `chrome.storage.sync`; no `IndexedDB`.

**Testing**: Existing Node harness (`tests/run_tests_node.js`) + Playwright; new editable-field fixtures and a dedicated `tests/autocomplete_check.js` assertion gate that drives synthetic typing (committed-composition `input` events) against `<input>`, `<textarea>`, and contenteditable hosts and asserts candidate ranking, insertion scope, reference format, instance dismissal, and fall-through verdict classification. Verifier exercised through the real JS — no reimplementation.

**Target Platform**: Chrome and other Chromium-based browsers (Edge, Brave, Arc, Opera) with Manifest V3. Firefox/Safari out of scope.

**Project Type**: Browser extension — MV3 service worker (background, reused) + content script (per-frame, `<all_urls>`, extended with the compose modules) + options page (extended with autocomplete settings). No popup change required.

**Performance Goals**:
- SC-005: keystroke handling stays responsive — no perceptible typing lag / dropped characters. Matching never runs before the min-word gate and is debounced; candidate narrowing on append is a client-side filter of the prior result set (no background round-trip).
- Background match RPC for a typed fragment returns within the existing per-fragment verify budget; live narrowing avoids re-querying on every keystroke.
- SC-002: correct ayah among candidates ≥95% / top-ranked ≥85% on the curated fragment set.

**Constraints**:
- Local-only (no network for matching, fonts, or data) — Principle I / Tech Constraints.
- Vanilla JS, no build step.
- Highlight taxonomy fixed (Principle II): the editor uses the existing five verdicts + lightGreen provenance; **no new color**.
- No Esc/explicit dismissal key (FR-011); settings toggle is the only feature-level off.
- Contenteditable rendering is **persistent markup** (FR-018b); plain inputs are text-only (cannot hold markup).
- Insertion always writes **authentic mushaf wording** (FR-017) — never the user's drifted text presented as authentic.
- Content script already runs on `<all_urls>`; **no new permissions** are required (no new host permissions, no clipboard for this feature).

**Scale/Scope**: 20 functional requirements (with sub-FRs FR-011a/012a/018a/018b), 8 success criteria, 4 key entities, 4 prioritized user stories (P1–P4), 9 edge cases. One new module directory (`js/compose/`), one new CSS file, options-page additions, one new prefs sub-object, one new background RPC (`matchPartial`), and a new test gate.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

### Pre-design check (against constitution v2.0.0)

| Principle | Coverage | Status |
|---|---|---|
| I. Integrity Is the Only North Star | This *is* the writer-side workflow named in Principle I — prevent false citations from entering circulation at composition time. Insertion only ever writes authentic mushaf text (FR-017). | ✅ Pass |
| II. Highlight Taxonomy Is Fixed (5 verdicts + 1 provenance) | The editor reuses the existing classifier's five verdicts; FR-018/FR-011a apply them unchanged. No new color introduced. | ✅ Pass |
| III. Integrity Across the Severity Order | Principle III explicitly lists "writer-side prevention (offer an ayah autocomplete as the user types in any page text input)" as co-equal. This feature delivers exactly that. | ✅ Pass |
| IV. Authentic-Text Replacement Is the Default Render | Matched citation text renders in the Quran font (FR-018) and inserted text is authentic JSON wording (FR-014/FR-017) — the default-render stance carried into the writing surface. | ✅ Pass |
| V. Porting Discipline From the Advanced Copy | The advanced copy has writer-side autocomplete code; this plan **harvests its cases** (caret tracking, contenteditable quirks, IME) and **redesigns the shape** in `js/compose/`. No verbatim port; matching reuses the rebuilt verifier, not the advanced copy's. | ✅ Pass |
| VI. Fixtures Are the Quality Gate | New editable-field fixtures + `tests/autocomplete_check.js` gate the behavior; existing suite must stay green (no regression). | ✅ Pass |

### Tech constraints alignment

| Constraint | Plan compliance | Status |
|---|---|---|
| MV3 only | Reuses the existing MV3 manifest; adds content scripts only | ✅ Pass |
| Vanilla JS, no build step | `js/compose/` is plain scripts; no bundler/framework | ✅ Pass |
| SW index rebuild ~50–100 ms; no IndexedDB | Reuses the existing index; adds one read-only RPC | ✅ Pass |
| `onMessage` handlers `return true` | New `matchPartial` handler conforms to the envelope + async discipline | ✅ Pass |
| Single Quran JSON authoritative | Matching/insertion resolve through the existing index | ✅ Pass |
| Playwright against real JS | New gate drives the real compose + verifier JS | ✅ Pass |
| Arabic-only V1 site scope | Autocomplete triggers on Arabic citation context only | ✅ Pass |
| Sequencing (Workflow item 6: autocomplete is the last phase) | Reader-side V1 (001) + correction (002) precede this; foundation is in place | ✅ Pass |

**Pre-design gate: PASS — no violations, no Complexity Tracking required.**

### Post-design re-check

After Phase 1 artifacts (data-model.md, contracts/, quickstart.md):
- No module adds or remaps a highlight color; the editor calls the existing classifier.
- The new `matchPartial` message uses the typed envelope and `return true`; no off-device transmission.
- `prefs.autocomplete` lives in the existing `prefs.v1` object in `chrome.storage.local`; no new keyspace.
- Insertion path writes authentic JSON wording only; the user's drifted text is never persisted as authentic (FR-017).
- Caret/dropdown is extension-owned UI; persistent contenteditable markup uses the existing Quran-font + verdict classes (no new taxonomy).

**Post-design gate: PASS — no new violations introduced by the design.**

## Project Structure

### Documentation (this feature)

```text
specs/003-ayah-autocomplete/
├── plan.md              # This file
├── research.md          # Phase 0 — matching reuse, caret tracking, IME, narrowing, porting discipline
├── data-model.md        # Phase 1 — Citation-in-progress, Candidate, Insertion scope, Autocomplete settings; state machine
├── contracts/           # Phase 1
│   ├── messaging.md     # New matchPartial RPC + reused verifier/prefs messages (envelope, return true)
│   ├── storage.md       # prefs.v1.autocomplete sub-object schema (defaults, clamps, migration)
│   └── window-globals.md# window.__quranCompose test hook (active citation, candidates, last insertion)
├── quickstart.md        # Phase 1 — how to exercise autocomplete, run the new gate, add an editable fixture
├── checklists/          # (pre-existing requirements.md, untouched by /speckit-plan)
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
js/
├── background.js              # REUSED + 1 new handler: matchPartial (typed fragment → ranked candidate refs/tiers, reusing the global contiguous/subsequence search used for no-ref citations)
├── content.js                 # REUSED; loads the compose orchestrator and forwards focus/input lifecycle (no scan-pipeline change)
├── compose/                   # NEW — writer-side autocomplete (the only new module dir)
│   ├── index.js               # Orchestrator: focusin delegation across editable fields; wires detect → match → dropdown → insert; min-word gate; debounce; IME (compositionend / isComposing) handling
│   ├── editable.js            # Surface abstraction over <input>/<textarea> (selectionStart + mirror-div caret coords, text-only) vs contenteditable (Selection/Range, markup-capable); reports caret rect + citation span
│   ├── detect.js              # Recognize a citation-in-progress at the caret using feature-001 detection signals (primary/secondary prefixes + Arabic run); delimit the citation span
│   ├── match.js               # Call matchPartial; cache + client-side narrowing on append (filter prior candidates); tier+mushaf ordering (FR-013); cascade exact→word-level→fuzzy→none (FR-007/008)
│   ├── dropdown.js            # Caret-anchored candidate list + the second insertion-scope menu (FR-012a/015); Tab/Enter accept; instance dismissal on type-past / caret-away (FR-011); no Esc
│   ├── insert.js              # Replace the citation span with authentic wording per scope (whole / typed-portion / start-to-end-word, FR-015/016); append reference per format pref (FR-014)
│   └── render-editable.js     # Apply verdict classification (FR-018) + Quran font to recognized citations; persistent markup in contenteditable (FR-018b), text-only/no-style in inputs; covers pre-existing-on-focus (FR-018a) and dropdown fall-through (FR-011a)
├── verifier/                  # REUSED — normalize, indexes, references, classify, orange (no change)
├── render/
│   └── fonts.js               # REUSED — Quran-font family names consumed by render-editable.js
├── storage/
│   └── prefs.js               # EXTENDED — add prefs.autocomplete {enabled, liveRender, refFormat, refPlacement, minWords} with defaults + clamps (contracts/storage.md)
├── options.js                 # EXTENDED — autocomplete settings section (enable, live-render, reference format/placement, min-word gate)
└── shared/                    # REUSED — messaging.js (envelope + matchPartial), i18n.js (new keys), log.js

css/
├── compose.css                # NEW — dropdown + scope-menu styling (namespaced to extension UI, all:initial guard) and the persistent in-editor citation styling classes
└── content.css                # REUSED — verdict color + Quran-font classes referenced by render-editable.js

html/
└── options.html               # EXTENDED — autocomplete settings controls + [data-i18n] labels

manifest.json                  # EXTENDED — add js/compose/*.js to content_scripts.js and css/compose.css to content_scripts.css; no new permissions

tests/
├── run_tests_node.js          # REUSED runner
├── autocomplete_check.js      # NEW — assertion gate: synthetic typing across input/textarea/contenteditable; asserts ranking, scopes, ref format, instance dismissal, fall-through classification
└── fixtures/
    └── compose/               # NEW — editable-field fixtures (plain input, textarea, contenteditable) with expected candidate sets + insertion results
```

**Structure Decision**: Single MV3 extension at repository root (unchanged). The writer-side concern is isolated in one new domain module, `js/compose/`, mirroring the existing `verifier/ render/ panel/ storage/` split — no build step, plain `<script>` includes via `content_scripts`. This keeps composition-time logic out of `content.js` (the reader-side scan orchestrator) and out of `background.js` (which gains only one read-only matching RPC), directly honoring Principle V (avoid the advanced copy's monolithic files).

## Phase 0 — Research

`research.md` resolves the implementation-shape questions the spec/clarifications did not pin down: (1) how "any part of any verse" matching and live narrowing reuse the existing verifier without new logic; (2) caret-coordinate tracking across `<input>`/`<textarea>` (mirror-div) vs contenteditable (Range rects); (3) IME/composition handling; (4) how persistent contenteditable markup reuses the verdict + Quran-font classes; (5) the porting-discipline reading of the advanced copy's autocomplete (cases to harvest, shape to redesign). **No NEEDS CLARIFICATION items remain** — the 6 clarifications resolved every functional ambiguity.

## Phase 1 — Design Artifacts

**Generated:**

1. **`data-model.md`** — Citation-in-progress (text, surface ref, span, caret offset), Candidate ayah (ref, authentic text, tier, coverage, rank), Insertion scope (whole / typed-portion / start-to-end-word + end word), Autocomplete settings; the dropdown/insert state machine (idle → detecting → suggesting → scope-menu → inserted | dismissed | fallthrough-classified).
2. **`contracts/messaging.md`** — the new `matchPartial` envelope (request/response/error, `return true`), plus the reused verifier RPCs and `PREFS_READ/WRITE/PREFS_CHANGED` this feature consumes.
3. **`contracts/storage.md`** — `prefs.v1.autocomplete` sub-object: fields, defaults (enabled=true, liveRender=true, refFormat="arabicName", refPlacement="after", minWords=2), clamp-on-read rules, and forward-compatible default-fill (no version bump).
4. **`contracts/window-globals.md`** — `window.__quranCompose` test hook exposing the active citation-in-progress, current candidate list (with tiers/ranks), and the last insertion result for the Playwright/Node gate.
5. **`quickstart.md`** — how to load unpacked, type into the fixtures to see suggestions, run `node tests/autocomplete_check.js`, and add an editable fixture; porting-discipline reminder.
6. **`CLAUDE.md` update** — repoint the `<!-- SPECKIT … -->` block to this active feature while keeping the orientation lines.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified.

No violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
