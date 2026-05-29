# Phase 0 Research — Writer-Side Ayah Autocomplete

All functional ambiguity was resolved by the 6 clarifications in [spec.md](./spec.md). This document records the **implementation-shape** decisions that the design (Phase 1) depends on. Each is framed as Decision / Rationale / Alternatives.

## 1. "Any part of any verse" matching + live narrowing (reuse, don't reinvent)

- **Decision**: A new background RPC `matchPartial(text, {limit})` reuses the verifier's **existing global search** — the same ordered-contiguous / multi-segment / fuzzy-subsequence path that already resolves *no-reference* citations in `js/background.js` (`findOrderedContiguousGlobal`, `matchMultiSegmentCitation`, and the soft/fuzzy tier). It returns ranked candidates `{ref, tier, authenticText, coverage}` where `tier ∈ {exact, wordLevel, fuzzy}` maps to the reader-side green/yellow/red verdicts. Live **narrowing**: when the typed text grows by appending (the common case), filter the *prior* candidate set client-side in `js/compose/match.js` (a candidate survives if the extended text still matches it) and only re-issue `matchPartial` on caret repositioning, deletion, or when the prior set empties.
- **Rationale**: Honors Principle V (no new matching logic; the rebuilt verifier is the single source of truth) and Principle I (matching is exactly the reader-side logic, so writer-side verdicts are consistent). Client-side narrowing keeps keystroke handling within the SC-005 latency budget by avoiding a background round-trip per character.
- **Alternatives considered**: (a) a dedicated prefix trie for verse text — rejected: duplicates the index, and the requirement is "any part," not prefix; (b) re-query the background on every keystroke — rejected: round-trip per character risks typing lag; (c) precompute an n-gram phrase index — rejected: large memory/build cost for a marginal win over reusing the existing global search.

## 2. Caret coordinate tracking across surface types

- **Decision**: `js/compose/editable.js` abstracts two surface kinds. For **contenteditable**, use `Selection`/`Range.getBoundingClientRect()` to position the dropdown and to delimit/replace the citation span (markup-capable). For **`<input>`/`<textarea>`**, caret pixel coordinates are computed with the standard **mirror-div technique** (a hidden div mirroring the field's text + computed style, with a marker span at `selectionStart`), and edits use `selectionStart/End` + value splicing (text-only).
- **Rationale**: These are the established, framework-free techniques; they need no new dependency and work under MV3 content-script constraints. Splitting the abstraction keeps the markup-vs-text-only distinction (FR-018b) in one place.
- **Alternatives considered**: `document.caretPositionFromPoint` (needs a point, not a caret); overlay-only positioning (loses the ability to replace the citation span in inputs).

## 3. IME / composition input

- **Decision**: `js/compose/index.js` ignores `InputEvent`s while `event.isComposing` is true and (re)evaluates on `compositionend`; matching always runs on **committed** text, never on in-flight composition.
- **Rationale**: Arabic is often entered via IME or mobile composition; matching partial composition would produce noise and could corrupt the field on replacement (FR edge case: IME/composition).
- **Alternatives considered**: debounce-only without composition guards — rejected: fires mid-composition and risks replacing uncommitted text.

## 4. Persistent in-editor rendering (FR-018/018a/018b)

- **Decision**: `js/compose/render-editable.js` reuses the **existing verdict color classes and Quran-font class** from `css/content.css` / `js/render/fonts.js`. In contenteditable it wraps each recognized citation in a styled span that **persists** into the saved content (FR-018b). In `<input>/<textarea>` it skips styling (the field cannot hold markup) while preserving matching/insertion. It runs on focus for pre-existing citations (FR-018a) and on dropdown fall-through (FR-011a), calling the same `js/verifier/classify.js` the reader side uses.
- **Rationale**: Guarantees the editor and the reader-side surface agree on verdicts and look (Principle II/IV) with zero new taxonomy. The persistence choice was ratified in clarification (Session 2026-05-24, Q on persistence).
- **Risk noted**: host-page sanitizers may strip the spans on save — acceptable; the authentic *text* (the integrity-critical part) survives even if styling does not.
- **Alternatives considered**: ephemeral overlay decoration — rejected per the ratified clarification (author wants the styling to persist).

## 5. Dropdown control model without Esc (FR-010/011/011a)

- **Decision**: The dropdown captures Tab/Enter **only while showing candidates**. Typing past the citation or moving the caret away closes that **instance** (not the feature); there is no Esc/explicit dismiss key, and the settings toggle is the only feature-level off switch. An unresolved citation is handed to the verdict classifier (§4).
- **Rationale**: Implements the ratified UX (Session 2026-05-24, Q on escape) while preventing Tab/Enter from hijacking ordinary form navigation when no dropdown is open.
- **Alternatives considered**: always-capture Tab/Enter — rejected: breaks form field navigation on false triggers.

## 6. Porting discipline — the advanced copy's autocomplete (Principle V)

- **Decision**: Read the advanced copy's writer-side autocomplete at `C:\Users\mosta\PycharmProjects\QuranChromePlugin` to **catalog cases** (contenteditable quirks across CMS/forum editors, caret-rect edge cases, IME behavior, end-word truncation, multi-citation fields) and **redesign the shape** in `js/compose/`. Do not port its implementation; matching must route through the rebuilt verifier (§1), not the advanced copy's matcher.
- **Rationale**: Constitution Principle V (NON-NEGOTIABLE) and Workflow item 6 (autocomplete is the last phase, built on a trustworthy verifier).
- **Alternatives considered**: verbatim port — rejected by the constitution.

## 7. Settings & defaults

- **Decision**: One `prefs.v1.autocomplete` sub-object: `{enabled:true, liveRender:true, refFormat:"arabicName", refPlacement:"after", minWords:2}`. Default-filled on read and clamped (unknown enum → default), forward-compatible without a `prefs` version bump (consistent with how the font set was reconciled in feature 001).
- **Rationale**: Matches the ratified defaults (feature enabled, live render on, Arabic-name parenthetical after, min two words) and the existing prefs store conventions.
- **Alternatives considered**: a separate top-level prefs key — rejected: the existing `prefs.v1` object already centralizes preferences with default-fill/clamp.

**No NEEDS CLARIFICATION items remain.**

## T032 — Porting-Discipline Pass (Principle V)

Read the advanced copy's autocomplete (read-only) at
`C:\Users\mosta\PycharmProjects\QuranChromePlugin\js\content.js` (functions
`isAutocompleteTarget`, `getEditableTextBeforeCaret`, the citation-detection
regexes ~L1464-1496, `getTextControlCaretRect` mirror-div ~L1652, the typeahead
dropdown, and `insertTypeaheadSuggestion` / `replaceContentEditableCitation`
~L1824-1879). Confirmed **no implementation was ported verbatim** — the rebuild
redesigns the shape in `js/compose/` and reuses the rebuilt verifier RPC.

**Cases harvested (and where each is covered):**
- Editable-target gating across `<input>`/`<textarea>`/contenteditable →
  `editable.js#surfaceOf` + gate hosts in `autocomplete_check.js`.
- Citation detection before the caret incl. bracket/quote openers → `detect.js`
  (lead-in reuse + ornate-bracket case; gate covers `﴿ { ( " “`).
- Caret-rect positioning for text controls vs contenteditable → `editable.js#caretRect`
  (we deliberately use the field box for inputs rather than porting the advanced
  copy's mirror-div pixel measurement — simpler, and the dropdown only needs to be
  near the caret).
- Multi-node contenteditable citation (lead-in + words in separate text nodes) →
  the advanced copy **bails** (`range.startContainer.nodeType !== TEXT_NODE` →
  return false); our `editable.js` block-scoped read + offset mapping **handles**
  it (gate: "split-node (WhatsApp shape)").
- End-word truncation / multi-citation fields → our scope menu + `startToEndWord`
  with the FR-016 not-found refusal (US2 gate); the advanced copy has no scope menu.

**Key divergences (shape redesigned, NOT ported):**
- **Insertion**: advanced copy does a raw `range.deleteContents()` + `insertNode`
  DOM splice (and a single insertion string `"{text} (ref)"`). Our `editable.js`
  uses `execCommand('insertText')` so framework editors (Lexical/Draft/ProseMirror)
  reconcile cleanly (the "lost lead-in" bug), with a raw-range **fallback** only for
  plain contenteditable — and never deletes the user's surrounding text.
- **Rendering**: the advanced copy has no persistent verdict/Quran-font markup; our
  `render-editable.js` adds additive, text-preserving verdict spans (FR-018b),
  pre-existing-on-focus (FR-018a), and fall-through (FR-011a).
- **IME/composition**: the advanced copy has no `compositionstart/end` guard; our
  `index.js` skips matching while `composing` and re-runs on `compositionend`.
- **Matching**: reuses the rebuilt verifier via `MATCH_PARTIAL` (Principle V) — the
  advanced copy's matching code was not consulted for our implementation.

No verbatim code was copied; only the *case inventory* informed the design.
