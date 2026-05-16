# Feature Specification: Arabic Quran Citation Auditor (V1)

**Feature Branch**: `001-arabic-citation-auditor`

**Created**: 2026-05-16

**Status**: Draft

**Input**: User description: "V1 reader-side Quran citation auditor for Arabic web pages: detect citations, classify each into the five-color taxonomy, surface reference-mismatch (orange) findings in a panel, render authentic Quran text in place by default, and let the user act on findings (copy, share, report, in-place edit)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A reader catches a "real verse, wrong reference" citation (Priority: P1)

A reader is browsing an Arabic article that quotes the Quran. One of the citations on the page attaches a real Quranic phrase to the wrong surah and ayah number — a mistake no human reader would catch by eye because both the quoted text and the cited reference are individually real. The extension highlights that citation in orange and shows the reader, in plain language, that the words actually belong to a different verse than the one the author wrote.

**Why this priority**: This is the headline reason the product exists. Reference-mismatch is the single most valuable signal because no human reader can detect it at scale, and getting it right is what distinguishes this extension from a simple Quran-text replacer.

**Independent Test**: Load a saved fixture page that contains at least one known orange case (e.g., fixture 174389 with `ما ننسخ من آية` mis-cited away from `البقرة:106`). Activate the extension. Confirm the citation receives an orange highlight and a tooltip that reads "Cited as [page reference], actually [true reference]." Independent of any panel, edit, or render-swap feature, this delivers the integrity value on its own.

**Acceptance Scenarios**:

1. **Given** a page contains real Quranic text labeled with a wrong reference, **When** the extension scans the page, **Then** that citation is highlighted in orange and the tooltip names both the cited reference and the true reference.
2. **Given** a page contains a citation whose text matches the Quran exactly and whose reference is correct, **When** the extension scans, **Then** that citation is highlighted in green (not orange) and the tooltip confirms verification.
3. **Given** a page contains a citation that differs from the Quran only in tashkeel or normal modern Arabic spelling drift (e.g., `بالليل` instead of `بِٱلَّيْلِ`, `الذين` instead of `ٱلَّذِينَ`), **When** the extension scans, **Then** the citation is still highlighted green and not downgraded to yellow.

---

### User Story 2 - A reader sees all orange findings on a page in one place (Priority: P2)

A long Arabic article may contain many citations; orange findings can be missed if they only appear as per-highlight tooltips scattered through the text. The reader opens a findings panel from the extension and sees every reference-mismatch finding on the page collected into a single skimmable list, with each entry showing the cited reference, the true reference, and a snippet of the citation text.

**Why this priority**: Orange is the headline finding, but per-highlight tooltips alone leave findings buried in the article. A panel turns the headline signal into something the reader can triage, share, or escalate without scrolling the entire page.

**Independent Test**: Load a fixture page with multiple orange findings. Open the extension popup. Confirm the findings panel lists every orange finding, each with a citation snippet, "cited as" reference, and "actually" reference. Confirm clicking a finding scrolls/focuses its highlight in the page. This delivers value independent of in-place edit or render swap.

**Acceptance Scenarios**:

1. **Given** a scanned page contains three orange findings, **When** the user opens the findings panel, **Then** all three findings are listed with citation snippet + cited ref + true ref.
2. **Given** the findings panel is open, **When** the user clicks an entry, **Then** the page scrolls to and focuses the corresponding orange highlight.
3. **Given** a finding is selected in the panel, **When** the user invokes copy, **Then** the clipboard contains a structured record (citation text, cited reference, true reference, page URL).

---

### User Story 3 - Authentic Quran text appears in place by default (Priority: P3)

For every citation the verifier can confirm (any non-red color), the extension by default replaces the page text with the authentic Quran text — full tashkeel and a proper Quran font — so the reader sees authoritative wording everywhere the Quran is quoted on the page, not just on pages whose authors took the trouble to use proper diacritics. Highlights act as scaffolding around the authentic rendering. The reader can turn this off, and can override it per color, from the extension popup.

**Why this priority**: This is the product's stance on integrity made visible: the extension does not just *flag* problems, it actively *shows* the authentic text wherever possible. Lower priority than detection itself because the verifier must be trustworthy before swapping page text is safe.

**Independent Test**: Load a page with at least one green and one orange citation. Confirm both display the authentic JSON wording with Quran font and full tashkeel by default. Toggle the master switch off in the popup; confirm both revert to the original page text while retaining their highlights. Toggle a per-color override; confirm only that color reverts.

**Acceptance Scenarios**:

1. **Given** the master replacement toggle is on and a citation is verified (green/light blue/yellow/orange), **When** the page renders, **Then** the highlighted span displays the authentic Quran wording with full tashkeel in a Quran font.
2. **Given** the master toggle is off, **When** the page renders, **Then** all highlights remain visible but the text reverts to the page's original wording.
3. **Given** a per-color override disables replacement for yellow only, **When** the page renders, **Then** yellow highlights show original text while other non-red colors show authentic text.
4. **Given** a citation is red, **When** the page renders, **Then** the text is never replaced (nothing authentic to render).

---

### User Story 4 - A reader corrects a wrong citation in place (Priority: P4)

When a reader sees an orange finding, they can — directly from the panel or the highlight — correct the citation in the article's DOM so that subsequent screenshot, copy, or share carries the corrected reference. The correction does not leave the article and does not require visiting any external tool.

**Why this priority**: Explicitly requested as a V1 stretch by the project owner. Lower priority than detection, panel, and authentic-render because it depends on the page DOM allowing edits; some pages will block it and the spec must degrade gracefully.

**Independent Test**: Load a fixture where the page DOM is editable (standard text node). Open the findings panel, select an orange finding, invoke the correction action. Confirm the cited reference in the page DOM is replaced with the true reference. On a page where DOM editing is blocked (e.g., shadow DOM, contenteditable disabled), confirm the action falls back gracefully to copying the corrected citation to the clipboard with an explanatory message.

**Acceptance Scenarios**:

1. **Given** an orange finding on an editable page region, **When** the user invokes correct-in-place, **Then** the cited reference in the DOM is replaced with the true reference and the finding's highlight color is recomputed to green.
2. **Given** an orange finding on a page region that does not permit DOM edits, **When** the user invokes correct-in-place, **Then** the action falls back to copying the corrected citation to the clipboard and shows the user an explanation.

---

### Edge Cases

- Citation text that spans multiple HTML text nodes (broken across `<span>`, `<a>`, or other inline elements) MUST still be detected and highlighted as a single span.
- Citation text that includes braces or quotation marks (`{ ... }`, `« ... »`, `" ... "`) MUST have those framing characters preserved in the highlighted region.
- A citation that matches the Quran but is missing a written reference is light blue, and the extension contributes the correct reference in the tooltip.
- A page that strongly looks like it carries Quran citations (lead-in phrases, braces, explicit references) but whose words do not appear in the Quran anywhere is red — possibly fabrication, heavy paraphrase, or transcription error.
- A page with no Quran citations at all produces zero highlights and an empty findings panel — not an error.
- An RTL/LTR mixed page MUST still produce correct highlight regions for the Arabic citations.
- A page rendered in a language other than Arabic is out of V1 scope; no highlights are added and the findings panel is empty.
- A citation in image form (rendered to canvas or as `<img>`) is out of V1 scope; the extension does not OCR.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST detect Arabic Quran citations within the visible text of a rendered web page.
- **FR-002**: System MUST classify each detected citation into exactly one of five categories: verified-with-reference (green), verified-without-reference (light blue), word-level-inexact (yellow), reference-mismatch (orange), or not-in-Quran (red).
- **FR-003**: System MUST treat tashkeel/diacritic-only differences and normal modern-vs-Quranic Arabic spelling drift (alif variants ا/آ/ٱ, alef maqsura ↔ ya ى/ي, ta marbuta ↔ ha ة/ه, adjacent same-letter collapse such as `بِٱلَّيْلِ` ↔ `بالليل`) as fully verified, not as yellow downgrades.
- **FR-004**: System MUST flag a citation as orange (reference-mismatch) when its text exists in the Quran at a reference different from the one written on the page.
- **FR-005**: System MUST present, for every orange finding, a tooltip that explicitly states both the cited reference and the true reference (wording: "Cited as X, actually Y").
- **FR-006**: System MUST flag a citation as red when the page strongly looks like a Quran citation (lead-in phrase, braces, explicit reference) but the words do not appear as ordered Quran text anywhere.
- **FR-007**: System MUST highlight each detected citation in the page with the color of its category, preserving original markup so that text selection, copy operations, and page reflow continue to work.
- **FR-008**: System MUST, by default, replace the visible text of every non-red highlighted citation with the authentic Quran wording (full tashkeel, Quran-font rendering) sourced from the local Quran data file.
- **FR-009**: Users MUST be able to enable/disable authentic-text replacement globally and per color from the extension popup; preferences MUST persist across browser sessions.
- **FR-010**: System MUST provide a findings panel that aggregates every orange finding on the currently scanned page into a single list.
- **FR-011**: For each finding listed in the panel, users MUST be able to (a) jump to its highlight in the article, (b) copy a structured record of the finding (citation snippet, cited reference, true reference, page URL) to the clipboard, (c) generate a shareable text/link for the finding, and (d) generate a report record for the finding.
- **FR-012**: Users MUST be able to correct an orange finding in place by replacing its cited reference with its true reference in the page DOM; on pages where DOM editing is not technically possible, the action MUST degrade to copying the corrected citation with an explanation.
- **FR-013**: System MUST operate entirely from local resources after the extension loads — no network calls to fetch Quran data, verify citations, or render text.
- **FR-014**: System MUST limit V1 detection and highlighting to Arabic-language pages and Arabic-language citations.
- **FR-015**: System MUST never replace text or assign a non-red color to a citation it has flagged as red.

### Key Entities

- **Citation Candidate**: A span of page text that resembles a Quran quote based on contextual signals (lead-in phrase, braces, explicit reference). Carries its DOM location, raw text, and any reference written next to it.
- **Verification Result**: The verifier's verdict on a candidate. Carries the assigned category (one of five colors), the matched verse reference, alternate references (for orange cases, both the cited and the true reference), and any classification notes (drift accepted, words missing/added/substituted, etc.).
- **Finding**: A user-facing record assembled from a candidate + verification result. Surfaces in the per-highlight tooltip and (for orange) in the findings panel.
- **Reference**: A Quran address — surah plus ayah, optionally a range or sub-range — that locates a verse.
- **Verse**: The authentic text of one ayah, sourced from the local Quran data file. The single source of truth for verification and authentic-text replacement.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On reference fixture 174389 (Islamweb article), the extension produces at least 17 verified matches and zero red findings, matching the maturity of the prior working implementation on the same page.
- **SC-002**: The known orange case `ما ننسخ من آية` is correctly resolved to its true reference (`البقرة:106`) and surfaced to the reader as an orange finding with the "Cited as X, actually Y" wording.
- **SC-003**: All eleven reviewed fixture pages reach at least the parity level set by the prior working implementation; no previously-verified citation regresses to red, yellow, or unverified.
- **SC-004**: Citations that differ from the Quran only in tashkeel or normal Arabic spelling drift are classified as verified (green) in 100% of cases across the fixture suite; none are downgraded to yellow.
- **SC-005**: From any page that contains orange findings, the reader can reach a list of every orange finding on that page in no more than two interactions (open popup → see list).
- **SC-006**: With authentic-text replacement enabled, every non-red highlighted span on the page displays the authentic Quran wording with full tashkeel; toggling replacement off restores the page's original wording while keeping the highlights.
- **SC-007**: A reader can copy a finding to the clipboard, persist their replacement preferences across browser restarts, and correct an orange finding in place (where the page DOM allows) without navigating away from the article.
- **SC-008**: On a page with no Quran citations, the extension produces no highlights and presents an empty (not error) findings panel.

## Assumptions

- The browser is Chrome or another Chromium-based browser with Manifest V3 support. Firefox and Safari are out of V1 scope.
- Arabic pages use standard UTF-8 HTML text nodes. Text rendered into canvas or delivered as images is out of V1 scope; no OCR is performed.
- The local Quran data file is the single source of truth. Tafseer cross-references and alternative qira'at are out of V1.
- "Share" in V1 means generating a copyable shareable text/link; integration with Twitter/X, email, or messaging apps is deferred.
- "Report" in V1 means generating a structured local record (citation, cited reference, true reference, URL, timestamp) the user can copy; submission to a backend channel is deferred.
- Some pages (shadow DOM, frames with contenteditable disabled, sandboxed iframes) will not permit in-place DOM edits. The in-place correction feature degrades gracefully to clipboard fallback on those pages and this is acceptable for V1.
- The Islamweb publishing convention is the primary anchor for candidate-extraction tuning in V1; other Arabic publishers benefit but are not gated for V1 ship.
- Reference fixture 174389 is the parity baseline. Other fixtures may have looser bars during ramp, but no fixture may regress against the prior working implementation.
