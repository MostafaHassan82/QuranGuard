# Phase 1 Data Model — Appearance / Theme System

Two new conceptual entities and one delta to existing storage. No new storage surface.

---

## Entity: Theme (registry-resident, build-time)

A named visual treatment. Pure data; carries no behavior.

| Field | Type | Description | Validation |
|---|---|---|---|
| `id` | string | Stable identifier. Lowercase ASCII, kebab-case, must match `^[a-z][a-z0-9-]{1,31}$`. Used in CSS attribute selectors (`[data-theme="<id>"]`) and in the persisted preference value. | Must be unique within the registry. Must not be the empty string. The id `default` is reserved for the existing UI. |
| `displayName` | string | Human-readable name in English. | Non-empty. |
| `displayNameAr` | string | Human-readable name in Arabic. | Non-empty. |
| `defaultFor` | enum: `'never'` \| `'fresh-install'` | Whether this theme is the default for fresh installs. Exactly one entry in the registry has `'fresh-install'` (the `default` theme); all others are `'never'`. | Exactly one `'fresh-install'` entry overall. |

**Sourced from**: `js/themes/registry.js` — an in-source ordered array `QuranThemes.list`. Order matters: it controls the order in the Appearance picker.

**Mihrab descriptor**:
```js
{ id: 'mihrab', displayName: 'Mihrab', displayNameAr: 'المحراب', defaultFor: 'never' }
```

**Default descriptor**:
```js
{ id: 'default', displayName: 'Default', displayNameAr: 'الافتراضي', defaultFor: 'fresh-install' }
```

**Lifecycle**: Themes are added/removed at build time only (the next published version of the extension). At runtime the registry is read-only.

**Relationships**: The Appearance preference (below) references a Theme by `id`. If a stored `id` is not present in the registry — for example after a theme is removed in a later release — the read path silently demotes to the `defaultFor: 'fresh-install'` theme (FR-007).

---

## Entity: Appearance preference (runtime-resident, user-set)

The user's currently selected theme.

| Field | Type | Description | Validation |
|---|---|---|---|
| `appearance.theme` | string (Theme `id`) | The active theme. | Must be a registered Theme `id`. Invalid / missing → clamp to the `defaultFor: 'fresh-install'` theme. |

**Sourced from**: `chrome.storage.local['prefs.v1'].appearance.theme`. Read/written via the existing `QuranPrefs` module.

**Default**: `default` (the existing UI).

**State transitions**: Single field. User changes it via the Appearance picker on the options page; `QuranPrefs.patch({ appearance: { theme } })` writes the new value and the picker emits an immediate `documentElement.dataset.theme = id` update so the user sees the change without page reload.

---

## Storage delta — `prefs.v1` schema

The full `prefs.v1` shape is defined in `js/storage/prefs.js`. This feature adds one top-level field:

```diff
 prefs.v1: {
   master: { authenticTextReplacement: bool },
   perColor: { green, lightBlue, yellow, orange, red: bool },
   font: enum,
   scanTrigger: enum,
   autoCorrect: { orange, lightBlue, yellow, red: bool },
   refLinks: bool,
   refHighlight: bool,
   lang: enum,
   panelPosition: enum,
   floatAnchor: enum,
   panelFilter: { ... },
   highlightStyle: { ... },
   autocomplete: { ... },
+  appearance: { theme: string }
 }
```

**Default-fill** (in `applyDefaults` in `js/storage/prefs.js`):
- Missing/non-object `appearance` → `{ theme: 'default' }`.
- Missing/non-string `appearance.theme` → `'default'`.
- `appearance.theme` not present in the theme registry's valid id set → `'default'`. (This is the FR-007 silent fallback.)

**Migration**: No legacy field migrates into `appearance`. Existing users with no `appearance` key get the default theme, satisfying FR-003 (default-untouched for upgraders).

**Sync compatibility**: This field is inside the existing `prefs.v1` object, so it inherits whatever Chrome-sync behavior `prefs.v1` already has. FR-014 is satisfied transitively.

---

## Computed/derived values

None. The active theme id is the single piece of state; everything else (the CSS that applies, the active picker card, the panel root attribute) is a deterministic projection of that id and the registry.

---

## Invariants

1. The set of valid `appearance.theme` values equals exactly `{t.id for t in QuranThemes.list}`. Enforced by `QuranPrefs.applyDefaults`.
2. Exactly one Theme has `defaultFor: 'fresh-install'`. Enforced by `QuranThemes.list` shape (asserted at load in development; clamped in production by picking the first matching entry, falling back to a hardcoded `'default'`).
3. No Theme carries behavior — no functions, no async hooks, no JS files specific to a theme. Enforced by the registry's type contract (strings only).
4. Themes never override verdict color classes (`.v-green`, `.v-light-blue`, `.v-yellow`, `.v-orange`, `.v-red`, `.v-light-green`). Enforced by code review and by SC-005's computed-color regression test.
