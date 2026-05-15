# Scanner Behavior

## Detection Strategy

The scanner should combine several signals instead of depending on one fixed phrase list.

Important signals:

- Quran lead-in phrases such as `قوله تعالى`, `قال سبحانه`, `قوله عز وجل`, and close variants.
- Arabic text inside braces, parentheses, or quote-like boundaries after a lead-in.
- Explicit references after a phrase, such as `(سبأ:13)` or `(الواقعة:10-26)`.
- Back-reference opportunities: when an explicit reference is found, look backward for nearby citation text.
- Local continuation context: `وقوله:` can be treated as Quran citation context only shortly after a previous Quran citation.
- Multi-ayah separators such as `*`.

The scanner should prefer not highlighting over false red highlights. Ordinary Arabic prose should not be red unless there is a strong citation signal.

## Normalization Principles

Use one normalization model for both page text and Quran text:

- Remove tatweel.
- Normalize common alif/hamza variants.
- Normalize alef maqsura/ya where appropriate.
- Remove or ignore tashkeel for matching unless a stricter mode is explicitly enabled.
- Collapse whitespace and line breaks.
- Support Arabic and Western digits.
- Keep enough original text mapping to highlight the exact page range.

The scanner should also use a lighter "skeleton" form for fallback matching, especially when page text has missing hamza, altered ya/alif, or reduced diacritics.

## Verification Modes

## Matching Search Strategy

Future implementations should use layered deterministic search. Do not rely on one pass or a single exact-string map.

### 1. Precompute Quran Search Forms

For every ayah, keep:

- Original Uthmani text.
- Normalized text.
- Tokenized normalized words.
- Skeleton words for fallback matching.
- Reference metadata: surah name, surah number, ayah number, and display label.

Build indexes that can answer these questions quickly:

- Does this normalized phrase equal a full ayah?
- Does this normalized phrase appear as ordered words inside an ayah?
- Which ayahs contain most of these words, even if not in perfect order?
- Which ayah or ayahs are named by this explicit reference?
- Which combined range text is represented by this reference range?

### 2. Extract Candidate Text Before Searching

The content scanner should first decide what text is worth verifying. Candidate extraction uses page context:

- Direct Quran lead-in phrase followed by quoted/braced Arabic text.
- Explicit reference after nearby Arabic text.
- Braced Arabic text after recent Quran citation context.
- Range constructs with `إلى قوله`.
- Short fragments only when context is strong.

This matters because the verifier should not be asked to judge large unrelated prose as if it were a Quran quote.

### 3. Search Exact And Ordered Matches First

For each candidate:

1. Normalize the candidate.
2. Check full normalized ayah equality.
3. Check whether candidate words appear contiguously inside any ayah.
4. Check whether candidate words appear in the same order inside any ayah, allowing small gaps when appropriate.
5. Return all exact ordered references, not just the first one.

This is why a phrase like `كذلك يبين الله لكم آياته` must list all matching ayahs that preserve the same word order.

### 4. Search Explicit Reference Context

When a candidate has an explicit reference:

1. Resolve the surah name and ayah numbers from the reference.
2. Verify the candidate against those ayahs first.
3. If the candidate does not match the written reference, still run global search.
4. If global search finds the phrase elsewhere, report the correct Quran reference instead of trusting the written reference.
5. If neither referenced nor global search works, mark red only if the citation signal is strong.

This prevents wrong references from becoming false green matches.

### 5. Search Ranges And Subranges

For range references:

1. Combine the ayah texts in the written range.
2. Search the candidate inside the combined normalized range text.
3. If the candidate covers the whole range, display the written range compactly.
4. If the candidate covers only part of the range, map the matched words back to the ayah numbers actually used.
5. If multiple quoted parts exist around `إلى قوله`, split and verify each part separately.

The important rule is that a written range is context, not automatically the final displayed reference.

### 6. Search Partial And Skeleton Matches Last

Only after exact and ordered search fail:

- Use skeleton/token overlap to find likely ayahs.
- Rank candidates by matched significant words, order, and coverage.
- Mark these as partial/non-ordered in tooltip output.
- Do not let partial results hide exact ordered results.

Partial matches are useful diagnostics, but they are not the same thing as verified exact Quran citations.

### 7. Deduplicate And Rank Results

Result ordering should be stable:

- Exact full-ayah matches first.
- Exact ordered phrase matches next.
- Explicit-reference-confirmed results before unrelated results when quality is equal.
- Partial/non-ordered matches last.
- Duplicate references removed.

The tooltip should preserve this ranking.

### Global Text Verification

Use when a candidate is extracted from a lead-in phrase or braces.

Return:

- Exact full-verse matches.
- Exact ordered phrase matches inside verses.
- Partial or non-ordered matches only as secondary information.
- No match when confidence is too low.

### Explicit Reference Verification

Use when a nearby reference is present.

The written reference helps identify the intended ayah, but should not override the Quran text. If the reference text is wrong yet the phrase clearly matches another verse, the tooltip should still show the correct reference.

### Range Verification

For references such as `(فصلت:3-4)` or `(الواقعة:10-26)`:

- Verify against the combined ayah text.
- Preserve a compact range label when the quoted text covers the range.
- If the quoted text covers only a subrange, display the actual subrange.
- If a quote contains several disjoint quoted parts introduced by `إلى قوله`, treat each quoted part as its own citation candidate.

Examples:

- `كتاب فصلت آياته قرآنا عربيا لقوم يعلمون * بشيرا ونذيرا فأعرض أكثرهم فهم لا يسمعون` -> `فصلت:3-4`
- `والسابقون السابقون * أولئك المقربون * ثلة من الأولين` -> `الواقعة:10-11،13`
- `لا يسمعون فيها لغوا ولا تأثيما * إلا قيلا سلاما سلاما` -> `الواقعة:25-26`
- `وأصحاب اليمين ما أصحاب اليمين * في سدر مخضود * وطلح منضود` -> `الواقعة:27-29`
- `ثلة من الأولين * وثلة من الآخرين` -> `الواقعة:39-40`

### Short Fragment Verification

Short citations can be valid when they are strongly signaled:

- `رحمت ربك`
- `رحمتنا`
- `الرحمن`

For one-word fragments, require strong context such as an explicit reference or direct Quran lead-in. If the explicit reference does not contain that word but the word exists elsewhere in the Quran, list the correct Quran reference rather than accepting the wrong one.

## Tooltip Semantics

Tooltip output should be clear and stable:

- Exact ordered matches appear normally.
- Partial or non-ordered matches are visually distinct from exact ordered matches.
- Multiple exact ordered refs should all appear.
- Ranges should be compact where possible.
- Red highlights should explain the unverified fragment, not just show `???` unless no better diagnostic exists.

## Stats

The scanner currently reports eight temporary debug numbers:

1. `yellowMatches`: verified/high-confidence matched citation spans.
2. `redMatches`: high-confidence citation candidates that failed verification.
3. `yellowReferences`: total references attached to verified spans, including partial references.
4. `partialReferences`: count of partial/non-ordered references.
5. `refsSeen`: explicit reference strings seen by the scanner.
6. `refCandidates`: candidates created from explicit references.
7. `refVerified`: reference-driven candidates verified.
8. `refRejected`: reference-driven candidates rejected.

These numbers are temporary development diagnostics. They can later move behind a debug flag.

## False Positive Controls

Avoid these common mistakes:

- Do not highlight bare reference metadata such as `(آل عمران:13)` as Quran text.
- Do not highlight lists like `يوسف: الآيات 21، 40، 68` as red ayah text.
- Do not mark explanatory prose after a citation as red just because it contains Quran-related words.
- Do not let a long backward scan consume unrelated prose before the actual braced citation.
- Do not treat every `وقوله` as Quran context unless nearby citation context justifies it.
