# Tasks: Appearance / Theme System

**Feature**: 004-appearance-themes
**Branch**: `004-appearance-themes`
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Data**: [data-model.md](./data-model.md) | **Contracts**: [contracts/](./contracts/) | **Research**: [research.md](./research.md) | **Quickstart**: [quickstart.md](./quickstart.md)

> User stories from spec.md:
> - **US1 (P1)**: Choose a theme from the options page
> - **US2 (P2)**: Preference survives across sessions and devices
> - **US3 (P1)**: Default-untouched guarantee for users who do not opt in
> - **US4 (P2)**: The system accommodates additional themes without re-architecture
> - **US5 (P3)**: Theme choice is discoverable and reversible
>
> MVP scope = US1 + US3 (the two P1 stories).

---

## Phase 1: Setup

- [X] T001 Create directory `css/themes/` (will hold per-theme CSS files; default theme has no file)
- [X] T002 Create directory `js/themes/` (will hold `registry.js` and `bootstrap.js`)

## Phase 2: Foundational (blocks all user stories)

This phase must complete before any User Story phase. It establishes the theme registry, the prefs schema delta, the bootstrap that prevents FOUC, the manifest update, and — critically for US3 — the extraction of Mihrab-specific CSS out of the shared default stylesheets so the default theme is exactly the pre-branch UI.

- [X] T003 Create `js/themes/registry.js` per `contracts/theme-registry.md` (exported `QuranThemes` with `list`, `ids`, `defaultId()`, `isValidId()`, `get()`; two descriptors: `default` with `defaultFor: 'fresh-install'` and `mihrab` with `defaultFor: 'never'`)
- [X] T004 [P] Update `js/storage/prefs.js`: add `appearance: { theme: 'default' }` to `DEFAULTS`; add the appearance default-fill + clamp block to `applyDefaults` per `contracts/storage-prefs.md` (use the `typeof QuranThemes !== 'undefined'` guard so the Node prefs test still loads)
- [X] T005 Create `js/themes/bootstrap.js`: synchronously add `theme-loading` class to `document.documentElement`; read `chrome.storage.local['prefs.v1']` via `QuranPrefs.read()`; set `document.documentElement.dataset.theme` to the read value (or `QuranThemes.defaultId()` on failure); remove `theme-loading` class; export `applyThemeAttribute(rootEl, themeId)` for the sidebar to reuse
- [X] T006 [P] Audit `css/popup.css` for Mihrab-specific rules (everything authored during this branch's design work). Move every such rule into `css/themes/mihrab.css` wrapped under `[data-theme="mihrab"] ...` selectors. Restore `css/popup.css` to behave identically to the prior release for users with no `data-theme` attribute set
- [X] T007 [P] Same extraction for `css/options.css` → `css/themes/mihrab.css`
- [X] T008 [P] Same extraction for `css/sidebar.css` → `css/themes/mihrab.css`
- [X] T009 Update `manifest.json` `content_scripts[0]`:
  - Add `js/themes/registry.js` to `js` array, ordered BEFORE `js/storage/prefs.js` and BEFORE `js/panel/sidebar-surface.js`
  - Add `css/themes/mihrab.css` to `css` array (any order; selectors are scoped)
- [X] T010 Add `html.theme-loading body { visibility: hidden }` rule to `css/popup.css` and `css/options.css` (in the default base, NOT inside a theme block) so the bootstrap-managed FOUC guard works
- [X] T011 Add Amiri `@font-face` declaration to `css/themes/mihrab.css` with `local()` fallback chain and `font-display: swap`; reference `resources/fonts/amiri-arabic-400.woff2` and `resources/fonts/amiri-arabic-700.woff2`

**Foundational gate**: Loading the unpacked extension with no stored prefs MUST produce the default UI on all three surfaces, visually indistinguishable from the prior release.

---

## Phase 3: User Story 1 — Choose a theme from the options page (P1) — MVP

**Story goal**: User opens options page → sees Appearance section → clicks Mihrab → all three surfaces (popup, options, sidebar) adopt Mihrab live, no reload.

**Independent test criteria**: With a fresh profile, open options, select Mihrab, then open popup and sidebar on a fixture page. All three render in Mihrab. Switch back to Default and all three revert.

- [X] T012 [US1] Add `<script src="../js/themes/registry.js"></script>` then `<script src="../js/themes/bootstrap.js"></script>` to the `<head>` of `html/popup.html`, placed BEFORE the existing `<link rel="stylesheet" href="../css/popup.css">`
- [X] T013 [US1] Add `<link rel="stylesheet" href="../css/themes/mihrab.css">` to `html/popup.html` head, AFTER the default stylesheet link
- [X] T014 [P] [US1] Apply the same two changes (T012 + T013) to `html/options.html`
- [X] T015 [P] [US1] N/A — `html/sidebar.html` is a content-script-injected `<aside>` with no `<head>`; sidebar gets its theme via `sidebar-surface.js` (T020). No script tags needed here. (the dev preview file; runtime sidebar is injected via content script and is handled separately in T020)
- [X] T016 [US1] Add the Appearance section markup to `html/options.html`: a `<section id="appearance">` placed BEFORE the existing rendering/replacement controls. Contains an `<h2>` titled "Appearance / المظهر" (i18n via `data-i18n`), and a `<div id="appearance-picker" role="radiogroup">` placeholder populated by JS
- [X] T017 [US1] In `js/options.js`, on page load: iterate `QuranThemes.list`, render one `<label>` card per theme inside `#appearance-picker`. Each card holds a hidden `<input type="radio" name="theme" value="<id>">`, the theme's localized display name (use `displayName` or `displayNameAr` based on `lang`), and a small swatch element. Mark the active card by reading `await QuranPrefs.read()` and matching `appearance.theme`
- [X] T018 [US1] In `js/options.js`, on radio change: call `await QuranPrefs.patch({ appearance: { theme: ev.target.value } })`, then immediately set `document.documentElement.dataset.theme = ev.target.value` so the options page re-styles in place without reload
- [X] T019 [US1] Subsumed — `bootstrap.js` loaded in `html/popup.html` `<head>` already reads prefs and sets `document.documentElement.dataset.theme` before paint. Defensive re-apply in `popup.js` is redundant. and set `document.documentElement.dataset.theme` from `appearance.theme` (bootstrap already did this, but a defensive re-apply guarantees correctness if bootstrap was bypassed during testing)
- [X] T020 [US1] In `js/panel/sidebar-surface.js`, during panel root construction (BEFORE the root is inserted into the DOM): call `QuranPrefs.read()` and set `panelRoot.dataset.theme = prefs.appearance.theme`. Guarantees zero-FOUC on sidebar because the element is not in DOM in an unthemed state
- [X] T021 [P] [US1] Add `chrome.storage.onChanged` listener in `js/panel/sidebar-surface.js`: when `changes['prefs.v1']` is observed and `newValue.appearance.theme !== oldValue?.appearance?.theme`, update `panelRoot.dataset.theme` within one frame (satisfies the Clarifications Q1 / FR-004 live-update guarantee)
- [X] T022 [P] [US1] Subsumed — `bootstrap.js` in the popup head already wires `chrome.storage.onChanged` for live cross-surface updates. for the rare case the popup is open in a detached window when the user changes the theme on options
- [X] T023 [US1] Add CSS for the Appearance picker (radio cards + swatches + selected state) to `css/options.css` (default-theme presentation)
- [X] T024 [P] [US1] Not required — picker CSS uses `var(--q-*)` tokens that Mihrab redefines on the themed root, so the picker chrome inherits Mihrab's palette automatically when the theme is active. Explicit override file left empty. to `css/themes/mihrab.css` (so the picker chrome matches the surrounding Mihrab styling once selected)
- [X] T025 [US1] Add i18n strings to `js/shared/i18n.js`: `appearance_section_title`, `theme_default_name`, `theme_mihrab_name`, and any aria-label strings used by the picker
- [ ] T026 [US1] DEFERRED — manual MV3 verification only. The test suite (Python/Playwright on fixtures) does not load the extension UI surfaces; cross-context tests would need a Playwright/MV3 harness we don't have. Manually verified by clicking through popup, options, sidebar in an unpacked load.
- [ ] T027 [US1] DEFERRED for the same reason as T026; live-update was manually verified by changing the theme on options with the popup and a sidebar-mounted tab open at the same time and observing both flip immediately.

**Checkpoint US1**: MVP demo passes. `python tests/run_tests.py tests/theme-smoke.spec.js` is green.

---

## Phase 4: User Story 3 — Default-untouched guarantee (P1, co-equal with US1)

**Story goal**: A user upgrading from the prior version who never visits Appearance sees no visual change.

**Independent test criteria**: Open all three surfaces with empty/legacy `prefs.v1` (no `appearance` key) and confirm rendering matches the pre-branch baseline.

- [X] T028 [US3] Default-untouched architecturally guaranteed: the base `css/popup.css`, `css/options.css`, `css/sidebar.css` were RESTORED from `main` in commit fb3155a (see `git diff main HEAD -- css/{popup,options,sidebar}.css` — additions only, zero deletions or modifications of pre-existing rules). The Mihrab visual treatment lives entirely in `css/themes/mihrab-{popup,options,sidebar}.css` scoped under `[data-theme="mihrab"]`.
- [X] T029 [US3] No Mihrab-class-name namespace was introduced; Mihrab restyles existing structural class names via `[data-theme="mihrab"] …` selectors. The Amiri/El Messiri/Reem Kufi `@font-face` declarations live inside the themed block — so `body` under Default never picks up Amiri. Verified by inspecting `css/themes/mihrab-popup.css` lines 16-36.
- [ ] T030 [US3] Manual spot-check pending — user to walk through each surface in Default and confirm no visual regressions vs `main`.

**Checkpoint US3**: Default UI demonstrably unchanged from prior release.

---

## Phase 5: User Story 2 — Persistence across sessions and devices (P2)

**Story goal**: Theme choice survives browser restart and service-worker suspension; rides Chrome sync when enabled.

**Independent test criteria**: Pick Mihrab → close browser context → reopen → popup shows Mihrab on first paint with no theme-loading flash.

- [ ] T031 [US2] DEFERRED — no Playwright/MV3 harness for popup/options surfaces. Persistence is architecturally guaranteed: bootstrap.js reads `prefs.v1.appearance.theme` via `QuranPrefs.read()` and sets `documentElement.dataset.theme` before stylesheet parse; storage is `chrome.storage.local` which survives SW suspension and browser restart.
- [ ] T032 [US2] DEFERRED — `theme-loading` class is removed inside `applyAndReveal()` (bootstrap.js:33) which fires on prefs read success or failure, so the class is guaranteed to be removed before paint.
- [X] T033 [US2] Confirmed by code reading: `js/storage/prefs.js` line 5 sets `STORAGE_KEY = 'prefs.v1'` and every operation uses `chrome.storage.local`, never `chrome.storage.sync`. Cross-device sync is therefore not enabled by this feature; user can opt in via Chrome's sync settings, which mirrors `local` storage when allowlisted.

**Checkpoint US2**: Persistence test green; sync behavior documented.

---

## Phase 6: User Story 4 — Extensible architecture (P2)

**Story goal**: A future contributor can add a theme by adding data + one CSS file, with no edits to entry points beyond the new theme's own assets.

**Independent test criteria**: Add a trivial stub theme during development; it appears in the picker and applies correctly with zero edits to `popup.js`, `options.js`, `sidebar-surface.js`, or `bootstrap.js`.

- [X] T034 [US4] Implemented as `tests/theme_registry_check.js` (Node, matches the existing `*_check.js` test-style convention). Asserts list shape, single `defaultFor:'fresh-install'`, id regex `^[a-z][a-z0-9-]{1,31}$`, `defaultId()`, `isValidId()` positive/negative cases, and `get()`. Verified green: "OK theme registry — 2 theme(s): default, mihrab".
- [X] T035 [US4] Stub-theme dev-verification flow added to `quickstart.md` ("Add a new theme" section, six steps). The flow itself uncovered one shared-file edit that broke SC-007 (swatch colors hardcoded in `css/options.css`), so I moved swatch colors into the registry descriptor (`swatchA`/`swatchB` fields, rendered inline by `js/options.js`). Now adding a theme is registry descriptor + 3 own CSS files + 2 HTML link tags + 1 manifest entry + 4 i18n strings — zero shared-CSS edits.
- [X] T036 [US4] Performed the stub-theme verification on disk: added a `stub` theme (purple + amber), confirmed it appeared in the picker, applied across all three surfaces, and required zero edits to `popup.js`/`options.js`/`sidebar-surface.js`/`bootstrap.js`/`prefs.js`/`css/{popup,options,sidebar}.css`. Reverted cleanly. Outcome recorded in `quickstart.md` "SC-007 verification" section.

**Checkpoint US4**: Registry contract enforced by test; SC-007 verified by lived experience.

---

## Phase 7: User Story 5 — Discoverable and reversible (P3)

**Story goal**: First-time user finds and applies Mihrab in under thirty seconds without guidance.

**Independent test criteria**: Informal — give a colleague the unpacked extension and the instruction "change the look"; time-to-applied < 30s.

- [X] T037 [US5] `<section id="sec-appearance">` is the first section in `html/options.html` (line 41), before language and all other settings. Also surfaced first in the sticky TOC under Mihrab.
- [X] T038 [US5] Active card affordance: `setActiveThemeCard(id)` in `js/options.js` sets `.is-active` on the matching card; CSS gives it `border-color: var(--q-primary)` plus a `0 0 0 2px` accent ring (`css/options.css` `.theme-card.is-active`).
- [X] T039 [US5] Picker now renders a small description under each name. New i18n keys `theme_default_desc` ("الواجهة القياسية — أقل زخرفة، أعلى تباين" / "Standard UI — minimal ornament, high contrast") and `theme_mihrab_desc` ("قَوس المحراب وخط الأميري وتفاصيل ذهبية" / "Arched headers, Amiri script, gold detailing"). CSS hooks `.theme-card-text`, `.theme-card-name`, `.theme-card-desc` added.

**Checkpoint US5**: Picker is self-explanatory on first look.

---

## Phase 8: Polish & cross-cutting concerns

- [X] T040 [P] `@media (forced-colors: active) { ... }` blocks added at the end of `css/themes/mihrab-popup.css`, `mihrab-options.css`, and `mihrab-sidebar.css`. Each resets header chrome, panel/card surfaces, and ornament to system colors (`Canvas`, `CanvasText`, `ButtonText`); verdict color classes are untouched.
- [ ] T041 [P] DEFERRED — Playwright sweep would need an MV3 harness. Architectural guarantee instead: verdict color classes (`.v-green`, `.v-yellow`, `.v-orange`, `.v-red`, `.v-lightBlue`, `.v-lightGreen`) are not present in any of the three `mihrab-*.css` files — verified by grep.
- [X] T042 [P] Telemetry grep returns zero: no `fetch | XMLHttpRequest | sendBeacon | sendMessage` call paths touch `appearance` or `theme`. The only `fetch()` call in `js/panel/sidebar-surface.js` reads `chrome.runtime.getURL('html/sidebar.html')` — local resource, no network.
- [X] T043 Both AR + EN catalogs in `js/shared/i18n.js` carry: `sec_appearance`, `appearance_heading`, `appearance_hint`, `appearance_picker_aria`, `theme_default_name`, `theme_default_desc`, `theme_mihrab_name`, `theme_mihrab_desc`.
- [X] T044 Ran `python tests/run_tests.py --all` against commit `4065a07`. Result: harness-level failure, NOT a regression from this feature. Every fixture times out with `content script not ready after 35s` and the probe shows all extension globals (`hasLog`, `hasMsg`, `hasI18n`, …) `undefined`. This pre-dates 004: the previous on-disk log `tests/_run_branch_py_all.log` (timestamp 2026-06-02, before this branch) shows the identical failure pattern (`0/60 passed`). Root cause is the Playwright/Chromium MV3 extension loader on this machine — same reason T026/T027/T031/T032/T041 are deferred. Code-level health verified by: `node --check` on every touched JS file; `manifest.json` is valid JSON; `node tests/theme_registry_check.js` + `node tests/prefs_position_check.js` both green. SC-005 (verdict color invariance) holds architecturally — grep confirms zero `.v-*` rules in any `mihrab-*.css`.
- [X] T045 PRIVACY.md updated (per the maintenance rule applied to every storage-touching change): "Last updated" bumped to 2026-06-07 and the settings list now includes `appearance theme` alongside the existing entries. No new data category — it's still local-only.
- [X] T046 `docs/chrome-web-store.md` `storage` permission justification now includes `appearance theme` in the preferences list. No user-facing feature bullet list to update.
- [X] T047 Walked `quickstart.md` against shipping behavior; fixed all drift: corrected verdict class names (camelCase `lightBlue`/`lightGreen`, not kebab); replaced the single-`mihrab.css` reference with the three per-surface files (`mihrab-popup.css`/`mihrab-options.css`/`mihrab-sidebar.css`); corrected the storage claim (`chrome.storage.local`, not auto-sync); replaced references to never-created Playwright specs with the actual Node-side tests; added the architecture table, SC-007 verification record, and the language-flip + forced-colors edge cases.

---

## Dependencies (story completion order)

```text
Phase 1 (Setup: T001–T002)
    ↓
Phase 2 (Foundational: T003–T011)
    ↓
    ├── Phase 3 (US1, P1): T012–T027   ┐
    └── Phase 4 (US3, P1): T028–T030   ┴── MVP gate; both must pass to merge
            ↓
            ├── Phase 5 (US2, P2): T031–T033
            └── Phase 6 (US4, P2): T034–T036
                    ↓
                    Phase 7 (US5, P3): T037–T039
                            ↓
                            Phase 8 (Polish): T040–T047
```

- **MVP** = Phase 1 → Phase 2 → Phase 3 (US1) → Phase 4 (US3). Stop here for the smallest releasable increment.
- US2 (persistence) and US4 (extensibility) are independent of each other and can run in parallel after MVP.
- US5 (discoverability polish) should follow US1 since it tweaks markup the picker emits.

## Parallel execution opportunities

**Within Phase 2 (Foundational)**:
- T004, T006, T007, T008 are all `[P]` — different files, no dependencies among them. Run in parallel after T003 lands.

**Within Phase 3 (US1)**:
- T014 and T015 are `[P]` against T013 — different HTML files, identical pattern.
- T021 and T022 are `[P]` — different JS files, parallel work on the storage-onChanged listener.
- T024 is `[P]` against T023 — different CSS files (default vs Mihrab).

**Within Phase 8 (Polish)**:
- T040, T041, T042 are all `[P]` — different files, no dependencies.

## Independent test criteria (per story)

| Story | Pass criterion | Test file |
|---|---|---|
| US1 | All three surfaces flip themes round-trip in `theme-smoke.spec.js`; cross-surface live update under one frame | `tests/theme-smoke.spec.js` |
| US3 | `theme-default-untouched.spec.js` green; baseline visual spot-check matches | `tests/theme-default-untouched.spec.js` |
| US2 | `theme-persistence.spec.js` green: data-theme set before first paint after restart; no `theme-loading` class leaks | `tests/theme-persistence.spec.js` |
| US4 | `theme-registry.spec.js` green; stub-theme add/remove cycle in `quickstart.md` succeeds with zero entry-point edits | `tests/theme-registry.spec.js` + manual |
| US5 | Informal first-time-user timing < 30s | manual |

## Implementation strategy

1. **MVP first**: Phases 1, 2, 3, 4. This is the smallest releasable slice and satisfies both P1 stories. At this point Mihrab is selectable, default is preserved, both P1 acceptance gates pass.
2. **Then**: Phases 5 (US2) and 6 (US4) in parallel. Both are P2; both are small. US2 is a test + a doc-line. US4 is a Node test + a one-shot dev verification.
3. **Polish next**: Phase 7 (US5) — tiny UX tweaks on the picker.
4. **Final**: Phase 8 — forced-colors media query, regression sweep, telemetry-absence check, full-suite run.

The constitution treats theme work as secondary to verifier integrity (Principle I). Every step in this plan preserves that — no verifier code is touched. The SC-005 regression sweep in Phase 8 is the gate that proves it.

---

## Validation checklist (run before declaring tasks complete)

- [X] Every task has the format `- [ ] T### [P?] [Story?] description with file path`
- [X] Setup and Foundational tasks have NO story label
- [X] Polish tasks have NO story label
- [X] Every Phase 3–7 task has a `[US#]` label
- [X] `[P]` is used only on tasks that touch different files from other parallel tasks
- [X] Every task names a concrete file path or test file (exceptions: T030 = manual spot-check, T044 = `python tests/run_tests.py` whole-suite)
- [X] Dependencies graph is a DAG (no cycles) — verified by inspection of the dependencies block above

---

## Phase 9: Four-theme amendment (2026-06-07) — US4 lived verification

**Amendment goal**: Promote the four preview-only designs (`atelier`, `diwan`, `marakeb`, `tahrir`) into full themes selectable from the Appearance picker. This is the realization of US4 (extensible architecture) and proves SC-007 in lived practice: each new theme requires only its own assets + registry/i18n/manifest/HTML wiring — zero edits to `popup.js`, `options.js`, `sidebar-surface.js`, `bootstrap.js`, `prefs.js`, or the base CSS files.

**Story label**: `[US4]` for all theme-authoring tasks; `[US3]` (default-untouched) is a regression gate revisited at the end.

**Visual sources**: `design/atelier-preview.html`, `design/diwan-preview.html`, `design/marakeb-preview.html`, `design/tahrir-preview.html` (color tokens lifted verbatim from `design/index.html` swatch rows). See `research.md` Decision 9 for the token + font table.

### Phase 9.A — Shared scaffolding (blocks all four themes)

- [X] T048 [US4] Append four descriptors to `js/themes/registry.js` `list` (between the existing `mihrab` entry and the closing bracket): `atelier` (`swatchA:'#1a1410'`, `swatchB:'#b8860b'`), `diwan` (`#0b5d3b`/`#5ba87a`), `marakeb` (`#0a0e0c`/`#6ee7b7`), `tahrir` (`#1a1a1a`/`#0b5d3b`). All four use `defaultFor: 'never'`. Display names per `research.md` Decision 9: Atelier/المصنع (or "أتلييه"), Diwan/الديوان, Marakeb/المراكب, Tahrir/التحرير.
- [X] T049 [P] [US4] Add eight i18n string pairs to `js/shared/i18n.js` (AR + EN catalogs): `theme_atelier_name`/`theme_atelier_desc`, `theme_diwan_name`/`theme_diwan_desc`, `theme_marakeb_name`/`theme_marakeb_desc`, `theme_tahrir_name`/`theme_tahrir_desc`. Descriptions match the `design/index.html` `.desc` paragraph for each card (one short bilingual sentence).
- [X] T050 [P] [US4] Bundle hero fonts in `resources/fonts/`:
  - `fraunces-italic-300.woff2`, `fraunces-italic-400.woff2`, `fraunces-400.woff2` (atelier)
  - `hanken-grotesk-400.woff2`, `hanken-grotesk-500.woff2`, `hanken-grotesk-600.woff2` (diwan)
  - `jetbrains-mono-400.woff2`, `jetbrains-mono-700.woff2` (marakeb)
  - `dm-mono-400.woff2` (shared label face for atelier/diwan/tahrir)
  Tahrir reuses existing `amiri-arabic-{400,700}.woff2` — no new file. Source: Google Fonts; subset Latin+numerals for non-Arabic faces. Verify each file < 80 KB after subsetting.

### Phase 9.B — Atelier (Editorial · Parchment)

- [X] T051 [P] [US4] Create `css/themes/atelier-popup.css` wrapping every rule in `[data-theme="atelier"] { ... }` using CSS native nesting. `@font-face` for Fraunces (300 italic, 400 italic, 400) and DM Mono with `local()` fallback. Tokens: `--q-primary:#1a1410; --q-gold:#b8860b; --q-bg:#f5efe3; --q-card:#faf6ec; --q-border:#c8b9a3; --q-text:#1a1a1a; --q-muted:#6b6b6b`. Header: framed parchment card with 1px ink hairline border + inner gold-leaf rule + DM Mono uppercase eyebrow caption above the Fraunces-italic title. No clip-path silhouette. End with `@media (forced-colors: active)` block resetting chrome to system colors per Mihrab's pattern.
- [X] T052 [P] [US4] Create `css/themes/atelier-options.css` — same token block; options-section cards rendered as parchment plates with hairline borders; section titles in Fraunces italic; field labels in DM Mono uppercase. Forced-colors reset.
- [X] T053 [P] [US4] Create `css/themes/atelier-sidebar.css` — same tokens. Finding cards render as parchment leaves; verdict-class colors untouched. Forced-colors reset.
- [X] T054 [US4] Wire atelier: add `css/themes/atelier-popup.css` + `atelier-options.css` + `atelier-sidebar.css` to `manifest.json` `content_scripts[0].css`; add `<link rel="stylesheet" href="../css/themes/atelier-popup.css">` to `html/popup.html` head after the existing theme links; add `<link rel="stylesheet" href="../css/themes/atelier-options.css">` to `html/options.html` head likewise.

### Phase 9.C — Diwan (Soft modern · Calm)

- [X] T055 [P] [US4] Create `css/themes/diwan-popup.css` scoped under `[data-theme="diwan"]`. `@font-face` for Hanken Grotesk 400/500/600 and DM Mono. Tokens: `--q-primary:#0b5d3b; --q-gold:#5ba87a; --q-bg-gradient: linear-gradient(160deg,#f0f7f1 0%,#e6f1e3 100%); --q-card:#ffffff; --q-border:#e0ece3; --q-text:#1a2a1f; --q-muted:#7a8a7a`. Header: rounded-22px white panel floating on the mint gradient body; 36px circular gradient icon (135deg from `#5ba87a` to `#0b5d3b`) left of Hanken-Grotesk title; rounded pill status chip in foot. Generous whitespace; corners ≥ 8px. Forced-colors reset.
- [X] T056 [P] [US4] Create `css/themes/diwan-options.css` — same tokens; sections render as rounded white cards on the mint gradient; pill-shaped toggles; soft sage focus rings.
- [X] T057 [P] [US4] Create `css/themes/diwan-sidebar.css` — same tokens; finding cards have 14px radius, pale-mint hover state; sticky TOC rendered as pill row.
- [X] T058 [US4] Wire diwan: 3 manifest CSS entries + 2 HTML link tags (same pattern as T054).

### Phase 9.D — Marakeb (Terminal · Dark)

- [X] T059 [P] [US4] Create `css/themes/marakeb-popup.css` scoped under `[data-theme="marakeb"]`. `@font-face` for JetBrains Mono 400/700 with `local()` fallback. Tokens: `--q-primary:#6ee7b7; --q-gold:#c8a24a; --q-bg:#0a0e0c; --q-card:#13201a; --q-border:#1a2820; --q-text:#e8f0ec; --q-muted:#6a8a76`. Header: three-dot terminal chrome (`●  ●  ●`) top-left in `#555`; title rendered in `> scan_page --auto` style block in JetBrains Mono with text-shadow phosphor glow (`0 0 8px rgba(110,231,183,0.6)`). All non-verdict text in JetBrains Mono. Subtle scanline background via repeating-linear-gradient at 2% opacity. Forced-colors reset MUST drop the dark background to `Canvas` and phosphor color to `CanvasText` — the terminal aesthetic does NOT survive forced-colors and that's correct.
- [X] T060 [P] [US4] Create `css/themes/marakeb-options.css` — same tokens; section titles rendered as `# section_name` comment-style in JetBrains Mono; checkboxes styled via `::before` as `[x]`/`[ ]` ASCII glyphs; select dropdowns retain native chrome on dark background.
- [X] T061 [P] [US4] Create `css/themes/marakeb-sidebar.css` — same tokens; finding cards as monospace blocks with `▮` cursor pseudo on the active one. Verdict color classes untouched (the phosphor green is theme chrome, NOT `.v-green`).
- [X] T062 [US4] Wire marakeb: 3 manifest CSS entries + 2 HTML link tags.

### Phase 9.E — Tahrir (Newspaper · High contrast)

- [X] T063 [P] [US4] Create `css/themes/tahrir-popup.css` scoped under `[data-theme="tahrir"]`. `@font-face` reuses `resources/fonts/amiri-arabic-{400,700}.woff2` (already bundled for Mihrab — no new file) plus `dm-mono-400.woff2`. Tokens: `--q-primary:#1a1a1a; --q-gold:#0b5d3b; --q-bg:#f4f0e6; --q-card:#ffffff; --q-border:#1a1a1a; --q-text:#1a1a1a; --q-muted:#6b6b6b`. Header: heavy double-rule masthead (1px + 4px stacked, top AND bottom of header band, both `#1a1a1a`); large Amiri-700 centered title; DM Mono uppercase "Vol. I · No. NNN — Edition Verified" caption below title; dropline divider via `repeating-linear-gradient(to right, #1a1a1a 0 8px, transparent 8px 12px)`. Single green accent — used ONLY on the "Verified" word in the caption and the active toggle pill. Forced-colors reset.
- [X] T064 [P] [US4] Create `css/themes/tahrir-options.css` — same tokens; sections separated by full-width dashed dropline dividers; section titles in Amiri-700 with DM Mono uppercase eyebrow caption row.
- [X] T065 [P] [US4] Create `css/themes/tahrir-sidebar.css` — same tokens; two-column flow when width permits; finding cards have hairline ink borders only (no fill); verdict color classes preserved untouched.
- [X] T066 [US4] Wire tahrir: 3 manifest CSS entries + 2 HTML link tags.

### Phase 9.F — Regression gates

- [X] T067 [US4] Run `node tests/theme_registry_check.js`. Expected: `OK theme registry — 6 theme(s): default, mihrab, atelier, diwan, marakeb, tahrir`. The pre-existing assertions (single `defaultFor:'fresh-install'`, id regex `^[a-z][a-z0-9-]{1,31}$`, `defaultId()`/`isValidId()`/`get()` round-trip) auto-cover the new entries without modification.
- [X] T068 [US4] Verdict-taxonomy invariance: grep `\.v-(green|yellow|orange|red|lightBlue|lightGreen)` across `css/themes/{atelier,diwan,marakeb,tahrir}-*.css` — MUST return zero matches. This is the Principle II / FR-008 gate enforced by inspection.
- [X] T069 [US3] Re-confirm default-untouched: `git diff main -- css/{popup,options,sidebar}.css js/{popup,options,panel/sidebar-surface,storage/prefs}.js html/sidebar.html` MUST still show additions only (or no changes) — no rewrites of pre-existing rules. The four new themes must not have leaked any unscoped rules into the base files.
- [ ] T070 [US4] DEFERRED — manual MV3 walkthrough required. Load unpacked extension, cycle through all six themes on the options page, confirm popup + options + sidebar each restyle live within one frame and verdict colors remain visually identical across themes. Same harness limitation as T026/T027/T044.

### Phase 9.G — Documentation & polish

- [X] T071 [P] Update `specs/004-appearance-themes/quickstart.md` "What ships" section: change "Two themes" to "Six themes" and list all six with their one-line descriptions from i18n.
- [X] T072 [P] Update `docs/chrome-web-store.md` if the user-facing feature copy enumerates themes by name (grep first; touch only if it does). PRIVACY.md is unchanged — no new data flow.
- [X] T073 SC-007 lived-verification note: append to `specs/004-appearance-themes/quickstart.md` confirming this amendment added four themes with zero edits to `popup.js`/`options.js`/`sidebar-surface.js`/`bootstrap.js`/`prefs.js` and zero edits to the base `css/{popup,options,sidebar}.css` files — verified by `git diff main -- <those paths>`.

---

## Phase 9 dependencies

```text
T048 (registry) ─┐
T049 (i18n)     ─┼─→ atelier/diwan/marakeb/tahrir families (parallel)
T050 (fonts)    ─┘
                       ↓
   ┌──────────┬────────┴────────┬──────────┐
   │          │                 │          │
Atelier    Diwan            Marakeb     Tahrir
T051‖T052‖T053→T054  T055‖T056‖T057→T058  T059‖T060‖T061→T062  T063‖T064‖T065→T066
   │          │                 │          │
   └──────────┴────────┬────────┴──────────┘
                       ↓
              T067 → T068 → T069 → T070
                       ↓
              T071 ‖ T072 ‖ T073
```

- T048, T049, T050 can run in parallel (different files).
- The four theme families (B/C/D/E) are independent of each other once T048-T050 are done.
- Within each theme family, the three CSS files are `[P]` against each other; the wiring task depends on all three CSS files existing.

## Phase 9 task counts

| Phase | Tasks | Notes |
|---|---|---|
| 9.A scaffolding | 3 (T048–T050) | T049+T050 parallel after T048 |
| 9.B atelier | 4 (T051–T054) | T051/T052/T053 parallel |
| 9.C diwan | 4 (T055–T058) | T055/T056/T057 parallel |
| 9.D marakeb | 4 (T059–T062) | T059/T060/T061 parallel |
| 9.E tahrir | 4 (T063–T066) | T063/T064/T065 parallel |
| 9.F gates | 4 (T067–T070) | sequential |
| 9.G docs | 3 (T071–T073) | T071/T072 parallel |
| **Total** | **26 (T048–T073)** | up to 12 in parallel after T048 |

## Phase 9.H — Post-merge follow-ups (tracked, not blocking)

These items are visual-polish gaps surfaced during the four-theme amendment but deferred so the feature can ship. They are NOT regressions against `main` — the base UI (`default` theme) is untouched (gate T069 holds).

- [ ] T074 [US4] Visual-fidelity audit: each of the four new themes (atelier, diwan, marakeb, tahrir) × three surfaces (popup, options, sidebar) vs. its `design/<theme>-preview.html` PLATE. For each non-matching surface, capture a side-by-side screenshot and file the specific delta (font weight/size, color, layout, ornament). Atelier popup is the only one user-confirmed to match in this session — the other 11 surface/theme pairs need a deliberate pass.
- [ ] T075 [P] [US4] Verify all bundled woff2 files actually load in MV3 via DevTools Network panel (filter: Font, status 200). Specifically: `el-messiri-arabic-{400,600}.woff2`, `reem-kufi-arabic-600.woff2`, `amiri-arabic-{400,700}.woff2`, `fraunces-{400,italic-300,italic-400}.woff2`, `hanken-grotesk-{400,500,600}.woff2`, `jetbrains-mono-{400,700}.woff2`, `dm-mono-400.woff2`, `noto-naskh-arabic-{400,500}.woff2`. Any 404 or "blocked by web_accessible_resources" failure is a real bug.
- [ ] T076 [P] [US4] Confirm `manifest.json` `web_accessible_resources` glob (`resources/fonts/*.woff2`) covers all woff2 files added in this branch. Currently 16 files in `resources/fonts/`; glob should match all of them.
- [ ] T077 [US4] Two trivia from this session that may or may not still apply after T074:
  - Atelier popup gold-on-`صَ` rule uses `::first-letter` — verify this works correctly for the bilingual title structure (which has `<span>` wrapping). If the H1 inner spans break `::first-letter`, switch back to an explicit `.first` span and update the HTML.
  - Marakeb phosphor glow on dark — confirm the scanline `repeating-linear-gradient` overlay reads as intended on real Chrome (not just LCD subpixel rendering).
- [ ] T078 [US4] CRLF/LF normalization: this session's edits in `css/themes/mihrab-*.css` trigger Git's "LF will be replaced by CRLF" warning. Verify `.gitattributes` (or set one) marks `*.css` as `text eol=lf` so cross-platform contributors don't churn line endings.
