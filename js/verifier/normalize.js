'use strict';
// T013 — Tashkeel/drift normalization per FR-003.
// Exported as QuranNormalize global (loaded via importScripts in SW, <script> in popup/sidebar).
const QuranNormalize = (() => {
  function toAsciiDigits(s) {
    return s
      .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
      .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
  }

  // ── Tashkeel / annotation stripping ──────────────────────────────────────────
  // Arabic base letters are U+0621-U+063A and U+0641-U+064A.
  // The ranges below deliberately exclude those blocks.
  //
  //   U+0610-U+061A  Arabic sign abbreviations (before base letters)
  //   U+064B-U+065F  Tashkeel: fathatan … sukun and all harakat
  //   U+06D6-U+06ED  Quranic annotation signs (waqf, small yeh, etc.)
  //   U+08D3-U+08FF  Arabic Extended-A vocalization marks
  //   U+0640         Tatweel / kasheeda (sits between the two base-letter blocks)
  //
  // Note: U+0670 (superscript alef) is NOT stripped here — it is converted to
  // a regular alef below, because in Uthmani Quran script it represents an
  // actual alef that is omitted from the written consonantal skeleton.
  // eslint-disable-next-line no-misleading-character-class
  const STRIP_RE = /[ؐ-ًؚ-ٟۖ-ۭ࣓-ࣿـ]/g;

  function tier1(text) {
    if (!text) return '';
    let s = text;

    // 1. Strip tashkeel and annotation marks (does NOT touch Arabic base letters).
    s = s.replace(STRIP_RE, '');

    // 2. Uthmani superscript alef U+0670 → ا.
    //    In Uthmani script, marks a hidden alef omitted from the consonantal
    //    skeleton but present in the standard Arabic spelling.
    //    A handful of words then differ by one alef (e.g. كذالك vs كذلك);
    //    the verifier's soft-equality check absorbs that drift.
    s = s.replace(/ٰ/g, 'ا'); // superscript alef → ا

    // 3. Alef variants without hamza → ا
    //    آ = alef madda (long aa), ٱ = alef wasla (silent in pronunciation).
    //    Both are alefs proper, no hamza component to preserve.
    s = s.replace(/[آٱ]/g, 'ا');

    // 4. Uthmani decomposed آ: ء immediately before ا → ا
    s = s.replace(/ءا/g, 'ا');

    // 5. Hamza-bearing letters → bare hamza ء.
    //   Quran's carrier choice for hamza (ؤ on waw, ئ on yeh, أ/إ on alef,
    //   bare ء, etc.) is determined by the surrounding vowel; modern Arabic
    //   spelling makes different choices on the same root, so the carrier
    //   can disagree even when the consonant skeleton is identical:
    //     - Uthmani أَبْنَٰٓؤُا۟ vs modern أبناء (ؤ vs bare ء)
    //     - Uthmani أَرَءَيْتُمْ vs modern أرأيتم (bare ء vs أ on alef)
    //   Mapping every carrier to a single neutral marker ء lets soft-equality
    //   absorb the carrier drift on top of its existing alef/waw/yeh insertion
    //   tolerance. أ/إ are included because they too are hamzas riding on a
    //   (silent) alef carrier — dropping the carrier mirrors the ؤ→ء / ئ→ء
    //   rule. Step 4 already collapsed Uthmani-decomposed ءا → ا, so the
    //   ء values produced here represent real hamzas, not orthographic alefs.
    s = s.replace(/[ؤئءأإ]/g, 'ء');

    // 6. Alef maqsura → ya; ta marbuta → ha
    s = s.replace(/ى/g, 'ي'); // ى → ي
    s = s.replace(/ة/g, 'ه'); // ة → ه

    // 7. Collapse adjacent same-letter runs (Quranic-vs-modern drift: e.g. لل → ل)
    s = s.replace(/([ء-ي])\1+/g, '$1');

    // 8. Whitespace normalization
    s = s.replace(/\s+/g, ' ').trim();

    return s;
  }

  // Skeleton: remove long-vowel letters (used for Tier-3 candidate finding only).
  function toSkeleton(tier1Text) {
    return tier1Text.replace(/[اويء]/g, '');
  }

  // Given two original strings that are Tier-1 equal, classify how they differ.
  function classifyDeviation(originalA, originalB) {
    if (originalA === originalB) return 'none';
    const stripMarks = s => s.replace(STRIP_RE, '').replace(/ٰ/g, '');
    if (stripMarks(originalA) === stripMarks(originalB)) return 'tashkeelOnly';
    return 'spellingDrift';
  }

  return { tier1, toSkeleton, classifyDeviation, toAsciiDigits };
})();
