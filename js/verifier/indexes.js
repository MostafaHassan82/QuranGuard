'use strict';
// T014 — Build all 5 indexes from the Quran JSON.
// Depends on: QuranNormalize (normalize.js must be loaded first).
const QuranIndexes = (() => {
  // Surah name variants for common non-standard spellings.
  const SURAH_VARIANTS = {
    'البقر':       2,
    'الحجرت':      49,
    'يسين':        36,
    'الرحمان':     55,
    'الانشراح':    94,
    'بني اسرايل':  17,
    'سبا':         34,
    'حم السجدة':   41,
    'المومن':      40,
    'غافر':        40,
    'المؤمن':      40,
  };

  function build(quranData) {
    const { tier1, toSkeleton, hasContent } = QuranNormalize;

    const byRef = {};
    const byTier1Norm = new Map();
    const wordIndex = new Map();
    const skeletonWordIndex = new Map();
    const surahNameIndex = new Map();

    // Surah name index from JSON metadata
    for (const [arName, surahNum] of Object.entries(quranData.meta.chaptersNames.chaptersNamesAr)) {
      const norm = tier1(arName);
      surahNameIndex.set(norm, surahNum);
      surahNameIndex.set(toSkeleton(norm), surahNum);
    }
    // Manual variants
    for (const [variant, surahNum] of Object.entries(SURAH_VARIANTS)) {
      const norm = tier1(variant);
      surahNameIndex.set(norm, surahNum);
      surahNameIndex.set(toSkeleton(norm), surahNum);
    }

    for (const sura of quranData.suras) {
      const surahNum = parseInt(sura.index, 10);
      const surahName = sura.name;
      byRef[surahNum] = byRef[surahNum] || {};

      for (const aya of sura.ayas) {
        const ayahNum = parseInt(aya.index, 10);
        // Uthmani preprocessing: يَٰبَنِى is written as one orthographic word (vocative
        // يا merged with the following noun). Insert a space after the initial يَٰ token
        // so tier-1 splits it into يا + noun, matching page text.
        // Only the START of each space-delimited token is replaced to avoid splitting
        // mid-word يَٰ in words like ءَايَٰت (آيات).
        const ayaText = aya.text.split(' ').map(
          tok => tok.replace(/^ي[َُِ]*ٰ/, 'يَا ')
        ).join(' ');
        const t1 = tier1(ayaText);
        const skeleton = toSkeleton(t1);
        const tier1Words = t1.split(' ').filter(w => w.length > 0);
        const skelWords = skeleton.split(' ').filter(w => w.length > 0);
        const ref = `${surahName}:${ayahNum}`;

        // Uthmani words, aligned 1:1 with tier1Words by index. Used by the
        // excerpt-preserving swap (T058a) to slice the authentic wording for
        // just the cited span. Standalone Quranic annotation tokens (waqf/pause
        // marks like ۛ ۚ) are their own space-delimited tokens that tier1()
        // strips to empty — so we drop any token that normalizes to empty,
        // keeping uthmaniWords aligned 1:1 with tier1Words. (Without this,
        // ~44% of ayahs misaligned and the swap fell back to the whole ayah.)
        // hasContent is the cheap equivalent of `tier1(w).length > 0` (verified
        // identical on all ~82k words) — avoids a full 9-pass tier1 per word.
        const uthmaniWords = ayaText.split(' ').filter(w => w.length > 0 && hasContent(w));

        const record = { text: aya.text, tier1: t1, skeleton, tier1Words, uthmaniWords, skelWords, ref, surahName, surahNum, ayahNum };

        byRef[surahNum][ayahNum] = record;

        if (!byTier1Norm.has(t1)) byTier1Norm.set(t1, []);
        byTier1Norm.get(t1).push(record);

        const key = `${surahNum}:${ayahNum}`;
        for (const w of tier1Words) {
          if (!wordIndex.has(w)) wordIndex.set(w, new Set());
          wordIndex.get(w).add(key);
        }
        for (const w of skelWords) {
          if (!skeletonWordIndex.has(w)) skeletonWordIndex.set(w, new Set());
          skeletonWordIndex.get(w).add(key);
        }
      }
    }

    return { byRef, byTier1Norm, wordIndex, skeletonWordIndex, surahNameIndex };
  }

  return { build };
})();
