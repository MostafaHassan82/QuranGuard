'use strict';

// T006/T015/T027 — Load shared modules before any other code runs.
// Paths are relative to this file's URL (chrome-extension://<id>/js/background.js),
// so they resolve inside the js/ directory — no 'js/' prefix needed.
importScripts(
  'shared/log.js',            // QuranLog (leveled logger)
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

// Lifecycle/diagnostic logging now goes through QuranLog levels (shared/log.js):
//   info  = worker boot, "Index ready", findings count
//   debug = per-finding dump, per-batch [bgprofile] breakdown
//   trace = SW eval marker
// Raise at runtime in the service-worker console: QuranLog.setLevel('debug').
function dlog(...args) { QuranLog.debug(...args); }

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
      chrome.tabs.sendMessage(tab.id, { type, requestId: QuranMsg.randomId(), payload })
        .catch(() => {}); // tab may have no content script
    }
  } catch (_) {}
}

// ── Data loading (T011 fail-loud + T015 wire indexes) ────────────────────────

async function loadAndIndex() {
  // Minimal index source: only the fields QuranIndexes.build reads
  // (sura index/name, aya index/text, meta.chaptersNames). The full
  // *_desc-v2.json carries a per-ayah `words` breakdown nothing reads, which
  // made it ~7.4× larger (11.3MB vs 1.5MB) and dominated cold-start
  // fetch+parse. Regenerate via `python scripts/build-min-json.py`.
  const url = chrome.runtime.getURL('resources/quran-uthmani_min-v2.json');
  let data;
  // Cold-start instrumentation: split fetch (download the JSON) from parse
  // (JSON.parse it) from build (below) so a slow cold start is attributable.
  // resp.text() + JSON.parse instead of resp.json() only to time the two
  // halves separately. Every worker wake rebuilds (module globals reset on
  // eviction), so this line prints once per wake.
  const tFetch = performance.now();
  let fetchMs = 0, parseMs = 0;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw { reason: 'unreadable', detail: `HTTP ${resp.status}` };
    const text = await resp.text();
    fetchMs = performance.now() - tFetch;
    const tParse = performance.now();
    data = JSON.parse(text);
    parseMs = performance.now() - tParse;
  } catch (e) {
    const err = { reason: e.reason || 'unreadable', detail: e.detail || String(e) };
    dataState = 'unavailable';
    dataError = err;
    broadcastToContent('DATA_UNAVAILABLE', err);
    chrome.runtime.sendMessage({ type: 'DATA_UNAVAILABLE', requestId: QuranMsg.randomId(), payload: err }).catch(() => {});
    throw err;
  }

  const schemaErr = validateQuranSchema(data);
  if (schemaErr) {
    const err = { reason: 'schemaFailure', detail: `Schema validation failed: ${schemaErr}` };
    dataState = 'unavailable';
    dataError = err;
    broadcastToContent('DATA_UNAVAILABLE', err);
    chrome.runtime.sendMessage({ type: 'DATA_UNAVAILABLE', requestId: QuranMsg.randomId(), payload: err }).catch(() => {});
    throw err;
  }

  const tBuild = performance.now();
  indexes = QuranIndexes.build(data);
  const buildMs = performance.now() - tBuild;
  dataState = 'ready';
  dataError = null;
  const totalMs = performance.now() - tFetch;
  QuranLog.scope('index').info(
    `ready — cold start: fetch=${Math.round(fetchMs)}ms parse=${Math.round(parseMs)}ms ` +
    `build=${Math.round(buildMs)}ms total=${Math.round(totalMs)}ms — verses: ${indexes.byTier1Norm.size}, ` +
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
  if (diff > 2) return false;
  const isDrift = c => c === 'ا' || c === 'و' || c === 'ي' || c === 'ء';

  // diff === 0: same length, allow a single drift-letter substitution at one
  // position (both differing chars must be drift letters). Handles Uthmani
  // أَقْصَا (terminal alef) vs modern أقصى (alef maqsura → ي): "ءقصا" vs "ءقصي".
  if (diff === 0) {
    let mismatchPos = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (mismatchPos !== -1) return false;       // >1 mismatch — reject
      if (!isDrift(a[i]) || !isDrift(b[i])) return false; // non-drift sub — reject
      mismatchPos = i;
    }
    return mismatchPos !== -1; // exactly one drift substitution
  }

  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];

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

// Recursive aligner that tries 1:1 soft-equality first, then merges in both
// directions (concatenating up to 3 adjacent words on either side).
// Handles word-segmentation drift between citation and Quran:
//   k:1  — modern splits a Quranic fused word (يا + بن + أم ↔ Uthmani يبنءم)
//   1:k  — modern fuses what the Quran writes as separate words, often via a
//          missing space (فقلءفلا ↔ Quran فقل ءفلا — case from Yunus:31)
// Returns the haystack index one past the last consumed word on success, or -1.
// Backtracks (returns -1 from a successful 1:1 only to try the merge path) when
// the rest of the alignment fails downstream.
const MAX_MERGE = 3;
function alignSoftWithMerge(haystack, needle, hi, ji) {
  if (ji === needle.length) return hi;
  if (hi >= haystack.length) return -1;
  // 1:1
  if (softEqualWord(haystack[hi], needle[ji])) {
    const r = alignSoftWithMerge(haystack, needle, hi + 1, ji + 1);
    if (r >= 0) return r;
  }
  // k:1 merge — concatenate next k needle words to match one haystack word
  for (let k = 2; k <= MAX_MERGE && ji + k <= needle.length; k++) {
    const merged = needle.slice(ji, ji + k).join('');
    if (softEqualWord(haystack[hi], merged)) {
      const r = alignSoftWithMerge(haystack, needle, hi + 1, ji + k);
      if (r >= 0) return r;
    }
  }
  // 1:k merge — concatenate next k haystack words to match one needle word
  for (let k = 2; k <= MAX_MERGE && hi + k <= haystack.length; k++) {
    const merged = haystack.slice(hi, hi + k).join('');
    if (softEqualWord(merged, needle[ji])) {
      const r = alignSoftWithMerge(haystack, needle, hi + k, ji + 1);
      if (r >= 0) return r;
    }
  }
  return -1;
}

function isContiguousSoftSubsequence(haystackWords, needleWords) {
  if (needleWords.length === 0) return false;
  for (let i = 0; i < haystackWords.length; i++) {
    if (alignSoftWithMerge(haystackWords, needleWords, i, 0) >= 0) return true;
  }
  return false;
}

// ── T058a — excerpt-preserving swap support ──────────────────────────────────
// Build parallel tier1 + Uthmani word arrays across one or more records, with a
// map back to the source ayah. Uthmani words align 1:1 with tier1 words per
// record (see indexes.js); when a record's alignment is off (a token normalized
// to empty), we fall back to null Uthmani entries for that record so callers
// can detect the gap and decline rather than emit a misaligned excerpt.
function buildParallelWords(records) {
  const t1 = [], uth = [];
  for (const rec of records) {
    const aligned = Array.isArray(rec.uthmaniWords) && rec.uthmaniWords.length === rec.tier1Words.length;
    for (let i = 0; i < rec.tier1Words.length; i++) {
      t1.push(rec.tier1Words[i]);
      uth.push(aligned ? rec.uthmaniWords[i] : null);
    }
  }
  return { t1, uth };
}

// Find the contiguous span in `records` that aligns with candidateWords and
// return the authentic Uthmani wording for just that span (FR-008 excerpt
// shape). Returns null if no alignment or if Uthmani words are unavailable.
function authenticExcerptForCandidate(records, candidateWords) {
  if (!records || records.length === 0 || !candidateWords || candidateWords.length === 0) return null;
  const { t1, uth } = buildParallelWords(records);
  for (let i = 0; i < t1.length; i++) {
    const endHi = alignSoftWithMerge(t1, candidateWords, i, 0);
    if (endHi >= 0) {
      const span = uth.slice(i, endHi);
      if (span.length === 0 || span.some(w => w == null)) return null;
      return span.join(' ');
    }
  }
  return null;
}

// Ellipsis variant: align each segment in order and join the authentic spans
// with the same ellipsis marker so the swap preserves the "first … last" shape.
function authenticEllipsisExcerptForSegments(records, segWordsList) {
  if (!records || records.length === 0 || !segWordsList || segWordsList.length === 0) return null;
  const { t1, uth } = buildParallelWords(records);
  const parts = [];
  let cursor = 0;
  for (const seg of segWordsList) {
    let placed = -1, end = -1;
    for (let i = cursor; i < t1.length; i++) {
      const endHi = alignSoftWithMerge(t1, seg, i, 0);
      if (endHi >= 0) { placed = i; end = endHi; cursor = endHi; break; }
    }
    if (placed === -1) return null;
    const span = uth.slice(placed, end);
    if (span.length === 0 || span.some(w => w == null)) return null;
    parts.push(span.join(' '));
  }
  return parts.join(' … ');
}

// Multi-segment match for `*`-separated citations that span multiple verses
// (and may skip verses). Each `*` is the page's verse-end marker; the segments
// must each match a verse in the same surah in strictly ascending ayah order,
// within a bounded ayah-window so unrelated coincidental matches don't pass.
// Returns {firstRec, surahNum, ayahs[], displayRef} on success, or null.
//
// Used as a fallback when single-verse lookups fail. Handles both:
//   - Contiguous spans (الواقعة:27-29)
//   - Spans that skip verses (الواقعة:10,11,13 — user dropped v12)
const MULTI_SEGMENT_MAX_SPAN = 30; // max ayah-distance between first and last segment match
function matchMultiSegmentCitation(candidateText) {
  const segments = candidateText.split('*').map(s => s.trim()).filter(s => s.length > 0);
  if (segments.length < 2) return null;

  // For each segment, collect candidate verses (exact → strict-ordered → soft-ordered)
  const segHits = [];
  for (const seg of segments) {
    const t1 = tier1Normalize(seg);
    const words = t1.split(' ').filter(Boolean);
    if (words.length === 0) return null;
    let recs = findExactGlobal(t1);
    if (recs.length === 0) recs = findOrderedContiguousGlobal(words);
    if (recs.length === 0) recs = findOrderedContiguousSoftGlobal(words);
    if (recs.length === 0) return null; // any segment unmatched → bail
    segHits.push(recs);
  }

  // Find a surah where every segment can be placed in ascending ayah order.
  const surahCounts = new Map();
  for (const recs of segHits) {
    const surahs = new Set(recs.map(r => r.surahNum));
    for (const s of surahs) surahCounts.set(s, (surahCounts.get(s) || 0) + 1);
  }
  for (const [surahNum, count] of surahCounts) {
    if (count !== segHits.length) continue;
    const ayahLists = segHits.map(recs =>
      recs.filter(r => r.surahNum === surahNum).map(r => r.ayahNum).sort((a, b) => a - b)
    );
    let prev = 0;
    const picked = [];
    let ok = true;
    for (const ayahs of ayahLists) {
      const next = ayahs.find(a => a > prev);
      if (next === undefined) { ok = false; break; }
      picked.push(next);
      prev = next;
    }
    if (!ok) continue;
    if (picked[picked.length - 1] - picked[0] > MULTI_SEGMENT_MAX_SPAN) continue;
    const firstRec = indexes.byRef[surahNum]?.[picked[0]];
    if (!firstRec) continue;
    const surahName = firstRec.surahName;
    const displayRef = picked.length === 1
      ? `${surahName}:${picked[0]}`
      : `${surahName}:${picked[0]}-${picked[picked.length - 1]}`;
    return { firstRec, surahNum, ayahs: picked, displayRef };
  }
  return null;
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

// Union of every ayah key whose word soft-equals `word`: the exact key set PLUS
// the one-drift-letter (ا/و/ي/ء) insertion/deletion variants. Unlike
// softWordIndexLookup — which early-returns on an exact hit as a match-time
// optimization — candidate GENERATION must keep the variants too. Otherwise a
// citation word that happens to exist verbatim elsewhere (e.g. "موسي", spelled
// without the superscript alef in some ayahs) hides every ayah that spells it
// "موسيا" (طه:49's يَٰمُوسَىٰ), dropping the true match before alignment runs.
function softWordKeysUnion(word, wordIdx) {
  const out = new Set();
  const add = s => { if (s) for (const k of s) out.add(k); };
  add(wordIdx.get(word));
  for (let i = 0; i <= word.length; i++) {
    for (const c of ['ا', 'و', 'ي', 'ء']) add(wordIdx.get(word.slice(0, i) + c + word.slice(i)));
  }
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === 'ا' || ch === 'و' || ch === 'ي' || ch === 'ء') add(wordIdx.get(word.slice(0, i) + word.slice(i + 1)));
  }
  return out;
}

// Soft anchor keys for the ordered-contiguous candidate set. Unions the
// drift-variant lookups for the first/last word, and also for the first/last
// 2..MAX_MERGE words joined — mirroring alignSoftWithMerge's k:1 merge tolerance
// so a word the mushaf fuses with a neighbour (e.g. "يا بن أم" ↔ "يبنؤم") still
// surfaces its ayah as a candidate the alignment step can accept.
function softAnchorKeys(words, fromEnd) {
  const out = new Set();
  const n = Math.min(MAX_MERGE, words.length);
  for (let m = 1; m <= n; m++) {
    const slice = fromEnd ? words.slice(words.length - m) : words.slice(0, m);
    for (const k of softWordKeysUnion(slice.join(''), indexes.wordIndex)) out.add(k);
  }
  return out;
}

// Like findOrderedContiguousGlobal but uses soft word lookup + soft subsequence check.
function findOrderedContiguousSoftGlobal(t1Words) {
  if (t1Words.length < 2) return [];
  const first = softAnchorKeys(t1Words, false);
  const last = softAnchorKeys(t1Words, true);
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
  // Merge-aware alignment (mirrors single-record path): allow up to 3 cited
  // words to fuse onto one verse word (e.g. cited "يا بن أم" ↔ verse "يبنءم").
  let matchStart = -1, matchEndHi = -1;
  for (let i = 0; i < allWords.length; i++) {
    const endHi = alignSoftWithMerge(allWords, candidateWords, i, 0);
    if (endHi >= 0) { matchStart = i; matchEndHi = endHi; break; }
  }
  if (matchStart === -1) {
    if (tr) {
      tr(`  match[multi]: NO alignment (verseWords=${allWords.length} candWords=${candidateWords.length})`);
      tr(`    cand[0]=${JSON.stringify(candidateWords[0])} cand[last]=${JSON.stringify(candidateWords[candidateWords.length-1])}`);
    }
    return null;
  }
  // matchEndHi is one past last consumed haystack index; clamp into [matchStart, len-1].
  const matchEnd = Math.max(matchStart, matchEndHi - 1);
  const firstAyah = wordToAyah[matchStart], lastAyah = wordToAyah[matchEnd];
  const surahName = records[0].surahName;
  const displayRef = firstAyah === lastAyah ? `${surahName}:${firstAyah}` : `${surahName}:${firstAyah}-${lastAyah}`;
  const anchorRec = records.find(r => r.ayahNum === firstAyah) || records[0];
  return { rec: anchorRec, displayRef, deviation: 'spellingDrift' };
}

// Ellipsis-excerpt match. Pages often quote a long ayah as "first part ... last
// part" using `...` or `…` to indicate skipped middle words. Treat that as a
// green match: split the raw candidate on the ellipsis, tier1-normalize each
// segment, and require each segment to align (soft + merge-aware) against the
// claimed ayah's words in strictly ascending order. Returns {rec, displayRef}
// on success, or null. Caller decides the deviation label.
function ellipsisMatchInClaimedAyahs(rawCandidateText, resolved, tr = null) {
  if (!/\.{3,}|…/.test(rawCandidateText)) return null;
  const rawSegments = rawCandidateText.split(/\s*(?:\.{3,}|…+)\s*/u).map(s => s.trim()).filter(Boolean);
  if (rawSegments.length < 2) return null;
  const segWords = rawSegments.map(s => tier1Normalize(s).split(' ').filter(Boolean));
  if (segWords.some(w => w.length === 0)) return null;

  const { surahNum, ayahNums } = resolved;
  const records = ayahNums.map(n => indexes.byRef[surahNum]?.[n]).filter(Boolean);
  if (records.length === 0) return null;

  // Concatenate all claimed-ayah words and track which ayah each came from so
  // we can build a range displayRef when the excerpt spans multiple ayahs.
  const allWords = [], wordToAyah = [];
  for (const rec of records) {
    for (const w of rec.tier1Words) { allWords.push(w); wordToAyah.push(rec.ayahNum); }
  }

  let cursor = 0;
  let firstStart = -1, lastEnd = -1;
  for (const seg of segWords) {
    let placed = -1;
    for (let i = cursor; i < allWords.length; i++) {
      const endHi = alignSoftWithMerge(allWords, seg, i, 0);
      if (endHi >= 0) { placed = i; cursor = endHi; lastEnd = endHi - 1; if (firstStart === -1) firstStart = i; break; }
    }
    if (placed === -1) {
      if (tr) tr(`  ellipsis: seg ${JSON.stringify(seg.slice(0, 3))}… failed to align from cursor=${cursor}`);
      return null;
    }
  }
  const surahName = records[0].surahName;
  const firstAyah = wordToAyah[firstStart];
  const lastAyah = wordToAyah[Math.max(firstStart, lastEnd)];
  const displayRef = firstAyah === lastAyah ? `${surahName}:${firstAyah}` : `${surahName}:${firstAyah}-${lastAyah}`;
  const anchorRec = records.find(r => r.ayahNum === firstAyah) || records[0];
  return { rec: anchorRec, displayRef };
}

function wordLevelMatchInClaimedAyahs(candidateWords, resolved) {
  // For 1-word candidates, the edit-distance path would always return diffs=1
  // against any verse word (one allowed substitution), producing a spurious
  // yellow even when the word isn't in the verse. tier1MatchInClaimed already
  // handles the only legitimate 1-word green path (soft-equal in claimed verse).
  if (candidateWords.length < 2) return null;
  const { surahNum, ayahNums } = resolved;
  const records = ayahNums.map(n => indexes.byRef[surahNum]?.[n]).filter(Boolean);
  let best = null;
  for (const rec of records) {
    const diffs = wordLevelCompareSingleAyah(candidateWords, rec.tier1Words);
    if (diffs !== null && (best === null || diffs < best.diffs)) best = { rec, diffs };
  }
  return best;
}

// Single-word orange path: search wordIndex for the candidate word elsewhere
// in the Quran (excluding claimed ayahs). Gated by a max-hits threshold so
// very common words (الله, من, ما, ...) don't spawn noisy orange findings.
function findElsewhereForSingleWord(word, claimedKeySet, maxHits = 8) {
  const keys = softWordIndexLookup(word, indexes.wordIndex);
  const recs = [];
  for (const key of keys) {
    if (claimedKeySet.has(key)) continue;
    const { surahNum, ayahNum } = parseKey(key);
    const rec = indexes.byRef[surahNum]?.[ayahNum];
    if (!rec) continue;
    recs.push(rec);
    if (recs.length > maxHits) return null; // too generic to be a useful orange signal
  }
  if (recs.length === 0) return null;
  recs.sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
  return recs;
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
    return makeResult({ color: 'lightBlue', matchedRef: sorted[0].ref, matchedRefs: sorted.map(r => r.ref), authenticText: sorted[0].text, authenticExcerpt: authenticExcerptForCandidate([sorted[0]], words), deviation: classifyDeviation(sorted[0].text, candidateText), candidateConfidence, matchType: 'exact' });
  }

  // Multi-segment match for `*`-separated citations MUST run before the
  // single-verse contiguous search. The `*` marks an ayah boundary, so the
  // excerpt spans multiple verses (e.g. "أحد * الله" = الإخلاص 112:1→112:2,
  // used with "إلى قوله" for "from … to …", sometimes skipping middle verses
  // like الواقعة:10*11*13). If we searched single-verse contiguity first, the
  // boundary-spanning excerpt would be wrongly collapsed onto an unrelated
  // verse that happens to contain the joined words in a row.
  const multi = matchMultiSegmentCitation(candidateText);
  if (multi) {
    return makeResult({ color: 'lightBlue', matchedRef: multi.displayRef, authenticText: multi.firstRec.text, deviation: 'spellingDrift', candidateConfidence, matchType: 'orderedContiguous' });
  }

  // Strict first (matchedRef is the cleaner spelling); fall back to soft (handles
  // ولكن vs ولاكن — Quran's superscript alef expands to an extra ا that strict
  // equality rejects but softEqualWord tolerates).
  let orderedRecs = findOrderedContiguousGlobal(words);
  if (orderedRecs.length === 0) orderedRecs = findOrderedContiguousSoftGlobal(words);
  if (orderedRecs.length > 0) {
    const sorted = orderedRecs.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
    return makeResult({ color: 'lightBlue', matchedRef: sorted[0].ref, matchedRefs: sorted.map(r => r.ref), authenticText: sorted[0].text, authenticExcerpt: authenticExcerptForCandidate([sorted[0]], words), deviation: 'spellingDrift', candidateConfidence, matchType: 'orderedContiguous' });
  }

  // Single-word brace with no ref (e.g. `قوله سبحانه: {أرني}` or `{عندك}`).
  // The ordered/wordLevel global searches all bail for 1-word candidates, so
  // consult the wordIndex directly. Confidence drives the gate:
  //   - HIGH (an explicit primary lead-in like "قوله تعالى:" precedes the brace):
  //     citation intent is explicit, so verify even a common word — present
  //     anywhere in the Quran → lightBlue (cap the reported refs for the
  //     tooltip); present nowhere → red (the lead-in claimed Quran that isn't).
  //   - MEDIUM (no lead-in): keep the maxHits gate so common particles (الله,
  //     من, ما, …) don't spawn noisy findings; otherwise drop it (no highlight).
  if (words.length === 1) {
    const highConf = candidateConfidence === 'high';
    const recs = findElsewhereForSingleWord(words[0], new Set(), highConf ? Infinity : 8);
    if (recs && recs.length > 0) {
      const top = recs.slice(0, 8);
      return makeResult({
        color: 'lightBlue', matchedRef: top[0].ref, matchedRefs: top.map(r => r.ref),
        authenticText: top[0].text, deviation: 'spellingDrift', candidateConfidence, matchType: 'partial',
      });
    }
    // Not found anywhere: a high-confidence lead-in over a non-Quran word is a
    // fabricated single-word citation → red; otherwise just drop it.
    if (highConf) return makeResult({ color: 'red', candidateConfidence, matchType: 'none' });
    return makeResult({ color: null, candidateConfidence, matchType: 'none' });
  }

  const wlRecs = wordLevelMatchGlobal(words);
  if (wlRecs.length > 0) {
    const sorted = wlRecs.slice().sort((a, b) => a.diffs - b.diffs || a.rec.surahNum - b.rec.surahNum);
    return makeResult({ color: 'yellow', matchedRef: sorted[0].rec.ref, matchedRefs: sorted.slice(0, 3).map(r => r.rec.ref), authenticText: sorted[0].rec.text, authenticExcerpt: authenticExcerptForCandidate([sorted[0].rec], words), deviation: 'wordLevel', candidateConfidence, matchType: 'partial' });
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

  // T058a — records for the resolved ayah(s); used to slice the authentic
  // wording for just the cited span (excerpt-preserving swap).
  const recordsFor = (r) => (r.ayahNums || []).map(n => indexes.byRef[r.surahNum]?.[n]).filter(Boolean);
  // Ellipsis segment words (mirrors ellipsisMatchInClaimedAyahs' split) so we
  // can build the authentic excerpt with the ellipsis shape preserved.
  const ellSegWords = () => {
    if (!/\.{3,}|…/.test(candidateText)) return null;
    const segs = candidateText.split(/\s*(?:\.{3,}|…+)\s*/u).map(s => s.trim()).filter(Boolean);
    if (segs.length < 2) return null;
    const sw = segs.map(s => tier1Normalize(s).split(' ').filter(Boolean));
    return sw.some(w => w.length === 0) ? null : sw;
  };

  const t1InClaimed = tier1MatchInClaimedAyahs(candidateText, words, resolved, tr);
  if (t1InClaimed) {
    tr(`tier1MatchInClaimed: HIT (${t1InClaimed.displayRef}, deviation=${t1InClaimed.deviation}) → green`);
    // allExactRefs/allPartialRefs (the "also/partially appears in …" tooltip
    // lines) are NOT computed here: findAllGlobalMatches is O(words²) per
    // candidate verse and dominated bgCompute on long verses, yet the verdict
    // is already green. The content script fetches them lazily on hover via
    // the 'alternateRefs' message.
    const authenticExcerpt = authenticExcerptForCandidate(recordsFor(resolved), words);
    return wrap(makeResult({ color: 'green', matchedRef: preferClaimedSpelling(t1InClaimed.displayRef, refString), claimedRef: refString, authenticText: t1InClaimed.rec.text, authenticExcerpt, deviation: t1InClaimed.deviation, candidateConfidence, matchType: 'exact' }));
  }
  tr(`tier1MatchInClaimed: MISS`);

  // Range-fallback: {Surah:a،b} where author meant the range a..b (، used as a hyphen).
  // Only retried when discrete-parse failed and references.js suggested a small-gap expansion.
  if (resolved.rangeAyahNums) {
    const rangeResolved = { surahNum: resolved.surahNum, ayahNums: resolved.rangeAyahNums, isRange: true };
    const t1InRange = tier1MatchInClaimedAyahs(candidateText, words, rangeResolved, tr);
    if (t1InRange) {
      tr(`tier1MatchInRange: HIT → green`);
      const authenticExcerpt = authenticExcerptForCandidate(recordsFor(rangeResolved), words);
      return wrap(makeResult({ color: 'green', matchedRef: preferClaimedSpelling(t1InRange.displayRef, refString), claimedRef: refString, authenticText: t1InRange.rec.text, authenticExcerpt, deviation: t1InRange.deviation, candidateConfidence, matchType: 'exact' }));
    }
  }

  // Ellipsis-excerpt path: `{first part ... last part}` against a long ayah.
  // Tried after the strict tier1 match misses but before falling to yellow,
  // so genuine excerpts stay green rather than getting downgraded.
  const ellInClaimed = ellipsisMatchInClaimedAyahs(candidateText, resolved, tr);
  if (ellInClaimed) {
    tr(`ellipsisMatchInClaimed: HIT (${ellInClaimed.displayRef}) → green`);
    const authenticExcerpt = authenticEllipsisExcerptForSegments(recordsFor(resolved), ellSegWords());
    return wrap(makeResult({ color: 'green', matchedRef: preferClaimedSpelling(ellInClaimed.displayRef, refString), claimedRef: refString, authenticText: ellInClaimed.rec.text, authenticExcerpt, deviation: 'spellingDrift', candidateConfidence, matchType: 'exact' }));
  }
  if (resolved.rangeAyahNums) {
    const rangeResolved = { surahNum: resolved.surahNum, ayahNums: resolved.rangeAyahNums, isRange: true };
    const ellInRange = ellipsisMatchInClaimedAyahs(candidateText, rangeResolved, tr);
    if (ellInRange) {
      tr(`ellipsisMatchInRange: HIT → green`);
      const authenticExcerpt = authenticEllipsisExcerptForSegments(recordsFor(rangeResolved), ellSegWords());
      return wrap(makeResult({ color: 'green', matchedRef: preferClaimedSpelling(ellInRange.displayRef, refString), claimedRef: refString, authenticText: ellInRange.rec.text, authenticExcerpt, deviation: 'spellingDrift', candidateConfidence, matchType: 'exact' }));
    }
  }

  // Verbatim FULL-ayah match at a DIFFERENT ref than claimed → orange (correct
  // words, wrong reference), and it must outrank the partial word-level match at
  // the claimed ayah below: the author quoted another verse verbatim with the
  // wrong reference (e.g. "الذين يقيمون الصلاة ومما رزقناهم ينفقون" cited
  // البقرة:3 but it is الأنفال:3), which is a wrong-reference case, not an
  // altered-wording (yellow) one. Covers strict-exact AND soft full-verse
  // matches (Uthmani drift like الصلاة↔الصلوٰة defeats strict equality). Limited
  // to FULL-ayah coverage (candidate spans the whole verse) so a sub-excerpt
  // that also sits inside the claimed ayah isn't mislabeled. The claimed-ayah
  // case was already returned green above.
  const claimedKeys = new Set((resolved.ayahNums || []).map(n => `${resolved.surahNum}:${n}`));
  const notClaimed = r => !claimedKeys.has(`${r.surahNum}:${r.ayahNum}`);
  let verbatimElsewhere = findExactGlobal(t1).filter(notClaimed);
  if (verbatimElsewhere.length === 0) {
    verbatimElsewhere = findOrderedContiguousSoftGlobal(words)
      .filter(notClaimed)
      .filter(r => r.tier1Words.length === words.length); // whole verse, not a fragment
  }
  if (verbatimElsewhere.length > 0) {
    const sorted = verbatimElsewhere.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
    tr(`verbatimElsewhere: HIT (${sorted[0].ref}) → orange`);
    return wrap(makeResult({
      color: 'orange', matchedRef: sorted[0].ref, matchedRefs: sorted.map(r => r.ref),
      claimedRef: refString, authenticText: sorted[0].text,
      authenticExcerpt: authenticExcerptForCandidate([sorted[0]], words),
      deviation: 'none', candidateConfidence, matchType: 'exact',
    }));
  }

  const wlInClaimed = wordLevelMatchInClaimedAyahs(words, resolved);
  if (wlInClaimed) { tr(`wordLevelInClaimed: HIT (${wlInClaimed.rec.ref}, diffs=${wlInClaimed.diffs}) → yellow`); const authenticExcerpt = authenticExcerptForCandidate(recordsFor(resolved), words); return wrap(makeResult({ color: 'yellow', matchedRef: preferClaimedSpelling(wlInClaimed.rec.ref, refString), claimedRef: refString, authenticText: wlInClaimed.rec.text, authenticExcerpt, deviation: 'wordLevel', candidateConfidence, matchType: 'partial' })); }
  tr(`wordLevelInClaimed: MISS`);

  if (resolved.rangeAyahNums) {
    const rangeResolved = { surahNum: resolved.surahNum, ayahNums: resolved.rangeAyahNums, isRange: true };
    const wlInRange = wordLevelMatchInClaimedAyahs(words, rangeResolved);
    if (wlInRange) { tr(`wordLevelInRange: HIT → yellow`); const authenticExcerpt = authenticExcerptForCandidate(recordsFor(rangeResolved), words); return wrap(makeResult({ color: 'yellow', matchedRef: wlInRange.rec.ref, claimedRef: refString, authenticText: wlInRange.rec.text, authenticExcerpt, deviation: 'wordLevel', candidateConfidence, matchType: 'partial' })); }
  }

  // Multi-segment `*` citation the claimed-range matchers couldn't place — e.g.
  // the cited range undercounts the actual span (the quote runs a verse past the
  // cited end, like الشورى:39-42 for text that spans 39-43). The boundary-aware
  // matcher recovers the true span; verbatim multi-verse Quran must never fall
  // through to red. The words are authentic, so the only question is the ref:
  //   - matched range == claimed range  → green (authentic + ref correct; we only
  //     reach here if concat drift defeated the precise matcher above).
  //   - matched range != claimed range  → orange (correct words, wrong reference)
  //     so it gets flagged + corrected to the true range. matchedRef carries that
  //     true range, which the correct-in-place flow writes over the cited one.
  const multiSeg = matchMultiSegmentCitation(candidateText);
  if (multiSeg) {
    const claimedSet = new Set(resolved.ayahNums || []);
    const sameRange = multiSeg.surahNum === resolved.surahNum &&
      multiSeg.ayahs.length === claimedSet.size &&
      multiSeg.ayahs.every(a => claimedSet.has(a));
    tr(`multiSegment: HIT (${multiSeg.displayRef}) sameRange=${sameRange} → ${sameRange ? 'green' : 'orange'}`);
    return wrap(makeResult({
      color: sameRange ? 'green' : 'orange',
      matchedRef: multiSeg.displayRef,
      matchedRefs: [multiSeg.displayRef],
      claimedRef: refString,
      authenticText: multiSeg.firstRec.text,
      deviation: sameRange ? 'spellingDrift' : 'none',
      candidateConfidence,
      matchType: 'orderedContiguous',
    }));
  }
  tr(`multiSegment: MISS`);

  // Single-word orange: text is a single word that doesn't appear in the claimed
  // verse(s) but appears elsewhere in the Quran. QuranOrange.findElsewhere bails
  // on <2-word candidates, so handle 1-word here. High-confidence only — same
  // gate the multi-word orange path uses.
  if (words.length === 1 && candidateConfidence === 'high') {
    const claimedKeySet = new Set(resolved.ayahNums.map(n => `${resolved.surahNum}:${n}`));
    const elsewhere = findElsewhereForSingleWord(words[0], claimedKeySet);
    if (elsewhere) {
      tr(`orange[1-word]: HIT (${elsewhere.length} refs, first=${elsewhere[0].ref}) → orange`);
      return wrap(makeResult({
        color: 'orange',
        matchedRef: elsewhere[0].ref,
        matchedRefs: elsewhere.map(r => r.ref),
        claimedRef: refString,
        authenticText: elsewhere[0].text,
        authenticExcerpt: authenticExcerptForCandidate([elsewhere[0]], words),
        deviation: 'none',
        candidateConfidence,
        matchType: 'exact',
      }));
    }
    tr(`orange[1-word]: MISS (word not found elsewhere or too generic)`);
  }

  // Orange (FR-004, FR-016): text IS Quran but at a different ref than claimed.
  // QuranOrange owns the decision; we provide the search helpers it needs,
  // including the soft variant so Uthmani drift doesn't mask wrong-ref cases.
  const orangeHits = QuranOrange.classify(t1, words, resolved, candidateConfidence, {
    findExactGlobal,
    findOrderedContiguousGlobal,
    findOrderedContiguousSoftGlobal,
  });
  if (orangeHits) {
    tr(`orange: HIT (${orangeHits.length} refs, first=${orangeHits[0].ref}) → orange`);
    return wrap(makeResult({
      color: 'orange',
      matchedRef: orangeHits[0].ref,
      matchedRefs: orangeHits.map(r => r.ref),
      claimedRef: refString,
      authenticText: orangeHits[0].text,
      authenticExcerpt: authenticExcerptForCandidate([orangeHits[0]], words),
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
    return wrap(makeResult({ color: 'yellow', matchedRef: sorted[0].rec.ref, matchedRefs: sorted.slice(0, 3).map(r => r.rec.ref), claimedRef: refString, authenticText: sorted[0].rec.text, authenticExcerpt: authenticExcerptForCandidate([sorted[0].rec], words), deviation: 'wordLevel', candidateConfidence, matchType: 'partial' }));
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

  // PERSIST_REMOVE (T071) — remove a single correction/dismissal entry.
  if (type === 'PERSIST_REMOVE') {
    QuranPersisted.remove(payload)
      .then(() => sendResponse(QuranMsg.okResponse(requestId, {})))
      .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
    return true;
  }

  // CLEAR_PERSISTED (T010)
  if (type === 'CLEAR_PERSISTED') {
    QuranPersisted.clearAll()
      .then(async r => {
        // Tell open sidebars to drop their now-stale persisted badges and
        // re-render. The clear button moved to the options page (T094), so it
        // can no longer reach the content-script panel model directly.
        await broadcastToContent('PERSISTED_CLEARED', {});
        sendResponse(QuranMsg.okResponse(requestId, r));
      })
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
        chrome.runtime.sendMessage({ type: 'DATA_AVAILABLE', requestId: QuranMsg.randomId(), payload: {} }).catch(() => {});
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
        case 'verifyFragment': {
          const t0 = performance.now();
          const r = verifyFragment(msg.text, msg.candidateConfidence);
          if (r) r._bgMs = +(performance.now() - t0).toFixed(2);
          return r;
        }
        case 'verifyFragmentByRef': {
          const t0 = performance.now();
          const r = verifyFragmentByRef(msg.text, msg.ref, msg.candidateConfidence, !!msg.debug);
          if (r) r._bgMs = +(performance.now() - t0).toFixed(2);
          return r;
        }
        case 'verifyFragmentBatch': {
          // One round-trip for a whole scan pass: verify every cache-miss
          // candidate server-side and return the verdicts in input order.
          // Collapsing N postMessages into 1 is the dominant scan-latency win
          // under service-worker contention (per-call round-trip queueing far
          // outweighs the verify compute itself). _bgMs is the batch total.
          const t0 = performance.now();
          const items = Array.isArray(msg.items) ? msg.items : [];
          // At debug level, time each item so we can see where the now-
          // dominant bgCompute goes. Cost tracks how far through the strategy
          // gauntlet a candidate runs: exact/lightBlue short-circuit cheaply;
          // none/yellow ran every search (exact→multi→ordered→soft→wordLevel).
          const prof = QuranLog.enabled('debug') ? [] : null;
          const results = items.map(it => {
            const ts = prof ? performance.now() : 0;
            const r = it.type === 'verifyFragmentByRef'
              ? verifyFragmentByRef(it.text, it.ref, it.candidateConfidence, !!it.debug)
              : verifyFragment(it.text, it.candidateConfidence);
            if (prof) prof.push({ ms: performance.now() - ts, type: it.type, matchType: r?.matchType || 'none', color: r?.color ?? 'null', text: it.text || '' });
            return r;
          });
          const bgMs = +(performance.now() - t0).toFixed(2);
          if (prof) {
            const byKey = {};
            for (const p of prof) {
              const k = `${p.type === 'verifyFragmentByRef' ? 'byRef' : 'noRef'}/${p.matchType}/${p.color}`;
              (byKey[k] ||= { n: 0, ms: 0, max: 0 });
              byKey[k].n++; byKey[k].ms += p.ms; if (p.ms > byKey[k].max) byKey[k].max = p.ms;
            }
            // Emit the whole report as ONE log entry under the [bgprofile] tag
            // (the scope prefixes the entry) so a console filter on the tag
            // keeps all of it and it copies as a single block.
            const lines = [`items=${items.length} total=${bgMs}ms`];
            for (const [k, v] of Object.entries(byKey).sort((a, b) => b[1].ms - a[1].ms)) {
              lines.push(`  ${k}: n=${v.n} sum=${v.ms.toFixed(1)}ms avg=${(v.ms / v.n).toFixed(2)}ms max=${v.max.toFixed(1)}ms`);
            }
            for (const p of prof.slice().sort((a, b) => b.ms - a.ms).slice(0, 5)) {
              lines.push(`  slow ${p.ms.toFixed(1)}ms [${p.matchType}/${p.color}] ${p.text.slice(0, 60)}`);
            }
            QuranLog.scope('bgprofile').debug(lines.join('\n'));
          }
          return { results, _bgMs: bgMs };
        }
        case 'resolveReference': {
          // Accept the ref at top level (legacy sendToBackground) or inside the
          // envelope payload (QuranMsg.sendRequest from the panel).
          const r = QuranReferences.resolve(msg.ref ?? msg.payload?.ref, indexes);
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
        case 'alternateRefs': {
          // Lazy companion to the green verify path: where else this exact /
          // near text appears, for the hover tooltip's "also/partially in …"
          // lines. Deferred off the scan because it is O(words²) per verse.
          const t1 = tier1Normalize(String(msg.text || '').replace(/\*/g, ' '));
          const words = t1.split(' ').filter(w => w.length > 0);
          if (words.length === 0) return { allExactRefs: [], allPartialRefs: [] };
          return findAllGlobalMatches(t1, words);
        }
        case 'ping':
          return { ok: true, indexReady: indexes !== null };
        case 'logFindings': {
          // Findings dump is its own (debug) level — guard so the strings
          // aren't built when the level is below debug.
          if (QuranLog.enabled('debug')) {
            const flog = QuranLog.scope('findings');
            const findings = msg.findings || [];
            flog.debug(`${findings.length} total ─────────────`);
            for (const f of findings) {
              flog.debug(
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

// Go through ensureInitialized (NOT loadAndIndex directly) so install,
// activate, and the top-level warm-up below all share the one initPromise —
// otherwise a fresh install/reload races 2–3 concurrent full index builds.
self.addEventListener('install', () => {
  ensureInitialized().catch(err => QuranLog.error('install index load failed:', err));
});

self.addEventListener('activate', () => {
  ensureInitialized().catch(err => QuranLog.error('activate index load failed:', err));
});

// Keep-alive: content scripts hold a long-lived port (see content.js). An open
// port resets the worker's idle-eviction timer, so while any page with the
// extension is visible the worker stays warm and skips the cold-start latency
// (which on a resource-starved browser — e.g. many tabs — was observed at
// 20–90s). The port carries no messages; its mere existence is the keep-alive.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'quran-keepalive') return;
  // Listening for disconnect is enough to hold the reference; no work to do.
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
});

// Eager warm-up on every worker startup. `install`/`activate` only fire on
// (re)install, NOT when the worker is woken from eviction by an incoming
// message — so without this, the first scan after an idle eviction would build
// the index synchronously mid-scan (the ~6s cold-start spike). Kicking off the
// build at top-level script evaluation runs on every wake; ensureInitialized()
// awaits the same initPromise, so verify calls never trigger a second build.
// info: one line per worker wake — pair it with the "Index ready — cold start"
// line to see how often the worker is evicted/restarted and what each rebuild
// costs. trace: a marker right after importScripts; comparing it with the
// content script's "maybeAutoscan @ …" send time isolates Chrome's
// worker-START latency (the dominant cold-start cost on a busy browser).
QuranLog.scope('sw-eval').trace(`post-importScripts @ ${new Date().toISOString()}`);
QuranLog.scope('boot').info(`worker boot @ ${new Date().toISOString()}`);
ensureInitialized().catch(() => {});
