# Feature Specification: Correction & Autocorrect for lightBlue · yellow · red

**Feature Branch**: `002-correction-autocorrect`

**Created**: 2026-05-24

**Status**: Draft

**Input**: User description: "V1.2 — extend the existing orange correct-in-place / autocorrect mechanism to the other non-green findings (lightBlue, yellow, red), each with its own correction meaning. lightBlue surfaces the missing reference in the tooltip only (no page-text insertion) and recolors to green/lightGreen. yellow and red (and orange) get a visual diff-style fix that strikes through the extra/wrong wording and highlights the inserted/corrected wording, with a revert button — and can also be fully corrected to lightGreen like orange today. Spec all phases at once."

## Context

V1 already ships **orange** correction: from a panel finding, `correctInPlace` rewrites a wrong on-page reference to the true one and re-verifies into a **lightGreen** ("corrected") successor finding (FR-012, FR-022, FR-024 in feature 001). This feature generalizes that same machinery to the remaining non-green verdicts so the reader can repair every kind of citation defect, not just wrong-reference cases.

The five-verdict taxonomy and the lightGreen provenance color are **unchanged** (constitution Principle II). Orange remains the flagship case (Principle III); this feature widens the safety net around it. Integrity (Principle I) is preserved: a correction only ever writes **authentic mushaf wording** or a **verified reference** — never a guess.

## Clarifications

### Session 2026-05-24

- Q: When does the red fuzzy near-match probe run? → A: During scan — every red finding is probed as part of the scan so suggestions are ready instantly in the panel.
- Q: How does Revert interact with persisted corrections and autocorrect? → A: Revert clears the persisted correction entry, so the revert sticks across reloads and autocorrect treats the finding as normal again.
- Q: Is the yellow aligned diff shown inline automatically, or only on demand? → A: Always inline — the strike/highlight diff renders directly in the page for every yellow finding as soon as it is detected (visual overlay only; no page-text edit until "Fix in place").
- Q: Default state of the new lightBlue autocorrect toggle on fresh install? → A: On by default (lightBlue never edits page text — it only surfaces a reference in the tooltip and recolors — so safe auto-resolution is the out-of-box behavior). Orange autocorrect keeps its existing default (off / migrated).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reader fixes a near-miss quote (yellow → corrected) (Priority: P1)

A reader finds a citation flagged **yellow** (the wording is *nearly* right — a word dropped, added, or substituted relative to the authentic ayah). They want to both *understand* what is off and *repair* it in place without retyping the verse.

**Why this priority**: Word-level drift (yellow) is the most common defect a reader cannot easily fix by hand, and the visual before/after diff is the headline new experience of this feature. It is independently valuable even if lightBlue and red correction never ship.

**Independent Test**: Load a page with one known yellow finding. Confirm the panel row and the in-page highlight show an aligned word-level diff (missing words marked as insertions, extra words struck through, substitutions paired). Invoke "Fix in place" → the highlighted span shows the authentic wording with the changed parts visually marked (strike-through on removed wording, emphasis on inserted/corrected wording), the verdict flips to a **lightGreen corrected** successor, and a **Revert** affordance restores the original page wording and the original yellow finding.

**Acceptance Scenarios**:

1. **Given** a yellow finding whose text matches a single ayah with a small word-level difference, **When** the reader opens the panel, **Then** the finding row presents an aligned diff (cited vs. authentic) identifying each missing / extra / substituted word.
2. **Given** that yellow finding, **When** the reader invokes "Fix in place", **Then** the on-page highlight is updated to the authentic excerpt with removed wording struck through and inserted/corrected wording highlighted, and the finding becomes a lightGreen corrected successor that back-references the original (priorFindingId).
3. **Given** a fix has been applied, **When** the reader invokes **Revert** on that finding, **Then** the page returns to the reader-supplied original wording and the finding returns to its original yellow verdict.
4. **Given** a yellow finding whose match is ambiguous or spans an ayah boundary (e.g. an excerpt joined by `*`), **When** the reader opens the panel, **Then** the diff is shown but "Fix in place" is withheld with an explanation that the match is not safe to auto-rewrite.

---

### User Story 2 - Reader supplies the missing reference (lightBlue → corrected) (Priority: P2)

A reader finds a citation flagged **lightBlue** (the wording is authentic but **no reference** is given on the page). They want the extension to identify the true reference and present it, turning an unattributed quote into an attributed one — without altering the page's text.

**Why this priority**: lightBlue is lower-risk than yellow because it never edits the author's words; it only surfaces a reference. It is highly useful for readers verifying unattributed quotes, and it reuses the verifier's existing reference resolution.

**Independent Test**: Load a page with one known lightBlue finding whose text resolves to exactly one ayah. Confirm the finding's resolved reference appears in the highlight's **tooltip** (and the panel row) — NOT injected into the page body text. Invoke the correction → the verdict flips to a **green/lightGreen corrected** successor carrying the resolved reference. Load a lightBlue finding whose text occurs in more than one place → confirm it is presented as ambiguous and the reference is NOT chosen automatically unless context disambiguates it.

**Acceptance Scenarios**:

1. **Given** a lightBlue finding whose authentic text resolves to exactly one reference, **When** the reader views it, **Then** the resolved reference is shown in the highlight tooltip and the panel row, and no reference text is inserted into the page body.
2. **Given** that lightBlue finding, **When** the reader accepts the correction, **Then** the finding becomes a corrected successor (green verdict, lightGreen provenance) carrying the resolved reference, with a Revert affordance.
3. **Given** a lightBlue finding whose text occurs in multiple places, **When** an adjacent already-attributed finding shares one of those surahs, **Then** that surah's reference is adopted as the resolved reference (context disambiguation).
4. **Given** a lightBlue finding whose text occurs in multiple places with no disambiguating context, **When** the reader views it, **Then** the candidate references are listed and the reader must choose one; nothing is auto-selected.

---

### User Story 3 - Reader rescues a typo'd citation, or learns it can't be fixed (red → suggestion) (Priority: P3)

A reader finds a citation flagged **red** (a citation signal is present but the text was not found in the Quran). They want to know whether it is a near-miss (a typo away from a real ayah) that can be repaired, or genuinely not Quran.

**Why this priority**: Red is the rarest and riskiest to act on, so it ships last. The value is turning "not found" into either an actionable suggestion or a clear "no automatic correction" verdict — never a silent or wrong edit.

**Independent Test**: Load a page with a red finding that is one or two edits away from a real ayah. Confirm a "Did you mean …?" suggestion appears with the candidate ayah + reference. Accept it → the correction runs the same diff-and-fix path as yellow and produces a lightGreen corrected successor. Load a red finding with no near-match → confirm it is marked "No automatic correction" and no edit is offered.

**Acceptance Scenarios**:

1. **Given** a red finding within the near-match threshold of a real ayah, **When** the reader views it, **Then** a "Did you mean …?" suggestion shows the candidate ayah and reference.
2. **Given** such a suggestion, **When** the reader accepts it, **Then** the citation is corrected via the diff-and-fix path (authentic wording, changed parts marked, revertable) into a lightGreen corrected successor.
3. **Given** a red finding with no near-match within threshold, **When** the reader views it, **Then** it is labelled "No automatic correction" (explicitly not an error), and no in-place edit is offered.
4. **Given** any red finding, **When** any autocorrect preference is enabled, **Then** the red finding is never auto-edited (red is suggestion-only).

---

### User Story 4 - Reader controls automation and can always undo (Priority: P4)

A reader wants the safe corrections to happen automatically on pages they trust, while retaining the ability to undo any applied correction.

**Why this priority**: Automation and universal revert are cross-cutting conveniences that depend on the per-color corrections existing first.

**Independent Test**: Enable the generalized autocorrect preference; load a page with safe (unambiguous) orange and lightBlue findings → confirm they are corrected automatically on scan, while yellow and red are left for manual review. Apply any correction, then Revert it → confirm the page and finding return to their pre-correction state. Confirm yellow/red are never auto-corrected regardless of preference.

**Acceptance Scenarios**:

1. **Given** autocorrect is enabled, **When** a page is scanned, **Then** only safe (unambiguous / context-resolved) orange and lightBlue findings are corrected automatically; yellow and red remain manual.
2. **Given** any applied correction (any color), **When** the reader invokes Revert, **Then** the page text/markers and the finding return to their pre-correction state and the action is removed from the corrected section.
3. **Given** autocorrect is disabled, **When** a page is scanned, **Then** no finding is corrected without an explicit reader action.

---

### Edge Cases

- **Ambiguous match**: a finding whose text occurs at multiple references and lacks disambiguating context is never auto-resolved or auto-fixed; it is presented for manual choice.
- **Boundary-spanning excerpt**: an excerpt joined by `*` (or otherwise spanning an ayah boundary) that resolves to a single verse is treated as unsafe to rewrite; the diff/info is shown but in-place text replacement is withheld.
- **Locked / non-editable DOM** (shadow DOM, disabled contenteditable, sandboxed iframe): in-place edits fall back to copying the corrected citation to the clipboard with an explanation, mirroring the existing orange fallback (FR-012).
- **Revert after page mutation**: if the page has re-rendered the corrected region since the fix, Revert restores the recorded original wording where the span still exists; where it no longer exists, the reader is told the original could not be restored automatically.
- **lightBlue tooltip vs. recolor**: the resolved reference is presented in the tooltip only; the page body text is never modified for a lightBlue correction.
- **Layout safety**: any visual diff marking or recolor must obey the existing span-local layout-absorption bound (no content jump beyond the established threshold).
- **Re-encounter on revisit**: a previously corrected finding surfaces on a later visit with a "previously corrected" badge and (per the existing revisit behavior) may re-apply, and must not be silently suppressed.

## Requirements *(mandatory)*

### Functional Requirements

**General correction model**

- **FR-001**: The system MUST extend the existing correct-in-place mechanism to lightBlue, yellow, and red findings, in addition to the orange case already supported.
- **FR-002**: Every applied correction MUST produce a successor finding that back-references the original finding and is presented in the panel's "corrected" section regardless of the active filter, consistent with the existing orange behavior.
- **FR-003**: Every successfully corrected finding MUST render in the **lightGreen** ("corrected") provenance color while keeping its underlying verified verdict; the system MUST NOT introduce any new highlight color or alter the five-verdict taxonomy.
- **FR-004**: A correction MUST only ever write **authentic mushaf wording** (for text fixes) or a **verifier-resolved reference** (for reference fixes); the system MUST NOT write reader-guessed or unverified content into the page.
- **FR-005**: When the target page region cannot be edited (locked / non-editable DOM), any in-place correction MUST fall back to copying the corrected citation to the clipboard with a user-visible explanation.
- **FR-006**: Every applied correction (any color) MUST be **revertable** via a per-finding Revert affordance that restores the reader-supplied original page content and returns the finding to its pre-correction verdict. Revert MUST also **clear the persisted correction entry** for that finding so the revert survives reload and the finding is treated as a normal (uncorrected) finding by autocorrect thereafter.

**lightBlue (missing reference)**

- **FR-007**: For a lightBlue finding, the system MUST surface the verifier-resolved reference in the highlight's **tooltip** and the panel row, and MUST NOT insert any reference text into the page body.
- **FR-008**: When a lightBlue finding's text resolves to exactly one reference, accepting the correction MUST flip it to a corrected successor (verified verdict, lightGreen provenance) carrying that reference.
- **FR-009**: When a lightBlue finding's text resolves to multiple references, the system MUST attempt context disambiguation (adopt the reference of an adjacent attributed finding sharing one of the candidate surahs); only a context-resolved or single-candidate reference may be applied automatically.
- **FR-010**: When a lightBlue finding remains ambiguous after disambiguation, the system MUST present the candidate references for manual selection and MUST NOT auto-select one.

**yellow (word-level drift)**

- **FR-011**: For a yellow finding, the system MUST compute and present an **aligned word-level diff** against the matched ayah, identifying each word as kept / missing / extra / substituted.
- **FR-012**: The aligned diff MUST be rendered **inline in the page automatically** for every yellow finding as soon as it is detected (removed wording struck through, inserted/corrected wording highlighted), in addition to being presented in the panel row. This inline diff is a **visual overlay only** — it MUST NOT modify the underlying page text until the reader invokes "Fix in place", and it MUST obey the span-local layout-absorption bound (SC-007).
- **FR-013**: When the reader invokes "Fix in place" on a yellow finding, the system MUST update the on-page highlight to the authentic excerpt with **removed wording struck through and inserted/corrected wording highlighted**, then re-verify into a lightGreen corrected successor.
- **FR-014**: The system MUST withhold yellow in-place text replacement (offering diff/info only) when the match is unsafe to rewrite — specifically boundary-spanning (`*`) excerpts that resolved to a single verse, or ambiguous matches.

**red (not found)**

- **FR-015**: For a red finding, the system MUST run a fuzzy near-match probe **during the scan** (so suggestions are ready in the panel without a per-finding wait); when a candidate within threshold exists, it MUST present a "Did you mean …?" suggestion naming the candidate ayah and reference. The probe MUST stay within the established scan-time budget for the page.
- **FR-016**: When the reader accepts a red near-match suggestion, the correction MUST proceed via the same diff-and-fix path as yellow (authentic wording, changed parts marked, revertable) into a lightGreen corrected successor.
- **FR-017**: When a red finding has no near-match within threshold, the system MUST label it "No automatic correction" (explicitly distinguished from an error state) and MUST NOT offer an in-place edit.

**Automation & persistence**

- **FR-018**: The system MUST generalize the autocorrect preference so it can independently enable automatic correction for orange and for lightBlue; yellow and red MUST always be manual and MUST NOT be auto-corrected by any preference. On a fresh install the **lightBlue autocorrect toggle defaults ON** (lightBlue never edits page text — it only surfaces a reference and recolors), while the **orange autocorrect toggle retains its existing default (off)**.
- **FR-019**: Automatic correction MUST apply only to safe findings — unambiguous (single-candidate) or context-resolved matches; ambiguous matches are never auto-corrected.
- **FR-020**: The existing orange autocorrect preference setting MUST migrate forward to the generalized preference without loss of the reader's prior choice.
- **FR-021**: A corrected finding MUST be persisted per the existing revisit behavior so that on a later visit it surfaces with a "previously corrected" indicator and is not silently suppressed. A finding whose correction was reverted (FR-006) MUST NOT be re-applied on revisit.
- **FR-022**: All correction UI strings (diff labels, "Did you mean …?", "No automatic correction", Revert, and per-color action labels) MUST be localized in the same languages as the rest of the interface.

### Key Entities *(include if feature involves data)*

- **Correction**: an applied repair of a finding. Attributes: kind (reference-edit / reference-resolve-tooltip / text-replace), the original (reader-supplied) content needed to revert, the resulting verified reference and/or authentic wording, and a back-reference to the original finding.
- **Aligned diff**: the per-word comparison between the cited wording and the authentic ayah, where each word carries an operation (keep / missing / extra / substitute) and its cited and authentic forms.
- **Near-match suggestion**: a candidate ayah + reference proposed for a red finding, with a distance/confidence measure used to gate whether it is offered.
- **Autocorrect preference**: per-color (orange, lightBlue) booleans controlling automatic application of safe corrections; yellow and red are excluded by design.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reader can repair a yellow near-miss citation and see the corrected, marked-up result in **2 or fewer interactions** from the panel, without retyping any Quranic text.
- **SC-002**: For yellow findings with a single-ayah match, the aligned diff correctly identifies the changed words in **at least 95%** of a curated drift test set.
- **SC-003**: For lightBlue findings whose text resolves to a single reference, the correct reference is surfaced in **100%** of a curated single-resolution test set; multi-resolution cases are never auto-resolved without disambiguating context.
- **SC-004**: For red findings that are within the near-match threshold of a real ayah, the correct candidate is offered in **at least 90%** of a curated near-match test set; findings beyond threshold are labelled "No automatic correction" with **zero** incorrect auto-edits.
- **SC-005**: **100%** of applied corrections (every color) can be reverted to the exact reader-supplied original content where the target span still exists.
- **SC-006**: Across the autocorrect test set, **zero** yellow or red findings are ever auto-corrected, and **zero** ambiguous findings of any color are auto-corrected.
- **SC-007**: No correction (recolor, diff marking, or text replacement) causes on-page content to shift beyond the established span-local layout-absorption bound on any fixture in the layout-safety set.
- **SC-008**: Every correction-related interface string renders in each supported language with no missing-translation fallback.

## Assumptions

- The verifier already exposes the resolved reference(s), the matched ayah, the authentic excerpt, and a word-level difference signal for the relevant findings; the **one new verifier output** required is the *aligned* word-level diff (which words are missing / extra / substituted), reused for the red near-match preview.
- "Authentic wording" is the shipped mushaf JSON text already used by the display-time swap engine; in-place text replacement makes that same wording permanent in the page and re-verifies it.
- The near-match threshold for red is a tunable distance bound; its exact value is an implementation/tuning decision validated against the SC-004 test set.
- Autocorrect is restricted to orange and lightBlue because they do not rewrite the author's words (orange edits a reference, lightBlue only surfaces one); yellow and red can change quoted wording and therefore always require explicit reader review.
- lightBlue corrections present the reference via tooltip only (no page-body insertion), per the reader's explicit scope decision.
- Revert restores the reader-supplied original content captured at correction time; it relies on the corrected span still being present in the DOM.
- This feature reuses the existing panel, persistence, revisit, clipboard-fallback, and layout-absorption mechanisms from feature 001 rather than introducing new ones.
