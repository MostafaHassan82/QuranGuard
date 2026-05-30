# Implementation Plan: Correction & Autocorrect for lightBlue · yellow · red (V1.2)

**Branch**: `002-correction-autocorrect` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-correction-autocorrect/spec.md` (22 FRs, 8 SCs, 4 clarifications session 2026-05-24, 4 user stories P1–P4)

## Summary

Generalize the existing **orange** correct-in-place mechanism (FR-012/FR-022 of feature 001) to the three remaining non-green verdicts, each with its own correction meaning while keeping the five-verdict taxonomy and the lightGreen provenance color unchanged (constitution Principle II). **lightBlue** surfaces the verifier-resolved reference in the highlight tooltip and panel row (FR-007 — never inserts reference text into the page body). **yellow** renders an aligned word-level diff automatically inline as a visual overlay (FR-012), and the user can invoke "Fix in place" to permanently write the authentic mushaf excerpt with strike/highlight markup (FR-013). **red** is probed for fuzzy near-matches during scan (FR-015) and presented as "Did you mean …?" suggestions; on accept it runs the same diff-and-fix path as yellow (FR-016). All corrections produce a lightGreen successor finding (FR-002/FR-003) back-referencing the original via `priorFindingId`, are revertable (FR-006), and persist forward through revisits (FR-021). Autocorrect generalizes to a per-verdict preference for **orange** and **lightBlue** only — yellow and red are manual by rule (FR-018); on fresh install lightBlue autocorrect defaults ON (it only recolors and tooltips, no page-text edit) while orange retains its existing default-off (FR-018, FR-020).

The technical approach extends the existing vanilla-JS MV3 modules from feature 001 (`js/verifier/`, `js/panel/`, `js/render/`, `js/storage/`) without introducing new top-level domains: one new verifier output (aligned word-level diff) plus a red near-match probe in the existing scan pipeline; the panel renderer learns three new row presentations (diff for yellow, suggested-ref for lightBlue, did-you-mean for red); the existing `correctInPlace` action grows two new edit kinds beyond the current `ref-edit` (orange) — `text-replace` (yellow / accepted-red) and **no edit-kind** for lightBlue (it is recolor-and-tooltip only per FR-007 — the panel/highlight surface the resolved reference but the page body is not modified); the prefs schema migrates `autoCorrectOrange` → `autoCorrect: { orange, lightBlue }`; persisted corrections gain a `kind` discriminator so Revert can clear the entry per-finding (FR-006). No new highlight color, no new storage area, no new external dependency. **Scope note:** this plan describes the target end state; the design predecessor at `specs/001-arabic-citation-auditor/v1.2-correction-design.md` (T201) had a partial implementation land on the `003-ayah-autocomplete` branch (commits `9ba93fe`…`1b014f1`) that diverges from the spec on lightBlue (the design proposed `ref-insert`; the spec finalized tooltip-only) — Phase 2 task generation must reconcile what landed against the spec, not against the older design.

## Technical Context

**Language/Version**: Vanilla JavaScript (ES2022), no transpiler, no build step. Same as feature 001.

**Primary Dependencies**: Same Chromium MV3 surface area as feature 001 (`chrome.runtime`, `chrome.storage.local`, `chrome.action`, `chrome.scripting`). No third-party JS/CSS. Reuses the verifier's existing helpers in `js/background.js` (`wordLevelCompareSingleAyah`, `wordLevelMatchGlobal`, soft-subsequence) — no new matcher.

**Storage**: `chrome.storage.local` only (constitution Tech Constraints). Two schema deltas: (a) `prefs.v1` grows `autoCorrect: { orange: bool, lightBlue: bool }` and migrates the legacy `autoCorrectOrange` boolean; (b) each entry in `persisted.v1.byUrl.<urlKey>` grows a `kind: "ref-edit"|"text-replace"|"reference-attribution"|"dismissal"` discriminator so Revert (FR-006) can clear precisely the right entry. 30-day TTL behavior from feature 001 (FR-024) is inherited unchanged. No new storage area.

**Testing**: Playwright via `tests/run_tests.py` against fixtures under `tests/fixtures/{pages,synthetic}/`. Three new curated fixture sets per spec SCs:
- `yellow-drift/` — single-ayah word-level drift cases for SC-002 (≥95% correct diff identification) and SC-001 (≤2 interactions to repair).
- `lightblue-resolution/` — single-resolution and multi-resolution cases for SC-003 (100% correct ref on single-resolution; never auto-resolve multi-resolution without disambiguating context).
- `red-near-match/` — within-threshold and beyond-threshold red cases for SC-004 (≥90% correct candidate within threshold; zero incorrect auto-edits beyond threshold).
Plus reuse of the existing `tests/fixtures/layout-safety/` set for SC-007 (no inline diff overlay or correction shifts beyond the span-local 1.5× line-box bound from feature 001 FR-008).

**Target Platform**: Chromium MV3 (Chrome, Edge, Brave, Arc, Opera). Same as feature 001.

**Project Type**: Browser extension — extends the existing MV3 service worker (background) + content script + popup + page-injected sidebar. No new process or context.

**Performance Goals**:
- Red near-match probe runs **during scan** (FR-015) and MUST stay within the existing feature 001 scan budget (SC-012 from feature 001: ~5,000-word page fully scanned in < 5 s end-to-end). Probe is bounded per-finding by the existing fuzzy-match thresholds; no per-finding wait at panel-open time.
- Aligned word-level diff is computed once when the yellow verdict is emitted and is cached on the Finding — no recomputation on panel render.
- Inline yellow diff overlay (FR-012) reuses the swap engine's wrapper machinery — no new layout pass.

**Constraints**:
- **Integrity (NON-NEGOTIABLE Principle I):** every correction writes only **authentic mushaf wording** (text fixes) or a **verifier-resolved reference** (reference fixes). Never a guess (FR-004).
- **Taxonomy frozen (Principle II):** no new highlight color. lightGreen provenance applies on every successful correction; underlying verdict goes to green (FR-003).
- **Layout-safety bound (Principle inherited from feature 001 FR-008 / SC-013):** the yellow inline diff overlay AND any text-replace correction MUST stay within the span-local 1.5× line-box absorption bound (SC-007). Non-editable / locked DOM regions fall back to clipboard with a user-visible explanation (FR-005, mirroring feature 001 FR-012).
- **Yellow + red are manual by rule:** no preference or migration path can enable autocorrect for yellow or red (FR-018). Ambiguous matches of any color are never auto-corrected (FR-019).
- **Revert clears persistence (FR-006):** a reverted finding behaves as a normal finding on the next scan/visit — including for autocorrect.
- **Porting discipline (NON-NEGOTIABLE Principle V):** the advanced copy at `C:\Users\mosta\PycharmProjects\QuranChromePlugin` is harvested for *cases* (yellow drift patterns, red near-misses, lightBlue ambiguous-by-context examples). Implementation is designed in-place; not ported verbatim.

**Scale/Scope**:
- 22 functional requirements (FR-001 through FR-022), 8 measurable success criteria, 4 user stories (P1 yellow → P2 lightBlue → P3 red → P4 controls), 3 new fixture sets, ~1 new verifier output, ~2 new prefs keys.
- Net code growth target: well under the feature 001 deltas; this is a generalization of existing machinery, not a new subsystem.

## Constitution Check

*GATE: Must pass before Phase 0 research and again after Phase 1 design. Re-check after Phase 1.*

### Pre-design check (against constitution v2.0.0)

| Principle | Spec coverage | Status |
|---|---|---|
| I. Integrity Is the Only North Star (NON-NEGOTIABLE) | FR-004 hard-rules "authentic mushaf wording OR verifier-resolved reference — never reader-guessed". FR-014 withholds yellow text-replace on boundary-spanning (`*`) or ambiguous matches. FR-019 forbids auto-correction of ambiguous findings. SC-004 requires zero incorrect auto-edits beyond threshold. SC-006 requires zero yellow/red auto-corrections and zero ambiguous auto-corrections. | ✅ Pass |
| II. Highlight Taxonomy Is Fixed (Five Verdicts + One Provenance Color) | FR-003 enshrines "no new highlight color; lightGreen provenance only". The diff overlay (FR-012) is presentation inside an existing yellow span, not a new color. | ✅ Pass |
| III. Integrity Across the Severity Order (Red > Yellow > Orange) | Phasing P1=yellow (mid-severity, highest-value-to-user), P2=lightBlue (lowest-risk, no page-text edit), P3=red (highest-severity, suggestion-only by rule). Orange machinery is the substrate; this widens it without demoting it. Yellow + red are manual-only (FR-018) because their consequences are heaviest. | ✅ Pass |
| IV. Authentic-Text Replacement Is the Default Render | The yellow inline diff overlay (FR-012) is a *visual overlay only* until "Fix in place" is invoked — it does not write to the DOM. When the reader does invoke Fix in place (FR-013), it writes the **same** authentic excerpt the existing swap engine would show, just made permanent and re-verified. lightBlue corrections never edit page text. | ✅ Pass |
| V. Porting Discipline From the Advanced Copy (NON-NEGOTIABLE) | Aligned word-level diff is **designed**, not ported (the advanced copy's diff is intertwined with its render pipeline). Red near-match reuses the rebuild's own fuzzy helpers (`wordLevelMatchGlobal`, soft-subsequence) — already in `js/background.js`. lightBlue context disambiguation is a small, principled adjacency check; not a per-fixture carve-out. | ✅ Pass |
| VI. Fixtures Are the Quality Gate, Not the Porting Target | SC-002, SC-003, SC-004 each define a curated fixture set as the quality bar. SC-005 (revert), SC-006 (autocorrect safety), SC-007 (layout-safety), SC-008 (localization) extend the existing fixture-driven discipline. | ✅ Pass |

### Tech constraints alignment

| Constraint | Plan compliance | Status |
|---|---|---|
| MV3 only | No platform change. | ✅ Pass |
| Vanilla JS, no build step | All deltas are vanilla JS extending existing files. | ✅ Pass |
| Service worker index rebuild ~50–100 ms | Unchanged. The red near-match probe reuses already-built indexes (`wordIndex`, `skeletonWordIndex`). | ✅ Pass |
| `chrome.runtime.onMessage` handlers `return true` | All new envelopes follow contracts/messaging.md from feature 001. | ✅ Pass |
| Single Quran JSON authoritative | Unchanged. | ✅ Pass |
| TreeWalker + virtual text + offset map | Inline diff overlay is rendered into the existing yellow wrapper span; text-replace reuses the swap engine's wrap/unwrap. | ✅ Pass |
| Playwright tests against real JS | All new SC fixtures use the existing runner. No Python verifier reimplementation. | ✅ Pass |

**Pre-design gate: PASS — no violations, no Complexity Tracking required.**

### Post-design re-check

After writing Phase 1 artifacts (`data-model.md`, `contracts/messaging.md` and `contracts/storage.md` deltas, `quickstart.md`), re-evaluated:
- No new highlight color introduced; lightGreen provenance and verified-verdict pairing preserved.
- The `kind` discriminator on persisted entries strictly extends the existing `correction|dismissal` schema; legacy entries (no `kind`) are read as `kind: "ref-edit"` for backward compatibility.
- Prefs migration is one-way and idempotent: on first read after upgrade, `autoCorrectOrange: bool` → `autoCorrect: { orange: bool, lightBlue: true }` (lightBlue default-on per FR-018); the legacy key is removed on the same write.
- All new messages carry the standard envelope and handlers `return true`.
- Revert (FR-006) is symmetric to the correction path: same persistence layer, same surface, restores the reader-supplied original content.

**Post-design gate: PASS — no new violations introduced by the design.**

## Project Structure

### Documentation (this feature)

```text
specs/002-correction-autocorrect/
├── plan.md              # This file (/speckit-plan output)
├── spec.md              # Pre-existing — 22 FRs, 8 SCs, 4 clarifications (session 2026-05-24)
├── research.md          # Phase 0 — relationship to feature 001, the v1.2 design predecessor, and divergences from what landed on 003
├── data-model.md        # Phase 1 — DiffSegment, NearMatchSuggestion, generalized AutoCorrectPrefs, generalized PersistedCorrection
├── contracts/
│   ├── messaging.md     # Phase 1 — new message types: CORRECT_IN_PLACE (kind="text-replace"), CORRECT_LIGHTBLUE_REF, REVERT_CORRECTION, plus existing-message field deltas
│   └── storage.md       # Phase 1 — prefs.v1 generalization (autoCorrect{orange,lightBlue}) + persisted entry kind discriminator + migration rules
├── quickstart.md        # Phase 1 — how to load, exercise each P1–P4 path, add a yellow/lightBlue/red fixture, run the SC-002/003/004/007 gates
├── checklists/
│   └── requirements.md  # Pre-existing — fully checked
└── tasks.md             # Phase 2 — generated by /speckit-tasks (NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
js/
├── background.js                 # Existing — extend VerificationResult with alignedDiff (yellow) and nearMatchSuggestion (red); call sites: yellow branch + red branch in classify
├── verifier/
│   ├── classify.js               # Existing — already emits the five verdicts; threaded changes to call alignedDiff for yellow and nearMatchProbe for red
│   ├── normalize.js              # Existing — unchanged
│   ├── indexes.js                # Existing — unchanged (red probe reuses wordIndex / skeletonWordIndex)
│   ├── references.js             # Existing — unchanged
│   ├── orange.js                 # Existing — unchanged
│   ├── alignedDiff.js            # NEW — aligned word-level diff: cited words ↔ authentic words → [{op:'keep'|'missing'|'extra'|'sub', cited, authentic}] (FR-011)
│   └── nearMatch.js              # NEW — fuzzy global probe for red findings, returns {candidateRef, candidateText, distance} | null within threshold (FR-015)
├── render/
│   ├── swap.js                   # Existing — reused by yellow Fix-in-place; add `markupKind: 'diff'` rendering mode that wraps removed words in <del> and inserted/corrected words in <ins> while remaining within the existing 1.5× line-box bound (FR-012, FR-013, SC-007)
│   └── fonts.js                  # Existing — unchanged
├── panel/
│   ├── model.js                  # Existing — Finding type extends with alignedDiff?, nearMatchSuggestion?, resolvedLightBlueRef?, correctionKind on successor findings (FR-002)
│   ├── actions.js                # Existing — generalize correctInPlace to dispatch on kind: ref-edit (orange, existing), text-replace (yellow / accepted-red), and lightBlue-attribution (recolor + tooltip ref, no DOM edit per FR-007). Add Revert action (FR-006). Add Accept-suggestion action for red.
│   ├── popup-surface.js          # Existing — yellow row gets aligned-diff presentation; lightBlue row surfaces resolvedRef; red row shows "Did you mean …?" suggestion or "No automatic correction" label (FR-017)
│   ├── sidebar-surface.js        # Existing — mirror popup-surface.js presentations
│   └── keyboard.js               # Existing — extend the per-finding action map with Revert and Accept-suggestion bindings
├── storage/
│   ├── prefs.js                  # Existing — migrate autoCorrectOrange → autoCorrect{orange,lightBlue} on read; write back generalized shape on next save (FR-020); lightBlue default ON, orange retains user's prior choice (FR-018)
│   └── persisted.js              # Existing — add `kind` discriminator on entry write; legacy entries are read as kind:"ref-edit"; Revert clears the matching entry by compositeKey + kind (FR-006)
└── shared/
    └── i18n.js                   # Existing — add localized strings for diff labels, "Did you mean …?", "No automatic correction", per-color action labels, Revert (FR-022, SC-008)

html/                              # No new files; popup.html / sidebar.html unchanged in shape
css/
├── content.css                   # Extend yellow span styling with .diff-del / .diff-ins; lightGreen provenance unchanged
└── popup.css / sidebar.css       # Extend panel row layout for the three new presentations

tests/
└── fixtures/
    ├── yellow-drift/             # NEW — curated single-ayah word-level drift cases (SC-002, SC-001)
    ├── lightblue-resolution/     # NEW — single-resolution and multi-resolution cases (SC-003)
    ├── red-near-match/           # NEW — within-threshold and beyond-threshold red cases (SC-004)
    └── layout-safety/            # Existing (feature 001) — reused for SC-007
```

**Structure Decision**: Extend the existing feature 001 module layout in-place. Two new verifier modules (`alignedDiff.js`, `nearMatch.js`) keep the single new computation each in a small, named file rather than growing `background.js` further (constitution Principle V — keep modules small and shaped, not patched). The render and panel deltas are additive on existing modules; no new top-level domain is introduced. Per-color rendering kinds are dispatched on a `kind` discriminator on the correction action and on persisted entries — extension, not refactor.

## Phase 0 — Research

`research.md` is generated in Phase 0 with three sections:

1. **What's already there** — what feature 001 leaves on the table for V1.2: `VerificationResult` already carries `matchedRef`, `matchedRefs[]`, `authenticText`, `authenticExcerpt`, `deviation`, `matchType`. So lightBlue resolution and yellow's matched-ayah info are free; only the **aligned** diff (FR-011) and the red **near-match probe** (FR-015) are net-new verifier outputs.
2. **Relationship to `specs/001-arabic-citation-auditor/v1.2-correction-design.md` (T201)** — the v1.2 design document predates the spec's 2026-05-24 clarifications and proposes a `ref-insert` edit kind for lightBlue (FR-007 in the spec rejected this in favor of tooltip-only) and proposes manual-only across the board (FR-018 in the spec ratified autocorrect for orange + lightBlue). The spec is authoritative; the design doc is retained for historical context only.
3. **Implementation already landed on `003-ayah-autocomplete`** — commits `9ba93fe`…`1b014f1` implemented P1–P3 against the older design (not against this spec). Phase 2 task generation must reconcile (a) which deltas landed match the spec and are keepers, (b) which need adjustment (chief candidate: any lightBlue ref-insert behavior must be reverted to tooltip-only), and (c) which are missing (Revert that clears persistence per FR-006; the generalized `autoCorrect` prefs migration with lightBlue default-on per FR-018).

**No NEEDS CLARIFICATION items**: the spec's 2026-05-24 clarifications resolved every functional ambiguity the planner would otherwise have to research.

**Output**: `research.md` with the three sections above.

## Phase 1 — Design Artifacts

**Generated:**

1. **`data-model.md`** — extends feature 001's data model:
   - `DiffSegment { op: 'keep'|'missing'|'extra'|'sub', cited?: string, authentic?: string }` — emitted as `Finding.alignedDiff: DiffSegment[]` for yellow.
   - `NearMatchSuggestion { candidateRef, candidateText, distance, withinThreshold: boolean }` — emitted as `Finding.nearMatchSuggestion` for red (null when no candidate within threshold).
   - `Finding.resolvedLightBlueRef?: string` — populated for lightBlue when `matchedRefs.length === 1` OR adjacency-context resolves to a single surah; never populated for ambiguous unresolved lightBlue.
   - `CorrectionKind = 'ref-edit' | 'text-replace' | 'reference-attribution'` — the action discriminator. `ref-edit` is the existing orange path. `text-replace` is yellow Fix-in-place and accepted-red. `reference-attribution` is lightBlue (recolor + tooltip, no DOM edit per FR-007).
   - `Finding.priorFindingId` unchanged (FR-002, back-reference to original).
   - State transitions: original → corrected (lightGreen successor, FR-002/FR-003) → reverted (clears persisted entry, returns to original verdict, FR-006).

2. **`contracts/messaging.md`** — delta from feature 001:
   - `CORRECT_IN_PLACE` payload grows `kind: CorrectionKind` (default `ref-edit` for backward compatibility); body includes the resolved reference (lightBlue, orange) or the authentic excerpt (yellow, red-accept).
   - `REVERT_CORRECTION { compositeKey }` — restores the reader-supplied original content, returns the finding to its pre-correction verdict, AND clears the matching persisted entry (FR-006).
   - `ACCEPT_NEAR_MATCH { compositeKey, candidateRef }` — red user-accept path; converts to `CORRECT_IN_PLACE` with `kind:"text-replace"` server-side.
   - All envelopes follow feature 001's `{type, requestId, payload}` shape; handlers `return true`.

3. **`contracts/storage.md`** — delta from feature 001:
   - `prefs.v1.autoCorrect: { orange: boolean, lightBlue: boolean }` replaces `prefs.v1.autoCorrectOrange: boolean`. **Migration**: on first read after upgrade, if `autoCorrectOrange` exists, write `{ orange: <legacy value>, lightBlue: true }` and delete the legacy key (FR-018, FR-020). lightBlue default ON, orange default carried from user's prior choice (or false on a true fresh install).
   - `persisted.v1.byUrl.<urlKey>[]` entries gain `kind: CorrectionKind | "dismissal"`. Legacy entries without `kind` are read as `kind: "ref-edit"`. Revert deletes the entry matching `compositeKey + kind`. 30-day TTL behavior from feature 001 unchanged.

4. **`quickstart.md`** — load-unpacked, run fixtures, the five things a new contributor will do most:
   - Reproduce a yellow drift case and see the inline diff overlay + panel diff row.
   - Reproduce a lightBlue case (single-resolution; multi-resolution-with-context; ambiguous) and see the tooltip-only ref behavior.
   - Reproduce a red near-match case and see the "Did you mean …?" suggestion vs the "No automatic correction" label.
   - Toggle the new `autoCorrect.lightBlue` preference and confirm safe autoresolution; confirm yellow/red are never auto-corrected regardless of preferences.
   - Apply a correction, reload the page, confirm persistence; invoke Revert and confirm the persisted entry is cleared.

5. **Agent context update** (per /speckit-plan key rules) — update the block between `<!-- SPECKIT START -->` and `<!-- SPECKIT END -->` in `CLAUDE.md` to point at `specs/002-correction-autocorrect/plan.md` and the design artifacts above.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
