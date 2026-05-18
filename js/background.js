'use strict';

// T006/T015/T027 — Load shared modules before any other code runs.
// Paths are relative to this file's URL (chrome-extension://<id>/js/background.js),
// so they resolve inside the js/ directory — no 'js/' prefix needed.
importScripts(
  'shared/messaging.js',      // QuranMsg
  'verifier/normalize.js',    // QuranNormalize
  'verifier/indexes.js',      // QuranIndexes
  'verifier/references.js',   // QuranReferences
  'verifier/classify.js',     // QuranClassify (T030)
  'verifier/orange.js',       // QuranOrange  (T031)
  'storage/prefs.js',         // QuranPrefs
  'storage/persisted.js',     // QuranPersisted
  'badge/badge.js'            // QuranBadge
);

// ── Module state ─────────────────────────────────────────────────────────────
let indexes = null;
let initPromise = null;
let dataState = 'pending'; // 'pending' | 'ready' | 'unavailable'
let dataError = null;      // {reason, detail} when dataState === 'unavailable'

const DEBUG = true;
function dlog(...args) { if (DEBUG) console.log('[QuranExt]', ...args); }

// ── Index build helpers (using extracted modules) ─────────────────────────────

const { tier1: tier1Normalize, toSkeleton, classifyDeviation, toAsciiDigits } = QuranNormalize;

// ── Schema validation (T011) ──────────────────────────────────────────────────

function validateQuranSchema(data) {
  if (!data || typeof data !== 'object') return 'missing';
  if (!Array.isArray(data.suras) || data.suras.length === 0) return 'schemaFailure';
  if (!data.meta?.chaptersNames?.chaptersNamesAr) return 'schemaFailure';
  const firstSura = data.suras[0];
  if (!firstSura.index || !firstSura.name || !Array.isArray(firstSura.ayas)) return 'schemaFailure';
  if (!firstSura.ayas[0]?.text || !firstSura.ayas[0]?.index) return 'schemaFailure';
  return null; // valid
}

async function broadcastToContent(type, payload) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type, requestId: crypto.randomUUID(), payload })
        .catch(() => {}); // tab may have no content script
    }
  } catch (_) {}
}

// ── Data loading (T011 fail-loud + T015 wire indexes) ────────────────────────

async function loadAndIndex() {
  const url = chrome.runtime.getURL('resources/quran-uthmani_desc-v2.json');
  let data;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw { reason: 'unreadable', detail: `HTTP ${resp.status}` };
    data = await resp.json();
  } catch (e) {
    const err = { reason: e.reason || 'unreadable', detail: e.detail || String(e) };
    dataState = 'unavailable';
    dataError = err;
    broadcastToContent('DATA_UNAVAILABLE', err);
    chrome.runtime.sendMessage({ type: 'DATA_UNAVAILABLE', requestId: crypto.randomUUID(), payload: err }).catch(() => {});
    throw err;
  }

  const schemaErr = validateQuranSchema(data);
  if (schemaErr) {
    const err = { reason: 'schemaFailure', detail: `Schema validation failed: ${schemaErr}` };
    dataState = 'unavailable';
    dataError = err;
    broadcastToContent('DATA_UNAVAILABLE', err);
    chrome.runtime.sendMessage({ type: 'DATA_UNAVAILABLE', requestId: crypto.randomUUID(), payload: err }).catch(() => {});
    throw err;
  }

  indexes = QuranIndexes.build(data);
  dataState = 'ready';
  dataError = null;
  console.log(
    `[QuranExt] Index ready — verses: ${indexes.byTier1Norm.size}, ` +
    `tier1 words: ${indexes.wordIndex.size}, surahs: ${Object.keys(indexes.byRef).length}`
  );
}

async function ensureInitialized() {
  if (dataState === 'ready') return;
  if (dataState === 'unavailable') throw new Error(dataError?.detail || 'Data unavailable');
  if (!initPromise) {
    initPromise = loadAndIndex().catch(err => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

// ── Search helpers ────────────────────────────────────────────────────────────

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

// Tolerates a 1- or 2-letter (ا و ي ء) insertion/deletion between two tier-1
// words. Each tolerated letter must be a drift-set member; that keeps the
// relaxation tight (a 4-letter word can't match an unrelated 5-letter word
// just because their consonant skeletons happen to align).
//
// Absorbs Uthmani-vs-standard drift:
//   ٰ→ا adds alef     (كذالك vs كذلك)
//   Uthmani الربوا vs standard الربا adds waw
//   Uthmani ىٰ → tier1 "يا"; modern equivalent is plain ا (e.g. أَنجَىٰكُم → "انجياكم"
//     vs modern "انجاكم"), leaving exactly one extra ي to tolerate.
//   Quranic U+0654 (HAMZA ABOVE, a diacritic) is stripped by tier1, so words
//     like خَٰسِـِٔينَ → "خاسين"; the modern citation خاسئين preserves the hamza as
//     a letter ئ → "خاسءين", leaving exactly one extra ء to tolerate.
//   Two-letter cases:
//     Imperative drift: Uthmani وَسْـَٔلِ → "وسل" vs modern واسأل → "واسال"
//       (disjoining alef + bare-vs-diacritic hamza, both removed from longer).
//     Leading-و + ٰ→ا on the same word: Uthmani وَكَذَٰلِكَ → "وكذالك" vs cited
//       كذلك → "كذلك" (citation drops the conjunction and the dagger-alef).
function softEqualWord(a, b) {
  if (a === b) return true;
  const diff = Math.abs(a.length - b.length);
  if (diff < 1 || diff > 2) return false;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  const isDrift = c => c === 'ا' || c === 'و' || c === 'ي' || c === 'ء';

  if (diff === 1) {
    for (let i = 0; i < longer.length; i++) {
      if (!isDrift(longer[i])) continue;
      if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return true;
    }
    return false;
  }

  // diff === 2: try removing two drift letters from longer
  for (let i = 0; i < longer.length; i++) {
    if (!isDrift(longer[i])) continue;
    const after1 = longer.slice(0, i) + longer.slice(i + 1);
    for (let j = 0; j < after1.length; j++) {
      if (!isDrift(after1[j])) continue;
      if (after1.slice(0, j) + after1.slice(j + 1) === shorter) return true;
    }
  }
  return false;
}

function isContiguousSoftSubsequence(haystackWords, needleWords) {
  if (needleWords.length === 0 || needleWords.length > haystackWords.length) return false;
  for (let i = 0; i <= haystackWords.length - needleWords.length; i++) {
    let ok = true;
    for (let j = 0; j < needleWords.length; j++) {
      if (!softEqualWord(haystackWords[i + j], needleWords[j])) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
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

function findExactGlobal(t1Text) {
  return indexes.byTier1Norm.get(t1Text) || [];
}

function findOrderedContiguousGlobal(t1Words) {
  if (t1Words.length < 2) return [];
  const keys = candidatesFromWords(t1Words, indexes.wordIndex);
  const results = [];
  for (const key of keys) {
    const { surahNum, ayahNum } = parseKey(key);
    const rec = indexes.byRef[surahNum]?.[ayahNum];
    if (!rec) continue;
    if (isContiguousSubsequence(rec.tier1Words, t1Words)) results.push(rec);
  }
  return results;
}

function sortRecs(recs) {
  return recs.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
}

// Word index lookup that also tries one-alef/waw insertion variants.
// Needed because Uthmani tier1 stores كذالك but page text supplies كذلك.
function softWordIndexLookup(word, wordIdx) {
  const exact = wordIdx.get(word);
  if (exact && exact.size > 0) return exact;
  const combined = new Set();
  // Try inserting ا, و, ي, or ء at each position (mirrors softEqualWord tolerance)
  for (let i = 0; i <= word.length; i++) {
    for (const c of ['ا', 'و', 'ي', 'ء']) {
      const v = word.slice(0, i) + c + word.slice(i);
      const s = wordIdx.get(v);
      if (s) for (const k of s) combined.add(k);
    }
  }
  // Try deleting one ا, و, ي, or ء
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === 'ا' || ch === 'و' || ch === 'ي' || ch === 'ء') {
      const v = word.slice(0, i) + word.slice(i + 1);
      const s = wordIdx.get(v);
      if (s) for (const k of s) combined.add(k);
    }
  }
  return combined;
}

// Like findOrderedContiguousGlobal but uses soft word lookup + soft subsequence check.
function findOrderedContiguousSoftGlobal(t1Words) {
  if (t1Words.length < 2) return [];
  const first = softWordIndexLookup(t1Words[0], indexes.wordIndex);
  const last = softWordIndexLookup(t1Words[t1Words.length - 1], indexes.wordIndex);
  const candidates = new Set();
  for (const k of first) if (last.has(k)) candidates.add(k);
  const results = [];
  for (const key of candidates) {
    const { surahNum, ayahNum } = parseKey(key);
    const rec = indexes.byRef[surahNum]?.[ayahNum];
    if (!rec) continue;
    if (isContiguousSoftSubsequence(rec.tier1Words, t1Words)) results.push(rec);
  }
  return results;
}

// Returns all Quran locations where the candidate text occurs, exact and partial.
// Used to populate allExactRefs / allPartialRefs in the result for tooltip display.
function findAllGlobalMatches(t1, words) {
  const exactFull = findExactGlobal(t1);
  const exactSeq = findOrderedContiguousSoftGlobal(words);
  const seen = new Set(exactFull.map(r => r.ref));
  for (const r of exactSeq) if (!seen.has(r.ref)) { seen.add(r.ref); exactFull.push(r); }
  const allExactRefs = sortRecs(exactFull).map(r => r.ref);

  // Partial: soft candidates + looser allowedDiffs (ceil(n/4)) for informational display.
  const exactSet = new Set(allExactRefs);
  const softFirst = softWordIndexLookup(words[0], indexes.wordIndex);
  const softLast = softWordIndexLookup(words[words.length - 1], indexes.wordIndex);
  const softCands = new Set();
  for (const k of softFirst) if (softLast.has(k)) softCands.add(k);
  const looseDiffs = Math.max(2, Math.ceil(words.length / 4));
  const partialRecs = [];
  for (const key of softCands) {
    const { surahNum, ayahNum } = parseKey(key);
    const rec = indexes.byRef[surahNum]?.[ayahNum];
    if (!rec || exactSet.has(rec.ref)) continue;
    const diffs = wordLevelCompareSingleAyahLoose(words, rec.tier1Words, looseDiffs);
    if (diffs !== null && diffs > 0) partialRecs.push(rec);
  }
  const allPartialRefs = sortRecs(partialRecs).map(r => r.ref);

  return { allExactRefs, allPartialRefs };
}

// wordEq: use softEqualWord so كذلك ≡ كذالك costs 0 (common alef omission in Arabic writing).
function wordEditDistance(a, b, maxDiffs) {
  if (Math.abs(a.length - b.length) > maxDiffs) return null;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1), curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = softEqualWord(a[i - 1], b[j - 1]) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDiffs) return null;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

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

// Like wordLevelCompareSingleAyah but with a caller-supplied allowedDiffs.
// Used by findAllGlobalMatches for informational partial detection.
function wordLevelCompareSingleAyahLoose(candidateWords, ayahWords, allowedDiffs) {
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

function wordLevelMatchGlobal(t1Words) {
  if (t1Words.length < 2) return [];
  const wordSets = t1Words.map(w => indexes.wordIndex.get(w) || new Set());
  const keyCounts = new Map();
  for (const ws of wordSets) for (const key of ws) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  const threshold = Math.max(2, Math.ceil(t1Words.length * 0.5));
  const results = [];
  for (const [key, count] of keyCounts) {
    if (count < threshold) continue;
    const { surahNum, ayahNum } = parseKey(key);
    const rec = indexes.byRef[surahNum]?.[ayahNum];
    if (!rec) continue;
    const diffs = wordLevelCompareSingleAyah(t1Words, rec.tier1Words);
    if (diffs !== null) results.push({ rec, diffs });
  }
  return results;
}

// ── Reference-anchored match helpers ─────────────────────────────────────────

function tier1MatchInClaimedAyahs(candidateText, candidateWords, resolved, tr = null) {
  const { surahNum, ayahNums } = resolved;
  const records = ayahNums.map(n => indexes.byRef[surahNum]?.[n]).filter(Boolean);
  if (records.length === 0) { if (tr) tr(`  match: no records for surah=${surahNum} ayahs=[${ayahNums.join(',')}]`); return null; }
  const candT1 = tier1Normalize(candidateText);

  if (records.length === 1) {
    const rec = records[0];
    if (rec.tier1 === candT1) return { rec, displayRef: rec.ref, deviation: classifyDeviation(rec.text, candidateText) };
    if (isContiguousSoftSubsequence(rec.tier1Words, candidateWords)) return { rec, displayRef: rec.ref, deviation: 'spellingDrift' };
    if (tr) {
      tr(`  match[single]: verse=${rec.ref} verseWords=${rec.tier1Words.length} candWords=${candidateWords.length}`);
      tr(`    verse-t1: ${JSON.stringify(rec.tier1.length > 160 ? rec.tier1.slice(0,157)+'...' : rec.tier1)}`);
    }
    return null;
  }

  // Multi-ayah: flat-word match across combined range
  const allWords = [], wordToAyah = [];
  for (const rec of records) {
    for (const w of rec.tier1Words) { allWords.push(w); wordToAyah.push(rec.ayahNum); }
  }
  let matchStart = -1;
  let bestPrefix = { i: -1, j: -1 }; // for trace: longest prefix that matched before failing
  outer: for (let i = 0; i <= allWords.length - candidateWords.length; i++) {
    if (!softEqualWord(allWords[i], candidateWords[0])) continue;
    for (let j = 1; j < candidateWords.length; j++) {
      if (!softEqualWord(allWords[i + j], candidateWords[j])) {
        if (j > bestPrefix.j) bestPrefix = { i, j };
        continue outer;
      }
    }
    matchStart = i;
    break;
  }
  if (matchStart === -1) {
    if (tr) {
      tr(`  match[multi]: NO alignment (verseWords=${allWords.length} candWords=${candidateWords.length})`);
      if (bestPrefix.j > 0) {
        const i = bestPrefix.i, j = bestPrefix.j;
        tr(`    bestPrefix: matched ${j} words at start=${i}, failed at j=${j}`);
        tr(`    verse[${i+j}]=${JSON.stringify(allWords[i+j])} vs cand[${j}]=${JSON.stringify(candidateWords[j])}`);
      } else {
        tr(`    first-word never matched. cand[0]=${JSON.stringify(candidateWords[0])} cand[last]=${JSON.stringify(candidateWords[candidateWords.length-1])}`);
      }
    }
    return null;
  }
  const matchEnd = matchStart + candidateWords.length - 1;
  const firstAyah = wordToAyah[matchStart], lastAyah = wordToAyah[matchEnd];
  const surahName = records[0].surahName;
  const displayRef = firstAyah === lastAyah ? `${surahName}:${firstAyah}` : `${surahName}:${firstAyah}-${lastAyah}`;
  const anchorRec = records.find(r => r.ayahNum === firstAyah) || records[0];
  return { rec: anchorRec, displayRef, deviation: 'spellingDrift' };
}

function wordLevelMatchInClaimedAyahs(candidateWords, resolved) {
  const { surahNum, ayahNums } = resolved;
  const records = ayahNums.map(n => indexes.byRef[surahNum]?.[n]).filter(Boolean);
  let best = null;
  for (const rec of records) {
    const diffs = wordLevelCompareSingleAyah(candidateWords, rec.tier1Words);
    if (diffs !== null && (best === null || diffs < best.diffs)) best = { rec, diffs };
  }
  return best;
}

// ── Result builder (T030) ─────────────────────────────────────────────────────
// QuranClassify owns the 5-category contract and the result shape, plus
// FR-015/017/018 guard rails. Aliased here so the verifier reads naturally.
const { makeResult } = QuranClassify;

// ── Verifier — Path 2 (no claimed ref) ───────────────────────────────────────

function verifyFragment(candidateText, candidateConfidence = 'medium') {
  if (!candidateText) return makeResult({ color: null, candidateConfidence });
  const t1 = tier1Normalize(candidateText.replace(/\*/g, ' '));
  const words = t1.split(' ').filter(w => w.length > 0);
  if (words.length === 0) return makeResult({ color: null, candidateConfidence });

  const exactRecs = findExactGlobal(t1);
  if (exactRecs.length > 0) {
    const sorted = exactRecs.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
    return makeResult({ color: 'lightBlue', matchedRef: sorted[0].ref, matchedRefs: sorted.map(r => r.ref), authenticText: sorted[0].text, deviation: classifyDeviation(sorted[0].text, candidateText), candidateConfidence, matchType: 'exact' });
  }

  // Strict first (matchedRef is the cleaner spelling); fall back to soft (handles
  // ولكن vs ولاكن — Quran's superscript alef expands to an extra ا that strict
  // equality rejects but softEqualWord tolerates).
  let orderedRecs = findOrderedContiguousGlobal(words);
  if (orderedRecs.length === 0) orderedRecs = findOrderedContiguousSoftGlobal(words);
  if (orderedRecs.length > 0) {
    const sorted = orderedRecs.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
    return makeResult({ color: 'lightBlue', matchedRef: sorted[0].ref, matchedRefs: sorted.map(r => r.ref), authenticText: sorted[0].text, deviation: 'spellingDrift', candidateConfidence, matchType: 'orderedContiguous' });
  }

  const wlRecs = wordLevelMatchGlobal(words);
  if (wlRecs.length > 0) {
    const sorted = wlRecs.slice().sort((a, b) => a.diffs - b.diffs || a.rec.surahNum - b.rec.surahNum);
    return makeResult({ color: 'yellow', matchedRef: sorted[0].rec.ref, matchedRefs: sorted.slice(0, 3).map(r => r.rec.ref), authenticText: sorted[0].rec.text, deviation: 'wordLevel', candidateConfidence, matchType: 'partial' });
  }

  if (candidateConfidence === 'high') return makeResult({ color: 'red', candidateConfidence, matchType: 'none' });
  return makeResult({ color: null, candidateConfidence, matchType: 'none' });
}

// ── Verifier — Path 1 (with claimed ref, includes orange) ────────────────────

// When the verifier confirms a green/yellow match against the user's claimed ref,
// the user's spelling of the surah name (e.g. إبراهيم with hamza) is more familiar
// than the JSON's metadata spelling (e.g. ابراهيم bare alef). Use the claimed
// spelling for display when both refer to the same surah after tier1 normalization.
function preferClaimedSpelling(matchedRef, claimedRef) {
  if (!matchedRef || !claimedRef) return matchedRef;
  const cleanClaim = claimedRef.replace(/^[\s({«\[﴿]+|[\s.,;)}\»\]﴾]+$/g, '').trim()
    .replace(/^(?:من\s+)?سور[ةه]\s+/u, '');
  const colonClaim = cleanClaim.search(/[:：]/);
  if (colonClaim === -1) return matchedRef;
  const claimSurah = cleanClaim.slice(0, colonClaim).trim();
  const claimAyah = cleanClaim.slice(colonClaim + 1).trim();
  const colonMatch = matchedRef.search(/[:：]/);
  if (colonMatch === -1) return matchedRef;
  const matchSurah = matchedRef.slice(0, colonMatch).trim();
  const matchAyah = matchedRef.slice(colonMatch + 1).trim();
  if (tier1Normalize(claimSurah) === tier1Normalize(matchSurah)) {
    return `${claimSurah}:${matchAyah}`;
  }
  return matchedRef;
}

function verifyFragmentByRef(candidateText, refString, candidateConfidence = 'medium', debug = false) {
  const trace = debug ? [] : null;
  const tr = (s) => { if (trace) trace.push(s); };
  const wrap = (r) => trace ? Object.assign(r, { _trace: trace }) : r;

  if (!candidateText) return wrap(makeResult({ color: null, candidateConfidence, claimedRef: refString }));
  const resolved = QuranReferences.resolve(refString, indexes);
  const t1 = tier1Normalize(candidateText.replace(/\*/g, ' '));
  const words = t1.split(' ').filter(w => w.length > 0);
  tr(`input: ref=${JSON.stringify(refString)} candLen=${candidateText.length} t1Words=${words.length}`);
  tr(`cand-t1: ${JSON.stringify(t1.length > 200 ? t1.slice(0, 197) + '...' : t1)}`);
  if (resolved) tr(`resolved: surahNum=${resolved.surahNum} ayahs=[${resolved.ayahNums.join(',')}] isRange=${!!resolved.isRange}`);
  else tr(`resolved: NULL (ref didn't parse) — falling back to verifyFragment`);
  if (words.length === 0) return wrap(makeResult({ color: null, candidateConfidence, claimedRef: refString }));
  if (!resolved) return verifyFragment(candidateText, candidateConfidence);

  const t1InClaimed = tier1MatchInClaimedAyahs(candidateText, words, resolved, tr);
  if (t1InClaimed) {
    tr(`tier1MatchInClaimed: HIT (${t1InClaimed.displayRef}, deviation=${t1InClaimed.deviation}) → green`);
    const { allExactRefs, allPartialRefs } = findAllGlobalMatches(t1, words);
    return wrap(makeResult({ color: 'green', matchedRef: preferClaimedSpelling(t1InClaimed.displayRef, refString), claimedRef: refString, authenticText: t1InClaimed.rec.text, deviation: t1InClaimed.deviation, candidateConfidence, matchType: 'exact', allExactRefs, allPartialRefs }));
  }
  tr(`tier1MatchInClaimed: MISS`);

  // Range-fallback: {Surah:a،b} where author meant the range a..b (، used as a hyphen).
  // Only retried when discrete-parse failed and references.js suggested a small-gap expansion.
  if (resolved.rangeAyahNums) {
    const rangeResolved = { surahNum: resolved.surahNum, ayahNums: resolved.rangeAyahNums, isRange: true };
    const t1InRange = tier1MatchInClaimedAyahs(candidateText, words, rangeResolved, tr);
    if (t1InRange) {
      tr(`tier1MatchInRange: HIT → green`);
      const { allExactRefs, allPartialRefs } = findAllGlobalMatches(t1, words);
      return wrap(makeResult({ color: 'green', matchedRef: preferClaimedSpelling(t1InRange.displayRef, refString), claimedRef: refString, authenticText: t1InRange.rec.text, deviation: t1InRange.deviation, candidateConfidence, matchType: 'exact', allExactRefs, allPartialRefs }));
    }
  }

  const wlInClaimed = wordLevelMatchInClaimedAyahs(words, resolved);
  if (wlInClaimed) { tr(`wordLevelInClaimed: HIT (${wlInClaimed.rec.ref}, diffs=${wlInClaimed.diffs}) → yellow`); return wrap(makeResult({ color: 'yellow', matchedRef: preferClaimedSpelling(wlInClaimed.rec.ref, refString), claimedRef: refString, authenticText: wlInClaimed.rec.text, deviation: 'wordLevel', candidateConfidence, matchType: 'partial' })); }
  tr(`wordLevelInClaimed: MISS`);

  if (resolved.rangeAyahNums) {
    const rangeResolved = { surahNum: resolved.surahNum, ayahNums: resolved.rangeAyahNums, isRange: true };
    const wlInRange = wordLevelMatchInClaimedAyahs(words, rangeResolved);
    if (wlInRange) { tr(`wordLevelInRange: HIT → yellow`); return wrap(makeResult({ color: 'yellow', matchedRef: wlInRange.rec.ref, claimedRef: refString, authenticText: wlInRange.rec.text, deviation: 'wordLevel', candidateConfidence, matchType: 'partial' })); }
  }

  // Orange (FR-004, FR-016): text IS Quran but at a different ref than claimed.
  // QuranOrange owns the decision; we provide the search helpers it needs.
  const orangeHits = QuranOrange.classify(t1, words, resolved, candidateConfidence, {
    findExactGlobal,
    findOrderedContiguousGlobal,
  });
  if (orangeHits) {
    tr(`orange: HIT (${orangeHits.length} refs, first=${orangeHits[0].ref}) → orange`);
    return wrap(makeResult({
      color: 'orange',
      matchedRef: orangeHits[0].ref,
      matchedRefs: orangeHits.map(r => r.ref),
      claimedRef: refString,
      authenticText: orangeHits[0].text,
      deviation: 'none',
      candidateConfidence,
      matchType: 'exact',
    }));
  }
  tr(`orange: MISS`);

  const wlGlobal = wordLevelMatchGlobal(words);
  if (wlGlobal.length > 0) {
    const sorted = wlGlobal.slice().sort((a, b) => a.diffs - b.diffs || a.rec.surahNum - b.rec.surahNum);
    tr(`wordLevelGlobal: HIT (${wlGlobal.length} verses, best=${sorted[0].rec.ref} diffs=${sorted[0].diffs}) → yellow`);
    return wrap(makeResult({ color: 'yellow', matchedRef: sorted[0].rec.ref, matchedRefs: sorted.slice(0, 3).map(r => r.rec.ref), claimedRef: refString, authenticText: sorted[0].rec.text, deviation: 'wordLevel', candidateConfidence, matchType: 'partial' }));
  }
  tr(`wordLevelGlobal: MISS`);

  if (candidateConfidence === 'high') { tr(`fallthrough: high-confidence → red`); return wrap(makeResult({ color: 'red', claimedRef: refString, candidateConfidence, matchType: 'none' })); }
  tr(`fallthrough: low-confidence → silent drop`);
  return wrap(makeResult({ color: null, claimedRef: refString, candidateConfidence, matchType: 'none' }));
}

// ── Convenience ───────────────────────────────────────────────────────────────

function getAyahText(surahNum, ayahNum) {
  const rec = indexes.byRef[surahNum]?.[ayahNum];
  if (!rec) return null;
  return { text: rec.text, ref: rec.ref };
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { type, requestId, payload = {} } = msg;

  // ── New typed envelope handlers (T006) ──────────────────────────────────────

  // SCAN_START: relay popup→background→content; only accept from non-tab senders (popup, not content).
  if (type === 'SCAN_START') {
    if (sender.tab) {
      // Came from a content script — ignore (content does not initiate SCAN_START).
      sendResponse(QuranMsg.okResponse(requestId, {}));
      return true;
    }
    const tabId = payload.tabId;
    if (!tabId) { sendResponse(QuranMsg.errResponse(requestId, 'INVALID_REQUEST', 'No tabId')); return true; }
    // Wait for index if the service worker just woke up (dataState may be 'pending').
    ensureInitialized()
      .then(() => {
        QuranBadge.onScanStart(tabId);
        return chrome.tabs.sendMessage(tabId, msg);
      })
      .then(r => sendResponse(r))
      .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
    return true;
  }

  // PREFS_READ (T008)
  if (type === 'PREFS_READ') {
    QuranPrefs.read()
      .then(prefs => sendResponse(QuranMsg.okResponse(requestId, prefs)))
      .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
    return true;
  }

  // PREFS_WRITE (T008)
  if (type === 'PREFS_WRITE') {
    QuranPrefs.patch(payload.patch || {})
      .then(async prefs => {
        await broadcastToContent('PREFS_CHANGED', { prefs });
        sendResponse(QuranMsg.okResponse(requestId, prefs));
      })
      .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
    return true;
  }

  // PERSIST_READ (T010)
  if (type === 'PERSIST_READ') {
    QuranPersisted.read(payload.urlKey)
      .then(r => sendResponse(QuranMsg.okResponse(requestId, r)))
      .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
    return true;
  }

  // PERSIST_WRITE (T010)
  if (type === 'PERSIST_WRITE') {
    QuranPersisted.write(payload)
      .then(() => sendResponse(QuranMsg.okResponse(requestId, {})))
      .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
    return true;
  }

  // CLEAR_PERSISTED (T010)
  if (type === 'CLEAR_PERSISTED') {
    QuranPersisted.clearAll()
      .then(r => sendResponse(QuranMsg.okResponse(requestId, r)))
      .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
    return true;
  }

  // RETRY_DATA_LOAD (T012)
  if (type === 'RETRY_DATA_LOAD') {
    dataState = 'pending';
    dataError = null;
    initPromise = null;
    loadAndIndex()
      .then(() => {
        broadcastToContent('DATA_AVAILABLE', {});
        chrome.runtime.sendMessage({ type: 'DATA_AVAILABLE', requestId: crypto.randomUUID(), payload: {} }).catch(() => {});
        sendResponse(QuranMsg.okResponse(requestId, {}));
      })
      .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'DATA_UNAVAILABLE', e.detail || e.message)));
    return true;
  }

  // Stub handlers for remaining new message types
  if (['CORRECT_IN_PLACE', 'DISMISS_FINDING', 'RESTORE_DISMISSED'].includes(type)) {
    // These are panel→content messages; background routes them (stub for now).
    const tabId = sender.tab?.id ?? payload.tabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, msg)
        .then(r => sendResponse(r))
        .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
    } else {
      sendResponse(QuranMsg.okResponse(requestId, {}));
    }
    return true;
  }

  // ── Legacy handlers (content.js still uses these until T017) ────────────────

  ensureInitialized()
    .then(() => {
      switch (msg.type) {
        case 'verifyFragment':
          return verifyFragment(msg.text, msg.candidateConfidence);
        case 'verifyFragmentByRef':
          return verifyFragmentByRef(msg.text, msg.ref, msg.candidateConfidence, !!msg.debug);
        case 'resolveReference': {
          const r = QuranReferences.resolve(msg.ref, indexes);
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
            console.log(
              `─ #${f.id} [${f.color}]\n` +
              `  text       : ${f.text}\n` +
              `  claimedRef : ${f.claimedRef ?? '(none)'}\n` +
              `  matchedRef : ${f.matchedRef ?? '(none)'}\n` +
              (f.matchedRefs && f.matchedRefs.length > 1 ? `  matchedRefs: ${f.matchedRefs.join(' • ')}\n` : '') +
              `  deviation  : ${f.deviation ?? '(none)'}\n` +
              `  confidence : ${f.confidence}\n` +
              `  strategy   : ${f.strategy}\n` +
              (f.authenticText ? `  authentic  : ${f.authenticText}\n` : '')
            );
          }
          return { ok: true };
        }
        default:
          return { error: `Unknown message type: ${msg.type}` };
      }
    })
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message || err.detail }));

  return true;
});

// ── Badge wiring (T027) — listen for scan lifecycle events from content scripts ──

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  const { type, payload = {} } = msg;
  switch (type) {
    case 'SCAN_START':
      if (tabId) QuranBadge.onScanStart(tabId);
      break;
    case 'SCAN_PROGRESS':
      if (tabId) QuranBadge.onScanProgress(tabId, payload.perCategoryCount, payload.runningCount);
      break;
    case 'SCAN_COMPLETE':
      if (tabId) QuranBadge.onScanComplete(tabId, payload.finalState, payload.perCategoryCount, payload.totalCount);
      break;
    case 'SCAN_CAP_HIT':
      if (tabId) QuranBadge.onCapHit(tabId, payload.perCategoryCount);
      break;
    case 'DATA_UNAVAILABLE':
      QuranBadge.onDataUnavailable(tabId, payload.reason);
      break;
    case 'DATA_AVAILABLE':
      QuranBadge.onDataAvailable(tabId);
      break;
  }
  // No sendResponse needed — this listener is fire-and-forget for badge updates.
  // Return false (default) to signal no async response.
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener('install', () => {
  loadAndIndex().catch(err => console.error('[QuranExt] install index load failed:', err));
});

self.addEventListener('activate', () => {
  loadAndIndex().catch(err => console.error('[QuranExt] activate index load failed:', err));
});
