'use strict';
// T013 — Tashkeel/drift normalization per FR-003.
// Exported as QuranNormalize global (loaded via importScripts in SW, <script> in popup/sidebar).
const QuranNormalize = (() => {
  function toAsciiDigits(s) {
    return s
      .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
      .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
  }

  function tier1(text) {
    if (!text) return '';
    let s = text;

    // Strip all Arabic diacritics, marks, sigla, tatweel in one pass.
    s = s.replace(/[ؐ-ًؚ-ٰٟۖ-ۭـࣣ-ࣿ]/g, '');
    s = s.replace(/[ۖ-ۭ]/g, '');
    s = s.replace(/[ٰٕٓٔ]/g, '');
    s = s.replace(/ـ/g, '');
    s = s.replace(/[ً-ٟ]/g, '');

    // Unify alif variants → ا
    s = s.replace(/[آأإٱ]/g, 'ا');

    // Uthmani decomposed آ: ءَ immediately before ا → ا
    s = s.replace(/ءا/g, 'ا');

    // Hamza-bearing letters → base
    s = s.replace(/ؤ/g, 'و');
    s = s.replace(/ئ/g, 'ي');

    // Alef maqsura → ya; ta marbuta → ha
    s = s.replace(/ى/g, 'ي');
    s = s.replace(/ة/g, 'ه');

    // Collapse adjacent same-letter runs (Quranic-vs-modern drift)
    s = s.replace(/([ء-ي])\1+/g, '$1');

    // Whitespace normalization
    s = s.replace(/[\s ​-‏﻿]+/g, ' ').trim();

    return s;
  }

  // Skeleton: remove long-vowel letters (used for Tier-3 candidate finding only).
  function toSkeleton(tier1Text) {
    return tier1Text.replace(/[اويء]/g, '');
  }

  // Given two original strings that are Tier-1 equal, classify how they differ.
  function classifyDeviation(originalA, originalB) {
    if (originalA === originalB) return 'none';
    const stripMarks = s => s.replace(/[ً-ٰٟٓ-ٕۖ-ۭـ]/g, '');
    if (stripMarks(originalA) === stripMarks(originalB)) return 'tashkeelOnly';
    return 'spellingDrift';
  }

  return { tier1, toSkeleton, classifyDeviation, toAsciiDigits };
})();
