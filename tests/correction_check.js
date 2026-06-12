'use strict';
/*
 * V1.2 correction/autocorrect assertion gate (T201).
 * ---------------------------------------------------------------------------
 * Reuses the autocomplete_check / interaction_check harness: system Chromium +
 * MV3 chrome mock + ORIGIN routing, loading the REAL background verifier.
 *
 * P1 coverage (this commit) — pure-information verifier outputs, no page edits:
 *   - yellow `diff`: an aligned word-level op list (keep/missing/extra/sub) so the
 *     panel can show النص/الصواب (design §2a).
 *   - red `nearMatch`: a fuzzy "did you mean …?" suggestion (design §3).
 * Ground truth is derived from the shipped index (Principle I) — verses are never
 * hand-typed; only deliberate drift/gibberish tokens are.
 *
 * Run: node tests/correction_check.js
 */
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) {
  console.error('ERROR: Playwright not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const TESTS_DIR = __dirname;
const PROJECT_DIR = path.resolve(TESTS_DIR, '..');
const ORIGIN = 'http://quran.test';

const BACKGROUND_DEPS = [
  'js/shared/log.js', 'js/shared/messaging.js', 'js/verifier/normalize.js',
  'js/verifier/indexes.js', 'js/verifier/references.js', 'js/verifier/classify.js',
  'js/verifier/orange.js', 'js/storage/prefs.js', 'js/storage/persisted.js', 'js/badge/badge.js',
];

function chromeMockSource() {
  return `
  (function () {
    const listeners = [];
    const store = Object.assign({}, window.__seedStorage || {});
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    function dispatch(message, callback) {
      let answered = false, willAsync = false;
      const sendResponse = (resp) => { if (answered) return; answered = true; window.chrome.runtime.lastError = undefined; if (callback) setTimeout(() => callback(clone(resp)), 0); };
      for (const fn of listeners.slice()) { let ret; try { ret = fn(clone(message), { id: 'mock' }, sendResponse); } catch (e) {} if (ret === true) willAsync = true; if (answered) break; }
      if (!answered && !willAsync && callback) { window.chrome.runtime.lastError = { message: 'no response' }; setTimeout(() => { callback(undefined); window.chrome.runtime.lastError = undefined; }, 0); }
    }
    window.chrome = {
      runtime: {
        lastError: undefined, id: 'mock-extension-id',
        getURL: (p) => '${ORIGIN}/' + String(p).replace(/^\\/+/, ''),
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onConnect: { addListener: () => {} }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} },
        sendMessage: (message, callback) => { if (typeof callback === 'function') { dispatch(message, callback); return; } return new Promise((resolve) => dispatch(message, resolve)); },
        connect: () => ({ name: '', onDisconnect: { addListener: () => {} }, disconnect: () => {} }),
      },
      storage: { local: {
        get: (keys, cb) => { const out = {}; const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys); for (const k of list) out[k] = (k in store) ? clone(store[k]) : (typeof keys === 'object' && keys ? keys[k] : undefined); if (cb) { setTimeout(() => cb(out), 0); return; } return Promise.resolve(out); },
        set: (obj, cb) => { Object.assign(store, clone(obj)); if (cb) { setTimeout(cb, 0); return; } return Promise.resolve(); },
        remove: (keys, cb) => { for (const k of [].concat(keys)) delete store[k]; if (cb) { setTimeout(cb, 0); return; } return Promise.resolve(); },
      } },
      tabs: { query: (q, cb) => { const t = [{ id: 1, url: location.href }]; if (cb) { setTimeout(() => cb(t), 0); return; } return Promise.resolve(t); }, sendMessage: (tabId, message, callback) => window.chrome.runtime.sendMessage(message, callback) },
      action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve(), setTitle: () => Promise.resolve() },
    };
    window.importScripts = function () {};
  })();
  `;
}

function buildRunnerHtml(seed) {
  const scripts = [...BACKGROUND_DEPS, 'js/background.js'].map(p => `<script src="${ORIGIN}/${p}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<script>window.__seedStorage = ${JSON.stringify(seed || {})};</script>
<script>${chromeMockSource()}</script>
</head><body><div id="host"></div>
${scripts}
</body></html>`;
}

async function launchSystemChromium() {
  const env = process.env.QURAN_TEST_BROWSER;
  if (env && fs.existsSync(env)) return chromium.launch({ headless: true, executablePath: env });
  const home = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    home && `${home}/Google/Chrome/Application/chrome.exe`,
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return chromium.launch({ headless: true, executablePath: p });
  return chromium.launch({ headless: true });
}

async function inPageTests() {
  const results = [];
  const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });
  const send = (msg) => new Promise(r => chrome.runtime.sendMessage(msg, r));

  let ready = false;
  for (let i = 0; i < 200; i++) { const p = await send({ type: 'ping' }); if (p && p.indexReady) { ready = true; break; } await new Promise(r => setTimeout(r, 25)); }
  T('background index ready', ready);
  if (!ready) return results;

  const t1 = (w) => QuranNormalize.tier1(w);

  // Known verse: Ayat al-Kursi (البقرة:255). Authentic text from the index.
  const ayah = await send({ type: 'getAyahText', surahNum: 2, ayahNum: 255 });
  T('getAyahText(2,255) returns text', ayah && ayah.text, JSON.stringify(ayah));
  if (!ayah || !ayah.text) return results;
  const verseWords = ayah.text.split(/\s+/).filter(Boolean);

  // ── P1a: yellow aligned diff (design §2a) ──────────────────────────────────
  // Substitute ONE interior word of a 7-word leading fragment with a clearly
  // non-Quranic, length-distinct token (so it is neither equal nor soft-equal —
  // a true word-level deviation, not tolerated spelling drift). Claimed against
  // البقرة:255 → exactly ONE diff (allowedDiffs = floor(7/8)→1) → yellow, and
  // `diff` must align it with a single `sub` and otherwise `keep`.
  {
    const base = verseWords.slice(0, 7);
    const foreigns = ['برثقومةٌ', 'ثقثقثقث', 'غضغضغضغ'];
    const target = base[3];
    const foreign = foreigns.find(f => Math.abs(t1(f).length - t1(target).length) >= 2) || foreigns[0];
    const drifted = base.slice(); drifted[3] = foreign;
    const r = await send({ type: 'verifyFragmentByRef', text: drifted.join(' '), ref: 'البقرة:255', candidateConfidence: 'high' });
    T('P1a one-word-substitution fragment classifies yellow', r && r.color === 'yellow', JSON.stringify({ color: r && r.color }));
    T('P1a yellow result carries an aligned diff op list', r && Array.isArray(r.diff) && r.diff.length > 0, JSON.stringify(r && r.diff));
    if (r && Array.isArray(r.diff)) {
      T('P1a diff ops are drawn only from keep/missing/extra/sub',
        r.diff.every(d => ['keep', 'missing', 'extra', 'sub'].includes(d.op)), JSON.stringify(r.diff));
      T('P1a diff has at least one non-keep op (the drift is surfaced)',
        r.diff.some(d => d.op !== 'keep'), JSON.stringify(r.diff.map(d => d.op)));
      const subOp = r.diff.find(d => d.op === 'sub' && d.cited === foreign);
      T('P1a a substitution pairs the cited foreign word with the authentic word',
        !!subOp && !!subOp.authentic && subOp.authentic !== foreign, JSON.stringify(subOp));
      const keeps = r.diff.filter(d => d.op === 'keep').length;
      T('P1a the unchanged words are aligned as keep', keeps >= 4, 'keeps=' + keeps);
    }
  }

  // ── P1a-missing: a dropped word surfaces as a `missing` diff op (SC-002) ────
  // Remove ONE interior word from a 7-word leading fragment, claim it against
  // البقرة:255. The citation omits a word the ayah has → exactly one word-level
  // diff (within the yellow budget) → yellow, and the diff must carry a `missing`
  // op (authentic word present, no cited counterpart).
  {
    const base = verseWords.slice(0, 7);
    const drifted = base.slice(0, 3).concat(base.slice(4)); // drop index 3
    const r = await send({ type: 'verifyFragmentByRef', text: drifted.join(' '), ref: 'البقرة:255', candidateConfidence: 'high' });
    T('P1a-missing dropped-word fragment classifies yellow', r && r.color === 'yellow', JSON.stringify({ color: r && r.color }));
    if (r && Array.isArray(r.diff)) {
      const miss = r.diff.find(d => d.op === 'missing');
      T('P1a-missing diff carries a missing op for the dropped word',
        !!miss && !!miss.authentic && miss.cited == null, JSON.stringify(miss || r.diff.map(d => d.op)));
    }
  }

  // ── P1a-extra: an inserted foreign word surfaces as an `extra` diff op ───────
  // Insert ONE non-Quranic token into a 6-word leading fragment → one word-level
  // diff → yellow, and the diff must carry an `extra` op (cited word struck, no
  // authentic counterpart).
  {
    const base = verseWords.slice(0, 6);
    const drifted = base.slice(0, 3).concat(['برثقومةٌ'], base.slice(3)); // insert at index 3
    const r = await send({ type: 'verifyFragmentByRef', text: drifted.join(' '), ref: 'البقرة:255', candidateConfidence: 'high' });
    T('P1a-extra inserted-word fragment classifies yellow', r && r.color === 'yellow', JSON.stringify({ color: r && r.color }));
    if (r && Array.isArray(r.diff)) {
      const extra = r.diff.find(d => d.op === 'extra' && d.cited === 'برثقومةٌ');
      T('P1a-extra diff carries an extra op for the inserted word',
        !!extra && extra.authentic == null, JSON.stringify(extra || r.diff.map(d => d.op)));
    }
  }

  // ── P1a-trailing: a substituted LAST word surfaces as `sub`, not `extra` ─────
  // Regression for the bestAlignWindow tie-break: when the final cited word is
  // wrong, the L=candLen-1 window (drops it as `extra`) and the L=candLen window
  // (renders a `sub`) tie on edit distance. The aligner must prefer the
  // equal-length window so the overlay shows the authentic replacement, not a
  // bare strike. Substitute the trailing word of a 7-word fragment → one diff →
  // yellow, and the diff must carry a `sub` pairing the foreign word.
  {
    const base = verseWords.slice(0, 7);
    const foreigns = ['برثقومةٌ', 'ثقثقثقث', 'غضغضغضغ'];
    const target = base[6];
    const foreign = foreigns.find(f => Math.abs(t1(f).length - t1(target).length) >= 2) || foreigns[0];
    const drifted = base.slice(); drifted[6] = foreign;
    const r = await send({ type: 'verifyFragmentByRef', text: drifted.join(' '), ref: 'البقرة:255', candidateConfidence: 'high' });
    T('P1a-trailing trailing-substitution fragment classifies yellow', r && r.color === 'yellow', JSON.stringify({ color: r && r.color }));
    if (r && Array.isArray(r.diff)) {
      const subOp = r.diff.find(d => d.op === 'sub' && d.cited === foreign);
      T('P1a-trailing trailing sub renders as a sub op with an authentic counterpart (not extra)',
        !!subOp && !!subOp.authentic && subOp.authentic !== foreign, JSON.stringify(subOp || r.diff.map(d => d.op)));
      T('P1a-trailing no spurious extra op for the trailing word',
        !r.diff.some(d => d.op === 'extra' && d.cited === foreign), JSON.stringify(r.diff.map(d => d.op)));
    }
  }

  // ── P1b: red near-match (design §3) ────────────────────────────────────────
  // TWO interior substitutions in a 7-word fragment exceed the word-level budget
  // (allowedDiffs 1) → red; the first/last words are untouched so the fuzzy probe
  // (looseDiffs 2) still resolves البقرة:255 as the near-match suggestion.
  {
    const base = verseWords.slice(0, 7);
    const fuzz = base.slice();
    fuzz[2] = 'برثقومةٌ';
    fuzz[4] = 'غضغضغضغ';
    const r = await send({ type: 'verifyFragmentByRef', text: fuzz.join(' '), ref: 'البقرة:255', candidateConfidence: 'high' });
    T('P1b two-substitution fragment classifies red', r && r.color === 'red', JSON.stringify({ color: r && r.color }));
    if (r && r.color === 'red') {
      T('P1b red result carries a nearMatch suggestion',
        r.nearMatch && r.nearMatch.refLabel && r.nearMatch.authenticText, JSON.stringify(r.nearMatch));
      T('P1b nearMatch suggests البقرة:255',
        r.nearMatch && r.nearMatch.refLabel === 'البقرة:255', r.nearMatch && r.nearMatch.refLabel);
      T('P1b nearMatch authentic text is the full verse from the index',
        r.nearMatch && r.nearMatch.authenticText === ayah.text, r.nearMatch && r.nearMatch.authenticText);
    }
  }

  // ── P1b-omit: mid-phrase omission keeps the correct cited words ─────────────
  // Drop TWO interior words (في آذانهم) from an 8-word authentic excerpt of
  // البقرة:19 ("يجعلون أصابعهم في آذانهم من الصواعق حذر الموت") → red (2 diffs
  // exceed the yellow budget). Regression for the bestAlignWindow tie-break:
  // the old length-gap-only rule tied at d=2 between the full 8-word window
  // (every cited word keeps + 2 missing) and a shifted 6-word window that
  // "aligns" by substituting the correct leading words يجعلون أصابعهم → في
  // آذانهم — so the suggested excerpt DROPPED the words the user got right.
  // Keeps-first tie-breaking must pick the full window: the excerpt restores
  // the omitted words and retains the correct ones.
  {
    const a19 = await send({ type: 'getAyahText', surahNum: 2, ayahNum: 19 });
    T('P1b-omit getAyahText(2,19) returns text', a19 && a19.text, JSON.stringify(a19));
    if (a19 && a19.text) {
      const disp = a19.text.split(/\s+/).filter(w => t1(w)); // display words, waqf-glyph tokens dropped
      const start = disp.findIndex(w => t1(w) === t1('يجعلون'));
      T('P1b-omit found the يجعلون excerpt in البقرة:19', start >= 0 && start + 8 <= disp.length, 'start=' + start);
      if (start >= 0) {
        const excerpt8 = disp.slice(start, start + 8);              // يجعلون … الموت
        const cited = excerpt8.slice(0, 2).concat(excerpt8.slice(4)); // drop في آذانهم
        const r = await send({ type: 'verifyFragmentByRef', text: cited.join(' '), ref: 'البقرة:19', candidateConfidence: 'high' });
        T('P1b-omit two-word omission classifies red', r && r.color === 'red', JSON.stringify({ color: r && r.color }));
        const t1join = (s) => String(s || '').split(/\s+/).map(t1).filter(Boolean).join(' ');
        T('P1b-omit nearMatch suggests البقرة:19',
          r && r.nearMatch && r.nearMatch.refLabel === 'البقرة:19', JSON.stringify(r && r.nearMatch && r.nearMatch.refLabel));
        T('P1b-omit suggested excerpt is the FULL 8-word window (retains يجعلون أصابعهم)',
          r && r.nearMatch && t1join(r.nearMatch.authenticExcerpt) === t1join(excerpt8.join(' ')),
          JSON.stringify({ got: r && r.nearMatch && r.nearMatch.authenticExcerpt, want: excerpt8.join(' ') }));
      }
    }
  }

  // ── P1c: red near-match recovers a copy-paste–doubled authentic phrase ──────
  // A whole-array duplication (the authentic phrase cited twice back-to-back) is
  // ~2× too long for every alignment window, so the fuzzy probe finds nothing.
  // collapseAdjacentRepeat + re-verify must still surface the single authentic
  // excerpt as the "did you mean …?" suggestion, tagged `duplicated`. Ground
  // truth: a 6-word contiguous excerpt of البقرة:255 (آية الكرسي), doubled.
  {
    const phrase = verseWords.slice(2, 8);                 // authentic 6-word excerpt
    const doubled = phrase.concat(phrase).join(' ');       // cited twice back-to-back
    const r = await send({ type: 'verifyFragmentByRef', text: doubled, ref: 'البقرة:255', candidateConfidence: 'high' });
    T('P1c doubled authentic phrase classifies red', r && r.color === 'red', JSON.stringify({ color: r && r.color }));
    if (r && r.color === 'red') {
      T('P1c nearMatch recovered despite duplication',
        r.nearMatch && r.nearMatch.refLabel === 'البقرة:255', JSON.stringify(r.nearMatch));
      T('P1c nearMatch is flagged duplicated',
        r.nearMatch && r.nearMatch.duplicated === true, JSON.stringify(r.nearMatch && r.nearMatch.duplicated));
      // De-duplicated: the excerpt is ~one copy of the phrase (±1 for dropped
      // waqf/pause glyph tokens), strictly shorter than the doubled citation.
      const exWords = r.nearMatch && typeof r.nearMatch.authenticExcerpt === 'string'
        ? r.nearMatch.authenticExcerpt.split(/\s+/).filter(Boolean).length : 0;
      T('P1c suggested excerpt is the single (de-duplicated) authentic phrase',
        exWords >= phrase.length - 1 && exWords <= phrase.length,
        JSON.stringify({ exWords, expected: phrase.length, excerpt: r.nearMatch && r.nearMatch.authenticExcerpt }));
    }
  }

  // ── T024a: revert roundtrip — a text-replace correction persists with its
  // payload and Revert clears exactly that entry (FR-006), leaving a dismissal
  // for the same finding untouched; a cleared entry can't re-apply on revisit
  // (FR-021). Exercises the storage contract directly via QuranPersisted.
  if (typeof QuranPersisted !== 'undefined') {
    const key = QuranPersisted.urlKey('http://quran.test/revert-roundtrip');
    const at = new Date().toISOString();
    await QuranPersisted.write({ urlKey: key, compositeKey: 'yk1', kind: 'text-replace', at, payload: { authenticExcerpt: 'أ ب', originalCitedText: 'أ ج' } });
    await QuranPersisted.write({ urlKey: key, compositeKey: 'yk1', kind: 'dismissal', at });
    let read = await QuranPersisted.read(key);
    const tr = read.entries.find(e => e.kind === 'text-replace' && e.compositeKey === 'yk1');
    T('T024a text-replace persisted with payload',
      tr && tr.payload && tr.payload.authenticExcerpt === 'أ ب' && tr.payload.originalCitedText === 'أ ج', JSON.stringify(tr));
    const rem = await QuranPersisted.remove({ urlKey: key, compositeKey: 'yk1', kind: 'text-replace' });
    T('T024a revert reports the entry was removed', rem && rem.removed === true, JSON.stringify(rem));
    read = await QuranPersisted.read(key);
    T('T024a text-replace entry cleared after revert (no re-apply on revisit)',
      !read.entries.some(e => e.kind === 'text-replace' && e.compositeKey === 'yk1'), JSON.stringify(read.entries));
    T('T024a dismissal for the same finding untouched by revert',
      read.entries.some(e => e.kind === 'dismissal' && e.compositeKey === 'yk1'), JSON.stringify(read.entries));
  }

  // ── T027/T033: reference-attribution persists its resolved ref and reverts ──
  // cleanly (FR-008/FR-006). No DOM payload — only the chosen ref is stored so a
  // revisit can re-attribute the exact reference the user picked (FR-021).
  if (typeof QuranPersisted !== 'undefined') {
    const key = QuranPersisted.urlKey('http://quran.test/lightblue-attrib');
    const at = new Date().toISOString();
    await QuranPersisted.write({ urlKey: key, compositeKey: 'lb1', kind: 'reference-attribution', at, payload: { resolvedRef: 'الرحمن:13' } });
    let read = await QuranPersisted.read(key);
    const ra = read.entries.find(e => e.kind === 'reference-attribution' && e.compositeKey === 'lb1');
    T('T027 reference-attribution persists the chosen ref',
      ra && ra.payload && ra.payload.resolvedRef === 'الرحمن:13', JSON.stringify(ra));
    const rem = await QuranPersisted.remove({ urlKey: key, compositeKey: 'lb1', kind: 'reference-attribution' });
    T('T027 revert removes the reference-attribution entry', rem && rem.removed === true, JSON.stringify(rem));
    read = await QuranPersisted.read(key);
    T('T027 reference-attribution cleared after revert',
      !read.entries.some(e => e.kind === 'reference-attribution' && e.compositeKey === 'lb1'), JSON.stringify(read.entries));
  }

  // ── Guard: non-yellow/non-red results are NOT enriched ──────────────────────
  {
    const r = await send({ type: 'verifyFragmentByRef', text: verseWords.slice(0, 5).join(' '), ref: 'البقرة:255', candidateConfidence: 'high' });
    T('green/exact result carries no spurious diff/nearMatch',
      r && (r.color === 'green' || r.color === 'lightBlue') && r.diff == null && r.nearMatch == null,
      JSON.stringify({ color: r && r.color, diff: r && r.diff, nearMatch: r && r.nearMatch }));
  }

  return results;
}

async function main() {
  const browser = await launchSystemChromium();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const runnerHtml = buildRunnerHtml({});

  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/runner') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: runnerHtml });
    const filePath = path.join(PROJECT_DIR, url.pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(PROJECT_DIR) || !fs.existsSync(filePath)) return route.fulfill({ status: 404, body: 'not found' });
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.js' ? 'application/javascript' : ext === '.json' ? 'application/json' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(filePath) });
  });
  await page.route('**/*', (route) => route.request().url().startsWith(ORIGIN) ? route.fallback() : route.abort());

  let results;
  try {
    await page.goto(`${ORIGIN}/runner`, { waitUntil: 'load', timeout: 20000 });
    results = await page.evaluate(`(${inPageTests.toString()})()`);
  } finally {
    await context.close();
    await browser.close();
  }

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\ncorrection: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
