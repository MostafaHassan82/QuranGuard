# Quran Citation Audit Extension — V1 PRD

**Status:** Draft for review
**Author:** Mostafa (product) + Claude (drafted 2026-05-15)
**Supersedes:** `01-product-scope.md` is now a supporting reference; this document is the authoritative V1 spec.

---

## TL;DR

A Chrome extension that audits Arabic web pages for Quran citation integrity. It catches the case no human reader can catch by eye: a citation whose text is real Quran but is attributed to the wrong reference. When the extension can verify a citation, it replaces the on-page text with the authentic Quran text (Quran font + full tashkeel from the local JSON), making the authentic Quran visible everywhere it appears. V1 ships on Arabic websites only.

---

## Problem Statement

The Quran is widely quoted online. On Arabic websites, citations appear with explicit references in nearly every religious article — and a non-trivial fraction of those citations are wrong in subtle ways: a real verse is attributed to the wrong surah or ayah, a word is missing or substituted, or the quoted text doesn't appear anywhere in the Quran at all. Readers cannot catch these errors at scale, and writers do not have a tool that flags mistakes as they compose. The result is gradual drift in how the Quran appears on the web, both unintentional (transcription error, citing from memory) and, occasionally, deliberate.

This product exists because the Quran is Noble and its integrity on the web is worth protecting actively. The cost of not solving it: distorted citations propagate, readers internalize wrong references, and the public corpus of "Quran on the web" diverges from the Quran itself.

---

## Goals (V1)

1. **Detect the four verifiable citation states reliably on Arabic web pages**: exact match, word-level deviation, reference mismatch, and unverifiable. Five-color highlight taxonomy below.
2. **Catch reference mismatch (orange)**: citations where the text is real Quran but the attached reference points to a different verse. No human reader catches this by eye, so it must be detected — but it is the LEAST severe problem case (correct words, wrong reference). Overall severity runs red > yellow > orange; the product's north star is citation integrity (never-altered text + authentic in-place replacement) plus writer-side prevention, not orange specifically.
3. **Render the authentic Quran text in place by default** for all verified findings (green, light blue, yellow, orange). Authenticity is signaled visually through the Quran font + full tashkeel, not just through colored highlights.
4. **Provide a findings panel** that collects all orange (reference-mismatch) findings on a page in one place, with actions to report, copy, share, and (where technically possible) edit the citation in place.
5. **Ship on Manifest V3** with a deterministic verifier whose green highlights are trustworthy enough that users do not learn to ignore them.

---

## Non-Goals (V1)

| Non-goal | Why |
|---|---|
| **Ayah PNG image render** | Exists in the advanced copy; visually heavier and not on the integrity-critical path. Park for V1.1. |
| **Typing autocomplete / inline suggestion while composing** | Writer-side assist is downstream of reader-side verifier quality. V1.2. |
| **English / transliteration citation support** | Doubles the surface area without doubling the value. Most integrity-critical content is in Arabic. V2. |
| **autoInteractive review mode (auto-scan every page)** | V1 is manual-scan-only. Auto-scan introduces performance, privacy, and false-positive surface that isn't worth shipping until manual works flawlessly. V1.1. |
| **Per-user accounts, telemetry, or cloud sync** | Local-only verification is faster and respects privacy. No telemetry in V1. |
| **Non-Chromium browsers** | Chrome-first. Firefox/Edge port after V1 stabilizes. |

---

## Users & Personas

**Reader-Auditor (primary V1 user).** Reads Arabic religious articles online, often on sites like Islamweb, Alukah, Dorar. Wants to know whether the citations they're reading are accurate. Cares deeply about Quran integrity. Will not tolerate false greens — once a green is wrong, all greens lose credibility.

**Author-Verifier (secondary V1 user).** Writes religious content for Arabic websites or personal projects. Drafts contain Quran citations from memory or by copy/paste from other sources. Wants real-time feedback that what they wrote is correct, and a one-click way to swap their text for the authentic Quran rendering. (V1 covers this via "scan my own draft" — fully real-time composer support lands in V1.2.)

**Researcher / Editor (V2+).** Bulk-checks corpora. Out of V1 scope but the verifier design should not preclude headless / programmatic use later.

---

## User Stories

### Reader-Auditor

- As a reader on an Arabic article, I want to click the extension and see every Quran citation on the page color-coded by verification status, so I can immediately see which citations are trustworthy and which need scrutiny.
- As a reader, I want a panel that lists every reference-mismatch (orange) finding on the page in one place, so I can review the most consequential errors without scrolling.
- As a reader, when I hover over an orange highlight, I want the tooltip to show me both what the page claims the reference is and what the verse actually is, so I can understand the disagreement at a glance.
- As a reader, I want every verified citation to render in the Quran font with full tashkeel by default, so I can visually distinguish authentic Quran text from prose without reading the highlight color.
- As a reader, I want a single popup toggle to turn off authentic-text replacement if I prefer to see the page as written.

### Author-Verifier

- As an author drafting an article, I want to paste my draft into an Arabic page I'm editing and run the scan, so I can see whether my citations are correct before publishing.
- As an author with a yellow finding (word missing/substituted), I want a one-click action to replace my imperfect text with the authentic Quran rendering, so the correction is both right and visually authoritative.

### All users

- As any user, I want to clear all highlights from the page when I'm done auditing, so the page returns to its original appearance.
- As any user, I want to be able to copy the details of a finding (text, claimed ref, actual ref) to my clipboard for reporting or sharing.
- As any user, I want my preferences (auto-swap default, per-color overrides, image folder choice) persisted across sessions.

---

## Verifier Semantics — The Five Colors

The verifier produces one of five states for every span it processes. These are not stylistic choices; each maps to a specific verification outcome and a specific user action.

| Color | Meaning | User Action |
|---|---|---|
| **Green** | Text matches Quran exactly **OR** differs only in tashkeel/diacritics **OR** differs only in normal modern-vs-Quranic spelling drift (ا/آ, ى/ي, ة/ه). The page-stated reference (if any) agrees with the matched verse. | Default: swap to authentic text (Quran font + tashkeel). |
| **Light blue** | Text matches the Quran exactly (green-grade match) but the page did not state a reference. | Swap text + tooltip surfaces the correct reference. |
| **Yellow** | Text largely matches a verse but with a word-level difference — a word missing, a word added, or a word substituted. The intent is clearly a citation of the matched verse, but the wording is imprecise. | Swap to authentic text (this is *both* the correction and the authenticity signal). |
| **Orange** | Text exists in the Quran *exactly* (green-grade match) — but at a **different reference** than the page states. Both the citation and the page's reference are real, but they don't belong together. | Tooltip shows "Cited as X, actually Y." Findings panel collects all orange findings. Edit-in-place lets the user correct the reference in the page DOM. Authentic-text swap optional and orthogonal. |
| **Red** | Page strongly looks like a Quran citation (lead-in phrase, braces, explicit reference) but the words do not exist as ordered Quran text anywhere. Likely fabrication, heavy paraphrase, or serious transcription error. | Highlight only. We cannot authentically render text we cannot verify. |

**Important rules.**

- Tashkeel and Quranic-vs-modern spelling drift are *not* alterations. Green must tolerate them. Promoting them to yellow trains users to ignore yellow.
- Orange is a required V1 finding (the case no reader catches by eye), even though it is the least severe problem case. The advanced copy does not produce orange at all; designing the orange pipeline is a fresh-design problem, not a port.
- A candidate that fails verification at high candidate-confidence is red. A candidate at low candidate-confidence with no match is dropped silently (no highlight).
- Layered fallback matching (skeleton, gap-allowed ordered, etc.) is allowed for *finding* candidates but does NOT promote a result to green. Only exact / tashkeel-drift / spelling-drift matches are green.

---

## Action Surface — Universal Authentic-Text Swap

The default V1 behavior: **whenever the extension can verify a span (green, light blue, yellow, orange), it replaces the page text with the authentic JSON copy rendered in Quran font with full tashkeel.** Red is the only state that cannot swap.

This is the product's most distinctive design choice. It's framed as authenticity signaling, not cosmetics: the visual difference between authentic Uthmani rendering and surrounding prose is itself part of the integrity message.

**Per-color details of the swap.**

- **Green:** swap is cosmetic-affirmative (text was already correct; rendering it in Uthmani affirms authenticity).
- **Light blue:** swap is cosmetic-affirmative, plus the tooltip adds the missing reference.
- **Yellow:** swap is corrective — replacing the imperfect wording with the authentic verse text. This is the audit's "fix" action.
- **Orange:** swap is corrective + reference-correcting. Two-part fix offered in the tooltip / panel: "Fix reference," "Replace with authentic text," or both.

**Controls.**

- Popup master toggle: "Replace verified citations with authentic Quran text" (default ON).
- Per-color overrides (optional V1.0, definite V1.1): user can choose to swap green/yellow/orange but not light blue, etc.
- When swap is OFF, highlights remain — colors and tooltips still appear; only the DOM rewrite is suppressed.

---

## Findings Panel — The Orange Home

V1 includes a panel (popup-attached or sidebar) that lists all findings on the current page, **grouped by color with orange surfaced at the top.** This is where the audit story lives.

**Panel contents per finding.**

- Color badge (green / light blue / yellow / orange / red)
- Citation text (truncated, hover for full)
- Claimed reference (as written on the page) and actual reference (what the verifier found) — for orange, both shown explicitly; for others, just the matched ref
- Click to scroll to the highlight on the page

**Per-finding actions.**

- **Copy** — copies a formatted summary to clipboard ("Cited as X, actually Y. Text: ...")
- **Share** — opens a shareable text (V1.0: copy formatted block; V1.1: integrate with Twitter/X intent, mailto, etc.)
- **Report** — submits a structured report (V1.0: copy-to-clipboard with a report template; V1.1: optional submission endpoint, opt-in).
- **Edit in place** — modifies the article DOM directly to correct the citation. Works on contenteditable elements always; works on static prose when the host page permits DOM mutation (most do). Behavior is best-effort: when DOM mutation isn't viable, the action is disabled with a tooltip explaining why.

**Counts** at panel top: total findings, green count, yellow count, orange count, red count.

---

## Architecture

**Target shape:** Manifest V3 Chrome extension with service worker background, content script per frame, popup with attached findings panel.

**Reuse strategy.** The active project is the QuranAuditPlugin rebuild. The QuranChromePlugin advanced copy is treated as a read-only reference. Approach:

1. **Harvest principles, fixtures, and case coverage** from the advanced copy. The 11 reviewed fixtures and the documented case set (range/subrange, surah variants, Islamweb DOM quirks, etc.) become the V1 quality gate.
2. **Do not port code verbatim.** Mostafa specifically flagged a concern that the advanced copy may contain hardcoded corner-case solutions accumulated over iteration. The size (1300 / 1883 lines) is consistent with that risk.
3. **Rewrite in clean shape** for each major component, then run the harvested fixtures as the regression gate. Fix breakage by improving the shape, not by adding carve-outs.
4. **Add the orange pipeline as a first-class feature** — this does not exist in the advanced copy and is the V1 differentiator.

**Component responsibilities.**

- **Background (service worker):** Quran JSON loader, index builder (normalized verse index, word index, skeleton word index, surah-name index with variants), normalization, reference parsing, verification API (`verifyFragment`, `verifyFragmentByRef`, `resolveReference`, plus a new `compareTextVsRef` that explicitly returns the orange / green / yellow disagreement state). Ephemerality handled by lazy rebuild + persistent settings in `chrome.storage.local`.
- **Content script:** DOM walker, candidate extraction (lead-in braced, explicit-ref backward, range construct, short fragment with ref — the four highest-yield strategies; continuation context is parked), candidate verification routing, highlight wrapping, authentic-text swap engine, tooltip rendering, edit-in-place driver.
- **Popup + Findings Panel:** scan/clear controls, scan stats, findings list with grouping/sorting, per-finding actions, settings (master swap toggle, future per-color overrides, future image source).

**Key new piece: the orange pipeline.** For every candidate that carries an explicit reference:

1. Resolve the reference → list of intended ayahs.
2. Compare candidate text to those intended ayahs (green-grade comparison).
3. If match: green.
4. If no match in intended ayahs: run **global search** for the candidate text. If found exactly elsewhere → **orange** (cited as X, actually Y). If found with word-level diff → yellow. If not found → red.

This is the comparison the current code does not do. Adding it is the single highest-value implementation task in V1.

---

## Requirements

### P0 — Must-Have for V1 ship

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R1 | MV3 extension structure, service worker background, content script, popup. | Loads in Chrome; service worker rebuilds index on activation; content script injects on Arabic web pages. |
| R2 | Quran JSON loaded once, indexed for normalized exact match, ordered-word search, skeleton fallback, and reference lookup. | Verifier returns results in <50ms for typical candidate sizes after warmup. |
| R3 | Five-color verifier semantics per the table above. | Each color has a deterministic definition that a test fixture can encode. Tashkeel/spelling-drift counted as green. |
| R4 | Orange pipeline: explicit-ref verification that explicitly compares page-claimed ref vs global-search result and produces an orange finding when they disagree. | At least 5 hand-curated fixtures where the page says ref X for text that is actually ref Y, all produce orange with tooltip showing both refs. |
| R5 | Candidate extraction supports: lead-in-braced citations, explicit-ref-backward extraction, range citations (`فصلت:3-4`), and short fragments with refs. | All 11 advanced-copy fixtures pass. |
| R6 | Universal authentic-text swap as default behavior for green / light blue / yellow / orange. | After scan, verified spans render in `me_quran.ttf` with text drawn from the JSON. Page layout preserved within reasonable approximation. |
| R7 | Popup master toggle for authentic-text replacement. Persisted in `chrome.storage.local`. | Toggling OFF preserves highlights but reverts DOM text. Persistence survives browser restart. |
| R8 | Findings panel listing all findings on the current page, grouped by color, orange surfaced first. Panel available in **two user-selectable surfaces**: popup-attached and page-injected (sidebar / overlay on the page itself). User chooses via popup settings; default is popup-attached. Both render the same data and actions. | Panel shows count summary, click-to-scroll works, claimed vs actual ref displayed for orange. Surface preference persisted in `chrome.storage.local`. |
| R9 | Per-finding actions: copy, edit-in-place (where DOM permits). Report and share are V1 stretch (see R12). | Copy puts formatted text on clipboard. Edit-in-place modifies article DOM for orange ref-correction. |
| R10 | Manual scan and clear actions from popup. | Scan completes within 5 seconds on a typical Islamweb article. Clear restores original page text and removes highlights. |
| R11 | Test infrastructure runs the real extension JS against saved HTML fixtures (per existing pattern). At least 11 fixtures port to V1 with intended-output expected JSON (not frozen current-output). | `python tests/run_tests.py --all` passes 11 fixtures. Each fixture's expected.json reflects intended correct output, including at least one orange finding where applicable. |

### P1 — Nice-to-Have (V1.0 if time, V1.1 otherwise)

| ID | Requirement |
|---|---|
| R12 | Report and share actions in findings panel. V1.0 = copy-to-clipboard with formatted template; V1.1 = integrate with Twitter/X intent and mailto. |
| R13 | Per-color overrides for authentic-text swap (e.g., swap green but not yellow). |
| R14 | Color-blind-friendly palette option. |
| R15 | Live URL test runner (already exists in advanced copy — port). |

### P2 — Future Considerations (V1.1+ / V2)

| ID | Requirement |
|---|---|
| R16 | Image render mode (Quran ayah PNGs). Exists in advanced copy. |
| R17 | Typing autocomplete in input / textarea / contenteditable. |
| R18 | English citation support (`Quran 2:255`, "Allah says"). |
| R19 | autoInteractive mode (auto-scan on page load). |
| R20 | Headless / programmatic API for researcher use. |
| R21 | Non-Chromium browser ports. |

---

## Success Metrics

V1 is shipped largely as a personal-mission tool, so business metrics are limited. Quality metrics matter more.

### Leading indicators (measure within 2 weeks of internal use)

| Metric | Target | Measurement |
|---|---|---|
| **Fixture pass rate** | 100% on 11 curated fixtures with intended-output expected JSON. | `run_tests.py --all` green. |
| **Orange precision** | ≥ 95% on a hand-curated orange test set of 20 cases. | False orange = green-grade text whose page-stated ref actually agrees with global search; should be near zero. |
| **Orange recall** | ≥ 90% on the same set. | Missed orange = case where page ref disagrees with text but no orange was produced. |
| **False-positive red rate** | ≤ 1 per 10 typical Arabic articles (non-Quran prose not flagged red). | Manual audit across 20 random Islamweb articles. |
| **Scan latency** | < 5 seconds for typical Islamweb article (~5000 words). | Measured by `run_live_url.py`. |
| **Swap layout stability** | No catastrophic layout breakage (overflow, content-jumping >50px) on top 10 fixture pages. | Manual visual inspection. |

### Lagging indicators (measure 1-3 months after release)

| Metric | Target | Notes |
|---|---|---|
| **User reports of false greens** | < 1 per month per active user. | Trust-killer; treat as P0 bug if it spikes. |
| **Orange findings per article (corpus average)** | Stable baseline established; sudden changes flagged. | Useful as a signal that the verifier is drifting. |
| **Personal use frequency** | Mostafa uses the extension during regular reading. | Dogfood is the V1 acceptance test. |

---

## Open Questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| Q1 | Can the extension reliably mutate the DOM on static articles to support edit-in-place, or does it only work on contenteditable / iframes? Need a feasibility pass across top 10 Arabic religious sites. | Engineering | Non-blocking for V1 ship — R9 already scopes edit-in-place as best-effort. |
| Q2 | ~~What is the right surface for the findings panel?~~ **Resolved 2026-05-15:** Both popup-attached and page-injected surfaces ship in V1, user-selectable. Default popup-attached. See R8. | — | Resolved. |
| Q3 | How are page-stated references parsed when the page uses unusual formats (commas + lists, transliterated surah names, hijri-style numerics)? Need a survey of formats across the 11 fixtures. | Engineering | Non-blocking — drives R4 implementation detail. |
| Q4 | ~~Should the report action submit to any endpoint?~~ **Resolved 2026-05-15:** Clipboard-only for V1. No phone-home. Optional submission deferred to V1.1 or later, opt-in only. | — | Resolved. |
| Q5 | How aggressively should authentic-text swap modify surrounding font / line-height to preserve layout? Need a design pass on swap rendering. | Engineering + Design | Blocking for R6 polish. |
| Q6 | Service worker eviction: how to handle index loss mid-scan without re-indexing on every message? | Engineering | Non-blocking — solvable in implementation. |
| Q7 | Are there Arabic sites where right-to-left + complex inline markup makes virtual-text mapping unreliable? Need a stress test set beyond Islamweb. | Engineering | Non-blocking — drives V1.1 hardening. |

---

## Timeline / Phasing

V1 is phased by milestone, not by calendar weeks, because pacing depends on session frequency and dogfooding velocity. With active AI-assisted implementation, the optimistic case compresses the original 6-week calendar to roughly **3 weeks of focused work** (~13–20 working sessions). Bottlenecks are fixture curation, orange test set hand-building, and review/dogfood cycles — not code production.

**Milestone A — Verifier foundation + orange pipeline.** R1, R2, R3, R4, R5. Harvest (with cleaning) the index, normalization, candidate extraction, and verification core from the advanced copy. Implement the orange pipeline (page-ref vs global-search disagreement detector) as a first-class verifier output. Run the 11 fixtures + 5+ hand-curated orange fixtures as the gate. Tashkeel-drift-as-green and same-letter-collapse-as-green rules land here. **Exit criteria:** all 11 advanced-copy fixtures pass with intended-output expected JSON; orange fires correctly on the 5+ curated orange fixtures.

**Milestone B — Orange precision/recall tuning.** Build the 20-case orange precision/recall scoring set. Tune the orange pipeline (candidate-confidence threshold, multi-match tie-breaking, edge cases) until targets are hit. **Exit criteria:** orange precision ≥95%, orange recall ≥90% on the scoring set.

**Milestone C — Authentic-text swap.** R6, R7. Implement the swap engine using `me_quran.ttf` + JSON-sourced text. Master toggle in popup. Layout stability pass on top 10 fixture pages. **Exit criteria:** swap works for all four swap-eligible colors with no catastrophic layout breakage.

**Milestone D — Findings panel + actions.** R8, R9, R10. Both panel surfaces (popup-attached and page-injected) with user selection. Copy and edit-in-place actions. Scan/clear in popup. **Exit criteria:** both surfaces render same data, click-to-scroll works, edit-in-place succeeds on at least 3 of top 5 Arabic religious sites.

**Milestone E — Test infrastructure + polish.** R11 plus persistent settings, performance pass, false-positive audit. **Exit criteria:** Beta gate (below) green.

**Beta gate.** All P0 requirements pass; 11 fixtures green with intended-output expected JSON; orange scoring set hits its precision/recall targets; 20-article false-positive audit clean; Mostafa dogfoods for at least a few real reading sessions.

**Pacing principle.** If a milestone slips, slip the ship date — do not compress later milestones. The biggest V1 risk is shipping a verifier that produces unreliable greens or unreliable oranges; everything else is recoverable in V1.1.

---

## Appendix — Terminology

- **Verified:** the verifier produced a green or light-blue match — text is exact-grade Quran.
- **Verified-inexact:** yellow — clearly a citation, with word-level deviation.
- **Mismatch:** orange — text is real Quran, ref is wrong.
- **Unverified:** red — strong citation signal, text not found anywhere.
- **Authentic-text swap:** the DOM rewrite that replaces page text with `me_quran.ttf`-rendered JSON text.
- **Findings panel:** the popup-attached list of all findings on the current page.
- **Advanced copy:** `C:\Users\mosta\PycharmProjects\QuranChromePlugin` — read-only reference, the mature MV2 implementation.
- **Rebuild:** `C:\Users\mosta\PycharmProjects\QuranAuditPlugin` — active MV3 target for V1.
