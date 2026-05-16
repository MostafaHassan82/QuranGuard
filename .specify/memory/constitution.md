<!--
SYNC IMPACT REPORT
==================
Version change: (uninitialized template) → 1.0.0
Modified principles: N/A (initial ratification)
Added sections:
  - Core Principles (6 principles)
  - Technology Constraints
  - Development Workflow
  - Governance
Removed sections: N/A
Templates requiring updates:
  ✅ .specify/templates/plan-template.md — Constitution Check gate references this file; no edit needed
  ✅ .specify/templates/spec-template.md — Aligned (no scope/requirement changes needed)
  ✅ .specify/templates/tasks-template.md — Aligned (no new task categories required at v1.0.0)
  ⚠ CLAUDE.md — Project guidance file should cite this constitution; review on next amend
Follow-up TODOs: None
-->

# QuranAuditPlugin Constitution

## Core Principles

### I. Integrity Is the Only North Star (NON-NEGOTIABLE)

Every feature, refactor, and design decision is weighed by a single test: **does this make false Quran citations visible on the web?** Mostafa's framing: *"Quran is Noble, we don't want anyone to alter it whether intentionally or not."*

The product serves two coupled workflows in service of this mission: (1) reader-side audit — detect when citations on a page are wrong (wrong reference attached to a real verse, altered wording, fabricated quote); and (2) writer-side assist — help authors insert correct citations while typing so mistakes never enter circulation. Both share the same Quran data layer, same normalization, same matching logic. Writer-side is downstream of getting the reader-side verifier right.

When prioritizing, render polish, image replacement, popup styling, and font swaps are SECONDARY to making the verifier trustworthy.

### II. Five-Color Highlight Taxonomy Is Fixed

The extension uses exactly five highlight colors. Each carries a specific verification meaning. The taxonomy MUST NOT be collapsed, relabeled, or extended without explicit ratification.

- **Green — Verified.** Text matches the Quran exactly OR differs only in tashkeel/diacritics OR differs only in normal modern-vs-Quranic Arabic spelling drift (alif variants ا/آ/ٱ, alef maqsura vs ya ى/ي, ta marbuta vs ha ة/ه, adjacent same-letter collapse such as `بِٱلَّيْلِ` ↔ `بالليل`). All such drift is NOT alteration and MUST be treated as fully verified. If a written reference accompanies the citation, it agrees with the matched verse.
- **Light Blue — Unreferenced but verified.** Citation matches the Quran (per green rules) but no reference was written. Extension contributes the correct reference in the tooltip.
- **Yellow — Word-level inexact.** A real word is missing, added, or substituted relative to the matched verse. Intent is clearly a citation; not wrong, just imprecise. Worth human review.
- **Orange — Reference mismatch.** ⭐ **HEADLINE FINDING.** Text exists in the Quran but at a DIFFERENT reference than the one written on the page. Both the citation and the written reference are real in isolation, but they don't belong together. Tooltip MUST say "Cited as X, actually Y." This is the case no human reader catches by eye, and it is the main reason this product exists.
- **Red — Not in Quran.** Page strongly looks like a Quran citation (lead-in phrase, braces, explicit reference) but the words do not exist as ordered Quran text anywhere. Could be fabrication, heavy paraphrase, or transcription error.

**Why:** Green must be reassuring without being overly strict — tashkeel and normal Arabic spelling drift MUST NOT downgrade the highlight, because that just trains users to ignore yellow/orange.

### III. Orange Is the Product's Flagship Signal

When designing matching logic, verifier output, tooltip text, popup/panel UI, or any user-facing surface, treat orange as the headline. The comparison that matters most is *"what the page says the ref is"* vs *"what global search says it is"* — disagreement = orange.

A feature that does not make orange more reliable, more discoverable, or more actionable is below the line for V1.

### IV. Authentic-Text Replacement Is the Default Render

Whenever the verifier can confirm a match (any non-red color: green, light blue, yellow, orange), the extension SHALL by default replace the page text with the authentic JSON copy — Quran font + full tashkeel — and use the highlight color as scaffolding around the authentic rendering. Red MUST NOT be swapped (nothing authentic to render).

This is not a per-color toggle. It is a global default: *"whenever we can verify, replace the page text with the authentic JSON copy."* The user controls it from the popup (master toggle plus per-color overrides). The product statement: the extension's job is to make authentic Quran visible everywhere it appears, with highlights as scaffolding around that.

### V. Porting Discipline From the Advanced Copy (NON-NEGOTIABLE)

`C:\Users\mosta\PycharmProjects\QuranChromePlugin` (the "advanced copy") is read-only reference. It has 17 verified matches and 0 red on fixture 174389 — the rebuild has 6 verified and 16 red on the same fixture. The advanced copy works; the rebuild does not yet.

Despite that maturity, the advanced copy MUST NOT be ported verbatim. Its `background.js` is 1300 lines and `content.js` is 1883 lines for "normalize + index + verify + extract + highlight + render" — sizes that indicate accumulated patches and case-by-case carve-outs. Mostafa flagged that progress slowed there because changes were tightly coupled to existing code.

The discipline:

- Treat the advanced copy as a **source of truth for cases that must work** (the 11 reviewed fixtures, surah-name variants, range/subrange edge cases, Islamweb DOM quirks). Catalog the *cases*. Do not copy the *implementation*.
- Treat it as a **map of where things got stuck**. If a region looks like a sequence of special cases rather than a principled shape, flag it for redesign, not port.
- For each major function: **read → understand the cases → redesign the shape → implement cleanly**.
- Small, clean ports (e.g., the surah-variant map, normalization rules) are fine. The discipline applies to extraction/verification/range-handling regions where size suggests patch buildup.

### VI. Fixtures Are the Quality Gate, Not the Porting Target

The 11 reviewed Playwright fixtures are valid signal that the verifier logic works. They are the gate *after* a rewrite, not a recipe to copy. Implement → run fixtures → fix what breaks — but fix by improving the shape, not by adding more carve-outs. If a single fixture requires a one-off branch in the code, treat that as a design smell and step back.

The V1 success bar is parity with the advanced copy on the existing fixture set: ≥17 verified matches and 0 red on fixture 174389 (currently 6/16), with `ما ننسخ من آية` resolving to `البقرة:106` (currently produces junk partials against `الطور:8` / `الطارق:6` / `الفلق:2`).

## Technology Constraints

- **Browser target:** Chromium-based browsers via Manifest V3 only. MV2 is end-of-life and out of scope.
- **JavaScript:** Vanilla JS. No jQuery, no UI framework, no build step for V1.
- **Background:** MV3 service worker. The Quran index is rebuilt on each activation by fetching the local JSON (~50–100 ms). No IndexedDB persistence layer for V1.
- **Async messaging:** `chrome.runtime.onMessage` handlers MUST `return true` to keep the message channel open for async responses.
- **Data source:** `quran-uthmani_desc-v2.json` is the authoritative copy. All verification, all rendering swaps, all reference resolution flow through it. No remote API calls in V1.
- **DOM strategy (content script):** TreeWalker-based traversal building a virtual concatenated text-node string (joined with `\x00` boundaries) plus an offset map. Regex runs against the virtual string; matches are projected back to live text nodes for wrapping.
- **Testing:** Playwright drives real extension runs against saved HTML fixtures under `tests/`. Tests assert on `window.__quranScan`, `window.__quranStats`, `window.__quranMatches`. No Python reimplementation of the verifier — the test runner exercises the actual JS.
- **V1 site scope:** Arabic websites only. English/transliteration matching is deferred.

## Development Workflow

1. **Anchor every change to a principle.** If a proposed change doesn't move orange reliability, integrity coverage, or the fixture pass rate forward, defer it.
2. **Read before you write.** When touching extraction, verification, or range handling, read the equivalent region in the advanced copy first to catalog cases — then redesign the shape in the rebuild.
3. **Fixture-driven iteration.** After any verifier change, run the full Playwright fixture suite (`tests/run_tests.py`). A regression on a previously-passing fixture is a stop-the-line event.
4. **No carve-outs in production code.** If a fixture forces an `if (url === ...)` or a hardcoded patch, the design is wrong. Step back and reshape.
5. **Reference docs override code archaeology.** When intent is ambiguous, consult `fresh_start/` (the V1 PRD, scope, architecture, verifier design) before guessing from existing code.
6. **Phases ship sequentially.** Phase 2 (scanner hardening) before Phase 3 (popup settings) before Phase 4 (Quran font render) before Phase 5 (Ayah PNG) before Phase 6 (typing autocomplete). Don't start a later phase until the prior one closes its fixtures.

## Governance

This constitution supersedes ad-hoc practice, prior `fresh_start/` documents where they conflict, and any inherited convention from the advanced copy. Where this document and the cowork memory disagree, this document wins — and the memory entry should be updated to match.

**Amendment procedure:**

- Any change to a principle, a color semantic, the render default, or a non-negotiable rule requires explicit ratification by the project owner before merge.
- Version bumps follow semantic versioning:
  - **MAJOR** — A principle is removed or redefined in a backward-incompatible way (e.g., color taxonomy changes meaning).
  - **MINOR** — A new principle or section is added, or guidance is materially expanded.
  - **PATCH** — Clarifications, wording improvements, typo fixes, non-semantic refinements.
- Each amendment MUST update the Sync Impact Report at the top of this file, the version line at the bottom, and `LAST_AMENDED_DATE`.
- Dependent templates (`plan-template.md`, `spec-template.md`, `tasks-template.md`) and runtime guidance (`CLAUDE.md`, `fresh_start/`) MUST be reviewed for alignment as part of the amendment PR.

**Compliance review:**

- Every implementation plan generated by `/speckit-plan` MUST pass a Constitution Check gate before Phase 0 research and again after Phase 1 design. Violations must be justified in the plan's Complexity Tracking table or the work does not proceed.
- Reviewers reject changes that collapse the five-color taxonomy, weaken the integrity test for prioritization, port verbatim from the advanced copy without case-by-case redesign, or introduce hardcoded per-fixture carve-outs.

**Version**: 1.0.0 | **Ratified**: 2026-05-16 | **Last Amended**: 2026-05-16
