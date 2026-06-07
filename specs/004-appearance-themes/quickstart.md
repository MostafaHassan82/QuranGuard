# Quickstart — Appearance / Theme System

## What ships

- Two themes selectable in the **Appearance** section of the options page:
  `default` (today's UI, byte-additive over `main`) and `mihrab` (arched
  green-and-gold treatment with Amiri Arabic script).
- Choice persists across browser restarts in `chrome.storage.local` under
  `prefs.v1.appearance.theme`. The schema is the same one Chrome's user-pref
  sync can mirror; we do not write to `chrome.storage.sync` directly.
- Users who never visit Appearance keep the previous Default UI exactly —
  base `css/popup.css`, `css/options.css`, `css/sidebar.css` were restored
  from `main` with additive shims only (FR-003 / SC-001 architecturally
  guaranteed by `git diff main HEAD -- css/{popup,options,sidebar}.css`).

## Try it (after loading the unpacked extension)

1. `chrome://extensions` → "Load unpacked" → repo root.
2. Click the QuranGuard toolbar icon. Popup opens in the **Default** theme.
3. Right-click the icon → Options (or "الإعدادات" / "Settings" in the popup
   footer). The Appearance section is the first one.
4. Click the **Mihrab** card. The options page restyles in place — no reload.
   The active card flips to a gold-soft / emerald border with a check ring.
5. Re-open the popup. It paints in Mihrab on first frame (no flash) because
   `js/themes/bootstrap.js` sets `documentElement.dataset.theme` before the
   stylesheet is parsed, with `html.theme-loading body { visibility: hidden }`
   covering the read.
6. Open a page with a Quran citation, trigger a scan, open the sidebar →
   the panel renders in Mihrab too. The collapse tab (a `<div>` appended to
   `document.body` as a sibling of the panel root) gets `data-theme` mirrored
   onto it by `sidebar-surface.js:ensureTab()`.
7. Switch back to **Default**. All three surfaces revert immediately. The
   options page picker name + description re-localize on any language flip
   without a refresh (US5 / T039 — picker spans carry `data-i18n`).

## Architecture in 8 lines

| Layer | File | Responsibility |
|---|---|---|
| Data | `js/themes/registry.js` | `QuranThemes.list` w/ id, displayName, displayNameAr, defaultFor, swatchA, swatchB |
| Storage | `js/storage/prefs.js` | `appearance.theme`, default-fill + clamp-on-read against registry |
| Bootstrap | `js/themes/bootstrap.js` | Sync FOUC class, async apply, `chrome.storage.onChanged` listener for live cross-surface flips |
| Sidebar | `js/panel/sidebar-surface.js` | Sets `dataset.theme` on panel root before DOM insert; mirrors onto the edge tab |
| Picker | `js/options.js` + `html/options.html` + `css/options.css` | Renders one `.theme-card` per registry entry with inline swatch colors from the descriptor |
| Theme CSS | `css/themes/<id>-popup.css`, `<id>-options.css`, `<id>-sidebar.css` | One file per surface to avoid cross-surface rule leakage (popup `body { max-width: 360px }` would crush options if shared) |
| i18n | `js/shared/i18n.js` | `theme_<id>_name` + `theme_<id>_desc` for each theme, AR + EN |
| Manifest | `manifest.json` content_scripts | Lists every theme's `-sidebar.css` so each is loaded into hosted pages |

CSS Nesting semantics matter: each per-surface file is wrapped in
`[data-theme="<id>"] { … }` and the build step rewrites root forms so they
resolve as same-element (`:root` and `html` both → `&`; the sidebar adds
`.quran-ext-panel` and `.quran-ext-panel-tab` → `&.quran-ext-panel(-tab)`
because both elements carry `data-theme` directly).

## Add a new theme (developer flow)

Add a theme `atelier`:

1. Add a descriptor to `js/themes/registry.js`:
   ```js
   { id: 'atelier', displayName: 'Atelier', displayNameAr: 'المرسم',
     defaultFor: 'never', swatchA: '#1f2937', swatchB: '#f59e0b' }
   ```
   Id must match `^[a-z][a-z0-9-]{1,31}$` — the registry test asserts this.

2. Create three CSS files. Each is wrapped in `[data-theme="atelier"] { … }`
   using CSS native nesting:
   - `css/themes/atelier-popup.css`
   - `css/themes/atelier-options.css`
   - `css/themes/atelier-sidebar.css`

   In the sidebar file, root form `.quran-ext-panel` and
   `.quran-ext-panel-tab` MUST be prefixed with `&` so they apply
   same-element (the panel and tab both carry `data-theme`, they're not
   descendants of an element that does).

   **Do NOT override** `.v-green`, `.v-lightBlue`, `.v-yellow`, `.v-orange`,
   `.v-red`, or `.v-lightGreen` — the verdict color taxonomy is fixed
   (Principle II of the constitution; FR-008).

3. Link the popup + options CSS:
   - `html/popup.html` head:
     `<link rel="stylesheet" href="../css/themes/atelier-popup.css">`
   - `html/options.html` head:
     `<link rel="stylesheet" href="../css/themes/atelier-options.css">`

4. Add the sidebar CSS to `manifest.json` `content_scripts[0].css`:
   ```json
   "css/themes/atelier-sidebar.css"
   ```

5. Add four i18n entries (two strings × two languages) to
   `js/shared/i18n.js`:
   ```js
   theme_atelier_name: 'Atelier' / 'المرسم',
   theme_atelier_desc: 'Industrial slate + amber accents' / '...'
   ```

6. Reload the extension. The new card appears in the Appearance picker with
   the swatch gradient driven by `swatchA`/`swatchB`, and its name +
   description re-localize on language toggle.

**Not required**: any edits to `popup.js`, `options.js`,
`sidebar-surface.js`, `bootstrap.js`, `prefs.js`, `css/popup.css`,
`css/options.css`, or `css/sidebar.css`. SC-007 holds because:
  - swatch colors live on the registry descriptor (rendered inline by the
    picker), not in shared CSS;
  - the picker reads `data-i18n` keys derived from each theme's `id`;
  - bootstrap and sidebar-surface accept any string the registry validates.

## SC-007 verification (T036 outcome)

Performed against commit `f0988c8` + the SC-007 swatch refactor:

- Added theme id `stub` (swatchA `#7c3aed`, swatchB `#fbbf24`) and three
  minimal `stub-{popup,options,sidebar}.css` files; linked them per step 3-4
  above and added two i18n entries per step 5.
- Card appeared in the picker with the purple→amber swatch; clicking it
  applied the override (purple primary, amber gold) across popup, options,
  and sidebar without any further code changes.
- **Files edited to add the stub** (all additive, one-line each except the
  three new CSS files): `js/themes/registry.js`, `html/popup.html`,
  `html/options.html`, `manifest.json`, `js/shared/i18n.js` (AR + EN
  entries).
- **Files NOT edited**: `popup.js`, `options.js`, `sidebar-surface.js`,
  `bootstrap.js`, `prefs.js`, base `css/popup.css`/`options.css`/
  `sidebar.css`.

SC-007 holds. The stub was reverted; no traces remain.

## Tests

```bash
# Node-side: registry contract + prefs validation including appearance pref
node tests/theme_registry_check.js
node tests/prefs_position_check.js

# Full project suite (Python harness over Playwright fixtures)
python tests/run_tests.py
```

The Python suite exercises reader-side verification and writer-side
autocomplete; it does not load the popup/options/sidebar surfaces and
therefore does not flip theme attributes directly. The SC-005 regression
guarantee for verdict colors is enforced architecturally instead: no
`.v-green`/`.v-yellow`/`.v-orange`/`.v-red`/`.v-lightBlue`/`.v-lightGreen`
rule exists in any `css/themes/*.css` file (verified by grep, T041 outcome).

## Edge cases worth exercising manually

- **Forced colors / Windows High Contrast**: enable a Contrast theme in
  Settings → Accessibility → Contrast themes, or DevTools → Rendering →
  Emulate CSS media feature `forced-colors: active`. Confirm the
  manual/auto popup toggle and the active theme card paint with system
  `Highlight`/`HighlightText` (we set `forced-color-adjust: none` on the
  active state so the OS leaves our system-color paint intact). Verdict
  spans on a fixture page must keep their normal colors (constitutional
  invariant).
- **Font failure**: temporarily rename `resources/fonts/amiri-arabic-400.woff2`
  in the loaded extension and switch to Mihrab. Arabic falls back through
  `'Amiri', "Segoe UI", serif` without layout breakage.
- **Removed theme**: temporarily delete the `mihrab` entry from
  `QuranThemes.list` while a profile has Mihrab selected. Reopen any
  surface: `applyDefaults()` clamps to `default` and the next read writes
  the cleaned value back, so stale ids self-heal.
- **Cross-surface live update**: popup open in one window + sidebar mounted
  in another; flip theme on options. The bootstrap's `onChanged` listener
  pushes the new `data-theme` to both within one frame (FR-004).
- **Language flip while options open**: switch lang select between AR and EN
  — picker name + description re-localize without rebuilding the picker
  because the spans carry `data-i18n` (T039 / live-i18n fix).

## Acceptance gate before merge

- [ ] Manual: popup, options, sidebar all render in Default identical to
  `main` (T030 spot-check).
- [ ] Manual: theme flip works across popup + options + sidebar; live
  update fires on the open popup AND the open sidebar tab.
- [ ] `node tests/theme_registry_check.js` green.
- [ ] `node tests/prefs_position_check.js` green (prefs schema unaffected).
- [ ] `python tests/run_tests.py` shows no reader-side / writer-side
  regression (SC-005 gate).
- [ ] PRIVACY.md mentions `appearance theme` in the local-storage list
  ("Last updated" bumped). Already done in this branch.
- [ ] `docs/chrome-web-store.md` storage permission justification mentions
  `appearance theme`. Already done in this branch.
