# QuranGuard (صون القرآن)

A Chrome extension (Manifest V3) that verifies Quran citations on the web and helps authors insert correct ayahs as they type.

> **Integrity is the only north star.** Quran is Noble; no citation should be altered — intentionally or not. QuranGuard pursues that goal on both sides of the page: it audits what readers see, and it guides what writers type.

## What it does

**Reader side — verify citations already on the page.** As you browse, QuranGuard scans page text for Quran citations, compares them against the authentic mushaf, and highlights each one with a fixed five-color verdict:

| Color       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| green       | verified exact — text and reference agree                            |
| light blue  | verified exact — no reference written on the page                    |
| yellow      | word-level deviation from the authentic wording                      |
| orange      | reference mismatch — the text is real Quran, but at a different ref  |
| red         | citation signal, but the text is not found in the Quran              |

A sixth color, **light green**, is reserved for *corrected-in-place* text — when QuranGuard rewrites yellow/orange/red wording back to the authentic mushaf form.

**Writer side — autocomplete correct ayahs as you type.** In any web editor or input, QuranGuard detects Quran-citation intent and offers inline suggestions drawn from the authentic mushaf (single ayah, multi-ayah ranges, or "to end of surah"). Mistakes are prevented at the source rather than caught after publication.

## Install (developer mode)

1. Clone this repo.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and pick the repo root.
5. The QuranGuard icon appears in the toolbar.

Manifest V3, vanilla JavaScript, no build step — what you load is what runs.

## Run the tests

```bash
python tests/run_tests.py
```

Tests are Playwright-driven against HTML fixtures in `tests/fixtures/`.

## Project layout

- `manifest.json` — MV3 manifest
- `js/background.js` — service worker; verifier gauntlet, diff, near-match
- `js/content.js` — page scan, citation detection, highlight orchestration
- `js/verifier/` — normalization helpers
- `js/compose/` — writer-side autocomplete (detection, dropdown, insertion)
- `js/panel/`, `js/render/` — findings panel, font/image swap
- `resources/` — Quran text JSON, fonts, ayah images
- `specs/` — feature specs and plans (Spec Kit)
- `tests/` — Playwright suite, fixtures, harness

## Specs and governance

This project uses [Spec Kit](https://github.com/github/spec-kit) for spec-driven development.

- Reader-side V1: `specs/001-arabic-citation-auditor/` (shipped)
- Writer-side autocomplete: `specs/003-ayah-autocomplete/` (shipped)
- Correction & autocorrect: `specs/002-correction-autocorrect/` (active)
- Constitution: `.specify/memory/constitution.md` — six principles, two non-negotiable

## A note on the name

The on-disk directory is still `QuranAuditPlugin/` for historical reasons (it predates the rename). The product, package, and extension name everywhere user-facing is **QuranGuard** (Arabic: **صون القرآن** — *Ṣawn al-Qurʾān*, "safeguarding the Qur'an").

## License

[MIT](./LICENSE) © 2026 Mostafa Hassan
