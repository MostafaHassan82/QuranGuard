# Implementation Plan: Appearance / Theme System

**Branch**: `004-appearance-themes` | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-appearance-themes/spec.md`

## Summary

Add a small Appearance system that lets the user pick a visual theme for the three extension surfaces (popup, options page, sidebar) and that defaults to today's UI. The system ships with two themes — `default` (the current UI, unchanged) and `mihrab` (the visual treatment already prototyped on this branch under `design/mihrab-preview.html` and partially applied in `css/popup.css`, `css/options.css`, `css/sidebar.css`). The architecture treats themes as data: a registry lists them; each theme owns a single CSS file scoped under a `[data-theme="<id>"]` attribute on `<html>` (popup, options) or on the panel root (sidebar). Adding a future theme means adding a registry entry and a CSS file — no edits to the entry points. Preference rides on the existing `prefs.v1` chrome.storage.local schema (new `appearance.theme` key), inheriting its persistence and Chrome-sync-compatible behavior. FOUC is prevented with an at-`document_start` bootstrap that reads the persisted theme and sets the attribute before first paint; the sidebar applies its theme as part of panel surface construction.

## Technical Context

**Language/Version**: Vanilla JavaScript (ES2020), no build step. CSS3 with attribute selectors and CSS custom properties.

**Primary Dependencies**: Chrome Extensions MV3 APIs (`chrome.storage.local`, `chrome.runtime`); no third-party runtime libraries. Tests use Playwright via `tests/run_tests.py`.

**Storage**: `chrome.storage.local` only, key `prefs.v1` (existing). Adds one new top-level field: `appearance: { theme: '<id>' }`. Read/write/migrate via the existing `QuranPrefs` module (`js/storage/prefs.js`).

**Testing**: Playwright fixtures under `tests/fixtures/` exercise the actual extension. Theme-system tests verify (a) picker round-trip in the options page, (b) data-theme attribute is set on first paint for popup/options/sidebar, (c) the existing reader-side and writer-side fixture suites still pass under each shipped theme.

**Target Platform**: Chromium-based browsers, Manifest V3, RTL-first Arabic UI (`<html dir="rtl" lang="ar">` on the three surfaces).

**Project Type**: Single browser extension. No backend; no frontend/backend split.

**Performance Goals**: Theme attribute applied within one frame of opening any surface (no observable flash). Picker change-to-applied across all three surfaces in under 1 s end-to-end (SC-001). No measurable increase in popup or sidebar paint time vs. the default theme.

**Constraints**: No remote font loading (constitution Technology Constraints). No third-party UI framework. CSS only — theme switching must NOT require re-rendering DOM trees, only restyling. Existing verdict color taxonomy and severity ordering MUST survive every theme (constitution Principle II, FR-008).

**Scale/Scope**: 2 themes in this release (`default`, `mihrab`). Registry sized for ~10 themes without restructuring. Three entry-point surfaces touched (popup, options, sidebar). One new prefs field. One new content-script CSS bundle (the registry + each theme's CSS file) added to `manifest.json`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution (v2.0.0) defines six principles. Theme work is explicitly named in Principle I as **secondary** to verifier trustworthiness — that is acceptable provided this feature does not regress the verifier and does not consume scope budget reserved for integrity work. Gate evaluation:

| Principle | Gate | Verdict |
|---|---|---|
| I. Integrity Is the Only North Star | Does this feature regress reader-side audit, writer-side autocomplete, or the authentic-text render? | **PASS** — theme system is CSS + a single new pref key; no verifier, normalizer, classifier, or matcher code is touched. SC-005 explicitly gates on "zero functionality regressions" validated by re-running existing fixtures under each theme. |
| II. Highlight Taxonomy Is Fixed (5 verdicts + 1 provenance) | Does any theme collapse, relabel, or extend the verdict colors? | **PASS** — FR-008 mandates every selectable theme preserve the exact verdict semantics. Themes change hue scaffolding (page chrome, headings, decorative elements) only; the six verdict colors and their meanings are constants validated by the test sweep. |
| III. Integrity Across Severity (Red > Yellow > Orange) | Does any theme alter severity ordering or visual prominence of severity? | **PASS** — themes do not reorder or de-emphasize verdict cells. Verdict tile grid layout (introduced on this branch for Mihrab) preserves the same severity ordering as the default list view. |
| IV. Authentic-Text Replacement Is the Default Render | Does any theme alter the replacement behavior or its toggles? | **PASS** — replacement is a behavior in the render pipeline; themes only restyle. The master toggle and per-color overrides in the popup remain functionally identical under every theme. |
| V. Porting Discipline (advanced copy is read-only reference) | Are we porting code from `QuranChromePlugin`? | **PASS** — the advanced copy has no theme system; nothing to port. The Mihrab CSS was authored fresh on this branch. |
| VI. Fixtures Are the Quality Gate | Does this feature change fixture pass behavior? | **PASS** — fixture pass rate is invariant under theme choice. SC-005 turns this into a positive gate: existing fixtures run unchanged under each shipped theme. |

**Result**: All gates pass with no violations. Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-appearance-themes/
├── plan.md              # This file
├── research.md          # Phase 0 — design decisions resolved
├── data-model.md        # Phase 1 — prefs delta + Theme entity
├── quickstart.md        # Phase 1 — how to add a theme; how to test
├── contracts/
│   ├── theme-registry.md    # How themes register and how the picker discovers them
│   └── storage-prefs.md     # `prefs.v1.appearance` schema delta
└── checklists/
    └── requirements.md   # Spec quality checklist (created by /speckit-specify)
```

### Source Code (repository root)

```text
QuranAuditPlugin/
├── manifest.json                       # MODIFIED — add theme CSS files to content_scripts.css
├── html/
│   ├── popup.html                      # MODIFIED — link theme registry CSS + bootstrap
│   ├── options.html                    # MODIFIED — link theme registry CSS + bootstrap + add Appearance section
│   └── sidebar.html                    # MODIFIED — link theme registry CSS (the dev preview file; runtime sidebar is injected by content script)
├── css/
│   ├── popup.css                       # MODIFIED — remove Mihrab-only rules; keep default; Mihrab-only rules move to themes/mihrab.css
│   ├── options.css                     # MODIFIED — same
│   ├── sidebar.css                     # MODIFIED — same
│   └── themes/
│       ├── mihrab.css                  # NEW — every Mihrab rule, scoped under [data-theme="mihrab"] selectors
│       └── (future) atelier.css, diwan.css, marakeb.css, tahrir.css
├── js/
│   ├── themes/
│   │   ├── registry.js                 # NEW — list of theme descriptors (id, displayName, asset hints)
│   │   └── bootstrap.js                # NEW — at-document_start bootstrap: read prefs, set data-theme on documentElement (popup, options) or on panel root (sidebar surface)
│   ├── storage/prefs.js                # MODIFIED — add `appearance: { theme }` field with default-fill + clamp
│   ├── options.js                      # MODIFIED — render Appearance picker; wire change → QuranPrefs.patch
│   ├── popup.js                        # MODIFIED — call bootstrap on load
│   └── panel/sidebar-surface.js        # MODIFIED — apply data-theme to the panel root element from prefs
├── resources/fonts/
│   ├── amiri-arabic-400.woff2          # already present (untracked) — ships with Mihrab
│   └── amiri-arabic-700.woff2          # already present (untracked) — ships with Mihrab
└── tests/
    └── fixtures/                       # existing fixtures re-run under each theme (SC-005)
```

**Structure Decision**: A single browser-extension project. No new top-level directories. Two small additions: `css/themes/` for per-theme stylesheets, `js/themes/` for the registry and bootstrap. Everything else is in-place edits. This matches the project's vanilla-JS no-build-step convention and keeps the theme system inspectable in the Chrome devtools sources panel.

## Complexity Tracking

> Empty — Constitution Check passed all gates.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| (none) | — | — |
