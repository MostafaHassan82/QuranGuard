# Phase 0 Research — Appearance / Theme System

The Technical Context in `plan.md` had no `NEEDS CLARIFICATION` markers. Research here resolves the three live design questions the spec deliberately left to the plan, plus best-practice notes for each.

---

## Decision 1 — How a theme is "applied": attribute scoping vs. dynamic CSS swap

**Decision**: Each theme owns one CSS file. Every selector in it is scoped under a `[data-theme="<id>"]` attribute selector on `<html>` (popup, options) or on the sidebar panel root element. All theme CSS files are linked unconditionally on every surface; switching themes is a one-line attribute change on a single element.

**Rationale**:
- Zero runtime JS work to switch themes. No stylesheet inject/remove, no rebuild of element trees. The browser's normal CSS engine restyles in place when the attribute changes — one frame.
- Survives FOUC trivially: the bootstrap script just sets the attribute before paint; whatever stylesheet was already cached applies immediately.
- Inspectable: every theme's rules are visible in devtools at all times; conflicts surface during development, not in production.
- Extensible: adding a theme is one new `<link>` per surface and one registry entry. Removing a theme is just deleting the file and the entry; the fallback (FR-007) silently demotes orphaned preferences to default.

**Alternatives considered**:
- *Dynamic stylesheet injection* (insert/remove `<link>` tags on theme change). Rejected: more runtime moving parts, harder to prevent FOUC on first paint when the sidebar is injected mid-page, and complicates devtools inspection.
- *CSS custom properties only, no per-theme files* (one variables block per theme, all rules use `var(--*)`). Rejected: Mihrab is more than a palette swap — it has structural rules (verdict tile grid, sticky TOC, arched titles, custom font face). Forcing every theme into a variables-only mold would either constrain themes severely or smuggle structure into the default stylesheet.
- *Build step that generates per-theme bundles*. Rejected: constitution forbids a build step for V1.

**Best practice**: Each theme file ends with `[data-theme="<id>"] { ... }` wrappers. The default theme is encoded as the absence of a `data-theme` attribute (so existing rules in `popup.css` / `options.css` / `sidebar.css` continue to apply unchanged for users who never opt in — this is the FR-003 guarantee).

---

## Decision 2 — How to prevent the flash of unintended theme on first paint (FR-006, SC-006)

**Decision**: Inline `<script src="../js/themes/bootstrap.js"></script>` in the `<head>` of `popup.html` and `options.html`, placed **before** the `<link>` to the page's main stylesheet so it begins executing as the parser reaches it. The bootstrap synchronously sets `document.documentElement.dataset.theme = 'default'` first (so any prior async render uses the safe default), then asynchronously reads `chrome.storage.local['prefs.v1']`, and updates the attribute. To handle the brief window between parse and storage read, the bootstrap also adds a `theme-loading` class on `<html>` and removes it after the read; the default stylesheet ships a `html.theme-loading body { visibility: hidden }` rule. The popup and options page are extension surfaces with tiny markup; storage reads typically complete in 1–5 ms, well below perception threshold.

For the sidebar (injected into pages by the content script, NOT loaded from `sidebar.html` at runtime), `js/panel/sidebar-surface.js` already constructs the panel root before insertion. It reads `QuranPrefs` once at construction and sets `data-theme` on the panel root element before appending it to the DOM. No FOUC window because the element never exists in the DOM in an unstyled state.

**Rationale**:
- Inline early script + visibility-hidden body is the standard FOUC-prevention pattern for storage-backed themes; it does not require synchronous storage APIs (which don't exist in MV3 anyway).
- Sidebar construction-time application is strictly stronger: no flash possible.
- Both paths read prefs through the same `QuranPrefs.read()` to inherit its default-fill + clamp + legacy migration behavior.

**Alternatives considered**:
- *Read prefs in the service worker on startup and cache to `chrome.storage.session` for synchronous-feeling reads in the popup*. Rejected: the SW also starts cold; the saved round-trip is rarely material; adds a new storage surface for a 1–5 ms win.
- *Persist a copy of the theme in a cookie on the extension origin so it's available before async storage resolves*. Rejected: cookies aren't synced by Chrome profile sync, breaking FR-014. Pref storage is the canonical source.

---

## Decision 3 — How a theme registers and how the picker discovers it

**Decision**: `js/themes/registry.js` defines a single exported object — `QuranThemes.list` — an ordered array of theme descriptors. Each descriptor: `{ id, displayName, displayNameAr, defaultFor: 'never' | 'fresh-install' }`. The registry is the single source of truth: the Appearance picker iterates `list` to render options; `QuranPrefs` validates `appearance.theme` against `new Set(list.map(t => t.id))`; the bootstrap looks up the active descriptor to read any asset hints. Adding a theme = add one entry + add a `css/themes/<id>.css` file + add the `<link>` to each surface's HTML. The contract document (`contracts/theme-registry.md`) makes this explicit.

**Rationale**:
- Pure data, zero behavior in the registry. No theme can ship arbitrary JS — themes are appearance-only by construction (FR-008).
- The `<link>`-per-surface step is the one piece that isn't pure data; this is intentional. It keeps the contents of `<head>` explicit and easy to audit; with two themes plus default that's a one-line addition per surface and a small price for visibility. A future cleanup could move to a manifest-driven loader if the count grows.

**Alternatives considered**:
- *Dynamic `<link>` insertion driven entirely by the registry*. Rejected for now: pushes more work into JS (and earlier into page load) for a small ergonomic win. Re-evaluate if theme count exceeds ~5.
- *Filesystem convention — auto-discover anything in `css/themes/`*. Rejected: extensions can't enumerate their own packaged files at runtime without bundling a manifest anyway, so this reduces to (a) just with extra magic.

---

## Decision 4 — Manifest + content-script CSS for the sidebar

**Decision**: Add `css/themes/mihrab.css` to `manifest.json` `content_scripts[0].css` so it loads alongside `sidebar.css` into every page where the sidebar may appear. Since theme CSS is scoped under `[data-theme="<id>"]`, having it loaded everywhere is inert until the panel surface sets the attribute. Each future theme adds one line to the manifest.

**Rationale**:
- Symmetric with how `sidebar.css` is already loaded.
- Avoids needing `chrome.scripting.insertCSS` at panel-construction time, which would complicate the existing surface construction code.

**Alternatives considered**:
- *Inject theme CSS via `chrome.scripting.insertCSS` only when a non-default theme is selected*. Rejected: saves a few KB per content-script load but adds an async dependency to panel construction; not worth the complexity for two themes.

---

## Decision 5 — Where the Appearance picker lives in the options page

**Decision**: A new "Appearance" section, placed near the top of the options page (above the rendering/replacement controls so it's discoverable on first scan — SC-004). Renders as a radio group of theme cards: each card shows the theme's display name in Arabic and English, and a small swatch of its primary palette (drawn from the registered theme by inline CSS using the theme's variables). The currently-active theme card is visually selected; clicking another card calls `QuranPrefs.patch({ appearance: { theme: id } })` and immediately re-sets `document.documentElement.dataset.theme` on the options page so the user sees the change.

**Rationale**:
- Radio cards are the standard discoverable pattern for "pick one of a small set." Two cards now, scales to ~5–6 before it needs a different layout.
- Same-page live preview satisfies US5 ("can tell which is active") and the second clause of FR-004 ("apply without reload").

**Alternatives considered**:
- *Dropdown `<select>`* — less discoverable, no preview. Rejected.
- *Standalone preview page with screenshots* — too heavy; the live preview on the options page already shows the user the chrome treatment immediately.

---

## Decision 6 — Forced-colors / high-contrast handling (FR-009)

**Decision**: Each theme file ends with an `@media (forced-colors: active)` block that resets the theme's color customizations to system colors (`Canvas`, `CanvasText`, `LinkText`, `Highlight`, `ButtonFace`) for the page chrome, while leaving the verdict color classes (`.v-green`, `.v-yellow`, etc.) at their semantic values (they are domain signals, not decoration). The verdict color classes in the existing default stylesheet already follow this pattern; themes inherit it because their `[data-theme="<id>"]` selectors don't override the verdict classes.

**Rationale**: Honors the OS contrast mode for chrome (where it matters for legibility) while preserving the constitution-mandated taxonomy semantics. A theme that genuinely cannot honor forced-colors gracefully degrades because the OS overrides the chrome anyway.

---

## Decision 7 — Font asset handling (FR-010)

**Decision**: The Mihrab `@font-face` declaration in `css/themes/mihrab.css` includes a `local()` fallback chain ahead of the bundled `woff2` `url()`, and the cascading `font-family` ends with `'Amiri', 'Scheherazade New', 'Traditional Arabic', serif`. If the bundled font fails to load (offline + cache miss, blocked), the browser uses the next available system Arabic serif; layout is unaffected because `font-display: swap` is set.

**Rationale**: Standard webfont fallback. The bundled `woff2` files in `resources/fonts/` are already present on this branch.

---

## Decision 8 — Test approach (SC-005, SC-007)

**Decision**: Three categories of tests, all under the existing Playwright runner:

1. **Smoke**: open the options page with a fresh profile; pick Mihrab; assert `<html data-theme="mihrab">` on options, then open the popup against a known fixture and assert the same; trigger the sidebar and assert the panel root has `data-theme="mihrab"`.
2. **Persistence**: pick Mihrab, restart the test browser context, re-open the popup and assert `data-theme="mihrab"` on first paint (no `theme-loading` class visible after document-ready).
3. **Regression sweep**: run a small subset of the existing reader-side and writer-side fixtures (one of each verdict color + one autocomplete fixture) twice — once under default, once under Mihrab — and assert `window.__quranScan` results match between runs. Also assert verdict color elements have identical computed background-color in both runs (because verdict classes are unchanged by themes). This is the FR-008 / SC-005 gate.

A trivial stub theme (e.g., `css/themes/_stub.css` adding a single accent rule + a registry entry behind a development flag) demonstrates SC-007 during development; it does NOT ship.

**Rationale**: Reuses the existing test harness; adds no new test framework.

---

## Open questions

None. Phase 1 can proceed.
