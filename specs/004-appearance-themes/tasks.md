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

- [ ] T012 [US1] Add `<script src="../js/themes/registry.js"></script>` then `<script src="../js/themes/bootstrap.js"></script>` to the `<head>` of `html/popup.html`, placed BEFORE the existing `<link rel="stylesheet" href="../css/popup.css">`
- [ ] T013 [US1] Add `<link rel="stylesheet" href="../css/themes/mihrab.css">` to `html/popup.html` head, AFTER the default stylesheet link
- [ ] T014 [P] [US1] Apply the same two changes (T012 + T013) to `html/options.html`
- [ ] T015 [P] [US1] Apply the same two changes (T012 + T013) to `html/sidebar.html` (the dev preview file; runtime sidebar is injected via content script and is handled separately in T020)
- [ ] T016 [US1] Add the Appearance section markup to `html/options.html`: a `<section id="appearance">` placed BEFORE the existing rendering/replacement controls. Contains an `<h2>` titled "Appearance / المظهر" (i18n via `data-i18n`), and a `<div id="appearance-picker" role="radiogroup">` placeholder populated by JS
- [ ] T017 [US1] In `js/options.js`, on page load: iterate `QuranThemes.list`, render one `<label>` card per theme inside `#appearance-picker`. Each card holds a hidden `<input type="radio" name="theme" value="<id>">`, the theme's localized display name (use `displayName` or `displayNameAr` based on `lang`), and a small swatch element. Mark the active card by reading `await QuranPrefs.read()` and matching `appearance.theme`
- [ ] T018 [US1] In `js/options.js`, on radio change: call `await QuranPrefs.patch({ appearance: { theme: ev.target.value } })`, then immediately set `document.documentElement.dataset.theme = ev.target.value` so the options page re-styles in place without reload
- [ ] T019 [US1] In `js/popup.js`, on load: call `QuranPrefs.read()` and set `document.documentElement.dataset.theme` from `appearance.theme` (bootstrap already did this, but a defensive re-apply guarantees correctness if bootstrap was bypassed during testing)
- [ ] T020 [US1] In `js/panel/sidebar-surface.js`, during panel root construction (BEFORE the root is inserted into the DOM): call `QuranPrefs.read()` and set `panelRoot.dataset.theme = prefs.appearance.theme`. Guarantees zero-FOUC on sidebar because the element is not in DOM in an unthemed state
- [ ] T021 [P] [US1] Add `chrome.storage.onChanged` listener in `js/panel/sidebar-surface.js`: when `changes['prefs.v1']` is observed and `newValue.appearance.theme !== oldValue?.appearance?.theme`, update `panelRoot.dataset.theme` within one frame (satisfies the Clarifications Q1 / FR-004 live-update guarantee)
- [ ] T022 [P] [US1] Add the same `chrome.storage.onChanged` listener in `js/popup.js` for the rare case the popup is open in a detached window when the user changes the theme on options
- [ ] T023 [US1] Add CSS for the Appearance picker (radio cards + swatches + selected state) to `css/options.css` (default-theme presentation)
- [ ] T024 [P] [US1] Add Mihrab-specific overrides for the Appearance picker to `css/themes/mihrab.css` (so the picker chrome matches the surrounding Mihrab styling once selected)
- [ ] T025 [US1] Add i18n strings to `js/shared/i18n.js`: `appearance_section_title`, `theme_default_name`, `theme_mihrab_name`, and any aria-label strings used by the picker
- [ ] T026 [US1] Create `tests/theme-smoke.spec.js`: open options on fresh profile, click the Mihrab card, assert `document.documentElement.dataset.theme === 'mihrab'` on options; open popup, assert same; open sidebar on a known fixture page, assert `panelRoot.dataset.theme === 'mihrab'`. Then click Default, assert all three revert
- [ ] T027 [US1] Extend `tests/theme-smoke.spec.js` with a live-update sub-test: open popup AND sidebar against a fixture, then from a separate options page tab toggle the theme; assert both surfaces' `data-theme` flips within 100ms via the storage-onChanged listener

**Checkpoint US1**: MVP demo passes. `python tests/run_tests.py tests/theme-smoke.spec.js` is green.

---

## Phase 4: User Story 3 — Default-untouched guarantee (P1, co-equal with US1)

**Story goal**: A user upgrading from the prior version who never visits Appearance sees no visual change.

**Independent test criteria**: Open all three surfaces with empty/legacy `prefs.v1` (no `appearance` key) and confirm rendering matches the pre-branch baseline.

- [ ] T028 [US3] Capture pre-branch baseline screenshots of popup, options, and sidebar (use `git stash` + manual capture, or check out the prior commit on a separate worktree) and save under `specs/004-appearance-themes/baseline/` (gitignored or kept locally — do NOT commit binary baselines)
- [ ] T029 [US3] Create `tests/theme-default-untouched.spec.js`: load extension with `chrome.storage.local` empty; open each surface; assert `document.documentElement.dataset.theme === 'default'` (set by bootstrap from `QuranThemes.defaultId()`); assert no Mihrab-only class names (e.g. `.mihrab-arch`, `.mihrab-verdict-tile`, whatever your extraction renamed) are present anywhere in the DOM; assert the computed `font-family` on `body` does NOT include "Amiri"
- [ ] T030 [US3] Manual visual spot-check: walk through every surface in default mode and compare against baseline from T028. Document any pixel diffs in a comment block at the top of the test from T029 (acceptable diffs: anti-aliasing only)

**Checkpoint US3**: Default UI demonstrably unchanged from prior release.

---

## Phase 5: User Story 2 — Persistence across sessions and devices (P2)

**Story goal**: Theme choice survives browser restart and service-worker suspension; rides Chrome sync when enabled.

**Independent test criteria**: Pick Mihrab → close browser context → reopen → popup shows Mihrab on first paint with no theme-loading flash.

- [ ] T031 [US2] Create `tests/theme-persistence.spec.js`: pick Mihrab via the options page, close the Playwright browser context, open a new context that points at the same profile, open the popup, assert `data-theme="mihrab"` is already set BEFORE any `await page.waitForLoadState('networkidle')` (proxy for "first paint")
- [ ] T032 [US2] Add a second assertion to T031: after `document.readyState === 'complete'`, the `html.theme-loading` class MUST be absent. If present, the FOUC guard is leaking
- [ ] T033 [US2] Manually verify Chrome sync compatibility: enable `chrome.storage.sync` mirror by inspection — confirm `prefs.v1` is stored in `chrome.storage.local` (not `sync`) but uses the same schema, so the existing sync story (whatever it is for other prefs) applies unchanged. Document the outcome in `quickstart.md` under "Sync behavior"

**Checkpoint US2**: Persistence test green; sync behavior documented.

---

## Phase 6: User Story 4 — Extensible architecture (P2)

**Story goal**: A future contributor can add a theme by adding data + one CSS file, with no edits to entry points beyond the new theme's own assets.

**Independent test criteria**: Add a trivial stub theme during development; it appears in the picker and applies correctly with zero edits to `popup.js`, `options.js`, `sidebar-surface.js`, or `bootstrap.js`.

- [ ] T034 [US4] Create `tests/theme-registry.spec.js` (Node-side unit test, no browser): require `js/themes/registry.js`; assert `QuranThemes.list` is a non-empty ordered array; assert exactly one entry has `defaultFor: 'fresh-install'`; assert every `id` matches `^[a-z][a-z0-9-]{1,31}$`; assert `defaultId()` returns that one entry's id; assert `isValidId('default')` true and `isValidId('not-real')` false
- [ ] T035 [US4] Add stub-theme dev-verification flow to `quickstart.md`: instructions to (a) add a `_stub` descriptor to `QuranThemes.list`, (b) create `css/themes/_stub.css` with one accent color rule, (c) add link tags + manifest entry, (d) confirm it shows up and applies, (e) revert. Mark as DEV ONLY — must NOT ship in a release
- [ ] T036 [US4] One-time stub-theme verification: actually perform the steps from T035 against the implementation, confirm SC-007 ("adding a new theme requires changes only within that theme's own asset surface") holds, then revert. Record outcome (pass/fail + any unexpected edits required) in `quickstart.md`

**Checkpoint US4**: Registry contract enforced by test; SC-007 verified by lived experience.

---

## Phase 7: User Story 5 — Discoverable and reversible (P3)

**Story goal**: First-time user finds and applies Mihrab in under thirty seconds without guidance.

**Independent test criteria**: Informal — give a colleague the unpacked extension and the instruction "change the look"; time-to-applied < 30s.

- [ ] T037 [US5] Confirm the Appearance section in `html/options.html` is positioned ABOVE the existing rendering/replacement controls (US5 acceptance scenario 1). If T016 already did this, mark satisfied
- [ ] T038 [US5] In `js/options.js` Appearance picker render, ensure the currently-active theme card has a visible "selected" affordance — a check icon, a colored border, or `aria-checked="true"` — distinct from the unselected cards (US5 acceptance scenario 2)
- [ ] T039 [US5] Add a brief description line under each theme name in the picker (e.g., "Today's UI" for default; "Arched titles + Amiri font" for Mihrab) so users can predict the change without clicking. Strings go in `js/shared/i18n.js`

**Checkpoint US5**: Picker is self-explanatory on first look.

---

## Phase 8: Polish & cross-cutting concerns

- [ ] T040 [P] Add `@media (forced-colors: active) { [data-theme="mihrab"] { ... } }` block to `css/themes/mihrab.css` per research Decision 6 — reset theme palette to `Canvas`/`CanvasText`/`LinkText` for page chrome; do NOT touch verdict color classes
- [ ] T041 [P] Create `tests/theme-regression-sweep.spec.js`: pick one fixture per verdict color from `tests/fixtures/` plus one autocomplete fixture. Run each twice — once under default, once under Mihrab. Assert `window.__quranScan` deep-equal between the two runs. Assert each verdict span's `getComputedStyle(...).backgroundColor` is byte-identical between the two runs (because verdict classes are NOT theme-scoped). This is the SC-005 gate
- [ ] T042 [P] Verify no telemetry of theme choice is added anywhere. Grep `js/` for any new fetch/XHR/`chrome.runtime.sendMessage` call paths touching `appearance` or `theme`; assert zero results. FR-013 / SC-005 invariant
- [ ] T043 Update `js/shared/i18n.js` Arabic and English string tables with all picker / section labels added during this feature
- [ ] T044 Run `python tests/run_tests.py` (full suite) and confirm zero regressions in the existing reader-side and writer-side fixtures (per constitution Principle VI / SC-005)
- [ ] T045 Verify `PRIVACY.md` requires NO update for this feature: data flow is unchanged (storage-only, no network). Confirm by inspection and add a one-line note to the PR description, NOT to PRIVACY.md itself
- [ ] T046 Update `docs/chrome-web-store.md` if it lists user-facing features: add a short "Optional appearance themes (Mihrab)" line. If it does not list features, skip
- [ ] T047 Walk through `specs/004-appearance-themes/quickstart.md` end-to-end against the final implementation; fix any drift between the document and shipping behavior

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

- [ ] Every task has the format `- [ ] T### [P?] [Story?] description with file path`
- [ ] Setup and Foundational tasks have NO story label
- [ ] Polish tasks have NO story label
- [ ] Every Phase 3–7 task has a `[US#]` label
- [ ] `[P]` is used only on tasks that touch different files from other parallel tasks
- [ ] Every task names a concrete file path or test file
- [ ] Dependencies graph is a DAG (no cycles)
