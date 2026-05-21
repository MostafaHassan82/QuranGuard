<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->

## Module map (V1 — 001-arabic-citation-auditor)

Chromium MV3, vanilla JS, no build step. Load order matters; the manifest lists
the content-script bundle in dependency order.

### Service worker — `js/background.js`
Builds the Quran index on activation (via `importScripts` of the verifier
modules) and answers verification + persistence + prefs messages.
- `js/verifier/normalize.js` — `QuranNormalize`: tier-1 normalization
  (tashkeel-strip + spelling-drift), skeleton, `classifyDeviation`.
- `js/verifier/indexes.js` — `QuranIndexes.build`: byRef / byTier1Norm / word /
  skeleton / surah-name indexes. Records carry `tier1Words` + `uthmaniWords`
  (1:1 aligned, drives the excerpt-preserving swap).
- `js/verifier/references.js` — `QuranReferences.resolve`: parse a cited ref
  string → {surahNum, ayahNums, isRange}.
- `js/verifier/orange.js` — `QuranOrange.classify`: the reference-mismatch
  (flagship) decision.
- `js/verifier/classify.js` — `QuranClassify`: the frozen 5-color taxonomy,
  `makeResult` (with `authenticExcerpt`), FR-015/017 guard rails.
- `js/storage/prefs.js` — `QuranPrefs`: `prefs.v1` defaults + validation.
- `js/storage/persisted.js` — `QuranPersisted`: per-URL corrections/dismissals,
  30-day TTL; `read/write/remove/clearAll`.

### Content script bundle (in manifest order)
- `js/shared/messaging.js` — `QuranMsg`: typed envelope `{type,requestId,payload}`,
  `sendRequest/emit/okResponse/errResponse`, `randomId` (secure-context-safe UUID).
- `js/panel/model.js` — `QuranPanelModel`: in-memory findings + per-finding panel
  state; section selectors (active / recently-corrected / dismissed / previously
  dismissed); `ingestProgress`, `unmarkDismissed`, `tagPersisted`.
- `js/panel/actions.js` — `QuranActions`: copy/share/report/JSON builders,
  clipboard, jump (popup + content), correct-in-place (popup + content),
  dismiss/restore, shared `urlKey`.
- `js/panel/keyboard.js` — `QuranPanelKeyboard.attach`: arrows / Enter / C·S·R·J /
  F·D / Space / two-stage Esc (FR-030).
- `js/panel/sidebar-surface.js` — `QuranPanelSidebar`: the **only** panel surface.
  Page-injected; hosts findings, filters, swap controls, and saved-corrections
  settings. Collapsible (to a top-right tab) + drag-resizable; width/collapsed
  persisted in `chrome.storage.local` (`quran.sidebar.ui`). `focusRow` (page →
  panel). No close button — collapse only.
- `js/render/fonts.js` — `QuranFonts`: `@font-face` registry + `familyFor`.
- `js/render/swap.js` — `QuranSwap`: authentic-text swap engine; prefers
  `authenticExcerpt`, gated on master + per-color prefs, never red (FR-015).
- `js/content.js` — orchestrator: extraction strategies, scan convergence loop,
  highlight wrapping, `correctInPlace`, ref markers, swap pass, MutationObserver,
  message handlers, the three `window.__quran*` test globals.

### Popup — `html/popup.html` + `js/popup.js`
**Scan-only** now: scan mode, scan/continue/clear, live status + stats, and the
sidebar's initial collapsed/expanded choice. No findings panel (that lives in the
sidebar). The old `js/panel/popup-surface.js` and the `panelSurface` pref were
removed on 2026-05-21 — the sidebar is the only panel surface.

### Surfaces / docs
- Messaging contract: `specs/001-arabic-citation-auditor/contracts/messaging.md`
- Storage schemas: `.../contracts/storage.md`
- Test globals: `.../contracts/window-globals.md`
- Fixture runner (Python, Playwright): `tests/run_tests.py`
- Node runner (Playwright, mocked chrome): `tests/run_tests_node.js`
