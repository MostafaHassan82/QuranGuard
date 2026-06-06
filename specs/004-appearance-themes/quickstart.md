# Quickstart — Appearance / Theme System

## What ships

- Two themes selectable in the Appearance section of the options page: `default` and `mihrab`.
- Preference persists across browser restarts and rides Chrome profile sync (via `prefs.v1`).
- Users who never visit the Appearance section keep the previous default UI exactly as it was.

## Try it (after implementation lands)

1. Load the unpacked extension at `chrome://extensions` → "Load unpacked" → repo root.
2. Click the QuranGuard toolbar icon to open the popup. It renders in the default theme.
3. Open the options page (right-click the icon → Options, or the "Settings" link in the popup).
4. Scroll to "Appearance" (it's near the top).
5. Click the **Mihrab** card. The options page restyles in place — no reload.
6. Re-open the popup. It opens in Mihrab.
7. Open any page with a Quran citation, trigger a scan, and open the sidebar. The sidebar renders in Mihrab.
8. Switch back to **Default**. All three surfaces revert immediately.

## Add a new theme (developer flow)

1. Pick a stable id, e.g. `atelier`.
2. Add a descriptor to `js/themes/registry.js`:
   ```js
   { id: 'atelier', displayName: 'Atelier', displayNameAr: 'المرسم', defaultFor: 'never' }
   ```
3. Create `css/themes/atelier.css`. Every selector goes under `[data-theme="atelier"]`. Do NOT override `.v-green`, `.v-light-blue`, `.v-yellow`, `.v-orange`, `.v-red`, or `.v-light-green`.
4. Add `<link rel="stylesheet" href="../css/themes/atelier.css">` to `html/popup.html`, `html/options.html`, `html/sidebar.html`.
5. Add `"css/themes/atelier.css"` to `manifest.json` `content_scripts[0].css`.
6. Reload the extension. The new card appears in the Appearance picker.
7. Run the regression sweep (see Tests below) under the new theme.

No edits to `popup.js`, `options.js`, `sidebar-surface.js`, `bootstrap.js`, or `prefs.js` are required.

## Tests

```bash
python tests/run_tests.py
```

Three test categories cover this feature:

- `tests/theme-smoke.spec.js` — picker round-trip across popup, options, sidebar.
- `tests/theme-persistence.spec.js` — restart the browser context, assert theme survives and no FOUC class is visible after document-ready.
- `tests/theme-regression-sweep.spec.js` — runs one fixture per verdict color and one autocomplete fixture, twice (default then mihrab), asserts `window.__quranScan` is identical between runs and that computed verdict colors match.

While iterating, run just the smoke test:

```bash
python tests/run_tests.py tests/theme-smoke.spec.js
```

## Edge cases worth exercising manually

- **Forced colors**: enable Windows high-contrast mode, switch to Mihrab, confirm all controls remain legible.
- **Font failure**: temporarily delete `resources/fonts/amiri-arabic-400.woff2` from the loaded extension, switch to Mihrab, confirm Arabic text falls back to system fonts without layout breakage.
- **Removed theme**: temporarily delete the `mihrab` entry from `QuranThemes.list` while a profile has Mihrab selected. Reopen any surface: it silently falls back to default; the next prefs write removes the stale id from storage.
- **Cross-surface live update**: have the popup open in one window and the sidebar open on a page in another. Change the theme on the options page. Both should reflect the change — the popup on its next open, the sidebar within one frame if it observes `chrome.storage.onChanged` (US1 scenario 3).

## Acceptance gate before merge

- [ ] Smoke test passes locally
- [ ] Persistence test passes locally
- [ ] Regression sweep shows zero diffs in `__quranScan` between default and mihrab runs
- [ ] Manual: pixel-spot-check the popup, options, and sidebar in default mode against the prior release — no observable change (FR-003)
- [ ] PRIVACY.md updated only if anything about data collection changed (it should not — FR-013 means nothing changes)
