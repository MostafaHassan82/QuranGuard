# Fresh Start Guide

This directory is a rebuild guide for the Quran citation extension. It assumes a clean project with only the provided resources and icons available, and no existing JavaScript, HTML, CSS, manifest, or tests.

The goal is not to copy the current implementation line by line. The goal is to preserve the product behavior, architecture boundaries, scanner rules, and regression workflow we learned while building the current version.

## Document Map

- `01-product-scope.md`: what the extension should do, what counts as correct behavior, and what is intentionally deferred.
- `02-architecture.md`: the extension structure, module responsibilities, resource assumptions, and message boundaries.
- `03-scanner-behavior.md`: the citation detection, matching/search strategy, and verification rules needed to reach the current scanner quality.
- `04-testing-workflow.md`: the fixture and live-site tools needed to test the real JavaScript behavior.
- `05-roadmap.md`: the next planned work after the current scanner/testing baseline.

## Relation To The Cursor Plan

These documents are the fresh-start version of `.cursor/plans/quran-extension-plan.md`. The plan's intent is included here, but reorganized by rebuild topic instead of task-list order:

- Baseline audit and current behavior -> `01-product-scope.md`
- Quran data layer and indexes -> `02-architecture.md` and `03-scanner-behavior.md`
- Content scan/highlight behavior -> `03-scanner-behavior.md`
- Popup/options direction -> `02-architecture.md` and `05-roadmap.md`
- Render modes -> `01-product-scope.md` and `05-roadmap.md`
- Typeahead UI -> `01-product-scope.md` and `05-roadmap.md`
- MV3 migration -> `02-architecture.md` and `05-roadmap.md`
- Test checklist/assets -> `04-testing-workflow.md`

The fresh-start docs intentionally avoid line-by-line implementation details, but they should preserve every product requirement and every major technical decision from the cursor plan.

## Current-State Target

Rebuilding from scratch should first reach this baseline:

- A Chrome extension that scans a page for Quran citations.
- Verified citations are highlighted green.
- Citation-like text that cannot be verified is highlighted red only when confidence is high.
- Hovering a highlight shows the matched surah and ayah references.
- Multiple exact matches are listed in the tooltip.
- Partial or non-ordered matches are shown distinctly from exact ordered matches.
- Explicit references and ranges such as `(البقرة:242)`, `(فصلت:3-4)`, and `{الواقعة:77،80}` are understood.
- The popup can trigger scan/clear actions and show temporary debug stats.
- Regression tests run the actual extension JavaScript in a browser against saved HTML fixtures.
- Live URL tests exist for cases where saved fixture DOM differs from the real rendered page.

## Important Principle

The Quran JSON is the source of truth. Fuzzy or partial matching can help with discovery and display, but the extension should not label a citation as verified unless the text can be deterministically matched to the Quran data after agreed normalization.
