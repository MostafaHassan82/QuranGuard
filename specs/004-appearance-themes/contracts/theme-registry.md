# Contract — Theme Registry

The registry is the single source of truth for which themes exist in this build. Every other piece of the system reads from it: the Appearance picker enumerates it, `QuranPrefs.applyDefaults` validates against it, and the bootstrap script looks up descriptors by id.

## Shape

```js
// js/themes/registry.js
'use strict';
const QuranThemes = (() => {
  // Ordered: this is the display order in the Appearance picker.
  const list = [
    { id: 'default', displayName: 'Default', displayNameAr: 'الافتراضي', defaultFor: 'fresh-install' },
    { id: 'mihrab',  displayName: 'Mihrab',  displayNameAr: 'المحراب',    defaultFor: 'never' },
  ];

  const ids = new Set(list.map(t => t.id));
  const byId = new Map(list.map(t => [t.id, t]));

  function defaultId() {
    const d = list.find(t => t.defaultFor === 'fresh-install');
    return d ? d.id : 'default';
  }

  function isValidId(id) { return typeof id === 'string' && ids.has(id); }

  function get(id) { return byId.get(id) || null; }

  return { list, ids, defaultId, isValidId, get };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QuranThemes;
```

## Public surface

| Member | Purpose | Used by |
|---|---|---|
| `QuranThemes.list` | Ordered array of all theme descriptors. | Appearance picker render loop. |
| `QuranThemes.ids` | `Set<string>` of valid ids. | `QuranPrefs.applyDefaults` clamp. |
| `QuranThemes.defaultId()` | Returns the id of the `defaultFor: 'fresh-install'` theme (or `'default'` if missing). | `QuranPrefs.applyDefaults` fallback; the bootstrap; the picker initial state. |
| `QuranThemes.isValidId(id)` | Predicate for clamp logic. | `QuranPrefs.applyDefaults`. |
| `QuranThemes.get(id)` | Descriptor lookup by id (returns `null` if not registered). | Picker card render; future asset-hint lookups. |

## Adding a theme

1. Pick a stable `id` matching `^[a-z][a-z0-9-]{1,31}$`. This id is permanent — changing it later orphans every user who selected the theme.
2. Add a descriptor to `QuranThemes.list` in the desired display order. `defaultFor` must stay `'never'`.
3. Create `css/themes/<id>.css`. Every rule MUST be scoped under either `[data-theme="<id>"]` (root-attribute scope) or `[data-theme="<id>"] .selector` (descendant scope). The file MUST NOT override the verdict color classes (`.v-green`, `.v-light-blue`, `.v-yellow`, `.v-orange`, `.v-red`, `.v-light-green`).
4. Add `<link rel="stylesheet" href="../css/themes/<id>.css">` to `html/popup.html`, `html/options.html`, and `html/sidebar.html` (the dev preview file).
5. Add `"css/themes/<id>.css"` to `manifest.json` `content_scripts[0].css` so the sidebar (injected at runtime) picks it up.
6. No edits required to `popup.js`, `options.js`, or `sidebar-surface.js` — they read the registry.

## Removing a theme

1. Delete the entry from `QuranThemes.list`.
2. Delete `css/themes/<id>.css`.
3. Delete the `<link>` lines and the `manifest.json` entry.
4. No migration code is needed. Users who had the removed theme selected will silently fall back to the default theme on their next read (FR-007).

## Constraints

- The registry MUST NOT export any function, callback, or stateful object that lets a theme run code at any lifecycle point. Themes are pure CSS + asset references by construction. This enforces FR-008 at the structural level.
- The order in `list` is the order in the picker. Default first.
- Display names in both languages are required because the options page renders both depending on the user's `lang` preference.
