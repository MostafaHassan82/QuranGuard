'use strict';

// =============================================================================
// Quran Audit Extension — Background Service Worker (V1)
// =============================================================================
// Implements the verifier per fresh_start/06-verifier-design.md.
//
// Output shape:
//   {
//     color: 'green' | 'lightBlue' | 'yellow' | 'orange' | 'red' | null,
//     matchedRef: string | null,
//     matchedRefs: string[],
//     claimedRef: string | null,
//     authenticText: string | null,
//     deviation: 'none' | 'tashkeelOnly' | 'spellingDrift' | 'wordLevel' | null,
//     candidateConfidence: 'high' | 'medium',
//     matchType: 'exact' | 'orderedContiguous' | 'orderedGapped' | 'partial' | 'none',
//   }
//
// `color: null` means drop the candidate (no highlight).

// ── Module state ─────────────────────────────────────────────────────────────
let indexes = null;
let initPromise = null;

// ── Debug ────────────────────────────────────────────────────────────────────
// When true, the verifier prints structured logs to the service worker console.
// View at chrome://extensions → Quran Citation Verifier → "service worker"
// (or "background page") link. Each finding produces a copyable block.
const DEBUG = true;

function dlog(...args) {
  if (DEBUG) console.log('[QuranExt]', ...args);
}

// ── Surah name variants ──────────────────────────────────────────────────────
// Harvested from rebuild + augmented during fixture review.
const SURAH_VARIANTS = {
  'البقر':       2,    // البقرة
  'الحجرت':      49,   // الحجرات
  'يسين':        36,   // يس
  'الرحمان':     55,   // الرحمن
  'الانشراح':    94,   // الشرح
  'بني اسرايل':  17,   // الإسراء
  'سبا':         34,   // سبأ — ء vs ا
  'حم السجدة':   41,   // فصّلت
  'المومن':      40,   // غافر
  'غافر':        40,
  'المؤمن':      40,
};

// ── Tier-1 Normalization ─────────────────────────────────────────────────────
// The rule that determines GREEN equality. Strips diacritics, unifies
// alif/hamza/ya/ta-marbuta, collapses adjacent same-letter runs to handle
// Quranic-vs-modern spelling drift (e.g., بِٱلَّيْلِ ↔ بالليل).

function tier1Normalize(text) {
  if (!text) return '';
  let s = text;

  // Strip ALL Arabic diacritics, marks, sigla, tatweel in one pass.
  // U+0610-U+061A sallallahu signs + Quranic small fatha/damma/kasra
  // U+064B-U+065F tanween, fatha, damma, kasra, shadda, sukun, madda, hamza marks
  // U+0670 dagger alef, U+06D6-U+06ED Quranic sigla, U+0640 tatweel
  // U+08E3-U+08FF additional Quranic marks block
  s = s.replace(/[ؐ-ًؚ-ٰٟۖ-ۭـࣣ-ࣿ]/g, '');
  // (legacy strips below are now redundant but kept harmless until verified)
  s = s.replace(/[ۖ-ۭ]/g, '');

  // Strip dagger alef, superscript alef variants, combining hamza marks
  s = s.replace(/[ٰٕٓٔ]/g, '');

  // Strip tatweel
  s = s.replace(/ـ/g, '');

  // Strip all tashkeel including shadda (collapse handles the doubling)
  s = s.replace(/[ً-ٟ]/g, '');

  // Unify alif variants → ا
  s = s.replace(/[آأإٱ]/g, 'ا');

  // Uthmani decomposed آ: standalone ء immediately before ا (e.g. ءَايَة) → ا.
  // This handles the Uthmani-vs-modern split where modern writes آ as one char
  // but Uthmani writes hamza+fatha+alef as a sequence.
  s = s.replace(/ءا/g, 'ا');

  // Hamza-bearing letters → base
  s = s.replace(/ؤ/g, 'و');   // ؤ → و
  s = s.replace(/ئ/g, 'ي');   // ئ → ي

  // Alef maqsura → ya
  s = s.replace(/ى/g, 'ي');

  // Ta marbuta → ha
  s = s.replace(/ة/g, 'ه');

  // Collapse adjacent same-letter runs (Quranic-vs-modern drift)
  s = s.replace(/([ء-ي])\1+/g, '$1');

  // Whitespace normalization
  s = s.replace(/[\s ​-‏﻿]+/g, ' ').trim();

  return s;
}

// Skeleton form for Tier-3 candidate-finding only (never asserts a match).
function toSkeleton(tier1Text) {
  return tier1Text.replace(/[اويء]/g, '');
}

// Given two strings that are Tier-1 equal, classify how they differ.
function classifyDeviation(originalA, originalB) {
  if (originalA === originalB) return 'none';

  const stripMarks = s => s.replace(
    /[ً-ٰٟٓ-ٕۖ-ۭـ]/g, ''
  );
  if (stripMarks(originalA) === stripMarks(originalB)) return 'tashkeelOnly';

  return 'spellingDrift';
}

function toAsciiDigits(s) {
  return s
    .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
}

// ── Index building ───────────────────────────────────────────────────────────

function buildIndexes(quranData) {
  const byRef = {};
  const byTier1Norm = new Map();
  const wordIndex = new Map();
  const skeletonWordIndex = new Map();
  const surahNameIndex = new Map();

  // Surah name index from JSON metadata
  for (const [arName, surahNum] of Object.entries(quranData.meta.chaptersNames.chaptersNamesAr)) {
    const norm = tier1Normalize(arName);
    surahNameIndex.set(norm, surahNum);
    surahNameIndex.set(toSkeleton(norm), surahNum);
  }
  // Manual variants
  for (const [variant, surahNum] of Object.entries(SURAH_VARIANTS)) {
    const norm = tier1Normalize(variant);
    surahNameIndex.set(norm, surahNum);
    surahNameIndex.set(toSkeleton(norm), surahNum);
  }

  // Per-ayah records
  for (const sura of quranData.suras) {
    const surahNum = parseInt(sura.index, 10);
    const surahName = sura.name;
    byRef[surahNum] = byRef[surahNum] || {};

    for (const aya of sura.ayas) {
      const ayahNum = parseInt(aya.index, 10);
      const tier1 = tier1Normalize(aya.text);
      const skeleton = toSkeleton(tier1);
      const tier1Words = tier1.split(' ').filter(w => w.length > 0);
      const skelWords = skeleton.split(' ').filter(w => w.length > 0);
      const ref = `${surahName}:${ayahNum}`;

      const record = {
        text: aya.text,
        tier1,
        skeleton,
        tier1Words,
        skelWords,
        ref,
        surahName,
        surahNum,
        ayahNum,
      };

      byRef[surahNum][ayahNum] = record;

      if (!byTier1Norm.has(tier1)) byTier1Norm.set(tier1, []);
      byTier1Norm.get(tier1).push(record);

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

async function loadAndIndex() {
  const url = chrome.runtime.getURL('resources/quran-uthmani_desc-v2.json');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load Quran JSON: ${resp.status}`);
  const data = await resp.json();
  indexes = buildIndexes(data);
  console.log(
    `[QuranExt] Index ready — verses: ${indexes.byTier1Norm.size}, ` +
    `tier1 words: ${indexes.wordIndex.size}, surahs: ${Object.keys(indexes.byRef).length}`
  );
}

async function ensureInitialized() {
  if (indexes !== null) return;
  if (!initPromise) {
    initPromise = loadAndIndex().catch(err => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

// ── Reference parsing ────────────────────────────────────────────────────────

function resolveReference(refString) {
  if (!refString || !indexes) return null;

  let s = refString.replace(/^[\s({«\[﴿]+|[\s)}\»\]﴾]+$/g, '').trim();
  s = s.replace(/^(?:من\s+)?سور[ةه]\s+/u, '');

  const colonIdx = s.search(/[:：]/);
  if (colonIdx === -1) return null;

  const surahPart = s.slice(0, colonIdx).trim();
  let ayahPart = s.slice(colonIdx + 1).trim();

  ayahPart = ayahPart.replace(/^(?:الآيات|الآية)\s*/u, '');
  ayahPart = toAsciiDigits(ayahPart);

  const normSurah = tier1Normalize(surahPart);
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

// ── Search helpers ───────────────────────────────────────────────────────────

function isContiguousSubsequence(haystackWords, needleWords) {
  if (needleWords.length === 0 || needleWords.length > haystackWords.length) return false;
  for (let i = 0; i <= haystackWords.length - needleWords.length; i++) {
    let ok = true;
    for (let j = 0; j < needleWords.length; j++) {
      if (haystackWords[i + j] !== needleWords[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function isOrderedSubsequence(haystackWords, needleWords) {
  let hi = 0;
  for (const w of needleWords) {
    while (hi < haystackWords.length && haystackWords[hi] !== w) hi++;
    if (hi >= haystackWords.length) return false;
    hi++;
  }
  return true;
}

function candidatesFromWords(normWords, wordIdx) {
  if (normWords.length === 0) return new Set();
  const first = normWords[0];
  const last = normWords[normWords.length - 1];
  const setFirst = wordIdx.get(first) || new Set();
  const setLast = normWords.length > 1 ? (wordIdx.get(last) || new Set()) : setFirst;
  const result = new Set();
  for (const key of setFirst) if (setLast.has(key)) result.add(key);
  return result;
}

function parseKey(key) {
  const [s, a] = key.split(':');
  return { surahNum: parseInt(s, 10), ayahNum: parseInt(a, 10) };
}

function findExactGlobal(tier1Text) {
  return indexes.byTier1Norm.get(tier1Text) || [];
}

function findOrderedContiguousGlobal(tier1Words) {
  if (tier1Words.length < 2) return [];
  const keys = candidatesFromWords(tier1Words, indexes.wordIndex);
  const results = [];
  for (const key of keys) {
    const { surahNum, ayahNum } = parseKey(key);
    const rec = indexes.byRef[surahNum]?.[ayahNum];
    if (!rec) continue;
    if (isContiguousSubsequence(rec.tier1Words, tier1Words)) {
      results.push(rec);
    }
  }
  return results;
}

// Bounded word-edit-distance with early exit.
function wordEditDistance(a, b, maxDiffs) {
  if (Math.abs(a.length - b.length) > maxDiffs) return null;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDiffs) return null;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Word-level "close enough" comparison: candidate vs a window within an ayah.
// Allows ≤ ceil(candidate.length / 8) word diffs.
function wordLevelCompareSingleAyah(candidateWords, ayahWords) {
  const allowedDiffs = Math.max(1, Math.floor(candidateWords.length / 8));
  if (candidateWords.length === 0) return null;
  if (candidateWords.length > ayahWords.length + allowedDiffs) return null;

  const minLen = Math.max(1, candidateWords.length - allowedDiffs);
  const maxLen = Math.min(ayahWords.length, candidateWords.length + allowedDiffs);

  let best = null;
  for (let start = 0; start <= ayahWords.length - minLen; start++) {
    for (let winLen = minLen; winLen <= maxLen && start + winLen <= ayahWords.length; winLen++) {
      const win = ayahWords.slice(start, start + winLen);
      const d = wordEditDistance(candidateWords, win, allowedDiffs);
      if (d !== null && (best === null || d < best)) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

function wordLevelMatchGlobal(tier1Words) {
  if (tier1Words.length < 2) return [];
  const wordSets = tier1Words.map(w => indexes.wordIndex.get(w) || new Set());
  const keyCounts = new Map();
  for (const ws of wordSets) {
    for (const key of ws) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(tier1Words.length * 0.5));
  const results = [];
  for (const [key, count] of keyCounts) {
    if (count < threshold) continue;
    const { surahNum, ayahNum } = parseKey(key);
    const rec = indexes.byRef[surahNum]?.[ayahNum];
    if (!rec) continue;
    const diffs = wordLevelCompareSingleAyah(tier1Words, rec.tier1Words);
    if (diffs !== null) results.push({ rec, diffs });
  }
  return results;
}

// ── Reference-anchored match helpers (for Path 1) ────────────────────────────

function tier1MatchInClaimedAyahs(candidateText, candidateWords, resolved) {
  const { surahNum, ayahNums } = resolved;
  const records = ayahNums.map(n => indexes.byRef[surahNum]?.[n]).filter(Boolean);
  if (records.length === 0) return null;

  const candTier1 = tier1Normalize(candidateText);

  if (records.length === 1) {
    const rec = records[0];
    if (rec.tier1 === candTier1) {
      return { rec, displayRef: rec.ref, deviation: classifyDeviation(rec.text, candidateText) };
    }
    if (isContiguousSubsequence(rec.tier1Words, candidateWords)) {
      return { rec, displayRef: rec.ref, deviation: 'spellingDrift' };
    }
    return null;
  }

  // Multi-ayah: flat-word match across combined range
  const allWords = [];
  const wordToAyah = [];
  for (const rec of records) {
    for (const w of rec.tier1Words) {
      allWords.push(w);
      wordToAyah.push(rec.ayahNum);
    }
  }

  let matchStart = -1;
  outer: for (let i = 0; i <= allWords.length - candidateWords.length; i++) {
    if (allWords[i] !== candidateWords[0]) continue;
    for (let j = 1; j < candidateWords.length; j++) {
      if (allWords[i + j] !== candidateWords[j]) continue outer;
    }
    matchStart = i;
    break;
  }
  if (matchStart === -1) return null;

  const matchEnd = matchStart + candidateWords.length - 1;
  const firstAyah = wordToAyah[matchStart];
  const lastAyah = wordToAyah[matchEnd];
  const surahName = records[0].surahName;
  const displayRef = firstAyah === lastAyah
    ? `${surahName}:${firstAyah}`
    : `${surahName}:${firstAyah}-${lastAyah}`;
  const anchorRec = records.find(r => r.ayahNum === firstAyah) || records[0];
  return { rec: anchorRec, displayRef, deviation: 'spellingDrift' };
}

function wordLevelMatchInClaimedAyahs(candidateWords, resolved) {
  const { surahNum, ayahNums } = resolved;
  const records = ayahNums.map(n => indexes.byRef[surahNum]?.[n]).filter(Boolean);
  let best = null;
  for (const rec of records) {
    const diffs = wordLevelCompareSingleAyah(candidateWords, rec.tier1Words);
    if (diffs !== null && (best === null || diffs < best.diffs)) {
      best = { rec, diffs };
    }
  }
  return best;
}

// ── Result builder ───────────────────────────────────────────────────────────

function makeResult(o) {
  return {
    color: o.color ?? null,
    matchedRef: o.matchedRef ?? null,
    matchedRefs: o.matchedRefs ?? [],
    claimedRef: o.claimedRef ?? null,
    authenticText: o.authenticText ?? null,
    deviation: o.deviation ?? null,
    candidateConfidence: o.candidateConfidence ?? 'medium',
    matchType: o.matchType ?? 'none',
  };
}

// ── Verifier — Path 2 (no claimed ref) ───────────────────────────────────────

function verifyFragment(candidateText, candidateConfidence = 'medium') {
  if (!candidateText) {
    return makeResult({ color: null, candidateConfidence });
  }
  const tier1 = tier1Normalize(candidateText.replace(/\*/g, ' '));
  const words = tier1.split(' ').filter(w => w.length > 0);

  dlog('verifyFragment ─────────────────────────────');
  dlog('  raw text  :', JSON.stringify(candidateText));
  dlog('  tier1     :', JSON.stringify(tier1));
  dlog('  words     :', JSON.stringify(words));
  dlog('  confidence:', candidateConfidence);

  if (words.length === 0) {
    dlog('  → null (no words)');
    return makeResult({ color: null, candidateConfidence });
  }

  // Tier-1 exact (full-ayah equality)
  const exactRecs = findExactGlobal(tier1);
  if (exactRecs.length > 0) {
    const sorted = exactRecs.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
    dlog('  → lightBlue (exact full ayah):', sorted.map(r => r.ref).join(', '));
    return makeResult({
      color: 'lightBlue',
      matchedRef: sorted[0].ref,
      matchedRefs: sorted.map(r => r.ref),
      authenticText: sorted[0].text,
      deviation: classifyDeviation(sorted[0].text, candidateText),
      candidateConfidence,
      matchType: 'exact',
    });
  }

  // Tier-1 contiguous within an ayah
  const orderedRecs = findOrderedContiguousGlobal(words);
  if (orderedRecs.length > 0) {
    const sorted = orderedRecs.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
    dlog('  → lightBlue (contiguous within ayah):', sorted.map(r => r.ref).join(', '));
    return makeResult({
      color: 'lightBlue',
      matchedRef: sorted[0].ref,
      matchedRefs: sorted.map(r => r.ref),
      authenticText: sorted[0].text,
      deviation: 'spellingDrift',
      candidateConfidence,
      matchType: 'orderedContiguous',
    });
  }

  // Word-level fallback → yellow
  const wlRecs = wordLevelMatchGlobal(words);
  if (wlRecs.length > 0) {
    const sorted = wlRecs.slice().sort((a, b) => a.diffs - b.diffs || a.rec.surahNum - b.rec.surahNum);
    dlog('  → yellow (word-level global):', sorted[0].rec.ref, 'diffs=' + sorted[0].diffs);
    return makeResult({
      color: 'yellow',
      matchedRef: sorted[0].rec.ref,
      matchedRefs: sorted.slice(0, 3).map(r => r.rec.ref),
      authenticText: sorted[0].rec.text,
      deviation: 'wordLevel',
      candidateConfidence,
      matchType: 'partial',
    });
  }

  // No match: red only if high confidence
  if (candidateConfidence === 'high') {
    dlog('  → red (no match, high confidence)');
    return makeResult({ color: 'red', candidateConfidence, matchType: 'none' });
  }
  dlog('  → null (no match, medium confidence — dropped)');
  return makeResult({ color: null, candidateConfidence, matchType: 'none' });
}

// ── Verifier — Path 1 (with claimed ref, includes orange) ────────────────────

function verifyFragmentByRef(candidateText, refString, candidateConfidence = 'medium') {
  if (!candidateText) {
    return makeResult({ color: null, candidateConfidence, claimedRef: refString });
  }

  const resolved = resolveReference(refString);
  const tier1 = tier1Normalize(candidateText.replace(/\*/g, ' '));
  const words = tier1.split(' ').filter(w => w.length > 0);

  dlog('verifyFragmentByRef ─────────────────────────');
  dlog('  raw text  :', JSON.stringify(candidateText));
  dlog('  raw ref   :', JSON.stringify(refString));
  dlog('  tier1     :', JSON.stringify(tier1));
  dlog('  words     :', JSON.stringify(words));
  dlog('  resolved  :', resolved);
  dlog('  confidence:', candidateConfidence);
  if (resolved) {
    const claimedAyahs = resolved.ayahNums
      .map(n => indexes.byRef[resolved.surahNum]?.[n])
      .filter(Boolean);
    for (const a of claimedAyahs) {
      dlog('  claimed ayah ' + a.ref + ' tier1:', JSON.stringify(a.tier1));
      dlog('  claimed ayah ' + a.ref + ' words:', JSON.stringify(a.tier1Words));
    }
  }

  if (words.length === 0) {
    dlog('  → null (no words)');
    return makeResult({ color: null, candidateConfidence, claimedRef: refString });
  }

  if (!resolved) {
    dlog('  ref unresolved — falling back to verifyFragment');
    return verifyFragment(candidateText, candidateConfidence);
  }

  // Tier-1 against claimed ayahs → GREEN
  const tier1InClaimed = tier1MatchInClaimedAyahs(candidateText, words, resolved);
  if (tier1InClaimed) {
    dlog('  → green (tier1 in claimed):', tier1InClaimed.displayRef, 'deviation=' + tier1InClaimed.deviation);
    return makeResult({
      color: 'green',
      matchedRef: tier1InClaimed.displayRef,
      claimedRef: refString,
      authenticText: tier1InClaimed.rec.text,
      deviation: tier1InClaimed.deviation,
      candidateConfidence,
      matchType: 'exact',
    });
  }

  // Word-level against claimed ayahs → YELLOW (citation was for this ref, wording drifted)
  const wlInClaimed = wordLevelMatchInClaimedAyahs(words, resolved);
  if (wlInClaimed) {
    dlog('  → yellow (word-level in claimed):', wlInClaimed.rec.ref, 'diffs=' + wlInClaimed.diffs);
    return makeResult({
      color: 'yellow',
      matchedRef: wlInClaimed.rec.ref,
      claimedRef: refString,
      authenticText: wlInClaimed.rec.text,
      deviation: 'wordLevel',
      candidateConfidence,
      matchType: 'partial',
    });
  }

  // ORANGE: text exists in Quran exactly but at a DIFFERENT ref than claimed.
  // Requires high candidate confidence (per design decision).
  if (candidateConfidence === 'high') {
    const claimedKeys = new Set(resolved.ayahNums.map(n => `${resolved.surahNum}:${n}`));

    let globalRecs = findExactGlobal(tier1);
    if (globalRecs.length === 0) globalRecs = findOrderedContiguousGlobal(words);

    const elsewhere = globalRecs.filter(r => !claimedKeys.has(`${r.surahNum}:${r.ayahNum}`));
    if (elsewhere.length > 0) {
      const sorted = elsewhere.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
      dlog('  → orange (text matches elsewhere):', sorted.map(r => r.ref).join(', '));
      return makeResult({
        color: 'orange',
        matchedRef: sorted[0].ref,
        matchedRefs: sorted.map(r => r.ref),
        claimedRef: refString,
        authenticText: sorted[0].text,
        deviation: 'none',
        candidateConfidence,
        matchType: 'exact',
      });
    }
  }

  // Word-level global → YELLOW with ref-mismatch annotation
  const wlGlobal = wordLevelMatchGlobal(words);
  if (wlGlobal.length > 0) {
    const sorted = wlGlobal.slice().sort((a, b) => a.diffs - b.diffs || a.rec.surahNum - b.rec.surahNum);
    dlog('  → yellow (word-level global):', sorted[0].rec.ref, 'diffs=' + sorted[0].diffs);
    return makeResult({
      color: 'yellow',
      matchedRef: sorted[0].rec.ref,
      matchedRefs: sorted.slice(0, 3).map(r => r.rec.ref),
      claimedRef: refString,
      authenticText: sorted[0].rec.text,
      deviation: 'wordLevel',
      candidateConfidence,
      matchType: 'partial',
    });
  }

  // Nothing anywhere → RED (requires high confidence)
  if (candidateConfidence === 'high') {
    dlog('  → red (no match anywhere, high confidence)');
    return makeResult({ color: 'red', claimedRef: refString, candidateConfidence, matchType: 'none' });
  }
  dlog('  → null (no match, medium confidence — dropped)');
  return makeResult({ color: null, claimedRef: refString, candidateConfidence, matchType: 'none' });
}

// ── Convenience ──────────────────────────────────────────────────────────────

function getAyahText(surahNum, ayahNum) {
  const rec = indexes.byRef[surahNum]?.[ayahNum];
  if (!rec) return null;
  return { text: rec.text, ref: rec.ref };
}

// ── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ensureInitialized()
    .then(() => {
      switch (msg.type) {
        case 'verifyFragment':
          return verifyFragment(msg.text, msg.candidateConfidence);
        case 'verifyFragmentByRef':
          return verifyFragmentByRef(msg.text, msg.ref, msg.candidateConfidence);
        case 'resolveReference': {
          const r = resolveReference(msg.ref);
          if (!r) return null;
          const ayahs = r.ayahNums.map(n => indexes.byRef[r.surahNum]?.[n]).filter(Boolean);
          return {
            surahNum: r.surahNum,
            surahName: ayahs[0]?.surahName,
            ayahNums: r.ayahNums,
            ayahTexts: ayahs.map(a => a.text),
            displayLabel: r.ayahNums.length === 1
              ? `${ayahs[0]?.surahName}:${r.ayahNums[0]}`
              : `${ayahs[0]?.surahName}:${r.ayahNums[0]}-${r.ayahNums[r.ayahNums.length - 1]}`,
          };
        }
        case 'getAyahText':
          return getAyahText(msg.surahNum, msg.ayahNum);
        case 'ping':
          return { ok: true, indexReady: indexes !== null };
        case 'logFindings': {
          const findings = msg.findings || [];
          console.log(`[QuranExt findings] ${findings.length} total ─────────────`);
          for (const f of findings) {
            // Copy-friendly per-finding block. Stays on screen so it can be
            // selected and copied as plain text.
            console.log(
              `─ #${f.id} [${f.color}]\n` +
              `  text       : ${f.text}\n` +
              `  claimedRef : ${f.claimedRef ?? '(none)'}\n` +
              `  matchedRef : ${f.matchedRef ?? '(none)'}\n` +
              (f.matchedRefs && f.matchedRefs.length > 1
                ? `  matchedRefs: ${f.matchedRefs.join(' • ')}\n` : '') +
              `  deviation  : ${f.deviation ?? '(none)'}\n` +
              `  confidence : ${f.confidence}\n` +
              `  strategy   : ${f.strategy}\n` +
              (f.authenticText
                ? `  authentic  : ${f.authenticText}\n` : '')
            );
          }
          return { ok: true };
        }
        default:
          return { error: `Unknown message type: ${msg.type}` };
      }
    })
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));

  return true;
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener('install', () => {
  loadAndIndex().catch(err => console.error('[QuranExt] install index load failed:', err));
});

self.addEventListener('activate', () => {
  loadAndIndex().catch(err => console.error('[QuranExt] activate index load failed:', err));
});
