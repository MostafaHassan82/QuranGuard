# Feature Specification: Arabic Quran Citation Auditor (V1)

**Feature Branch**: `001-arabic-citation-auditor`

**Created**: 2026-05-16

**Status**: Draft

**Input**: User description: "V1 reader-side Quran citation auditor for Arabic web pages: detect citations, classify each into the five-color taxonomy, surface reference-mismatch (orange) findings in a panel, render authentic Quran text in place by default, and let the user act on findings (copy, share, report, in-place edit)."

## Clarifications

### Session 2026-05-17

- Q: Should the findings panel list only orange, or all five color categories? → A: All five colors with filters; default orange-only.
- Q: How aggressively should authentic-text replacement adjust surrounding CSS to absorb layout shift? → A: Span-local only; line-box ≤ 1.5× original.
- Q: How should the five-color taxonomy be communicated to color-blind and screen-reader users? → A: Color + per-category icon glyph + category named in words in every tooltip and panel row.
- Q: How should the extension handle pages that change after the initial scan (SPA navigation, infinite scroll, AJAX inserts)? → A: Hybrid — auto incremental re-scan of mutated subtrees + manual "Re-scan all" button.
- Q: What is the wire format of the structured record produced by copy / share / report (FR-011)? → A: Plain-text with Arabic + English labels as primary; JSON via secondary "Copy as JSON" action.
- Q: What should the extension do if the local Quran data file fails to load or validate? → A: Fail loud and refuse to scan; popup shows error state with Retry action; content scripts do not attach; no highlights are produced.
- Q: How is a Finding identified across incremental re-scans so its state survives mutation ticks? → A: Composite identity = normalized citation text + cited reference + true reference + DOM path.
- Q: What is the lifecycle of an orange Finding after correct-in-place succeeds (color flips to green, but default filter is orange-only)? → A: Pin in a "Recently corrected" section above filtered results for the session; cleared on next full Re-scan or page reload.
- Q: What does the user see between clicking "Scan" and the full scan completing (potentially several seconds per SC-012)? → A: Progressive reveal — popup shows status + running count; highlights paint as each candidate is verified; panel populates incrementally; per-finding actions usable on already-rendered findings.
- Q: Should per-finding state (corrections, dismissals) persist across page reloads, and if so how? → A: Persist corrected + user-dismissed findings per URL in local storage with a 30-day TTL, clearable from popup settings; introduces a new per-finding "dismiss" action; re-encountered findings surface with a "Previously corrected / dismissed" badge (not silently suppressed) so server-side reverts remain visible.

## Users & Personas

- **Reader-Auditor (primary V1 user)** — Reads Arabic religious articles online, often on sites like Islamweb, Alukah, Dorar. Wants to know whether the citations they're reading are accurate. Cares deeply about Quran integrity. Will not tolerate false greens — once a green is wrong, all greens lose credibility.
- **Author-Verifier (secondary V1 user)** — Writes religious content for Arabic websites or personal projects. Drafts contain Quran citations from memory or copy-paste. V1 supports this only via "open my draft in a browser and run the scan"; fully real-time composer support is V1.2 or later.
- **Researcher / Editor (V2+)** — Bulk-checks corpora. Out of V1 scope, but the verifier design must not preclude headless or programmatic use later.

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

A long Arabic article may contain many citations; orange findings can be missed if they only appear as per-highlight tooltips scattered through the text. The reader opens a findings panel and sees every reference-mismatch finding on the page collected into a single skimmable list, with each entry showing the cited reference, the true reference, and a snippet of the citation text. The reader can choose where the panel lives: attached to the extension popup (default) or injected into the page as a sidebar/overlay so it stays visible while reading.

**Why this priority**: Orange is the headline finding, but per-highlight tooltips alone leave findings buried in the article. A panel turns the headline signal into something the reader can triage, share, or escalate without scrolling the entire page. Two surfaces give the reader a choice between a quick check (popup) and an always-visible audit companion (page-injected).

**Independent Test**: Load a fixture page with multiple orange findings. Open the extension popup. Confirm the popup-attached findings panel lists every orange finding, each with a citation snippet, "cited as" reference, and "actually" reference. Switch the surface preference to "page-injected" in popup settings; confirm the same data appears in a sidebar/overlay on the page itself. Confirm clicking a finding in either surface scrolls/focuses its highlight in the page. This delivers value independent of in-place edit or render swap.

**Acceptance Scenarios**:

1. **Given** a scanned page contains three orange findings, **When** the user opens the findings panel (in either surface), **Then** all three findings are listed with citation snippet + cited ref + true ref.
2. **Given** the findings panel is open (in either surface), **When** the user clicks an entry, **Then** the page scrolls to and focuses the corresponding orange highlight.
3. **Given** a finding is selected in the panel, **When** the user invokes copy, **Then** the clipboard contains a plain-text record with citation text, cited reference, true reference, page URL, category, and timestamp, each labeled in Arabic and English; invoking "Copy as JSON" instead places the same field set on the clipboard as a single JSON object.
4. **Given** the user changes the panel-surface preference in popup settings, **When** the next scan runs, **Then** the panel appears in the chosen surface and the preference persists across browser restarts.

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

1. **Given** an orange finding on an editable page region, **When** the user invokes correct-in-place, **Then** the cited reference in the DOM is replaced with the true reference, the finding's highlight color is recomputed to green, and the finding appears in a "Recently corrected" section pinned at the top of the findings panel for the rest of the page session — visible regardless of the active filter — until the next manual "Re-scan all" or page reload clears the section.
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
- **FR-005**: System MUST present, for every orange finding, a tooltip that explicitly states both the cited reference and the true reference (wording: "Reference mismatch — Cited as X, actually Y"). The category name ("Reference mismatch") MUST appear in words at the start of the tooltip so the verdict is intelligible to screen-reader users and to readers who cannot perceive the orange color.
- **FR-006**: System MUST flag a citation as red when the page strongly looks like a Quran citation (lead-in phrase, braces, explicit reference) but the words do not appear as ordered Quran text anywhere.
- **FR-007**: System MUST highlight each detected citation in the page with the color of its category, preserving original markup so that text selection, copy operations, and page reflow continue to work. Each highlight MUST also carry a leading category glyph (distinct per category, e.g., ✓ verified-with-reference, ⓘ verified-without-reference, ~ word-level-inexact, ⚠ reference-mismatch, ✗ not-in-Quran) and the per-highlight tooltip MUST always name the category in words, so the verdict is conveyed without relying on color alone.
- **FR-008**: System MUST, by default, replace the visible text of every non-red highlighted citation with the authentic Quran wording (full tashkeel, Quran-font rendering) sourced from the local Quran data file. Layout absorption for the swap is scoped to the highlighted span only: font-size and line-height MAY be adjusted inside the span, but no CSS outside the span MAY be modified, and the rendered line-box height MUST NOT exceed 1.5× the original line-box height of the surrounding text.
- **FR-009**: Users MUST be able to enable/disable authentic-text replacement globally and per color from the extension popup; preferences MUST persist across browser sessions.
- **FR-010**: System MUST provide a findings panel that can aggregate findings of any of the five categories (green, light blue, yellow, orange, red) on the currently scanned page into a single list. The panel MUST expose per-category filter toggles; the default filter shows orange only, and the user MAY enable any combination of the other four categories. Every panel row MUST display the category's icon glyph and the category name in words alongside its color swatch, so the verdict is conveyed without relying on color alone. The panel MUST be available in two user-selectable surfaces: (a) attached to the extension popup, and (b) injected into the page as a sidebar/overlay. Both surfaces MUST render the same data, the same filter controls, and the same per-finding actions. The user's surface preference and filter selection MUST be selectable from popup settings and MUST persist across browser sessions; defaults are popup-attached surface and orange-only filter.
- **FR-011**: For each finding listed in the panel, users MUST be able to (a) jump to its highlight in the article, (b) copy a structured record of the finding (citation snippet, cited reference, true reference, page URL, category, timestamp) to the clipboard, (c) generate a shareable text/link for the finding, and (d) generate a report record for the finding. The primary copy/share/report format MUST be human-readable plain text with every field labeled in both Arabic and English (one field per line). A secondary "Copy as JSON" action MUST be available on each finding and MUST emit the same fields as a single canonical JSON object. Both formats MUST contain the same field set; the plain-text form is the default the user receives when invoking copy, share, or report without explicitly choosing JSON.
- **FR-012**: Users MUST be able to correct an orange finding in place by replacing its cited reference with its true reference in the page DOM; on pages where DOM editing is not technically possible, the action MUST degrade to copying the corrected citation with an explanation.
- **FR-013**: System MUST operate entirely from local resources after the extension loads — no network calls to fetch Quran data, verify citations, or render text.
- **FR-014**: System MUST limit V1 detection and highlighting to Arabic-language pages and Arabic-language citations.
- **FR-015**: System MUST never replace text or assign a non-red color to a citation it has flagged as red.
- **FR-016**: For any citation that carries an explicit reference, the system MUST distinguish three outcomes: (a) the text matches the cited reference (green/yellow), (b) the text does not match the cited reference but matches an exact-grade Quran verse elsewhere (orange), or (c) the text does not match anywhere in the Quran (red).
- **FR-017**: Only matches that are exact OR differ from the Quran by tashkeel/diacritics only OR differ by normal Arabic spelling drift (per FR-003) MAY be classified green. Looser matching strategies used to FIND candidates (skeleton matching, gap-allowed ordered matching, partial matching) MUST NOT promote a result to green; they may yield yellow, orange, red, or no highlight, never green.
- **FR-018**: A candidate that lacks strong citation signals (no lead-in phrase, no braces or quotation marks, no explicit reference) and produces no verifiable match MUST be dropped silently without a red highlight. Red is reserved for candidates whose context strongly indicates a Quran citation but whose text cannot be verified.
- **FR-019**: System MUST keep highlights and findings consistent with the page after dynamic content changes. After the initial scan, the system MUST observe DOM mutations and incrementally re-scan only newly-added or mutated subtrees, with a debounce window of approximately 500 ms to coalesce bursts. Existing highlights on unchanged DOM MUST be retained without rework. The extension popup MUST also expose a manual "Re-scan all" action that discards the current results and performs a full pass over the document. SPA route changes (history pushState/replaceState/popstate or full document replacement) MUST be treated as mutations that trigger the incremental path for any newly-rendered content.
- **FR-020**: System MUST treat the local Quran data file as a hard prerequisite for any verification work. If the data file is missing, unreadable, or fails schema validation at extension startup or at any later point, the extension MUST: (a) refuse to attach content scripts and produce zero highlights on any page, (b) display an explicit error state in the popup ("Quran data unavailable — extension cannot verify citations") and in the findings panel (in both surfaces), and (c) expose a "Retry" action that re-attempts the load and, on success, returns the extension to normal operation. The extension MUST NOT fall back to a silent no-highlight state that is indistinguishable from a page with no citations.
- **FR-021**: System MUST assign each Finding a stable identifier derived from the composite key defined under Key Entities > Finding. During the incremental re-scans defined in FR-019, any Finding whose composite key is unchanged MUST retain its identifier, its panel-row state (selection, scroll-target binding, recently-corrected marker, in-flight action token), and its tooltip binding. A Finding whose composite key changes MUST be treated as a new Finding and the prior Finding's state MUST be discarded.
- **FR-022**: When a correct-in-place action (FR-012) succeeds, the Finding MUST flip from orange to green, the on-page span MUST follow the global FR-008/FR-009 replacement preferences as any other green span (no per-finding override), and the Finding MUST be pinned to a "Recently corrected" section displayed at the top of the findings panel for the rest of the page session. The Recently corrected section MUST be visible regardless of the active per-category filter selection (FR-010). The section MUST be cleared on the next manual "Re-scan all" action or on page reload. After clear, the corrected citation is re-evaluated from scratch; if its composite key still matches a persisted correction (FR-024) it surfaces with a "Previously corrected" badge per FR-024, otherwise it rejoins the normal panel flow under its current color.
- **FR-023**: System MUST surface scan progress to the user rather than blocking the UI until the scan completes. While a scan is in flight: (a) the popup MUST display a "Scanning…" status with a running count of citations verified so far, (b) highlights MUST be painted into the page as each candidate is verified rather than batched until completion, (c) the findings panel (in whichever surface is active) MUST populate incrementally as findings become available, and (d) per-finding actions (jump-to-highlight, copy, share, report, correct-in-place, dismiss) MUST be invocable on any already-rendered finding while the scan continues. When the scan completes, the "Scanning…" status MUST be replaced by a final summary count. The 5-second budget in SC-012 applies to the time from "Scan" click to all highlights rendered; it is not relaxed by progressive reveal.
- **FR-024**: System MUST persist two classes of per-finding state across page reloads, keyed by the page URL and the Finding composite key (per Key Entities > Finding): (a) corrections applied via FR-012, and (b) explicit user dismissals (per FR-025). Persisted entries MUST be stored in browser-local storage only — never transmitted off-device, in keeping with FR-013 — and MUST expire 30 days after they were written. When a scan produces a Finding whose composite key matches a non-expired persisted entry for the current URL, the Finding MUST be surfaced in the findings panel with a visible "Previously corrected on YYYY-MM-DD" or "Previously dismissed on YYYY-MM-DD" badge; the Finding MUST NOT be silently suppressed, so that server-side reversions of the user's correction remain visible. Previously-dismissed findings MAY be grouped into a collapsed "Previously dismissed" section below the active filter results. The popup settings MUST expose a "Clear remembered corrections and dismissals" action that wipes the entire persisted store immediately.
- **FR-025**: Users MUST be able to dismiss any finding from the panel (in either surface) via a per-finding "Dismiss" action. A dismissed finding MUST be hidden from the active filter view for the rest of the page session, moved to a collapsed "Dismissed (this session)" section in the panel, and recorded as a persisted dismissal per FR-024. The user MUST be able to restore a dismissed finding from the collapsed section, which removes its persisted dismissal entry for the current URL.

### Key Entities

- **Citation Candidate**: A span of page text that resembles a Quran quote based on contextual signals (lead-in phrase, braces, explicit reference). Carries its DOM location, raw text, and any reference written next to it.
- **Verification Result**: The verifier's verdict on a candidate. Carries the assigned category (one of five colors), the matched verse reference, alternate references (for orange cases, both the cited and the true reference), and any classification notes (drift accepted, words missing/added/substituted, etc.).
- **Finding**: A user-facing record assembled from a candidate + verification result. Surfaces in the per-highlight tooltip and (for orange) in the findings panel. Identity is the composite key `(normalized citation text, normalized cited reference, true reference, DOM path)`; as long as those four components are unchanged, the Finding retains the same identifier across the incremental re-scans defined in FR-019, and any per-finding state (panel selection, scroll-target, in-flight action) MUST survive the mutation tick. A change in any component yields a new Finding.
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
- **SC-009**: On a hand-curated 20-case orange test set (each case is a citation where the page-stated reference disagrees with the verse the text actually belongs to), orange precision is at least 95% — i.e., fewer than 1 in 20 orange findings is incorrectly orange when the cited reference actually agrees with the text.
- **SC-010**: On the same 20-case orange test set, orange recall is at least 90% — i.e., at most 2 of the 20 reference-mismatch cases are missed (no orange finding produced).
- **SC-011**: On a manual audit of 20 random Arabic articles from typical religious sites, the extension produces no more than 2 false-positive red highlights total (i.e., non-citation Arabic prose flagged red).
- **SC-012**: A full scan of a typical Islamweb article (~5,000 words) completes in under 5 seconds end-to-end, from popup "Scan" click to all highlights rendered.
- **SC-013**: When authentic-text replacement is enabled, no page in the top 10 fixture set exhibits catastrophic layout breakage from the swap — defined as any content jump greater than 50 pixels or content moving offscreen due to overflow. Per FR-008, layout absorption is span-local and bounded to ≤ 1.5× the original line-box height; any fixture that would violate the 50-pixel rule under that bound MUST be addressed by tuning span-local typography, not by relaxing the bound or mutating surrounding CSS.

## Assumptions

- The browser is Chrome or another Chromium-based browser with Manifest V3 support. Firefox and Safari are out of V1 scope.
- Arabic pages use standard UTF-8 HTML text nodes. Text rendered into canvas or delivered as images is out of V1 scope; no OCR is performed.
- The local Quran data file is the single source of truth. Tafseer cross-references and alternative qira'at are out of V1.
- "Share" in V1 means generating a copyable shareable text/link; integration with Twitter/X, email, or messaging apps is deferred.
- "Report" in V1 means generating a structured local record (citation, cited reference, true reference, URL, timestamp) the user can copy; submission to a backend channel is deferred.
- Some pages (shadow DOM, frames with contenteditable disabled, sandboxed iframes) will not permit in-place DOM edits. The in-place correction feature degrades gracefully to clipboard fallback on those pages and this is acceptable for V1.
- The Islamweb publishing convention is the primary anchor for candidate-extraction tuning in V1; other Arabic publishers benefit but are not gated for V1 ship.
- Reference fixture 174389 is the parity baseline. Other fixtures may have looser bars during ramp, but no fixture may regress against the prior working implementation.

## Open Questions

Carried forward from the V1 PRD. Q2 (findings panel surfaces) and Q4 (report destination) are already resolved and reflected in the requirements above. The questions below are deferred to `/speckit-clarify` or to planning, with their blocking status noted.

- **Q1 — DOM mutability survey (non-blocking for ship).** Can the extension reliably mutate the DOM on static articles across the top 10 Arabic religious sites, or does in-place edit (FR-012) fall back to clipboard often enough that the feature should be reframed?
- **Q3 — Reference parsing for unusual formats (non-blocking).** How are page-stated references parsed when the page uses commas + lists, transliterated surah names, hijri-style numerics, or other non-canonical formats?
- ~~**Q5 — Swap layout policy.**~~ Resolved 2026-05-17: span-local absorption only, line-box ≤ 1.5× original; see FR-008 and SC-013.
- **Q6 — Service worker eviction (non-blocking).** How should the background service worker handle mid-scan eviction without re-indexing on every message?
- **Q7 — RTL + complex inline markup (non-blocking).** Are there Arabic sites where right-to-left handling combined with complex inline markup breaks the virtual-text mapping used to project regex matches back to live DOM nodes?
