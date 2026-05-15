# Architecture

## Starting Assets

A fresh rebuild assumes these resources already exist:

- `resources/quran-uthmani_desc-v2.json`: complete Quran data split by verse.
- `resources/me_quran.ttf`: Quran font for future render mode.
- `resources/QuranAyas/*.png`: one image per ayah.
- `resources/QuranAyas2/*.png`: alternate image set.
- `icons/*`: extension icons.

## Extension Shape

Use a small Chrome extension structure:

- `manifest.json`
- `js/background.js`
- `js/content.js`
- `js/popup.js`
- `html/popup.html`
- `css/content.css`
- `css/popup.css`
- `tests/`

The current project is Manifest V2. A fresh rebuild may start with MV2 to preserve behavior quickly, then migrate to MV3 as a planned step. If starting directly with MV3, keep the same module responsibilities and message contracts.

## Module Responsibilities

### Background/Data Service

The background script owns Quran data loading and verification.

Responsibilities:

- Load the Quran JSON once.
- Build indexes for fast lookup.
- Normalize Quran text consistently.
- Resolve surah names, common spellings, and numeric references.
- Verify text fragments globally and against explicit references.
- Return structured match data to the content script.
- Receive debug stats from the content script and log them from the persistent extension side, so tab switching does not lose the console output.

Useful conceptual indexes:

- `byRef`: direct lookup by surah and ayah number.
- `surahNameIndex`: Arabic surah names and known variants.
- `normalizedVerseIndex`: normalized text to one or more verse references.
- `word/skeleton indexes`: helper indexes for partial, ordered, and short-fragment lookup.
- `range helpers`: utilities to combine ayahs and map quoted spans back to subranges.

### Content Scanner/UI Layer

The content script owns the page.

Responsibilities:

- Traverse visible text in the page.
- Extract citation candidates without damaging page structure.
- Avoid scanning scripts, styles, extension UI, and already-highlighted nodes.
- Send candidate fragments to the background verifier.
- Wrap verified citations in green spans.
- Wrap high-confidence unverified citations in red spans.
- Add tooltip metadata.
- Support scan, clear, and stats requests from the popup.
- Settle asynchronous scan work before reporting final stats.

### Popup

The popup starts as a practical debug/control surface.

Responsibilities:

- Trigger a scan of the active tab.
- Clear highlights from the active tab.
- Show temporary debug stats.
- Later, expose render mode, strictness, autocomplete, and image source settings.

## Message Boundaries

Keep the content script and background script loosely coupled. The exact message names can change, but the product needs these capabilities:

- Verify a free text fragment and return exact, ordered, partial, and best references.
- Verify a fragment against an explicit reference or range.
- Resolve a reference string into Quran data.
- Search suggestions by typed prefix for the future autocomplete feature.
- Report debug stats from the page scanner to the background console.
- Ask the content script to scan, clear, or report current stats.

## Styling Responsibilities

`css/content.css` should define:

- Green verified highlight.
- Red unverified citation highlight.
- Tooltip behavior.
- Any future inline dropdown styles.

`css/popup.css` should define:

- Compact debug stat layout.
- Scan/clear controls.
- Future settings controls.

## Resource Exposure

The manifest must expose only the resources needed by page-facing code:

- Quran JSON if loaded from extension URL.
- Quran font for future font mode.
- Quran ayah PNG folders for future image mode.
- Content CSS and icon assets as needed.

