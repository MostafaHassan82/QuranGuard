# Quickstart — Writer-Side Ayah Autocomplete (003)

Builds on the feature-001 extension. No build step; vanilla JS.

## Load & try it
1. `chrome://extensions` → Developer mode → **Load unpacked** → repo root.
2. Open any page with an editable field (or the fixtures under `tests/fixtures/compose/`).
3. In a `<textarea>` or contenteditable editor, type a citation lead-in (a recognized primary/secondary prefix) then the first couple of Arabic words of an ayah.
4. After the min-word gate (default 2 words), a caret-anchored **dropdown** of candidate ayahs appears; keep typing to narrow it.
5. Press **Tab/Enter** to accept the highlighted candidate → pick an **insertion scope** (whole ayah / only what you typed / from here to an end word) → the authentic ayah + reference is inserted.
6. Leave a recognized citation unresolved → it is highlighted by its **verdict color** (green/light blue/yellow/orange/red); matched text renders in the configured Quran font (contenteditable only).

## Settings
Options page (`chrome://extensions` → this extension → Details → Extension options) → **Autocomplete** section:
- Enable/disable the feature (the only way to turn it off — there is no Esc dismissal).
- Toggle live Quran-font / verdict rendering.
- Reference format (`(البقرة:255)` vs `(2:255)`) and placement (after/before).
- Minimum-word gate.

## Run the tests
- Full suite (must stay green — no regression): `npm test` (chains `run_tests_node.js --all` + the check scripts).
- This feature's gate: `node tests/autocomplete_check.js` — drives synthetic typing across `<input>`, `<textarea>`, and contenteditable hosts and asserts:
  - candidate ranking (tier first, then mushaf order; correct ayah present/top — SC-002),
  - the three insertion scopes incl. end-word-not-found refusal (FR-015/016),
  - reference format/placement (FR-014),
  - instance dismissal on type-past/caret-away (FR-011) and Tab/Enter capture only while shown,
  - fall-through verdict classification (FR-011a) and plain-input text-only behavior (FR-018b).
- Assertions read `window.__quranCompose` (see `contracts/window-globals.md`).

## Add an editable fixture
Put an HTML host with the editable surface under `tests/fixtures/compose/<name>.html` and a `<name>.expected.json` enumerating the typed text, expected candidates (ref + tier), and the expected insertion result. The gate types the text and compares.

## Module map (this feature)
- `js/compose/index.js` — orchestrator (focus delegation, min-word gate, debounce, IME).
- `js/compose/editable.js` — input/textarea (mirror-div caret, text-only) vs contenteditable (Range, markup).
- `js/compose/detect.js` — citation-in-progress detection (feature-001 prefixes).
- `js/compose/match.js` — `MATCH_PARTIAL` + client-side narrowing + ordering.
- `js/compose/dropdown.js` — candidate list + insertion-scope menu; Tab/Enter; no Esc.
- `js/compose/insert.js` — authentic-wording insertion per scope + reference.
- `js/compose/render-editable.js` — verdict + Quran-font rendering (persistent in contenteditable).

## Porting-discipline reminder (Principle V)
The advanced copy (`C:\Users\mosta\PycharmProjects\QuranChromePlugin`, read-only) has writer-side autocomplete. **Catalog its cases** (editor quirks, caret rects, IME, end-word truncation) — **do not port** its code. Matching routes through the rebuilt verifier (`MATCH_PARTIAL`), never the advanced copy's matcher.
