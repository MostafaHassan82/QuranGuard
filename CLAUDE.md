<!-- SPECKIT START -->
Active feature: **002-correction-autocorrect** (V1.2). Foundation: 001
(reader-side V1, shipped) and 003 (writer-side ayah autocomplete, shipped on
003-ayah-autocomplete branch — its commits are ancestors of this branch).

Read the implementation plan and supporting artifacts before making
non-trivial changes:

- Plan:        specs/002-correction-autocorrect/plan.md
- Spec:        specs/002-correction-autocorrect/spec.md (22 FRs, 8 SCs, 4 clarifications)
- Data model:  specs/002-correction-autocorrect/data-model.md
- Contracts:   specs/002-correction-autocorrect/contracts/
- Research:    specs/002-correction-autocorrect/research.md
- Quickstart:  specs/002-correction-autocorrect/quickstart.md
- Foundation:  specs/001-arabic-citation-auditor/ (reader-side V1, shipped) and
               specs/003-ayah-autocomplete/ (writer-side autocomplete, shipped).
- Constitution: .specify/memory/constitution.md (v2.0.0 — 6 principles, two NON-NEGOTIABLE)

Constitution non-negotiables (full text in the constitution file):
1. Integrity Is the Only North Star.
5. Porting Discipline From the Advanced Copy at C:\Users\mosta\PycharmProjects\QuranChromePlugin (read-only): harvest cases, do not port implementation.

Quick orientation:
- Chromium MV3 extension; vanilla JS; no build step.
- Highlight taxonomy is fixed: five verification verdicts (green / light blue / yellow / orange / red) plus one provenance color, light green = "corrected" (applied by correct-in-place, not the classifier).
- Core goal is citation integrity: never let an ayah be altered, and replace verified text with the authentic mushaf wording. Problem-case severity is red > yellow > orange (orange = correct words, wrong reference = LEAST severe). Orange is NOT the flagship.
- Writer-side prevention (ayah autocomplete as the user types in page inputs) is a co-equal goal, not a nice-to-have.
- All cross-context messaging uses the envelope in contracts/messaging.md; handlers MUST `return true`.
- Storage: chrome.storage.local only; see contracts/storage.md for the `prefs.v1` and `persisted.v1.*` schemas.
- Tests: Playwright via tests/run_tests.py against fixtures in tests/fixtures/.
<!-- SPECKIT END -->
