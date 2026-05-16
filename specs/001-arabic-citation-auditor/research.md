# Research: Arabic Quran Citation Auditor (V1)

**Feature**: [spec.md](./spec.md)
**Created**: 2026-05-16
**Purpose**: Capture the Phase 1 baseline inventory, the gap to V1, and the cross-reference discipline an implementer needs before `/speckit-plan` produces an implementation plan.

This document is implementation-adjacent, not part of the user-facing specification. It exists so the plan does not have to re-discover what is already built or where to look for prior art.

---

## 1. Phase 1 Baseline Inventory (what already exists)

The active rebuild at `C:\Users\mosta\PycharmProjects\QuranAuditPlugin` completed a baseline pass. The following components exist and are candidates for reuse — but per Constitution Principle V, reuse means harvesting *cases* and small clean ports, not verbatim copies.

### Manifest (`manifest.json`)

- Manifest V3
- Service worker background
- Vanilla JS, no jQuery, no build step
- Content script auto-injected per frame

### Background service worker (`js/background.js`)

- Loads the local Quran data file (`quran-uthmani_desc-v2.json`) on service worker activation; rebuild takes ~50–100 ms.
- Builds five in-memory indexes:
  - `byRef` — `surah:ayah` → verse object
  - `surahNameIndex` — surah name variants → surah number
  - `normalizedVerseIndex` — normalized verse text → reference
  - `wordIndex` — word → list of `(ref, position)` pairs
  - `skeletonWordIndex` — diacritic-stripped skeleton word → list of `(ref, position)` pairs
- Four-layer search ladder: exact → ordered contiguous → ordered gapped → skeleton partial.
- Verifier API surface: `resolveReference`, `verifyFragment`, `verifyFragmentByRef`.
- MV3 messaging discipline: every `chrome.runtime.onMessage` handler `return true` so the channel stays open for the async response.
- Index is rebuilt on each service worker activation. No `IndexedDB` persistence; the local JSON fetch is fast enough.

### Content script (`js/content.js`)

- TreeWalker-based DOM traversal.
- Virtual text builder: concatenates every text node into a single string with `\x00` boundaries and an offset map that projects regex match positions back to the original live DOM text nodes.
- Five candidate-extraction strategies (note: the V1 PRD lists four "high-yield" strategies plus continuation context parked — the Phase 1 implementation has five. Reconcile this delta during planning).
- `wrapTextNodes` for inserting highlight spans without breaking selection, copy, or reflow.
- Two highlight colors active: green and red. **Yellow, light blue, and orange do not exist yet.**
- Tooltip via `data-tooltip` attribute + `::after` pseudo-element.

### Popup (`html/popup.html`, `js/popup.js`)

- Two controls: Scan and Clear.
- Eight debug stat displays.
- No settings UI yet; no persistence via `chrome.storage.local` yet.

### Tests (`tests/`)

- `tests/run_tests.py` — Playwright fixture runner that drives the **real extension JS** (deliberately not a Python reimplementation of the verifier).
- `tests/add_fixture.py` — saves a live page as an HTML fixture for regression.
- `tests/run_live_url.py` — runs the extension on a live URL for comparison against the saved fixture.
- Five fixtures reviewed in the rebuild (the advanced copy has eleven — closing this gap is part of V1).
- Playwright reads results via three window globals exposed by the content script: `window.__quranScan`, `window.__quranStats`, `window.__quranMatches`.

### CSS

- `css/content.css` — highlight styles and the `::after` tooltip rule.
- `css/popup.css` — popup styling.

---

## 2. Gap Analysis (what V1 requires that Phase 1 lacks)

### Verifier

- **Orange pipeline** — explicit-ref vs global-search disagreement detector. The advanced copy does NOT produce orange at all; per the V1 PRD, "designing the orange pipeline is a fresh-design problem, not a port." This is the single highest-value implementation task in V1.
- **Yellow classification** — word-level inexact (missing/added/substituted word relative to a matched verse).
- **Light blue classification** — verified-without-reference, with the verifier contributing the missing reference in the tooltip.
- **Drift-as-green rule** — tashkeel/diacritic-only AND modern-vs-Quranic Arabic spelling drift (alif variants, ى↔ي, ة↔ه, adjacent same-letter collapse like `بِٱلَّيْلِ` ↔ `بالليل`) MUST yield green, not yellow.
- **Fallback-does-not-promote-to-green rule (FR-017)** — skeleton matching, gap-allowed ordered matching, and partial matching may be used to *find* candidates but MUST NOT produce a green verdict.
- **Low-confidence drop rule (FR-018)** — candidates without strong citation signals that produce no match must be dropped silently, not red.

### Fixtures

- Five → eleven fixture parity with the advanced copy.
- At least five hand-curated **orange fixtures** (the advanced copy has none; this is fresh test material).
- A 20-case **orange precision/recall scoring set** for SC-009 and SC-010.
- All fixture `expected.json` files must reflect **intended** output, not frozen current output. Do not capture the rebuild's broken Phase 1 output as a regression target.

### Authentic-text swap engine

- DOM-rewrite engine that replaces verified spans with JSON-sourced text rendered in `resources/me_quran.ttf`.
- Layout preservation: match approximate surrounding font size and line height; degrade gracefully if the font fails to load.
- Reversible: clearing highlights or toggling the master switch off restores the page's original text.
- Per-color override scaffolding (V1.0 if time permits, V1.1 otherwise).

### Findings panel

- Aggregates all orange findings on the current page into one list (FR-010).
- **Two surfaces**, user-selectable, both rendering identical data and actions:
  - popup-attached (default)
  - page-injected sidebar/overlay
- Per-finding actions: copy (V1.0), edit-in-place (V1.0 best-effort), report and share (V1.0 clipboard-only with formatted template; V1.1 integrations for Twitter/X intent, mailto, etc.).
- Click-to-scroll to the corresponding highlight on the page.
- Count summary at panel top (total + per color).

### Settings & persistence

- `chrome.storage.local` for: master authentic-text-replacement toggle, findings-panel surface preference, future per-color overrides, future image-source folder choice.
- Notify the content script when settings change so the current page reflects the new state without a full reload where possible.

### MV3 stability

- Retry / re-index logic if the service worker is evicted between scan messages (Q6, non-blocking but flagged).

---

## 3. Cross-Reference Operational Discipline

When implementing each region of V1, this is where to look first.

### Advanced copy is authoritative for *cases*

Path: `C:\Users\mosta\PycharmProjects\QuranChromePlugin` (**read-only — do not edit**).

Consult the advanced copy first when working on:

- Verifier behavior (normalization rules, match-grading thresholds)
- Surah-name variants (Arabic naming conventions, common misspellings, abbreviations)
- Range and subrange handling (`فصلت:3-4`, `إلى قوله` constructs)
- Candidate extraction edge cases (lead-in braced, explicit-ref-backward, range construct, short fragment with ref)
- Islamweb DOM quirks and other publisher conventions
- Fixture content and intended-output reasoning
- Popup wiring patterns and `chrome.storage.local` usage

Cardinal rule: **Never assume the rebuild's current implementation is the latest learning.** The advanced copy almost always has more battle-tested logic. If the rebuild and the advanced copy disagree, the advanced copy is the default tiebreaker for *cases that must work* — but the *shape* of the rebuild's solution is the goal, not a copy of the advanced shape.

The advanced copy's own execution history lives at:

```
C:\Users\mosta\PycharmProjects\QuranChromePlugin\.cursor\plans\quran-extension-plan.md
```

Useful breadcrumb when you need to understand *why* a particular case was handled a particular way.

### `fresh_start/` is authoritative for product intent

- [`fresh_start/00-V1-PRD.md`](../../fresh_start/00-V1-PRD.md) — the V1 PRD; authoritative for goals, non-goals, requirements R1–R21, success metrics, milestones.
- [`fresh_start/01-product-scope.md`](../../fresh_start/01-product-scope.md) — supporting scope reference.
- [`fresh_start/02-architecture.md`](../../fresh_start/02-architecture.md) — architectural intent.
- [`fresh_start/03-scanner-behavior.md`](../../fresh_start/03-scanner-behavior.md) — scanner-behavior expectations.
- [`fresh_start/04-testing-workflow.md`](../../fresh_start/04-testing-workflow.md) — fixture and test workflow.
- [`fresh_start/05-roadmap.md`](../../fresh_start/05-roadmap.md) — phase roadmap (V1 → V2).
- [`fresh_start/06-verifier-design.md`](../../fresh_start/06-verifier-design.md) — verifier design notes.

If product intent and the advanced copy disagree, `fresh_start/` wins for *what* and the advanced copy wins for *which cases exist*.

### Porting discipline (per Constitution Principle V)

- Catalog the *cases* the advanced copy handles. Do **not** copy the *implementation*.
- For complex regions (extraction, verification, range handling): **read → understand the cases → redesign the shape → implement clean**.
- Small clean ports are fine: the surah-variant map, normalization tables, the Quran JSON itself.
- The discipline applies to regions where the advanced copy's size suggests accumulated patches: `background.js` 1300 lines, `content.js` 1883 lines.
- Fixtures are the **quality gate after rewrite**, not the porting target. If a fixture forces a one-off `if` branch, the design is wrong — step back and reshape.

---

## 4. Known Prior-Art in Advanced Copy (Roadmap Inspiration, NOT V1)

These features exist in the advanced copy but are explicitly out of V1. Captured here so they don't get rediscovered later when the roadmap reaches them.

- **Strictness toggle**: `exactOnly` vs `assisted` matching mode (target: Phase 3 popup settings).
- **Review mode toggle**: `manual` vs `autoPassive` scanning (target: Phase 3; V1 is manual-scan-only per V1 PRD non-goals).
- **Render mode toggle**: tri-state `text` / `quranFont` / `image` (V1 collapses this into the authentic-text-swap default + master toggle; the explicit tri-state is Phase 3+).
- **Image render mode**: ayah PNGs sourced from `resources/QuranAyas/` or `resources/QuranAyas2/` (Phase 5; V1 non-goal).
- **Quran font render mode**: `resources/me_quran.ttf` (partially landed in V1 via authentic-text swap; explicit standalone mode is Phase 4).
- **Working popup with persisted settings**: scaffolds the Phase 3 settings UI.

---

## 5. Inputs to `/speckit-plan`

When `/speckit-plan` runs against [spec.md](./spec.md), it should treat the following as known context (no need to re-derive):

1. **Project type**: Chromium MV3 browser extension. Vanilla JS, no build step, service worker background, content script + popup.
2. **Reuse boundary**: harvest from `QuranChromePlugin` per the discipline above; do not port verbatim.
3. **Test infrastructure exists**: Playwright + `run_tests.py` + `add_fixture.py` + `run_live_url.py`. Build new fixtures, do not build a new runner.
4. **Verifier API surface is partially in place**: `resolveReference`, `verifyFragment`, `verifyFragmentByRef`. The orange pipeline likely introduces a new entry point (the V1 PRD names it `compareTextVsRef`); naming/shape is a plan-level decision.
5. **Five-color classification is incomplete**: green and red exist; yellow, light blue, and orange must be added. Yellow and orange both require the page-stated-ref vs global-search comparison.
6. **Authentic-text swap is new in V1**: no swap engine exists yet.
7. **Findings panel is new in V1**: only a bare popup exists; both panel surfaces must be designed.
8. **Settings persistence is new in V1**: nothing is currently saved to `chrome.storage.local`.

The plan should structure work to match the V1 PRD's Milestones A–E (verifier + orange / orange precision-recall tuning / authentic-text swap / findings panel + actions / test infrastructure + polish), with the Beta gate as the final acceptance.

---

## 6. Out-of-V1 Threads Worth Remembering

These came up in scoping but were intentionally deferred. They are not work for now; they are notes so a future spec (Feature 002+) does not have to rediscover them.

- **Writer-side assist (V1.2+)**: real-time composer support for authors typing Quran citations. Mission-level companion to the reader-side audit; shares the same data/normalization/matching layer. Mentioned in `mission.md` and constitution Principle I.
- **English / transliteration citation support (V2)**: doubles surface area without doubling value while V1 reader-side is still being trusted.
- **autoInteractive mode (V1.1)**: auto-scan on page load. Deferred until manual-scan works flawlessly and the performance/privacy/false-positive surfaces are characterized.
- **Per-user accounts, telemetry, cloud sync (out of V1)**: V1 is local-only by design.
- **Non-Chromium browsers (post-V1)**: Firefox/Edge port after V1 stabilizes.
- **Researcher / Editor headless API (V2)**: the verifier design should not preclude this, but no API surface is built in V1.
