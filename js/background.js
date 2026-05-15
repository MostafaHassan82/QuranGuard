'use strict';

// ── Module state ────────────────────────────────────────────────────────────
// Rebuilt on every service worker activation (MV3 workers are ephemeral).
// fetch() from the local extension package is fast (~50–100ms).
let indexes = null;

// ── Arabic normalization ─────────────────────────────────────────────────────

function normalize(text) {
  return text
    // Uthmani-only waqf/tilawa/sajda/hizb marks
    .replace(/[ۖ-ۭ]/g, '')
    // Superscript alef, madd (combining), hamza-above (combining)
    .replace(/[ٰٓٔ]/g, '')
    // Tatweel (kashida)
    .replace(/ـ/g, '')
    // All tashkeel: tanween fath/damm/kasr, fatha, damma, kasra, shadda, sukun, and variants
    .replace(/[ً-ٛ]/g, '')
    // Alif variants → plain alif: آ أ إ ٱ
    .replace(/[آأإٱ]/g, 'ا')
    // Hamza-bearing letters: ؤ→و  ئ→ي
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    // Collapse all whitespace (including NBSP, ZWNJ, ZWJ, RLM)
    .replace(/[\s ​‌‍‏﻿]+/g, ' ')
    .trim();
}

function toSkeleton(normalizedText) {
  return normalizedText
    // Alef maqsura → ya
    .replace(/ى/g, 'ي')
    // Ta marbuta → ha
    .replace(/ة/g, 'ه')
    // Standalone hamza
    .replace(/ء/g, '');
}

// Convert Arabic-Indic and Extended Arabic-Indic digits to ASCII
function toAsciiDigits(str) {
  return str
    .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
}

// ── Index building ────────────────────────────────────────────────────────────

const SURAH_VARIANTS = {
  // Common shortenings and misspellings seen on Islamic sites
  'البقر': 2,       // البقر → البقرة
  'الانعام': 6,  // الانعام (no shadda)
  'الاعراف': 7,  // الاعراف (no shadda)
  'يسين': 36,            // يسين → يس
  'الحجرت': 49, // الحجرت → الحجرات
  'الرحمان': 55, // الرحمان (variant spelling)
  'فصلت': 41,            // فصلت → فصّلت
};

function buildIndexes(data) {
  const byRef = {};
  const surahNameIndex = new Map();
  const normalizedVerseIndex = new Map();
  const wordIndex = new Map();
  const skeletonWordIndex = new Map();

  // Build surah name index from JSON metadata
  for (const [arName, surahNum] of Object.entries(data.meta.chaptersNames.chaptersNamesAr)) {
    surahNameIndex.set(normalize(arName), surahNum);
  }

  // Add manual variant spellings
  for (const [variant, surahNum] of Object.entries(SURAH_VARIANTS)) {
    surahNameIndex.set(normalize(variant), surahNum);
  }

  // Also index by English transliteration (normalized, lowercase)
  for (const [enName, surahNum] of Object.entries(data.meta.chaptersNames.chaptersNamesEn)) {
    surahNameIndex.set(enName.toLowerCase().replace(/_/g, '-'), surahNum);
  }

  // Build per-ayah records and populate lookup indexes
  for (const sura of data.suras) {
    const surahNum = parseInt(sura.index, 10);
    const surahName = sura.name;
    byRef[surahNum] = byRef[surahNum] || {};

    for (const aya of sura.ayas) {
      const ayahNum = parseInt(aya.index, 10);
      const norm = normalize(aya.text);
      const skeleton = toSkeleton(norm);
      const normWords = norm.split(' ').filter(w => w.length > 0);
      const skelWords = skeleton.split(' ').filter(w => w.length > 0);
      const ref = `${surahName}:${ayahNum}`;

      const record = {
        text: aya.text,
        norm,
        skeleton,
        normWords,
        skelWords,
        ref,
        surahName,
        surahNum,
        ayahNum,
      };
      byRef[surahNum][ayahNum] = record;

      // Exact full-ayah lookup
      if (!normalizedVerseIndex.has(norm)) {
        normalizedVerseIndex.set(norm, []);
      }
      normalizedVerseIndex.get(norm).push({ sura: surahNum, ayah: ayahNum, ref, surahName });

      // Word-level indexes
      for (const w of normWords) {
        if (!wordIndex.has(w)) wordIndex.set(w, new Set());
        wordIndex.get(w).add(`${surahNum}:${ayahNum}`);
      }
      for (const w of skelWords) {
        if (!skeletonWordIndex.has(w)) skeletonWordIndex.set(w, new Set());
        skeletonWordIndex.get(w).add(`${surahNum}:${ayahNum}`);
      }
    }
  }

  return { byRef, surahNameIndex, normalizedVerseIndex, wordIndex, skeletonWordIndex };
}

async function loadAndIndex() {
  const url = chrome.runtime.getURL('resources/quran-uthmani_desc-v2.json');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load Quran JSON: ${resp.status}`);
  const data = await resp.json();
  indexes = buildIndexes(data);
  console.log(
    `[QuranExt] Index built — verses: ${indexes.normalizedVerseIndex.size}, ` +
    `words: ${indexes.wordIndex.size}, surahs: ${Object.keys(indexes.byRef).length}`
  );
}

async function ensureInitialized() {
  if (indexes !== null) return;
  await loadAndIndex();
}

// ── Reference parsing ─────────────────────────────────────────────────────────

// Parses strings like: (سبأ:13)  (فصلت:3-4)  {الواقعة:77،80}  البقرة:255
// Returns: { surahNum, ayahNums: Number[], isRange: Boolean } or null
function resolveReference(refString) {
  if (!refString) return null;

  // Strip outer bracket characters
  let s = refString.replace(/^[\s({«\[]+|[\s)}\»\]]+$/g, '').trim();

  // Handle "سورة <name>" or "من سورة <name>" prefix — strip it
  s = s.replace(/^(?:من\s+)?سور[ةه]\s+/u, '');

  // Find the colon separator
  const colonIdx = s.search(/[:：]/);
  if (colonIdx === -1) return null;

  const surahPart = s.slice(0, colonIdx).trim();
  let ayahPart = s.slice(colonIdx + 1).trim();

  // Strip leading "الآيات" or "الآية"
  ayahPart = ayahPart.replace(/^(?:الآيات|الآية)\s*/u, '');

  // Convert Arabic-Indic digits to ASCII
  ayahPart = toAsciiDigits(ayahPart);

  // Resolve surah name
  const normSurah = normalize(surahPart);
  const surahNum = indexes.surahNameIndex.get(normSurah);
  if (!surahNum) return null;

  // Parse ayah spec
  const ayahNums = [];
  let isRange = false;

  // Range: N-M or N–M
  const rangeMatch = ayahPart.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (start > 0 && end >= start) {
      for (let i = start; i <= end; i++) ayahNums.push(i);
      isRange = true;
    }
  } else {
    // List: N،M،K or N,M,K or single N
    const parts = ayahPart.split(/[،,]\s*/);
    for (const p of parts) {
      const n = parseInt(p.trim(), 10);
      if (!isNaN(n) && n > 0) ayahNums.push(n);
    }
    if (parts.length > 1) isRange = true;
  }

  if (ayahNums.length === 0) return null;
  return { surahNum, ayahNums, isRange };
}

// ── Search helpers ────────────────────────────────────────────────────────────

// Returns true if needle (array of words) appears contiguously in haystack
function isContiguousSubsequence(haystack, needle) {
  if (needle.length === 0) return false;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (haystack[i] === needle[0]) {
      let ok = true;
      for (let j = 1; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) { ok = false; break; }
      }
      if (ok) return true;
    }
  }
  return false;
}

// Returns true if needleWords appear in haystackWords in left-to-right order (gaps allowed)
function isOrderedSubsequence(haystackWords, needleWords) {
  let hi = 0;
  for (const w of needleWords) {
    while (hi < haystackWords.length && haystackWords[hi] !== w) hi++;
    if (hi >= haystackWords.length) return false;
    hi++;
  }
  return true;
}

// Find candidate ayah keys from word intersection (returns Set<"surah:ayah">)
function candidatesFromWords(normWords) {
  if (normWords.length === 0) return new Set();
  const first = normWords[0];
  const last = normWords[normWords.length - 1];
  const setFirst = indexes.wordIndex.get(first) || new Set();
  const setLast = normWords.length > 1 ? (indexes.wordIndex.get(last) || new Set()) : setFirst;
  // Intersect
  const result = new Set();
  for (const key of setFirst) {
    if (setLast.has(key)) result.add(key);
  }
  return result;
}

// Parse a "surah:ayah" key back into numbers
function parseKey(key) {
  const [s, a] = key.split(':');
  return { surahNum: parseInt(s, 10), ayahNum: parseInt(a, 10) };
}

// Build a result entry from a byRef record
function makeEntry(rec) {
  return { sura: rec.surahNum, ayah: rec.ayahNum, ref: rec.ref, surahName: rec.surahName };
}

// Deduplicate result entries by ref string
function dedup(arr) {
  const seen = new Set();
  return arr.filter(e => {
    if (seen.has(e.ref)) return false;
    seen.add(e.ref);
    return true;
  });
}

// ── Core verification ─────────────────────────────────────────────────────────

// Global search: 4-layer layered deterministic search.
// Returns { exact, ordered, partial, bestRef }
function verifyFragment(candidateText) {
  if (!candidateText || !candidateText.trim()) {
    return { exact: [], ordered: [], partial: [], bestRef: null };
  }

  // Normalize — strip multi-ayah separator * before matching
  const norm = normalize(candidateText.replace(/\*/g, ' '));
  const normWords = norm.split(' ').filter(w => w.length > 0);
  if (normWords.length === 0) {
    return { exact: [], ordered: [], partial: [], bestRef: null };
  }

  const skeleton = toSkeleton(norm);
  const skelWords = skeleton.split(' ').filter(w => w.length > 0);

  // ── Layer 1: exact full-ayah match ───────────────────────────────────────
  const exactMatches = indexes.normalizedVerseIndex.get(norm) || [];

  if (exactMatches.length > 0) {
    const best = exactMatches[0].ref;
    return { exact: dedup(exactMatches), ordered: [], partial: [], bestRef: best };
  }

  // ── Layer 2: ordered contiguous phrase match ──────────────────────────────
  const orderedExact = [];
  if (normWords.length >= 2) {
    const candidates = candidatesFromWords(normWords);
    for (const key of candidates) {
      const { surahNum, ayahNum } = parseKey(key);
      const rec = indexes.byRef[surahNum]?.[ayahNum];
      if (!rec) continue;
      if (isContiguousSubsequence(rec.normWords, normWords)) {
        orderedExact.push(makeEntry(rec));
      }
    }
  }

  if (orderedExact.length > 0) {
    orderedExact.sort((a, b) => a.sura - b.sura || a.ayah - b.ayah);
    return { exact: [], ordered: dedup(orderedExact), partial: [], bestRef: orderedExact[0].ref };
  }

  // ── Layer 3: ordered non-contiguous match (gap-allowed, score ≥ 0.75) ────
  const orderedGapped = [];
  if (normWords.length >= 2) {
    // Find ayahs containing many candidate words
    const wordSets = normWords.map(w => indexes.wordIndex.get(w) || new Set());
    const keyCounts = new Map();
    for (const ws of wordSets) {
      for (const key of ws) {
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
      }
    }
    const threshold = Math.ceil(normWords.length * 0.6);
    for (const [key, count] of keyCounts) {
      if (count < threshold) continue;
      const { surahNum, ayahNum } = parseKey(key);
      const rec = indexes.byRef[surahNum]?.[ayahNum];
      if (!rec) continue;
      if (isOrderedSubsequence(rec.normWords, normWords)) {
        const score = count / normWords.length;
        if (score >= 0.75) orderedGapped.push({ ...makeEntry(rec), score });
      }
    }
  }

  if (orderedGapped.length > 0) {
    orderedGapped.sort((a, b) => b.score - a.score || a.sura - b.sura);
    const results = dedup(orderedGapped);
    return { exact: [], ordered: results, partial: [], bestRef: results[0].ref };
  }

  // ── Layer 4: skeleton partial match (fallback only) ───────────────────────
  const partial = [];
  if (skelWords.length >= 2) {
    const skelSets = skelWords.map(w => indexes.skeletonWordIndex.get(w) || new Set());
    const keyCounts = new Map();
    for (const ws of skelSets) {
      for (const key of ws) {
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
      }
    }
    const scored = [];
    for (const [key, count] of keyCounts) {
      const { surahNum, ayahNum } = parseKey(key);
      const rec = indexes.byRef[surahNum]?.[ayahNum];
      if (!rec) continue;
      const maxLen = Math.max(skelWords.length, rec.skelWords.length);
      const score = count / maxLen;
      if (score >= 0.45) scored.push({ ...makeEntry(rec), score });
    }
    scored.sort((a, b) => b.score - a.score || a.sura - b.sura);
    partial.push(...dedup(scored).slice(0, 3));
  }

  const bestRef = partial.length > 0 ? partial[0].ref : null;
  return { exact: [], ordered: [], partial, bestRef };
}

// Verify candidate against specific ayahs (reference-anchored).
// Returns { matchType, entries, displayRef } or null
function verifyAgainstAyahs(normCandidate, resolvedRef) {
  if (!resolvedRef) return null;
  const { surahNum, ayahNums, isRange } = resolvedRef;
  const candWords = normCandidate.split(' ').filter(w => w.length > 0);
  if (candWords.length === 0) return null;

  // Build the set of records for the referenced ayahs
  const records = ayahNums
    .map(n => indexes.byRef[surahNum]?.[n])
    .filter(Boolean);
  if (records.length === 0) return null;

  const surahName = records[0].surahName;

  // Single ayah
  if (records.length === 1) {
    const rec = records[0];
    if (isContiguousSubsequence(rec.normWords, candWords) || rec.norm === normCandidate) {
      return {
        matchType: 'exact',
        entries: [makeEntry(rec)],
        displayRef: rec.ref,
      };
    }
    return null;
  }

  // Range or list: try against combined text first
  const combined = records.map(r => r.norm).join(' ');
  const combinedWords = combined.split(' ').filter(w => w.length > 0);
  if (isContiguousSubsequence(combinedWords, candWords)) {
    // Determine which ayahs the candidate actually spans
    const matchedAyahs = [];
    for (const rec of records) {
      if (isContiguousSubsequence(rec.normWords, candWords) ||
          rec.normWords.some(w => candWords.includes(w))) {
        matchedAyahs.push(rec.ayahNum);
      }
    }
    const first = matchedAyahs[0] ?? ayahNums[0];
    const last = matchedAyahs[matchedAyahs.length - 1] ?? ayahNums[ayahNums.length - 1];
    const displayRef = first === last
      ? `${surahName}:${first}`
      : `${surahName}:${first}-${last}`;
    return {
      matchType: 'exact',
      entries: records.filter(r => matchedAyahs.includes(r.ayahNum)).map(makeEntry),
      displayRef,
    };
  }
  return null;
}

// Reference-anchored verification with global fallback
function verifyFragmentByRef(candidateText, refString) {
  const normCandidate = normalize(candidateText.replace(/\*/g, ' '));
  const resolvedRef = resolveReference(refString);

  // Try against the referenced ayahs first
  if (resolvedRef) {
    const result = verifyAgainstAyahs(normCandidate, resolvedRef);
    if (result) {
      return {
        exact: result.entries,
        ordered: [],
        partial: [],
        bestRef: result.displayRef,
        refMatchType: 'exact',
      };
    }
  }

  // Fall back to global search
  const globalResult = verifyFragment(candidateText);
  globalResult.refMatchType = resolvedRef ? 'global' : 'none';
  return globalResult;
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ensureInitialized()
    .then(() => {
      switch (msg.type) {
        case 'verifyFragment':
          return verifyFragment(msg.text);
        case 'verifyFragmentByRef':
          return verifyFragmentByRef(msg.text, msg.ref);
        case 'resolveReference':
          return resolveReference(msg.ref);
        case 'suggestByPrefix':
          return []; // stub — implemented in Phase 6
        case 'logStats':
          console.log('[QuranExt stats]', msg.stats);
          return { ok: true };
        case 'ping':
          return { ok: true };
        default:
          return { error: `Unknown message type: ${msg.type}` };
      }
    })
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));

  return true; // keep channel open for async sendResponse (required in MV3)
});

// Pre-load index on service worker install/activate
self.addEventListener('install', () => loadAndIndex().catch(console.error));
self.addEventListener('activate', () => loadAndIndex().catch(console.error));
