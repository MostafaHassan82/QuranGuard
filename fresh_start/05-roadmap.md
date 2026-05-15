# Roadmap

## Phase 1: Rebuild Current Baseline

Goal: match the current scanner and test workflow before adding new product features.

Acceptance criteria:

- Extension loads in Chrome.
- Manual scan highlights verified Quran citations green.
- High-confidence unverified citation candidates are red.
- Tooltip references are correct for exact, multiple, partial, and range matches.
- Popup can scan, clear, and show the eight debug stats.
- Background console logs the debug stats.
- Fixture tests pass.
- Live URL runner can reproduce real-site behavior.

Must-have V1 scope:

- Core citation verification on the current page.
- Robust Arabic normalization.
- Green/red highlighting with tooltip details.
- Manual scan and clear highlights.
- Conservative candidate detection.
- Popup settings persistence where settings exist.
- Removal of test/noise phrases and intrusive debug behavior.

## Phase 2: Continue Scanner Hardening

Focus on reducing false positives and false negatives before adding replacement UI.

Work items:

- Keep improving range/subrange mapping.
- Improve handling for `إلى قوله` citation spans.
- Keep scanner-first detection strong so back-reference logic does not reduce global multi-match behavior.
- Make fixture and live-page output deterministic.
- Add new fixtures whenever a real bug is found.

Success signs:

- Red highlights are rare and explainable.
- Existing fixture stats remain stable.
- The scanner detects citations even when no explicit reference appears.
- Explicit reference logic helps rather than replacing global lookup.

Acceptance checklist:

- Correct Quran citations highlight green with proper tooltip references.
- Incorrect or altered citation-like text highlights red only when confidence is high.
- Non-citation Arabic text does not create excessive false positives.
- Multi-reference phrases keep all intended references.
- Ranges and subranges display the actual matched ayah span.

## Phase 3: Popup And Settings

Turn the temporary popup into a real control surface.

Controls:

- Scan current page.
- Clear highlights.
- Review mode: manual, automatic, or disabled.
- Render mode: page text, Quran font, image.
- Strictness: exact-only or assisted matching.
- Autocomplete on/off.
- Debug stats on/off.

Persist settings with Chrome storage and notify content scripts when settings change.

## Phase 4: Quran Font Render Mode

Add an explicit mode that renders verified citations using `resources/me_quran.ttf`.

Requirements:

- Do not change content unless the user enables this mode.
- Preserve surrounding font size and line height as much as possible.
- Keep the tooltip and verification metadata.
- Provide a clean way to revert to original page text.

Validation:

- Existing highlights can switch into font mode without page reload when possible.
- Font mode respects approximate surrounding font size.
- Missing font load fails back to text mode without breaking highlights.

## Phase 5: Ayah Image Render Mode

Add an explicit mode that replaces verified citations with PNG ayah images.

Requirements:

- Use `resources/QuranAyas` or `resources/QuranAyas2`.
- Match surrounding text size as closely as practical.
- Preserve accessibility metadata such as original text and reference.
- Handle multi-ayah and range citations gracefully.
- Avoid layout jumps where possible.

Validation:

- Image mode loads the correct ayah PNG.
- Missing images degrade gracefully.
- Multi-ayah citations and ranges are displayed predictably.

## Phase 6: Typing Assistant

Add a dropdown while the user types in inputs, textareas, and contenteditable fields.

Behavior:

- Detect Arabic Quran fragment prefixes.
- Detect `surah:ayah` style input.
- Query the background suggestion index.
- Show a small dropdown near the caret.
- Support keyboard navigation.
- Insert selected citation as Quran text, Quran font text, or image based on settings.

The assistant should use the same Quran data layer as the scanner. Do not build a second matching system.

Validation:

- Suggestions narrow while typing.
- Arrow keys and Enter select correctly.
- Inserted content matches the selected render mode where technically safe.
- The dropdown is keyboard accessible.

## Phase 7: Manifest V3 Migration

Migrate after the scanner and tests are stable, unless Chrome Web Store requirements force it earlier.

Keep these behavior checks during migration:

- Quran JSON still loads reliably.
- Background/service worker lifecycle does not lose indexes at scan time.
- Content script messaging handles inactive service worker wakeup.
- Tests still run against the real extension code.

## Phase 8: Release Readiness

Before release:

- Hide or gate debug stats.
- Remove temporary console noise.
- Document resource licenses and naming assumptions.
- Add a short user guide.
- Add a privacy note: verification is local if no network calls are used.
- Run all fixture tests and selected live URL tests.

## Future AI-Assisted Work

AI can be useful later, but only around the deterministic verifier.

Allowed uses:

- Rank likely citation spans before deterministic verification.
- Improve multilingual citation-intent detection.
- Help distinguish exact quote claims from paraphrase/meaning claims.

Guardrails:

- Never replace Quran JSON verification with AI confidence.
- Keep local-first behavior for privacy-sensitive pages.
- Show user-visible confidence/explanation for AI-assisted candidates.

## Risks And Mitigations

- Large Quran JSON: precompute indexes once and keep content-script messages small.
- False positives in Arabic prose: require strong citation signals before red highlighting.
- Back-reference overreach: keep backward windows bounded and prefer braced/quoted citation spans.
- Live DOM differs from saved HTML: use rendered fixture capture and live URL runner.
- MV2 deprecation: make migration a planned checkpoint, not an afterthought.
- Debug tools leaking into release: gate stats and console logging behind a debug flag.

## Delivery Checklist

1. Stabilize extension flow and remove runtime blockers.
2. Implement reliable Quran verification and highlighting.
3. Add tooltip metadata for verified and unverified citations.
4. Keep fixture and live URL tests passing.
5. Add render choices: text, Quran font, and ayah image.
6. Add typing autocomplete with narrowing results and insertion.
7. Add popup/options for mode, strictness, render behavior, and autocomplete.
8. Migrate to Manifest V3 after the core behavior is stable.
