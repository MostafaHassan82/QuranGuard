# Implementation Plan: Appearance / Theme System

**Branch**: `004-appearance-themes` | **Date**: 2026-06-06 (amended 2026-06-07) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-appearance-themes/spec.md`

## Summary

Add a small Appearance system that lets the user pick a visual theme for the three extension surfaces (popup, options page, sidebar) and that defaults to today's UI. The system ships with two themes — `default` (the current UI, unchanged) and `mihrab` (the visual treatment already prototyped on this branch under `design/mihrab-preview.html` and partially applied in `css/popup.css`, `css/options.css`, `css/sidebar.css`). The architecture treats themes as data: a registry lists them; each theme owns a CSS file per surface scoped under a `[data-theme="<id>"]` attribute on `<html>` (popup, options) or on the panel root (sidebar). Adding a future theme means adding a registry entry and CSS files — no edits to the entry points. Preference rides on the existing `prefs.v1` chrome.storage.local schema (new `appearance.theme` key), inheriting its persistence and Chrome-sync-compatible behavior. FOUC is prevented with an at-`document_start` bootstrap that reads the persisted theme and sets the attribute before first paint; the sidebar applies its theme as part of panel surface construction.

### Amendment — 2026-06-07: four additional themes

The MVP (default + mihrab) shipped with the architecture deliberately built so that further themes are pure data + per-theme CSS. This amendment realizes US4 by promoting the four remaining preview-only designs in `design/` (atelier, diwan, marakeb, tahrir) into full themes selectable from the picker. No architectural change: each theme is a registry entry plus three CSS files (`<id>-popup.css`, `<id>-options.css`, `<id>-sidebar.css`) under `css/themes/`, plus three additions to `manifest.json` `content_scripts[0].css`, plus two `<link>` tags each in `html/popup.html` and `html/options.html`, plus four i18n strings (AR/EN name + AR/EN description). This is the lived verification of SC-007: adding a theme requires changes only within that theme's own asset surface.

Visual reference for each theme is the corresponding HTML in `design/`:

| Theme | Register | Source preview | Palette anchors |
|---|---|---|---|
| atelier | Editorial · Parchment | `design/atelier-preview.html` | ink `#1a1410`, gold-leaf `#b8860b`, parchment `#f5efe3` |
| diwan | Soft modern · Calm | `design/diwan-preview.html` | green `#0b5d3b`, sage `#5ba87a`, mint `#f0f7f1` |
| marakeb | Terminal · Dark | `design/marakeb-preview.html` | bg `#0a0e0c`, phosphor `#6ee7b7`, brass `#c8a24a` |
| tahrir | Newspaper · High contrast | `design/tahrir-preview.html` | ink `#1a1a1a`, accent green `#0b5d3b`, broadsheet cream `#f4f0e6` |

## Technical Context

**Language/Version**: Vanilla JavaScript (ES2020), no build step. CSS3 with attribute selectors, native nesting (Chromium 112+), and CSS custom properties.

**Primary Dependencies**: Chrome Extensions MV3 APIs (`chrome.storage.local`, `chrome.runtime`); no third-party runtime libraries. Tests use Playwright via `tests/run_tests.py` plus the Node `*_check.js` suite.

**Storage**: `chrome.storage.local` only, key `prefs.v1` (existing). Adds one top-level field: `appearance: { theme: '<id>' }`. Read/write/clamp via `js/storage/prefs.js`. Unknown theme ids silently fall back to default per FR-007.

**Testing**: `tests/theme_registry_check.js` (Node) enforces the registry contract. Playwright fixtures re-run under each shipped theme to validate SC-005 (zero functional regression). Manual MV3 verification of cross-surface live-update gates (the harness lacks an MV3 surface loader — pre-existing limitation, documented in tasks.md T026/T027/T044).

**Target Platform**: Chromium-based browsers, Manifest V3, RTL-first Arabic UI on the three surfaces.

**Project Type**: Single browser extension. No backend.

**Performance Goals**: Theme attribute applied within one frame of opening any surface (no observable flash). Picker change-to-applied across all three surfaces in under 1 s (SC-001). No measurable popup or sidebar paint regression vs. default theme on any of the six shipped themes.

**Constraints**: No remote font loading (constitution Technology Constraints). No third-party UI framework. CSS only — theme switching must NOT require re-rendering DOM trees, only restyling. Existing verdict color taxonomy and severity ordering MUST survive every theme (constitution Principle II, FR-008). Each theme's hero font (if any) ships bundled in `resources/fonts/` with a `local()` fallback chain and `font-display: swap`.

**Scale/Scope**: 6 themes in this release after the amendment (`default`, `mihrab`, `atelier`, `diwan`, `marakeb`, `tahrir`). Registry sized for ~10 themes without restructuring. Three entry-point surfaces touched (popup, options, sidebar). One existing prefs field (no schema delta beyond what the MVP already shipped). Four new content-script CSS bundles added to `manifest.json` (one set of three per new theme).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution (v2.0.0) defines six principles. Theme work is explicitly named in Principle I as **secondary** to verifier trustworthiness — that is acceptable provided this feature does not regress the verifier and does not consume scope budget reserved for integrity work. Gate evaluation:

| Principle | Gate | Verdict |
|---|---|---|
| I. Integrity Is the Only North Star | Does this feature regress reader-side audit, writer-side autocomplete, or the authentic-text render? | **PASS** — theme system is CSS + a single pref key; no verifier, normalizer, classifier, or matcher code is touched. The four new themes add only `css/themes/<id>-*.css` files and registry data. SC-005 explicitly gates on "zero functionality regressions" validated by re-running existing fixtures under each theme. |
| II. Highlight Taxonomy Is Fixed (5 verdicts + 1 provenance) | Does any theme collapse, relabel, or extend the verdict colors? | **PASS** — FR-008 mandates every selectable theme preserve verdict semantics. Grep-enforced: zero `.v-green`/`.v-yellow`/`.v-orange`/`.v-red`/`.v-lightBlue`/`.v-lightGreen` rules permitted in any theme CSS file. Themes restyle chrome (headers, cards, dividers, ornament); verdict cells inherit the base color taxonomy from `css/popup.css`/`options.css`/`sidebar.css`. |
| III. Integrity Across Severity (Red > Yellow > Orange) | Does any theme alter severity ordering or visual prominence? | **PASS** — themes never reorder verdict cells. Tile-grid layout (Mihrab) and any new theme layouts must preserve the same severity sort key emitted by the panel model. |
| IV. Authentic-Text Replacement Is the Default Render | Does any theme alter replacement behavior or its toggles? | **PASS** — replacement is behavior in the render pipeline; themes only restyle. |
| V. Porting Discipline (advanced copy is read-only reference) | Are we porting code from `QuranChromePlugin`? | **PASS** — the advanced copy has no theme system; nothing to port. The four new themes are authored from the `design/*-preview.html` mock-ups on this branch. |
| VI. Fixtures Are the Quality Gate | Does this feature change fixture pass behavior? | **PASS** — fixture pass rate is invariant under theme choice. SC-005 turns this into a positive gate. |

**Result**: All gates pass with no violations. Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-appearance-themes/
├── plan.md                  # This file
├── research.md              # Phase 0 — design decisions resolved
├── data-model.md            # Phase 1 — prefs delta + Theme entity (unchanged by amendment)
├── quickstart.md            # Phase 1 — how to add a theme; how to test
├── contracts/
│   ├── theme-registry.md    # How themes register and how the picker discovers them
│   └── storage-prefs.md     # `prefs.v1.appearance` schema delta
├── checklists/
│   └── requirements.md      # Spec quality checklist
└── tasks.md                 # Phase 2 — task list (extended by amendment with T048+)
```

### Source Code (repository root)

```text
QuranAuditPlugin/
├── manifest.json                       # MODIFIED — add 4 × 3 theme CSS files to content_scripts.css
├── html/
│   ├── popup.html                      # MODIFIED — 4 new <link> tags (one per new theme's popup CSS)
│   ├── options.html                    # MODIFIED — 4 new <link> tags (one per new theme's options CSS)
│   └── sidebar.html                    # unchanged — sidebar is content-injected, themed via sidebar-surface.js
├── css/
│   ├── popup.css                       # unchanged — base/default styling
│   ├── options.css                     # unchanged
│   ├── sidebar.css                     # unchanged
│   └── themes/
│       ├── mihrab-popup.css            # unchanged
│       ├── mihrab-options.css          # unchanged
│       ├── mihrab-sidebar.css          # unchanged
│       ├── atelier-popup.css           # NEW
│       ├── atelier-options.css         # NEW
│       ├── atelier-sidebar.css         # NEW
│       ├── diwan-popup.css             # NEW
│       ├── diwan-options.css           # NEW
│       ├── diwan-sidebar.css           # NEW
│       ├── marakeb-popup.css           # NEW
│       ├── marakeb-options.css         # NEW
│       ├── marakeb-sidebar.css         # NEW
│       ├── tahrir-popup.css            # NEW
│       ├── tahrir-options.css          # NEW
│       └── tahrir-sidebar.css          # NEW
├── js/
│   ├── themes/
│   │   ├── registry.js                 # MODIFIED — append 4 descriptors (id, displayName{Ar}, swatchA, swatchB)
│   │   └── bootstrap.js                # unchanged
│   ├── storage/prefs.js                # unchanged
│   ├── shared/i18n.js                  # MODIFIED — 16 new strings (4 themes × {name, desc} × {AR, EN})
│   ├── options.js                      # unchanged (loops over QuranThemes.list)
│   ├── popup.js                        # unchanged
│   └── panel/sidebar-surface.js        # unchanged
├── resources/fonts/                    # MODIFIED — one bundled hero face per theme (see research.md fonts table)
└── tests/
    └── theme_registry_check.js         # unchanged — assertion auto-covers new entries via list length + id regex
```

**Structure Decision**: No new directories. The amendment is additive — twelve new CSS files in the existing `css/themes/` folder, four new lines in the registry, sixteen new i18n strings, four-times-three new manifest entries, eight new HTML `<link>` tags. Confirms SC-007 in lived practice: zero edits to `popup.js`, `options.js`, `sidebar-surface.js`, `bootstrap.js`, `prefs.js`, or the base CSS files.

## Complexity Tracking

> Empty — Constitution Check passed all gates.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| (none) | — | — |
