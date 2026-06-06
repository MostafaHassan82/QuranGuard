# Contract — `prefs.v1.appearance` Storage Delta

This contract pins down the storage shape change. It complements (does not replace) the existing `contracts/storage.md` in earlier features and `js/storage/prefs.js`.

## Schema change

```diff
 chrome.storage.local['prefs.v1'] = {
   master: { authenticTextReplacement: boolean },
   perColor: { green, lightBlue, yellow, orange, red: boolean },
   font: <font-enum>,
   scanTrigger: 'manual' | 'autoscan',
   autoCorrect: { orange, lightBlue, yellow, red: boolean },
   refLinks: boolean,
   refHighlight: boolean,
   lang: 'ar' | 'en',
   panelPosition: 'auto' | 'left' | 'right' | 'float',
   floatAnchor: 'auto' | 'left' | 'right',
   panelFilter: { ... },
   highlightStyle: { ... },
   autocomplete: { ... },
+  appearance: { theme: string }  // theme id from QuranThemes.list
 }
```

## Defaults (added to `DEFAULTS` in `js/storage/prefs.js`)

```js
appearance: { theme: 'default' }
```

The literal `'default'` is used as the constant. At read time, `applyDefaults` calls `QuranThemes.defaultId()` for the actual fallback — this lets a future release rename the default theme without changing the constant in `DEFAULTS` (which the Node-side prefs validation test imports without loading the registry).

## `applyDefaults` additions

Insert in `applyDefaults(raw)` in `js/storage/prefs.js`, alongside the other sub-object normalizations:

```js
// Appearance (feature 004): default-fill + clamp against registry.
const fallbackTheme = (typeof QuranThemes !== 'undefined' && QuranThemes.defaultId)
  ? QuranThemes.defaultId()
  : 'default';
if (!p.appearance || typeof p.appearance !== 'object') p.appearance = {};
if (typeof p.appearance.theme !== 'string') {
  p.appearance.theme = fallbackTheme;
} else if (typeof QuranThemes !== 'undefined' && QuranThemes.isValidId && !QuranThemes.isValidId(p.appearance.theme)) {
  console.warn('[QuranPrefs] appearance.theme not in registry, clamped to default');
  p.appearance.theme = fallbackTheme;
}
```

The `typeof QuranThemes !== 'undefined'` guard handles the Node test environment where the registry isn't loaded (the test only validates shape, not registry membership). In the extension runtime, `js/themes/registry.js` MUST be loaded before `js/storage/prefs.js` on every surface that reads prefs.

## Load order (script tag order in HTML and in `manifest.json`)

- `js/themes/registry.js` MUST come before `js/storage/prefs.js`.
- `js/themes/registry.js` MUST come before `js/themes/bootstrap.js`.
- `js/themes/bootstrap.js` MUST be inlined-or-loaded in the page `<head>` before any visible content of `popup.html` / `options.html`.

For the sidebar (injected by content script), the order in `manifest.json` `content_scripts[0].js` must list `js/themes/registry.js` before `js/storage/prefs.js` and before `js/panel/sidebar-surface.js`.

## Write paths

Only `QuranPrefs.patch({ appearance: { theme } })` writes this field. The Appearance picker is the only UI surface that calls it. There is no programmatic write from any background or content-script code path.

## Sync behavior

`prefs.v1` is stored in `chrome.storage.local`. If the user enables Chrome profile sync for extension storage, the entire `prefs.v1` object is synced; `appearance.theme` rides along. FR-014 is satisfied without per-field work.

## Telemetry

`appearance.theme` is never transmitted to any external service. There is no telemetry code path in this extension. FR-013 is satisfied by the absence of any such code, not by an opt-out.
