'use strict';
// T016 — Reference parsing: surah:ayah, ranges, surah-name variants.
// Depends on: QuranNormalize (normalize.js) and a live indexes object passed in on each call.
const QuranReferences = (() => {
  const { tier1, toSkeleton, toAsciiDigits } = QuranNormalize;

  // Parse a reference string against the active indexes.
  // Returns {surahNum, ayahNums, isRange} or null.
  function resolve(refString, indexes) {
    if (!refString || !indexes) return null;

    let s = refString.replace(/^[\s({«\[﴿]+|[\s.,;)}\»\]﴾]+$/g, '').trim();
    s = s.replace(/^(?:من\s+)?سور[ةه]\s+/u, '');

    const colonIdx = s.search(/[:：]/);
    if (colonIdx === -1) return null;

    const surahPart = s.slice(0, colonIdx).trim();
    let ayahPart = s.slice(colonIdx + 1).trim();

    ayahPart = ayahPart.replace(/^(?:الآيات|الآية)\s*/u, '');
    ayahPart = toAsciiDigits(ayahPart);

    const normSurah = tier1(surahPart);
    const surahNum = indexes.surahNameIndex.get(normSurah)
                  ?? indexes.surahNameIndex.get(toSkeleton(normSurah));
    if (!surahNum) return null;

    const ayahNums = [];
    let isRange = false;

    const rangeMatch = ayahPart.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > 0 && end >= start) {
        for (let i = start; i <= end; i++) ayahNums.push(i);
        isRange = true;
      }
    } else {
      const parts = ayahPart.split(/[،،,]\s*/);
      for (const p of parts) {
        const n = parseInt(p.trim(), 10);
        if (!isNaN(n) && n > 0) ayahNums.push(n);
      }
      if (parts.length > 1) isRange = true;
    }

    if (ayahNums.length === 0) return null;
    return { surahNum, ayahNums, isRange };
  }

  return { resolve };
})();
