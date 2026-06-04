# Feature Specification: Writer-Side Ayah Autocomplete

**Feature Branch**: `003-ayah-autocomplete`

**Created**: 2026-05-24

**Status**: Draft

**Input**: User description: "Writer-side ayah autocomplete. As the user types Arabic into a page input or rich editor, detect (the same way the reader-side scanner detects citations, via primary/secondary citation prefixes) that they are writing an ayah, wait a word or two (performance gate), then match what they wrote against any part of any verse (not only verse starts). Show a dropdown of candidate ayahs; narrow it as they keep typing. If no exact match, try word-level (yellow) matching, then fuzzy (red) matching, else mark it red. Multiple matches → ask which one (to attach the reference); single match (or once one is chosen) → replace their typing with the authentic ayah + reference; multiple matches with no choice on accept → take the first. Offer insertion scope: whole ayah, only the typed portion, or from the typed start up to an end-word the user then types. Unless disabled in settings, always render cited+matched text in the Quran font, or red-highlight it when there is no match. Accept via a caret dropdown with Tab/Enter; no Esc dismissal (only the settings toggle disables the feature)."

## Context

This feature is the **writer-side** companion to the reader-side citation auditor shipped in feature 001 — a co-equal goal in the project mission (CLAUDE.md; constitution Principle I). Where the reader-side scanner audits citations on pages the user *reads*, this feature helps the user *write* authentic citations: as they type a Quran quote into any editable field, the extension recognizes the emerging citation, offers the authentic ayah and its reference, and prevents drift before it is ever published.

It deliberately **reuses the existing matching/verification stack** from feature 001 — the same Arabic normalization, the same verse indexes, the same five-verdict matching (exact / word-level "yellow" / fuzzy "red"), the same citation-detection prefixes ("primary" and "secondary" signals), the same Quran-font rendering, and the same local-only/privacy posture. No verifier logic or the five-verdict taxonomy changes.

This feature does **not** depend on feature 002 (correction/autocorrect) and can ship independently.

## Clarifications

### Session 2026-05-24

- Q: For a single verse match, does the authentic ayah replace the typed text automatically, or does the user confirm? → A: Always confirm — even a single match requires Tab/Enter accept; text is never auto-replaced mid-typing. After the ayah is chosen, a **second menu** presents the insertion-scope choice (whole ayah / only the typed portion / from the typed start to an end word).
- Q: Should the feature act on citation text already present in a field on focus, or only newly-typed text? → A: Render-only for pre-existing — apply the Quran-font / red-highlight rendering (FR-018) to citations already in the field on focus, but offer the suggestion dropdown and insertion ONLY for newly-typed/edited citations.
- Q: What format and placement does the inserted reference use? → A: User-configurable (surah name vs. number, and placement), defaulting to the Arabic surah-name parenthetical form placed immediately after the inserted ayah, e.g. `(البقرة:255)`.
- Q: How are equal-tier candidate verses ordered (which is "first")? → A: Mushaf order — ascending surah number then ayah number. Deterministic; tier (exact > word-level > fuzzy) still orders across tiers, mushaf order breaks ties within a tier.
- Q: Does the live Quran-font / red-highlight rendering persist into the author's saved content, or is it transient? → A: Persist — in rich (contenteditable) surfaces the rendering is injected as real markup that becomes part of what the author publishes. Plain inputs (which cannot hold markup) still receive clean text only.
- Q: Without an Esc key, how does the author escape a false trigger, and what happens to an unresolved citation? → A: Typing past the citation or moving the caret away closes that dropdown instance (Tab/Enter are captured only while candidates show); the settings toggle remains the only feature-level off switch. A recognized citation the author does NOT resolve via the dropdown is handed to the main reader-side classifier and highlighted by its verdict (green / light blue / yellow / orange / red), reusing feature-001 classification — not merely "Quran font or red".

## Amendments

### 2026-06-03 — Multi-word "Up to…" + multi-ayah + surah-end scopes

The second menu (FR-012a / FR-015) is broadened:

- **(c) "Up to…" (was: "Up to an end word…")** — the user can now type a **single word OR a contiguous phrase** as the ending marker, and the search **spans across ayah boundaries** in the same surah. The matched ayah is searched from the typed start onwards; if the ending isn't there, the following ayahs (in mushaf order) are walked one by one until the ending is found OR the running word count exceeds `multiAyahsWordCap`. When the ending lives in ayah k, the inserted body is `matched_ayah[span.start..end] + whole(extras[1..k-1]) + extras[k][0..endIdx]` and the reference becomes a range (e.g. `(العلق:1-2)`). Single-word path keeps the original exact-then-soft ordering inside each ayah; phrase path uses contiguous soft equality. FR-016 still applies: "not found anywhere in window" or "cap exceeded" → user is told and no truncated passage is inserted.
- **(d) NEW — "Multiple ayahs…"** — the user picks this scope, then is prompted for **N** (integer ≥2) at insertion time. The system inserts the matched ayah plus the next (N-1) ayahs of the same surah, joined with single spaces. The inserted reference becomes a range (e.g. `(البقرة:255-257)`).
- **(e) NEW — "To the end of the surah"** — like (d) but spans through the surah's last ayah.

Both (d) and (e) are gated by `prefs.v1.autocomplete.multiAyahsWordCap` (default **200**, range 20–2000). When the resulting body would exceed the cap, the dropdown shows an inline "exceeds cap (N words)" note and the scope menu stays open so the user can pick a smaller scope. This is the safety guard preventing accidental insertion of a long surah (al-Baqarah, etc.) into a chat field.

**Affected FRs**:
- **FR-015** is extended from three scopes to five — `(a) whole`, `(b) typedPortion`, `(c) startToEndWord` (now phrase-capable), `(d) multiAyahs` (new), `(e) surahEnd` (new).
- **FR-016** (end-word not found refusal) is unchanged — it applies to phrases as well as single words.
- **New refusal**: the system MUST NOT insert a multi-ayah / surah-end body whose total word count exceeds `multiAyahsWordCap`; the user MUST be informed inline and given a chance to pick a smaller scope.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author completes a verse from memory and gets the authentic wording + reference (Priority: P1)

An author writing an article begins typing a Quran verse into the editor. After a word or two they are unsure of the exact wording. The extension recognizes the citation, offers a dropdown of matching ayahs, and on acceptance replaces their partial text with the authentic ayah and its reference.

**Why this priority**: This is the core writer-side value — turning a half-remembered quote into the exact mushaf wording with a correct reference, at the moment of writing. It is independently useful even if drift-warning and font rendering never ship.

**Independent Test**: In a contenteditable editor, type a recognized citation prefix followed by the first few words of a known ayah. Confirm a caret dropdown of candidate ayahs appears after the minimum-word gate. Keep typing → confirm the candidate list narrows. Press Tab/Enter → confirm the typed fragment is replaced with the authentic full ayah plus its reference. Repeat with a fragment that matches exactly one verse → confirm it auto-resolves to that verse on accept without requiring a manual pick.

**Acceptance Scenarios**:

1. **Given** an editable field and a recognized citation context, **When** the user has typed at least the minimum number of Arabic words of a verse, **Then** a dropdown of candidate ayahs (matched against any part of any verse, not only verse starts) appears anchored near the caret.
2. **Given** the dropdown is showing, **When** the user types additional words, **Then** the candidate list narrows to verses still consistent with the typed text.
3. **Given** the typed fragment matches exactly one verse, **When** the user accepts (Tab/Enter), **Then** the fragment is replaced with the authentic ayah wording and its reference, with no manual disambiguation required.
4. **Given** the typed fragment matches multiple verses, **When** the user accepts without having selected a candidate, **Then** the first (top-ranked) candidate is used.
5. **Given** the typed fragment matches multiple verses, **When** the user selects a specific candidate from the dropdown, **Then** that verse's wording and reference are inserted.

---

### User Story 2 - Author chooses how much of the verse to insert (Priority: P2)

When inserting, the author wants control over insertion scope — sometimes the whole ayah, sometimes only the portion they were quoting, sometimes a passage from where they started up to a chosen ending word.

**Why this priority**: Authors quote verses at different granularities; forcing a full-ayah insert would make the feature unusable for partial quotes. It builds directly on US1's insertion step.

**Independent Test**: Trigger a match as in US1. Confirm the insertion offers three scopes: (a) whole ayah, (b) only the portion the user typed, (c) from the user's starting words up to an end-word the user then types. Exercise each and confirm the inserted text matches the chosen scope, always in authentic wording, always with the reference.

**Acceptance Scenarios**:

1. **Given** a resolved match, **When** the user chooses "whole ayah", **Then** the complete authentic ayah and reference are inserted.
2. **Given** a resolved match, **When** the user chooses "only what I typed", **Then** only the authentic wording corresponding to the typed portion is inserted (still with the reference).
3. **Given** a resolved match, **When** the user chooses "from here to an end word" and then types an ending word, **Then** the authentic passage from the typed start through the verse word matching that ending word is inserted (with the reference).
4. **Given** the chosen end word does not occur in the matched verse after the start, **Then** the user is told the end word was not found and the passage is not truncated incorrectly.

---

### User Story 3 - Author is warned when their wording drifts, and unfixable text is flagged (Priority: P3)

As the author types, if the wording is close to but not exactly a verse, the extension still helps (word-level match); if it is only loosely similar, it offers fuzzy candidates; if nothing matches, it marks the text so the author knows it is not recognized Quran.

**Why this priority**: This is the "prevention" half of the writer-side mission — catching drift and non-Quran text before publishing. It depends on the US1 matching pipeline being in place.

**Independent Test**: Type a fragment with a small word-level deviation from a real verse → confirm word-level (yellow) candidates are offered. Type a loosely similar fragment → confirm fuzzy (red) candidates are offered. Type text that matches nothing → confirm it is marked red (not recognized) where the surface supports styling.

**Acceptance Scenarios**:

1. **Given** typed text with no exact verse match, **When** a word-level near match exists, **Then** word-level candidate ayahs are offered in the dropdown.
2. **Given** no exact and no word-level match, **When** a fuzzy near match exists, **Then** fuzzy candidate ayahs are offered.
3. **Given** no exact, word-level, or fuzzy match, **Then** the recognized citation text is marked red (not-recognized) where the surface supports styling, and no insertion is offered.
4. **Given** any stage of the cascade, **When** the user keeps typing, **Then** the cascade re-evaluates against the updated text.

---

### User Story 4 - Cited text renders in the authentic Quran font as the author writes (Priority: P4)

Unless disabled in settings, recognized-and-matched citation text the author has entered is rendered in the configured Quran font, and unmatched citation text is red-highlighted — giving the author live visual confirmation of authenticity in their own draft.

**Why this priority**: This carries the reader-side authenticity signal into the writing surface, but it is a rendering polish on top of the matching that US1–US3 provide, and it only fully applies on surfaces that support rich styling.

**Independent Test**: In a contenteditable editor with the feature enabled, insert/accept a matched ayah → confirm it renders in the configured Quran font. Leave an unmatched recognized citation → confirm it is red-highlighted. Disable the rendering setting → confirm neither styling is applied. Repeat in a plain `<input>`/`<textarea>` → confirm text insertion still works while inline styling is gracefully skipped (the field cannot render it).

**Acceptance Scenarios**:

1. **Given** rendering is enabled and a citation is matched, **When** it is present in a style-capable editable surface, **Then** it renders in the configured Quran font.
2. **Given** rendering is enabled and a recognized citation has no match, **When** it is present in a style-capable surface, **Then** it is red-highlighted.
3. **Given** rendering is disabled in settings, **Then** no Quran-font rendering or red-highlight styling is applied (matching/insertion still work).
4. **Given** a plain `<input>`/`<textarea>` (which cannot render rich styling), **Then** matching and insertion still function and inline styling is skipped without error.

---

### Edge Cases

- **Plain input vs. rich editor**: native `<input>`/`<textarea>` fields cannot render per-range font or highlight styling; in those surfaces text insertion works but the live Quran-font/red-highlight rendering (US4) is skipped. Full rendering applies only in style-capable (contenteditable) surfaces.
- **No dismissal**: there is no transient/Esc dismissal of the dropdown; while a recognized citation is being typed the suggestions remain available, and the only way to turn the feature off is the settings toggle.
- **Caret movement / mid-text editing**: the user may edit in the middle of existing text; suggestions and replacement must target the citation span at the caret, not the whole field.
- **End-word not found**: when the "from here to an end word" scope is chosen and the end word is absent from the matched verse, the passage is not truncated and the user is informed.
- **IME / composition input**: Arabic typed via an input-method composition session must be handled so matching fires on committed text, not partial composition.
- **Performance gate**: matching must not run on every keystroke from the first character; it waits for the minimum word count and must keep keystroke handling responsive.
- **Non-Arabic / non-citation typing**: ordinary typing that is not in a recognized citation context must never surface suggestions.
- **Multiple citations in one field**: more than one citation in the same field must each be detected and resolved independently.
- **Ambiguous match accepted blindly**: when multiple matches exist and the user accepts without choosing, the top-ranked candidate is inserted (the user can still revise).

## Requirements *(mandatory)*

### Functional Requirements

**Detection & trigger**

- **FR-001**: The system MUST detect that the user is typing a Quran citation in an editable field using the **same citation-detection signals** as the reader-side scanner (primary and secondary citation prefixes plus Arabic-text recognition).
- **FR-002**: The system MUST operate in both **plain editable fields** (`<input>`, `<textarea>`) and **rich contenteditable editors**.
- **FR-003**: The system MUST NOT begin matching until at least a configurable **minimum number of Arabic words** of the citation have been typed (a performance gate); it MUST NOT run a match on every single keystroke from the first character.
- **FR-004**: The system MUST process typed text **locally** and MUST NOT transmit field contents off the device (consistent with the project's local-only posture).

**Matching cascade**

- **FR-005**: The system MUST match the typed text against **any part of any verse** (substring/subsequence anywhere in a verse), not only verse beginnings.
- **FR-006**: As the user continues typing, the system MUST **narrow** the candidate set to verses still consistent with the typed text.
- **FR-007**: When no exact verse match exists, the system MUST attempt a **word-level ("yellow") match**; when that also fails, it MUST attempt a **fuzzy ("red") match**; this cascade reuses the feature-001 matching tiers.
- **FR-008**: When no exact, word-level, or fuzzy match exists, the system MUST mark the recognized citation text as **not-recognized (red)** where the surface supports styling, and MUST NOT offer an insertion.

**Suggestion & resolution UI**

- **FR-009**: The system MUST present candidate ayahs in a **dropdown anchored near the caret**, ranked, updating live as the candidate set narrows.
- **FR-010**: The user MUST be able to accept the highlighted candidate via **Tab or Enter**.
- **FR-011**: The system MUST NOT provide an explicit dismissal key (e.g., Esc) for suggestions, and the **only** way to turn the feature off entirely is the **settings toggle** (FR-019). However, the candidate dropdown for a given citation MUST close (that **instance** only, not the feature) when the author **types past the citation or moves the caret away**; Tab/Enter are captured **only while the dropdown is showing candidates**, so normal Tab/Enter behavior is preserved otherwise.
- **FR-011a**: A recognized citation the author does **not** resolve via the dropdown (instance dismissed, or no candidate accepted) MUST be handed to the **main reader-side verdict classification** (FR-018) so it is still highlighted by its verdict color.
- **FR-012**: When the typed text matches **exactly one** verse, the system MUST still require an explicit **Tab/Enter** accept (shown as a single-item dropdown); it MUST NOT auto-replace the typed text mid-typing. No manual disambiguation among candidates is needed in this case.
- **FR-012a**: After a candidate ayah is accepted (single or chosen), the system MUST present a **second menu** for the **insertion scope** (FR-015) before the text is inserted; the user confirms the scope to complete insertion.
- **FR-013**: When the typed text matches **multiple** verses, the system MUST let the user choose which candidate to insert (so the correct reference is attached); if the user accepts without choosing, the system MUST insert the **top-ranked (first)** candidate. Candidates MUST be ordered by **match tier first** (exact > word-level > fuzzy), and **within a tier by mushaf order** (ascending surah number, then ayah number).

**Insertion**

- **FR-014**: On resolution, the system MUST **replace the user's typed citation text** with the **authentic ayah wording** and **attach the verse reference**. The reference **format and placement MUST be user-configurable** (surah name vs. number; placement), defaulting to the **Arabic surah-name parenthetical** form placed immediately **after** the inserted ayah (e.g. `(البقرة:255)`), reusing feature-001 reference conventions.
- **FR-015**: After a candidate is accepted, the system MUST offer **insertion scopes** via the second menu (FR-012a): (a) the **whole ayah**; (b) **only the portion the user typed** (its authentic equivalent); (c) a passage **from the user's starting words up to** a single word or contiguous phrase the user subsequently types — the search **spans across ayah boundaries in the same surah**, and the reference becomes a range when the ending lives in a later ayah; (d) the matched ayah plus **N-1 following ayahs** of the same surah (N is prompted at insertion time, integer ≥2); (e) the matched ayah **through the surah's last ayah**. Scopes (c), (d), and (e) are gated by `multiAyahsWordCap` (see [Amendments](#amendments) 2026-06-03).
- **FR-016**: For scope (c), when the ending word/phrase is not found in the matched ayah or any following ayah within the cap window, OR when the resulting body's word count exceeds `multiAyahsWordCap`, the system MUST inform the user and MUST NOT insert an incorrectly truncated passage. For scopes (d) and (e), the cap-exceeded refusal applies the same way.
- **FR-017**: Inserted text MUST always be **authentic mushaf wording** and MUST always carry the **verse reference**; the system MUST NOT insert user-typed (potentially drifted) wording as if it were authentic.

**Rendering**

- **FR-018**: Unless disabled in settings, the system MUST apply **feature-001's reader-side verdict classification and rendering** to recognized citations in the field — coloring each citation by its verdict (**green / light blue / yellow / orange / red**) and rendering matched/authentic text in the configured **Quran font** — so that any recognized citation is classified and highlighted regardless of whether the author used the suggestion dropdown. On surfaces that support inline styling this is applied as markup; on surfaces that cannot render styling (plain inputs), it MUST skip styling without error while preserving matching and insertion.
- **FR-018a**: The rendering in FR-018 MUST also apply to citation text **already present in a field when it gains focus** (not only newly-typed text). However, the suggestion dropdown (FR-009) and insertion (FR-014) MUST be offered **only for newly-typed/edited citations**; pre-existing content is rendered but not rewritten.
- **FR-018b**: In rich (contenteditable) surfaces the FR-018 rendering MUST be applied as **real markup that persists into the author's saved/published content** (the font/highlight styling is part of what they publish). In plain inputs (which cannot hold markup) only clean text is written; no styling is persisted there.

**Settings**

- **FR-019**: The system MUST provide a **settings toggle** to enable/disable the entire autocomplete feature, a setting to disable the live Quran-font/red-highlight rendering (FR-018) independently, and a setting for the **reference format/placement** (FR-014).
- **FR-020**: All autocomplete UI strings (dropdown labels, insertion-scope choices, "end word not found", not-recognized state) MUST be **localized** in the same languages as the rest of the interface.

### Key Entities *(include if feature involves data)*

- **Citation-in-progress**: the span of recognized citation text currently being typed at the caret — its text, field/editor location, and the caret's position within it.
- **Candidate ayah**: a verse proposed for the current citation-in-progress, with its authentic wording, reference, match tier (exact / word-level / fuzzy), and rank.
- **Insertion scope**: the chosen extent of inserted text — `whole`, `typedPortion`, `startToEndWord` (with user-supplied word or phrase), `multiAyahs` (with user-supplied N), or `surahEnd`. Multi-ayah / surah-end are subject to `multiAyahsWordCap`.
- **Autocomplete settings**: feature on/off, live-rendering on/off, reference format/placement, plus the minimum-word performance gate.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An author can convert a typed partial verse into the authentic ayah + reference in **2 or fewer interactions** after the dropdown appears (select/accept, then insertion scope).
- **SC-002**: For a curated set of correctly-typed verse fragments, the correct ayah appears among the dropdown candidates in **at least 95%** of cases, and is the top-ranked candidate in **at least 85%**.
- **SC-003**: For fragments typed with small word-level drift, a word-level candidate is offered in **at least 90%** of a curated drift set; for loosely-similar fragments, a fuzzy candidate is offered where one exists within threshold.
- **SC-004**: Typing in non-citation contexts produces **zero** suggestion dropdowns across a curated set of ordinary (non-Quran) Arabic and non-Arabic inputs.
- **SC-005**: Keystroke handling remains responsive — the matching gate and candidate updates introduce no perceptible typing lag (no dropped/delayed characters) on the test fields.
- **SC-006**: **100%** of inserted citations contain authentic mushaf wording and a reference; **zero** insertions contain user-drifted wording presented as authentic.
- **SC-007**: Matching and insertion succeed in **both** plain inputs and contenteditable editors across the test set; live styling renders in contenteditable and is cleanly skipped in plain inputs.
- **SC-008**: Every autocomplete interface string renders in each supported language with no missing-translation fallback.

## Assumptions

- The reader-side citation-detection signals ("primary" and "secondary" prefixes) and the matching/normalization/index stack from feature 001 are reused as-is; this feature adds a writer-side surface on top of them rather than new matching logic.
- "Any part of any verse" matching means the typed text may align to a substring/subsequence located anywhere within a verse, enabling mid-verse quoting.
- The minimum-word performance gate is a tunable threshold (e.g., ~2–3 words); its exact value is an implementation/tuning decision validated against SC-005.
- Candidate ranking reuses the verifier's match-quality ordering (exact before word-level before fuzzy), with the "first" candidate meaning the top-ranked one.
- Live Quran-font rendering and red-highlighting can only be applied where the editable surface supports per-range styling (contenteditable); plain `<input>`/`<textarea>` fields receive text insertion only.
- The Quran font used for rendering is the user's existing configured font from feature 001's preferences.
- There is no transient dismissal of the dropdown by design; the settings toggle is the sole disable mechanism.
- This feature is local-only and adds no network, account, or telemetry surface.
- This feature is independent of feature 002 and may ship before or after it.
