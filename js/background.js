'use strict';

// T006/T015/T027 — Load shared modules before any other code runs.
// Paths are relative to this file's URL (chrome-extension://<id>/js/background.js),
// so they resolve inside the js/ directory — no 'js/' prefix needed.
importScripts(
  'shared/messaging.js',      // QuranMsg
  'verifier/normalize.js',    // QuranNormalize
  'verifier/indexes.js',      // QuranIndexes
  'verifier/references.js',   // QuranReferences
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

// Tolerates a single long-vowel (ا و) insertion/deletion between two tier-1 words.
// Absorbs Uthmani-vs-standard drift: ٰ→ا adds alef (كذالك vs كذلك),
// and Uthmani spellings like الربوا vs standard الربا add waw.
function softEqualWord(a, b) {
  if (a === b) return true;
  const diff = a.length - b.length;
  if (diff !== 1 && diff !== -1) return false;
  const [shorter, longer] = diff < 0 ? [a, b] : [b, a];
  for (let i = 0; i < longer.length; i++) {
    if (longer[i] !== 'ا' && longer[i] !== 'و') continue;
    if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return true;
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

function wordEditDistance(a, b, maxDiffs) {
  if (Math.abs(a.length - b.length) > maxDiffs) return null;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1), curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
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

function tier1MatchInClaimedAyahs(candidateText, candidateWords, resolved) {
  const { surahNum, ayahNums } = resolved;
  const records = ayahNums.map(n => indexes.byRef[surahNum]?.[n]).filter(Boolean);
  if (records.length === 0) return null;
  const candT1 = tier1Normalize(candidateText);

  if (records.length === 1) {
    const rec = records[0];
    if (rec.tier1 === candT1) return { rec, displayRef: rec.ref, deviation: classifyDeviation(rec.text, candidateText) };
    if (isContiguousSoftSubsequence(rec.tier1Words, candidateWords)) return { rec, displayRef: rec.ref, deviation: 'spellingDrift' };
    return null;
  }

  // Multi-ayah: flat-word match across combined range
  const allWords = [], wordToAyah = [];
  for (const rec of records) {
    for (const w of rec.tier1Words) { allWords.push(w); wordToAyah.push(rec.ayahNum); }
  }
  let matchStart = -1;
  outer: for (let i = 0; i <= allWords.length - candidateWords.length; i++) {
    if (!softEqualWord(allWords[i], candidateWords[0])) continue;
    for (let j = 1; j < candidateWords.length; j++) if (!softEqualWord(allWords[i + j], candidateWords[j])) continue outer;
    matchStart = i;
    break;
  }
  if (matchStart === -1) return null;
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

// ── Result builder ────────────────────────────────────────────────────────────

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
  if (!candidateText) return makeResult({ color: null, candidateConfidence });
  const t1 = tier1Normalize(candidateText.replace(/\*/g, ' '));
  const words = t1.split(' ').filter(w => w.length > 0);
  if (words.length === 0) return makeResult({ color: null, candidateConfidence });

  const exactRecs = findExactGlobal(t1);
  if (exactRecs.length > 0) {
    const sorted = exactRecs.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
    return makeResult({ color: 'lightBlue', matchedRef: sorted[0].ref, matchedRefs: sorted.map(r => r.ref), authenticText: sorted[0].text, deviation: classifyDeviation(sorted[0].text, candidateText), candidateConfidence, matchType: 'exact' });
  }

  const orderedRecs = findOrderedContiguousGlobal(words);
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

function verifyFragmentByRef(candidateText, refString, candidateConfidence = 'medium') {
  if (!candidateText) return makeResult({ color: null, candidateConfidence, claimedRef: refString });
  const resolved = QuranReferences.resolve(refString, indexes);
  const t1 = tier1Normalize(candidateText.replace(/\*/g, ' '));
  const words = t1.split(' ').filter(w => w.length > 0);
  if (words.length === 0) return makeResult({ color: null, candidateConfidence, claimedRef: refString });
  if (!resolved) return verifyFragment(candidateText, candidateConfidence);

  const t1InClaimed = tier1MatchInClaimedAyahs(candidateText, words, resolved);
  if (t1InClaimed) return makeResult({ color: 'green', matchedRef: t1InClaimed.displayRef, claimedRef: refString, authenticText: t1InClaimed.rec.text, deviation: t1InClaimed.deviation, candidateConfidence, matchType: 'exact' });

  const wlInClaimed = wordLevelMatchInClaimedAyahs(words, resolved);
  if (wlInClaimed) return makeResult({ color: 'yellow', matchedRef: wlInClaimed.rec.ref, claimedRef: refString, authenticText: wlInClaimed.rec.text, deviation: 'wordLevel', candidateConfidence, matchType: 'partial' });

  if (candidateConfidence === 'high') {
    const claimedKeys = new Set(resolved.ayahNums.map(n => `${resolved.surahNum}:${n}`));
    let globalRecs = findExactGlobal(t1);
    if (globalRecs.length === 0) globalRecs = findOrderedContiguousGlobal(words);
    const elsewhere = globalRecs.filter(r => !claimedKeys.has(`${r.surahNum}:${r.ayahNum}`));
    if (elsewhere.length > 0) {
      const sorted = elsewhere.slice().sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);
      return makeResult({ color: 'orange', matchedRef: sorted[0].ref, matchedRefs: sorted.map(r => r.ref), claimedRef: refString, authenticText: sorted[0].text, deviation: 'none', candidateConfidence, matchType: 'exact' });
    }
  }

  const wlGlobal = wordLevelMatchGlobal(words);
  if (wlGlobal.length > 0) {
    const sorted = wlGlobal.slice().sort((a, b) => a.diffs - b.diffs || a.rec.surahNum - b.rec.surahNum);
    return makeResult({ color: 'yellow', matchedRef: sorted[0].rec.ref, matchedRefs: sorted.slice(0, 3).map(r => r.rec.ref), claimedRef: refString, authenticText: sorted[0].rec.text, deviation: 'wordLevel', candidateConfidence, matchType: 'partial' });
  }

  if (candidateConfidence === 'high') return makeResult({ color: 'red', claimedRef: refString, candidateConfidence, matchType: 'none' });
  return makeResult({ color: null, claimedRef: refString, candidateConfidence, matchType: 'none' });
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
          return verifyFragmentByRef(msg.text, msg.ref, msg.candidateConfidence);
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
