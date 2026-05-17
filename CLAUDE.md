<!-- SPECKIT START -->
Active feature: **001-arabic-citation-auditor** (V1).

Read the implementation plan and supporting artifacts before making
non-trivial changes:

- Plan:        specs/001-arabic-citation-auditor/plan.md
- Spec:        specs/001-arabic-citation-auditor/spec.md (32 FRs, 13 SCs, 20 clarifications)
- Data model:  specs/001-arabic-citation-auditor/data-model.md
- Contracts:   specs/001-arabic-citation-auditor/contracts/
- Research:    specs/001-arabic-citation-auditor/research.md
- Quickstart:  specs/001-arabic-citation-auditor/quickstart.md
- Constitution: .specify/memory/constitution.md (v1.0.0 — 6 principles, two NON-NEGOTIABLE)

Constitution non-negotiables (full text in the constitution file):
1. Integrity Is the Only North Star.
5. Porting Discipline From the Advanced Copy at C:\Users\mosta\PycharmProjects\QuranChromePlugin (read-only): harvest cases, do not port implementation.

Quick orientation:
- Chromium MV3 extension; vanilla JS; no build step.
- Five-color highlight taxonomy is fixed: green / light blue / yellow / orange / red.
- Orange (reference-mismatch) is the flagship signal.
- All cross-context messaging uses the envelope in contracts/messaging.md; handlers MUST `return true`.
- Storage: chrome.storage.local only; see contracts/storage.md for the `prefs.v1` and `persisted.v1.*` schemas.
- Tests: Playwright via tests/run_tests.py against fixtures in tests/fixtures/.
<!-- SPECKIT END -->
