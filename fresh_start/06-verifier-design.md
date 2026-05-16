# V1 Verifier Design

**Status:** Design target for Milestone A implementation
**Authoritative source:** `00-V1-PRD.md` for product semantics; this doc defines the API contract that satisfies it.

---

## Purpose

This document specifies the verifier message contract, the normalization tiers, and the color decision tree. Implementation (background.js + content.js) targets this contract. The orange pipeline (Milestone B) is sketched here but not implemented until B; the API surface reserves space for it.

---

## Verifier Output Shape

Every verifier call returns a single result object:

```javascript
{
  color: 'green' | 'lightBlue' | 'yellow' | 'orange' | 'red' | null,

  // Reference data
  matchedRef: 'البقرة:106' | 'البقرة:106-107' | null,   // where the text actually lives
  matchedRefs: [...],                                    // when multiple ayahs match (e.g. repeated phrases)
  claimedRef: 'البقرة:107' | null,                       // what the page asserted (null if no ref on page)

  // Authentic text for swap
  authenticText: '...' | null,        // JSON-source text from matchedRef, with full tashkeel
                                       // null when color === 'red'

  // Deviation classification
  deviation: 'none' | 'tashkeelOnly' | 'spellingDrift' | 'wordLevel' | null,
  //   'none'          → byte-identical
  //   'tashkeelOnly'  → only diacritics differ
  //   'spellingDrift' → modern-vs-Quranic Arabic spelling drift (e.g., ٱ→ا, ى→ي, ة→ه)
  //   'wordLevel'     → word missing / added / substituted
  //   null            → not applicable (red, or no match)

  // Diagnostic / tooltip data
  candidateConfidence: 'high' | 'medium',  // extraction-stage signal (lead-in + braces = high)
  matchType: 'exact' | 'orderedContiguous' | 'orderedGapped' | 'partial' | 'none',
}
```

A `color: null` result means **drop the candidate** — no highlight, no entry in findings panel. Used when extraction confidence is medium and verification produces no plausible match.

---

## Color Decision Tree

For a candidate text `C` from the page, with optional `claimedRef R`:

### Path 1 — `R` is present (the page provides a reference)

```
Resolve R → ayah(s) A_R                          # may be single, range, or list

if match(C, A_R) is exact, tashkeelOnly, or spellingDrift:
    → green
    matchedRef = R (or subrange of R)
    authenticText = sourceText(A_R)
    deviation = 'none' | 'tashkeelOnly' | 'spellingDrift'

elif match(C, A_R) is wordLevel (one or two words off):
    → yellow
    matchedRef = R
    authenticText = sourceText(A_R)
    deviation = 'wordLevel'

else (no meaningful match to A_R):
    # Look elsewhere in the Quran
    globalExact = exactMatchGlobal(C)             # list of ayahs that match exactly
    if globalExact non-empty:
        → orange
        matchedRef = globalExact[0].ref           # or matchedRefs[] when multiple
        claimedRef = R
        authenticText = sourceText(globalExact[0])
        deviation = 'none' (the text itself is exact; only the ref is wrong)
    else:
        globalWordLevel = wordLevelMatchGlobal(C)
        if globalWordLevel non-empty:
            → yellow                              # text drifted from a verse and ref is also wrong
            matchedRef = globalWordLevel[0].ref
            claimedRef = R
            deviation = 'wordLevel'
        else:
            → red                                 # nothing matches anywhere
            matchedRef = null
            authenticText = null
```

### Path 2 — no `R` (page has no reference for this citation)

```
globalExact = exactMatchGlobal(C)
if globalExact non-empty:
    → lightBlue                                   # text is in Quran; we contribute the ref
    matchedRefs = globalExact[].ref
    authenticText = sourceText(globalExact[0])
    deviation = 'none' | 'tashkeelOnly' | 'spellingDrift'

else:
    globalWordLevel = wordLevelMatchGlobal(C)
    if globalWordLevel non-empty:
        → yellow                                  # close to Quran but not exact
        matchedRef = globalWordLevel[0].ref
        deviation = 'wordLevel'

    elif candidateConfidence === 'high':
        → red                                     # strong citation signal, nothing matches
        matchedRef = null
        authenticText = null

    else:
        → null                                    # drop; no signal to highlight
```

### Precedence rules

- **Orange beats yellow** when text is exactly in the Quran but at a different ref than claimed. The ref mismatch is the higher-value finding.
- **Yellow beats orange** when both the text and the ref are wrong — the text isn't even exactly in the Quran, so "wrong ref to right ayah" doesn't apply. This is still a citation-with-issues situation; yellow communicates "look at this," and the tooltip can elaborate.
- **Red requires high candidate confidence.** Medium-confidence candidates with no match are silently dropped to avoid flagging ordinary Arabic prose.
- A single candidate cannot be both yellow and orange. Pick the color that best describes the dominant problem; surface the other in the tooltip.

---

## Normalization Tiers

Three tiers. Each tier is a superset of the previous (more aggressive normalization).

### Tier 1 — Exact match (green-eligible)

Applied to both Quran text and candidate text. Two strings are "Tier-1 equal" if they're identical after:

1. **Tashkeel and diacritic removal:** combining marks `[ً-ٰٟۖ-ۭ]` stripped. (Includes fathatan, dammatan, kasratan, fatha, damma, kasra, shadda, sukun, superscript alef, dagger alef, Quranic sigla.)
2. **Alif unification:** `[آأإٱ] → ا`. The Quranic `ٱ` (waṣla) and dagger alif `ٰ` both collapse to `ا`.
3. **Hamza variants:** `ؤ → و`, `ئ → ي`. Standalone `ء` is preserved (not stripped) to keep it as a Tier-1 distinguishable letter.
4. **Tatweel removal:** `ـ → ""`.
5. **Spelling drift class:**
   - `ى → ي` (alef maqsura → ya)
   - `ة → ه` (ta marbuta → ha)
6. **Whitespace collapse:** any sequence of whitespace, NBSP, ZWNJ, ZWJ, RLM, BOM → single space. Trim ends.
7. **Adjacent same-letter collapse (Quranic-vs-modern spelling drift):** after the above steps, collapse any run of two or more identical adjacent letters to a single letter. This handles the canonical Quranic-vs-modern divergence cases:
   - `بِٱلَّيْلِ` → tashkeel-stripped → `بٱليل` → alif-unified → `باليل` (5 letters)
   - `بالليل` → already plain → `بالليل` → collapse `لل` → `باليل` (5 letters)
   - Match. Both classify as `deviation: 'spellingDrift'` (or `'none'` if also alif/ya/ta-marbuta-identical).
   - Same rule resolves `ٱلَّذِينَ`↔`الذين` and `ٱلصِّرَاطَ`↔`الصراط`.

   **Why this works:** Quranic orthography marks consonant doubling with shadda (single letter + ّ); modern orthography either writes the doubled letter twice (when assimilation of definite article ال into a sun letter that is itself ل) or writes one letter with implicit doubling (other sun letters, or assimilation-derived doubles in pronouns like الذين). Stripping shadda *and* collapsing adjacent same-letter runs handles both modern conventions correctly.

   **Tradeoff acknowledged:** in rare cases this over-collapses (e.g., `قطط` "cats" → `قط` "cat"). Citation context rarely surfaces these; risk accepted for V1.

If two strings produce identical Tier-1 normalized forms, the match is **exact** with `deviation` set to:
- `'none'` if they were already byte-identical
- `'tashkeelOnly'` if only marks differed
- `'spellingDrift'` if alif/hamza/ya/ta-marbuta or alif-elision differences were involved

All three are GREEN-eligible.

### Tier 2 — Word-level diff (yellow-eligible)

Computed by tokenizing both normalized forms and comparing word sequences. A candidate is "word-level matched" to an ayah if:

- The candidate's tokens appear in the ayah in order, with **at most 1 missing/inserted/substituted word per 8 candidate tokens** (configurable, but this is the V1 default).
- OR the candidate matches a contiguous span of the ayah with up to 1 token diff per ~8 candidate tokens.

The exact thresholds are tunable parameters; the fixture suite is the source of truth for whether they're right. Document this as a known calibration point.

### Tier 3 — Skeleton fallback (extraction-only)

A "skeleton" form that strips weak letters (`ا و ي`) and standalone hamza for *finding* candidate ayahs cheaply. **Used only as an index lookup to narrow the candidate space.** A skeleton match alone is NEVER GREEN. It must pass Tier 1 or Tier 2 to color anything but red.

---

## Index Shapes (Background)

Indexes built once at service worker activation. Re-builds on activation if state is lost (MV3 ephemerality).

```javascript
indexes = {
  // Per-verse records
  byRef: { [surahNum]: { [ayahNum]: VerseRecord } },

  // Quick exact lookup
  byTier1Norm: Map<string, VerseRecord[]>,    // multiple verses can have same Tier-1 form

  // Word indexes for narrowing candidates before O(n) check
  wordIndex: Map<string, Set<verseKey>>,      // normalized words → verse keys
  skeletonWordIndex: Map<string, Set<verseKey>>,

  // Reference resolution
  surahNameIndex: Map<string, surahNum>,      // includes normalized form + skeleton form + manual variants

  // Reverse: from ref to authentic text
  authenticText(surahNum, ayahNum) → original Uthmani text with full tashkeel
}

VerseRecord = {
  text: string,           // original Uthmani with tashkeel
  tier1Norm: string,      // Tier-1 normalized
  skeleton: string,       // Tier-3 skeleton
  tier1Words: string[],
  skeletonWords: string[],
  ref: 'البقرة:106',
  surahName: string,
  surahNum: number,
  ayahNum: number,
}
```

**Surah variants:** explicit map (harvest from the rebuild's `SURAH_VARIANTS` plus any additions discovered during fixture review). Common misspellings, alternate names, and shortened forms documented inline. Each entry indexed under both normalized form and skeleton form.

---

## Message Contract (Background ↔ Content)

MV3 service worker, `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`. Service worker rebuilds index on activation if state is lost.

### Inbound messages (content → background)

| Message | Purpose | Request | Response |
|---|---|---|---|
| `verifyFragment` | Verify text without a claimed ref. Returns lightBlue/yellow/red. | `{ text, candidateConfidence }` | Verifier output (see top of doc) |
| `verifyFragmentByRef` | Verify text with a claimed ref. Runs orange pipeline. Returns green/yellow/orange/red. | `{ text, claimedRef, candidateConfidence }` | Verifier output |
| `resolveReference` | Resolve a written ref to ayah(s) and authentic text. Used for tooltips and edit-in-place. | `{ refString }` | `{ surahNum, surahName, ayahNums, ayahTexts, displayLabel } \| null` |
| `getAyahText` | Get authentic Quran text for a specific ref. Used for swap. | `{ surahNum, ayahNum }` | `{ text, ref } \| null` |
| `ping` | Wake the service worker and confirm index is ready. | `{}` | `{ ok: true, indexReady: boolean }` |
| `logFindings` | Send the page's finding payload to background console for debug. | `{ findings: [...] }` | `{ ok: true }` |

### Orange pipeline contract

`verifyFragmentByRef` runs the full Path 1 of the decision tree:

1. Resolve `claimedRef` → list of ayahs.
2. Tier-1 compare candidate against claimed ayahs.
3. If match → return green (with deviation classification).
4. Else Tier-2 compare against claimed ayahs.
5. If match → return yellow.
6. Else Tier-1 global search.
7. If match found at a *different* ref → return **orange** with both refs surfaced.
8. Else Tier-2 global search.
9. If match → return yellow (text drifted + ref was wrong; tooltip notes both).
10. Else → red.

**Per Mostafa's 2026-05-15 direction, all 10 steps land in Milestone A.** Milestone B is reframed as orange precision/recall tuning against the curated 20-case scoring set, plus additional fixture curation.

`verifyFragment` (no ref) runs Path 2 and is also fully implemented in Milestone A.

---

## Out of Scope for This Design

- **Edit-in-place mechanics** — Milestone D.
- **Authentic-text swap rendering** — Milestone C. The verifier supplies `authenticText` in its output; the swap engine uses it.
- **Findings panel data shape** — Milestone D will specify the aggregate payload; per-finding shape is essentially this verifier output plus DOM anchoring metadata.
- **Tooltip text rendering** — content-script concern; design will live with content.js.

---

## Open Implementation Questions

1. **Same-letter-collapse safety.** The rule over-collapses in rare cases (`قطط`→`قط`). Need fixture-driven calibration: if false greens emerge, tighten by excluding specific letter pairs from the collapse. V1 risk accepted.
2. **Word-level diff thresholds (1 per 8).** First-pass guess. Tune against the curated fixture set.
3. **Orange tie-breaking when multiple ayahs match.** If candidate text exists in ayahs X, Y, and Z and the page claims ref R (none of them), which ref does orange surface? **Decision: surface the first ayah in surah-then-ayah order as `matchedRef`; populate `matchedRefs[]` with all of them; tooltip can render all.**
4. **Candidate-confidence in the color decision.** **Decision: orange and red both require high candidate confidence; yellow and green/lightBlue can fire on medium. Low confidence + no match → drop.**
