# Product Scope

## Product Goal

Build a Chrome extension that reviews the current web page, detects Quran citations, verifies them against the local Quran JSON resource, and gives the user visible confidence feedback.

The extension should help with two workflows:

1. Reading: identify whether Quran citations already present on a page are correct.
2. Writing: later, help users insert verified Quran citations while typing.

## Current Baseline Behavior

The current rebuild target is the reading workflow.

When scanning a page:

- Green highlight means the cited text was verified against Quran data.
- Red highlight means the page strongly appears to contain a Quran citation, but the extension could not verify it.
- No highlight means the text was not confidently identified as a Quran citation.
- Tooltips show one or more references such as `البقرة:242`.
- If the same phrase appears in multiple ayahs with the same ordered words, show all exact ordered references.
- If a match is only partial or out of order, display it separately from exact ordered references.
- Do not replace page text during scanning. Replacement with Quran font or ayah image is a later explicit render mode.

## Supported Citation Shapes

The scanner should support:

- Quran lead-in phrases such as `قوله تعالى`, `قوله سبحانه`, `قال تعالى`, and similar variants.
- Braced, parenthesized, or quoted citation text.
- Explicit references after text, including:
  - `(البقرة:242)`
  - `(البقر:106)` as a common shortened/misspelled surah form when resolvable.
  - `(فصلت:3-4)`
  - `{الواقعة:77،80}`
  - `(يوسف: الآيات 21، 40، 68)` as reference metadata, not ayah text.
- Multi-ayah citations separated by `*`.
- Citations split by nested inline markup or line breaks.
- Short fragments when an explicit reference or strong Quran lead-in gives enough confidence.
- Repeated citations in the same paragraph without a full lead-in each time, when local context clearly carries the Quran citation meaning.

## Pattern Families To Support

The scanner is rule-based and deterministic. Future AI can help rank likely candidates, but the first rebuild should use explicit pattern families and Quran JSON verification.

Arabic lead-in families:

- `قال الله تعالى`
- `قال تعالى`
- `قال سبحانه وتعالى`
- `قال سبحانه`
- `قوله تعالى`
- `قوله سبحانه`
- `قوله عز وجل`
- `يقول الله تعالى`
- `قال ربكم`
- `في كتاب الله`

Arabic reference families:

- `سورة <name>`
- `الآية <number>`
- `من سورة <name>`
- `<surah>:<ayah>`
- `<surah>:<start>-<end>`
- `<surah>:<ayah>،<ayah>`
- Arabic and Western digit variants.

English and hybrid families for a later hardening pass:

- `Allah says`
- `Allah said`
- `The Quran says`
- `As Allah says in the Quran`
- `It is mentioned in the Quran`
- `Quran 2:255`
- `Surah Al-Baqarah 2:255`
- `Surah Al-Baqarah, Ayah 255`
- English lead-in followed by Arabic quoted text.

English/transliteration matching should stay lower priority than Arabic Quran text verification.

## Review And Replacement Modes

The product should support these modes over time:

- `manualScan`: user clicks the extension to scan the current page. This is the V1 default.
- `autoPassive`: page scans automatically with low-noise highlights.
- `autoInteractive`: page scans automatically and offers a findings panel for navigation and review.

Replacement behavior should be configurable:

- `globalMode`: one display mode applied to every verified citation on the page. This is the preferred default once render modes ship.
- `inlineToggle`: each citation can be toggled individually.
- `hybrid`: global mode with per-citation overrides.

Safe defaults matter:

- Never replace page text automatically before the user enables a render mode.
- Preserve the original page text so highlights can be cleared or rerendered.
- Preview or clearly signal image/font replacement behavior.

## Examples To Preserve

These are behavior anchors, not implementation details:

- `كذلك يبين الله لكم آياته` should show all exact ordered references, not just the first.
- `كذلك يبين الله لكم الآيات` should show all exact ordered references for that wording.
- `{وقليل من عبادي الشكور} (سبأ:13)` should be detected even when preceded by a long explanatory phrase.
- `قوله تعالى: {ما ننسخ من آية أو ننسها} (البقر:106)` should resolve the intended reference.
- `قوله سبحانه: {كتاب فصلت آياته قرآنا عربيا لقوم يعلمون * بشيرا ونذيرا فأعرض أكثرهم فهم لا يسمعون} (فصلت:3-4)` should display the range as one citation reference.
- For range citations with partial quoted spans, map the quoted text to the actual subrange when possible rather than blindly displaying the full written range.

## Deferred Features

These are planned but not part of the baseline scanner:

- Quran font render mode.
- Ayah PNG render mode.
- Inline typing autocomplete and insertion.
- Full settings/options UI.
- Manifest V3 migration.
- User-facing report panel listing all findings.

## User-Friendly Representation Goals

Later UI should make the result understandable without relying only on color:

- Tooltip text should say whether a citation is verified or not exact.
- A findings panel should show total, verified, and unverified counts.
- Clicking a finding should scroll to the citation.
- Color-blind friendly highlight palettes should be possible.
- Tooltip size/density should be adjustable.
- Keyboard-only interaction should work for the typing assistant.
