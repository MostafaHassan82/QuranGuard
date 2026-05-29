'use strict';
/*
 * Writer-side ayah autocomplete assertion gate (feature 003).
 * ---------------------------------------------------------------------------
 * Reuses the run_tests_node / interaction_check harness pattern: system Chromium
 * + the MV3 chrome mock + ORIGIN asset routing, loading the REAL background +
 * (when present) the compose bundle into one page.
 *
 * Incremental coverage:
 *   T004/T010 (this commit) — MATCH_PARTIAL against the real Quran index:
 *     any-part-of-any-verse matching, exact tier, tier+mushaf ranking, empty in.
 *   T011-T029 (later) — synthetic typing into <input>/<textarea>/contenteditable,
 *     dropdown ranking, insertion scopes, instance dismissal, fall-through.
 *
 * Run: node tests/autocomplete_check.js
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
// Compose bundle is loaded only once the modules exist (forward-compatible).
// js/render/fonts.js precedes the compose modules in the real manifest; include
// it so render-editable.js can resolve the Quran font family (FR-018).
const COMPOSE_BUNDLE = [
  'js/render/fonts.js',
  'js/compose/editable.js', 'js/compose/detect.js', 'js/compose/match.js',
  'js/compose/dropdown.js', 'js/compose/insert.js', 'js/compose/render-editable.js',
  'js/compose/index.js',
].filter(p => fs.existsSync(path.join(PROJECT_DIR, p)));

// MV3 chrome mock — identical contract to interaction_check.js (kept in sync by hand).
function chromeMockSource() {
  return `
  (function () {
    const listeners = [];
    const connectListeners = [];
    const store = Object.assign({}, window.__seedStorage || {});
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    function dispatch(message, callback, senderOverride) {
      let answered = false, willAsync = false;
      const sendResponse = (resp) => {
        if (answered) return; answered = true;
        window.chrome.runtime.lastError = undefined;
        if (callback) setTimeout(() => callback(clone(resp)), 0);
      };
      for (const fn of listeners.slice()) {
        let ret; try { ret = fn(clone(message), senderOverride || { id: 'mock' }, sendResponse); } catch (e) {}
        if (ret === true) willAsync = true;
        if (answered) break;
      }
      if (!answered && !willAsync && callback) {
        window.chrome.runtime.lastError = { message: 'no response' };
        setTimeout(() => { callback(undefined); window.chrome.runtime.lastError = undefined; }, 0);
      }
    }
    window.chrome = {
      runtime: {
        lastError: undefined, id: 'mock-extension-id',
        getURL: (p) => '${ORIGIN}/' + String(p).replace(/^\\/+/, ''),
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onConnect: { addListener: (fn) => connectListeners.push(fn) },
        onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} },
        sendMessage: (message, callback) => {
          if (typeof callback === 'function') { dispatch(message, callback); return; }
          return new Promise((resolve) => dispatch(message, resolve));
        },
        connect: (info) => {
          const dl = [];
          const port = { name: (info && info.name) || '', onDisconnect: { addListener: (fn) => dl.push(fn) }, disconnect: () => { for (const fn of dl.slice()) try { fn(port); } catch (_) {} } };
          for (const fn of connectListeners.slice()) try { fn(port); } catch (_) {}
          return port;
        },
      },
      storage: { local: {
        get: (keys, cb) => {
          const out = {};
          const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
          for (const k of list) out[k] = (k in store) ? clone(store[k]) : (typeof keys === 'object' && keys ? keys[k] : undefined);
          if (cb) { setTimeout(() => cb(out), 0); return; } return Promise.resolve(out);
        },
        set: (obj, cb) => { Object.assign(store, clone(obj)); if (cb) { setTimeout(cb, 0); return; } return Promise.resolve(); },
        remove: (keys, cb) => { for (const k of [].concat(keys)) delete store[k]; if (cb) { setTimeout(cb, 0); return; } return Promise.resolve(); },
      } },
      tabs: {
        query: (q, cb) => { const t = [{ id: 1, url: location.href }]; if (cb) { setTimeout(() => cb(t), 0); return; } return Promise.resolve(t); },
        sendMessage: (tabId, message, callback) => window.chrome.runtime.sendMessage(message, callback),
      },
      action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve(), setTitle: () => Promise.resolve() },
    };
    window.importScripts = function () {};
  })();
  `;
}

function buildRunnerHtml(seed) {
  const scripts = [...BACKGROUND_DEPS, 'js/background.js', ...COMPOSE_BUNDLE]
    .map(p => `<script src="${ORIGIN}/${p}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<script>window.__seedStorage = ${JSON.stringify(seed || {})};</script>
<script>${chromeMockSource()}</script>
</head><body>
<div id="host"></div>
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

// In-page battery. Runs against the real background index via the chrome mock.
async function inPageTests() {
  const results = [];
  const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });
  const send = (msg) => new Promise(r => chrome.runtime.sendMessage(msg, r));

  // Wait for the index to build.
  let ready = false;
  for (let i = 0; i < 200; i++) {
    const p = await send({ type: 'ping' });
    if (p && p.indexReady) { ready = true; break; }
    await new Promise(r => setTimeout(r, 25));
  }
  T('background index ready', ready);
  if (!ready) return results;

  // Known verse: Ayat al-Kursi (البقرة:255). Pull its authentic text from the
  // index so we never hand-type Quran (Principle I).
  const ayah = await send({ type: 'getAyahText', surahNum: 2, ayahNum: 255 });
  T('getAyahText(2,255) returns text', ayah && ayah.text, JSON.stringify(ayah));
  if (!ayah || !ayah.text) return results;
  const verseWords = ayah.text.split(/\s+/).filter(Boolean);

  // (a) Leading fragment (first 4 words) → exact match, البقرة:255 present & top-ranked.
  const lead = verseWords.slice(0, 4).join(' ');
  const r1 = await send({ type: 'MATCH_PARTIAL', text: lead, limit: 8 });
  const c1 = (r1 && r1.candidates) || [];
  const top = c1[0];
  T('leading fragment returns candidates', c1.length > 0, JSON.stringify(r1));
  T('البقرة:255 is top-ranked for the leading fragment',
    top && top.ref && top.ref.surah === 2 && top.ref.ayah === 255, JSON.stringify(top));
  T('top candidate tier is exact', top && top.tier === 'exact', top && top.tier);
  T('candidate carries authentic text + refLabel',
    top && top.authenticText === ayah.text && top.refLabel === ('البقرة:' + '255'),
    top && JSON.stringify({ refLabel: top.refLabel }));

  // (b) MID-verse fragment (words 5..9) → "any part of any verse" must still match البقرة:255.
  const mid = verseWords.slice(5, 9).join(' ');
  const r2 = await send({ type: 'MATCH_PARTIAL', text: mid, limit: 8 });
  const c2 = (r2 && r2.candidates) || [];
  T('mid-verse fragment matches البقرة:255 (any part of any verse)',
    c2.some(c => c.ref.surah === 2 && c.ref.ayah === 255), JSON.stringify(c2.slice(0, 3)));

  // (c) Ranking invariant: exact tier never ranks after a wordLevel tier.
  const ranks = c1.concat(c2);
  let monotone = true;
  const order = { exact: 0, wordLevel: 1, fuzzy: 2 };
  for (const list of [c1, c2]) {
    for (let i = 1; i < list.length; i++) if (order[list[i].tier] < order[list[i - 1].tier]) monotone = false;
  }
  T('candidates ordered tier-first (exact before wordLevel)', monotone, JSON.stringify(ranks.map(c => c.tier)));

  // (d) Empty / whitespace input → no candidates (no spurious suggestions).
  const r3 = await send({ type: 'MATCH_PARTIAL', text: '   ', limit: 8 });
  T('empty input yields no candidates', r3 && Array.isArray(r3.candidates) && r3.candidates.length === 0, JSON.stringify(r3));

  // (e) prefs.autocomplete is present with the ratified defaults.
  const prefsResp = await send({ type: 'PREFS_READ', requestId: 'ac1', payload: {} });
  const ac = prefsResp && prefsResp.payload && prefsResp.payload.result && prefsResp.payload.result.autocomplete;
  T('prefs.autocomplete defaults present', ac && ac.enabled === true && ac.liveRender === true
    && ac.refFormat === 'arabicName' && ac.refPlacement === 'after' && ac.minWords === 2, JSON.stringify(ac));

  // ── US1: synthetic typing → dropdown → accept (T011-T016, hook T008) ────────
  const composeLoaded = typeof window.__quranCompose === 'object' && window.__quranCompose
    && typeof window.__quranCompose.acceptSelected === 'function';
  T('compose orchestrator loaded (window.__quranCompose)', composeLoaded);
  if (composeLoaded) {
    const host = document.getElementById('host');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const waitCandidates = async () => {
      for (let i = 0; i < 80; i++) {
        if ((window.__quranCompose.candidates || []).length > 0) return true;
        await sleep(25);
      }
      return false;
    };
    const lead4 = verseWords.slice(0, 4).join(' ');

    // input field
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.id = 'ac-input';
    host.appendChild(inp);
    inp.focus();
    inp.value = 'قال تعالى: ' + lead4;
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const got = await waitCandidates();
    T('US1 typing a citation surfaces candidates', got, JSON.stringify(window.__quranCompose.candidates));
    const topRef = (window.__quranCompose.candidates[0] || {}).ref;
    T('US1 top candidate is البقرة:255', topRef === ('البقرة:' + '255'), topRef);
    T('US1 hook active state is suggesting', window.__quranCompose.active && window.__quranCompose.active.state === 'suggesting',
      window.__quranCompose.active && window.__quranCompose.active.state);
    window.__quranCompose.acceptSelected();
    await sleep(20);
    // FR-012a: accept now opens the scope menu instead of inserting immediately.
    T('US1 accept opens the scope menu (FR-012a)',
      window.__quranCompose.active && window.__quranCompose.active.state === 'scopeMenu',
      window.__quranCompose.active && window.__quranCompose.active.state);
    window.__quranCompose.chooseScope('whole');
    await sleep(20);
    T('US1 accept replaced typed text with authentic ayah', inp.value.includes(ayah.text), inp.value);
    T('US1 accept appended the (surahName:ayah) reference', inp.value.includes('(البقرة:255)'), inp.value);
    T('US1 lastInsertion recorded on the hook',
      window.__quranCompose.lastInsertion && window.__quranCompose.lastInsertion.ref === ('البقرة:' + '255')
      && window.__quranCompose.lastInsertion.scope === 'whole', JSON.stringify(window.__quranCompose.lastInsertion));
    T('US1 dropdown hidden after accept', (window.__quranCompose.candidates || []).length === 0);

    // min-word gate: a single Arabic word must NOT trigger suggestions
    const inp2 = document.createElement('input');
    inp2.type = 'text';
    host.appendChild(inp2);
    inp2.focus();
    inp2.value = 'قال تعالى: ' + verseWords[0];
    inp2.setSelectionRange(inp2.value.length, inp2.value.length);
    inp2.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(180);
    T('US1 min-word gate: 1 word → no dropdown', (window.__quranCompose.candidates || []).length === 0,
      JSON.stringify(window.__quranCompose.candidates));

    // contenteditable surface
    const ce = document.createElement('div');
    ce.contentEditable = 'true';
    ce.id = 'ac-ce';
    host.appendChild(ce);
    ce.textContent = 'قال تعالى: ' + lead4;
    ce.focus();
    // place caret at end of the text node
    const range = document.createRange();
    const tn = ce.firstChild;
    range.setStart(tn, tn.textContent.length);
    range.collapse(true);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ce.dispatchEvent(new Event('input', { bubbles: true }));
    const gotCe = await waitCandidates();
    T('US1 contenteditable surfaces candidates', gotCe, JSON.stringify(window.__quranCompose.candidates));
    T('US1 contenteditable surface reported on hook',
      window.__quranCompose.active && window.__quranCompose.active.surface === 'contenteditable',
      window.__quranCompose.active && window.__quranCompose.active.surface);
    if (gotCe) {
      window.__quranCompose.acceptSelected();
      await sleep(20);
      window.__quranCompose.chooseScope('whole');
      await sleep(20);
      T('US1 contenteditable accept inserted authentic ayah + ref',
        ce.textContent.includes(ayah.text) && ce.textContent.includes('(البقرة:255)'), ce.textContent);
      T('US1 contenteditable keeps the lead-in (start not dropped)',
        ce.textContent.includes('قال تعالى'), ce.textContent);
    }

    // contenteditable split across multiple text nodes (WhatsApp/Lexical shape):
    // the lead-in lives in one <span> and the ayah words in another. Reading only
    // the caret's single text node hid the lead-in and the dropdown never opened
    // (the reported bug); the block-scoped read fixes it.
    const ceSplit = document.createElement('div');
    ceSplit.contentEditable = 'true';
    ceSplit.id = 'ac-ce-split';
    const span1 = document.createElement('span');
    span1.textContent = 'قال تعالى: ';
    const span2 = document.createElement('span');
    span2.textContent = lead4;
    ceSplit.appendChild(span1);
    ceSplit.appendChild(span2);
    host.appendChild(ceSplit);
    ceSplit.focus();
    {
      const r = document.createRange();
      const tn2 = span2.firstChild;             // caret at end of the ayah-words node
      r.setStart(tn2, tn2.textContent.length);
      r.collapse(true);
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
    ceSplit.dispatchEvent(new Event('input', { bubbles: true }));
    const gotSplit = await waitCandidates();
    T('US1 contenteditable split-node surfaces candidates (WhatsApp shape)',
      gotSplit, JSON.stringify(window.__quranCompose.candidates));
    if (gotSplit) {
      window.__quranCompose.acceptSelected();
      await sleep(20);
      window.__quranCompose.chooseScope('whole');
      await sleep(20);
      T('US1 contenteditable split-node accept inserted authentic ayah + ref',
        ceSplit.textContent.includes(ayah.text) && ceSplit.textContent.includes('(البقرة:255)'),
        ceSplit.textContent);
      T('US1 contenteditable split-node keeps the lead-in (start not dropped)',
        ceSplit.textContent.includes('قال تعالى'), ceSplit.textContent);
    }

    // ── US2: insertion-scope menu (T017-T020) ──────────────────────────────────
    // Three scopes off one accepted candidate: whole / typedPortion /
    // startToEndWord, plus the end-word-not-found refusal (FR-015/016).
    // Ground truth is derived from the index (Principle I) — no hand-typed Quran.
    const lead5 = verseWords.slice(0, 5).join(' ');           // a clean exact-tier fragment
    const typedPortionAuthentic = lead5;                      // exact tier → typed == authentic words
    const setupCitation = async (text) => {
      const f = document.createElement('input');
      f.type = 'text';
      host.appendChild(f);
      f.focus();
      f.value = 'قال تعالى: ' + text;
      f.setSelectionRange(f.value.length, f.value.length);
      f.dispatchEvent(new Event('input', { bubbles: true }));
      await waitCandidates();
      window.__quranCompose.acceptSelected();
      await sleep(20);
      return f;
    };

    // (a) typedPortion → only the authentic words the typed fragment maps to
    // (NOT the whole verse), still with the reference.
    {
      const f = await setupCitation(lead5);
      const atScope = window.__quranCompose.active && window.__quranCompose.active.state === 'scopeMenu';
      T('US2 scope menu state reported on the hook', atScope, window.__quranCompose.active && window.__quranCompose.active.state);
      window.__quranCompose.chooseScope('typedPortion');
      await sleep(20);
      const ins = window.__quranCompose.lastInsertion;
      T('US2 typedPortion inserts only the typed span (authentic words, not whole verse)',
        ins && ins.scope === 'typedPortion' && f.value.includes(typedPortionAuthentic)
          && f.value.includes('(البقرة:255)') && !f.value.includes(ayah.text),
        JSON.stringify({ value: f.value, ins }));
    }

    // (b) startToEndWord → from the typed start through a chosen end word.
    // Pick the first verse word after the typed start whose normalized form is
    // unique (no earlier duplicate), so the expected slice is deterministic.
    {
      const vn = verseWords.map(w => QuranNormalize.tier1(w));
      let endIdx = -1;
      for (let i = 3; i < vn.length - 1; i++) { if (vn.indexOf(vn[i]) === i) { endIdx = i; break; } }
      const f = await setupCitation(verseWords.slice(0, 3).join(' '));
      window.__quranCompose.chooseScope('startToEndWord');
      await sleep(20);
      window.__quranCompose.submitEndWord(verseWords[endIdx]);
      await sleep(20);
      const ins = window.__quranCompose.lastInsertion;
      const expected = verseWords.slice(0, endIdx + 1).join(' ');
      T('US2 startToEndWord inserts start-through-end-word passage',
        endIdx > 0 && ins && ins.scope === 'startToEndWord'
          && f.value.includes(expected) && f.value.includes('(البقرة:255)') && !f.value.includes(ayah.text),
        JSON.stringify({ value: f.value, expected, endIdx, ins }));
    }

    // (c) end word not in the verse → refuse, no truncated insert (FR-016).
    {
      const f = await setupCitation(verseWords.slice(0, 3).join(' '));
      const before = f.value;
      window.__quranCompose.chooseScope('startToEndWord');
      await sleep(20);
      window.__quranCompose.submitEndWord('زقزقةٌ');           // not a word of this verse
      await sleep(20);
      T('US2 end-word-not-found makes no insertion (FR-016)',
        f.value === before && (!window.__quranCompose.lastInsertion
          || window.__quranCompose.lastInsertion.scope !== 'startToEndWord'
          || window.__quranCompose.lastInsertion.insertedText.indexOf('زقزقةٌ') === -1),
        JSON.stringify({ before, after: f.value }));
      T('US2 end-word-not-found keeps the prompt open (state scopeMenu)',
        window.__quranCompose.active && window.__quranCompose.active.state === 'scopeMenu',
        window.__quranCompose.active && window.__quranCompose.active.state);
    }

    // ── US3: drift cascade + not-recognized flag (T021-T024) ────────────────────
    // The cascade is exact → wordLevel → fuzzy → none. Ground truth is derived
    // from the index (Principle I); the only hand-typed strings are the lead-in
    // and deliberately NON-Quranic drift/gibberish tokens.
    const waitFor = async (pred) => {
      for (let i = 0; i < 80; i++) { if (pred()) return true; await sleep(25); }
      return false;
    };
    const t1 = (w) => QuranNormalize.tier1(w);

    // (a) Word-level drift: drop one written alef from an INTERIOR word of a clean
    // exact fragment. The exact contiguous match then fails, but the soft (one-
    // letter drift) contiguous match still resolves البقرة:255 → wordLevel tier.
    {
      const base = verseWords.slice(0, 5);
      let drifted = null;
      for (let i = 1; i < base.length - 1; i++) {        // interior words; keep anchors clean
        const w = base[i];
        const ai = w.indexOf('ا');
        if (ai < 0) continue;
        const cand = w.slice(0, ai) + w.slice(ai + 1);   // remove one alef
        if (cand && t1(cand) && t1(cand) !== t1(w)) { drifted = base.slice(); drifted[i] = cand; break; }
      }
      T('US3 a word-level drift fragment was constructible from the index', !!drifted);
      if (drifted) {
        const f = document.createElement('input');
        f.type = 'text';
        host.appendChild(f);
        f.focus();
        f.value = 'قال تعالى: ' + drifted.join(' ');
        f.setSelectionRange(f.value.length, f.value.length);
        f.dispatchEvent(new Event('input', { bubbles: true }));
        await waitFor(() => (window.__quranCompose.candidates || []).length > 0);
        const cs = window.__quranCompose.candidates || [];
        T('US3 word-level drift offers البقرة:255 as a wordLevel candidate (FR-007)',
          cs.some(c => c.ref === 'البقرة:255' && c.tier === 'wordLevel'), JSON.stringify(cs));
        T('US3 word-level drift offers no exact candidate for البقرة:255',
          !cs.some(c => c.ref === 'البقرة:255' && c.tier === 'exact'), JSON.stringify(cs));
      }
    }

    // (b) Fuzzy: substitute an interior word with a clearly non-Quranic token of
    // distinctly different length (so it is neither equal nor one-letter-soft-equal
    // to the real word). The contiguous-soft match then breaks, but the loose edit-
    // distance match still resolves البقرة:255 → fuzzy tier.
    {
      const base = verseWords.slice(0, 5);
      const foreigns = ['برثقومةٌ', 'ثقثقثقث', 'غضغضغضغ'];
      const target = base[2];
      const foreign = foreigns.find(f => Math.abs(t1(f).length - t1(target).length) >= 2) || foreigns[0];
      const fuzz = base.slice(); fuzz[2] = foreign;
      const f = document.createElement('input');
      f.type = 'text';
      host.appendChild(f);
      f.focus();
      f.value = 'قال تعالى: ' + fuzz.join(' ');
      f.setSelectionRange(f.value.length, f.value.length);
      f.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(() => (window.__quranCompose.candidates || []).length > 0);
      const cs = window.__quranCompose.candidates || [];
      T('US3 a loosely-similar fragment offers البقرة:255 as a fuzzy candidate (FR-007)',
        cs.some(c => c.ref === 'البقرة:255' && c.tier === 'fuzzy'), JSON.stringify(cs));
    }

    // (c) No match: gibberish Arabic words after a lead-in → recognized citation,
    // zero candidates → records the fall-through verdict AND shows a non-destructive
    // "no matching ayah" note. CRITICAL: the user's text is NEVER touched.
    {
      const ce = document.createElement('div');
      ce.contentEditable = 'true';
      host.appendChild(ce);
      const original = 'قال تعالى: ثقثقثق غضغضغض';
      ce.textContent = original;
      ce.focus();
      const tn = ce.firstChild;
      const range = document.createRange();
      range.setStart(tn, tn.textContent.length);
      range.collapse(true);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      ce.dispatchEvent(new Event('input', { bubbles: true }));
      const flagged = await waitFor(() => {
        const lc = window.__quranCompose.lastClassification;
        return lc && lc.viaFallthrough === true && lc.verdict === 'red' && lc.ref === null;
      });
      T('US3 unmatched text → not-recognized red via fall-through (FR-008/011a)', flagged,
        JSON.stringify(window.__quranCompose.lastClassification));
      T('US3 unmatched text offers no candidates', (window.__quranCompose.candidates || []).length === 0,
        JSON.stringify(window.__quranCompose.candidates));
      T('US3 unmatched text NEVER deletes/alters the user text', ce.textContent === original, ce.textContent);
      T('US3 not-recognized shows a "no matching ayah" note (no field mutation)',
        !!(window.__quranCompose && window.__quranCompose.active && window.__quranCompose.active.state === 'classified')
          && document.querySelector('.quran-ac-note') && document.querySelector('.quran-ac-menu').style.display !== 'none',
        document.querySelector('.quran-ac-menu') && document.querySelector('.quran-ac-menu').innerHTML);
    }

    // ── Bug fixes (reported in manual testing) ──────────────────────────────────

    // (1) Ornate Quran brackets ﴿ ﴾ are valid citation delimiters — ﴿ (U+FD3F)
    // OPENS a quote. Typing the opener + verse words must surface candidates.
    {
      const f = document.createElement('input');
      f.type = 'text';
      host.appendChild(f);
      f.focus();
      f.value = 'قال تعالى: ﴿' + lead4;          // ﴿ = ﴿ ornate opener
      f.setSelectionRange(f.value.length, f.value.length);
      f.dispatchEvent(new Event('input', { bubbles: true }));
      const got = await waitFor(() => (window.__quranCompose.candidates || []).length > 0);
      T('ornate opening bracket ﴿ surfaces candidates', got, JSON.stringify(window.__quranCompose.candidates));
      T('ornate bracket offers البقرة:255',
        (window.__quranCompose.candidates || []).some(c => c.ref === 'البقرة:255'),
        JSON.stringify(window.__quranCompose.candidates));
    }

    // (1b) ANY quote/bracket the user opened — { ( [ « " “ … — must be emitted
    // BALANCED (no dangling opener), with the reference OUTSIDE, and the lead-in
    // preserved. Symmetric quotes (") close with themselves.
    for (const [open, close] of [['{', '}'], ['(', ')'], ['"', '"'], ['“', '”']]) {
      const f = document.createElement('input');
      f.type = 'text';
      host.appendChild(f);
      f.focus();
      f.value = 'قوله تعالى: ' + open + lead4;
      f.setSelectionRange(f.value.length, f.value.length);
      f.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(() => (window.__quranCompose.candidates || []).length > 0);
      window.__quranCompose.acceptSelected();
      await sleep(20);
      window.__quranCompose.chooseScope('whole');
      await sleep(20);
      T('opening ' + open + ' emits balanced ' + open + 'ayah' + close + ' (no dangling opener)',
        f.value.includes(open + ayah.text + close), f.value);
      T('balanced ' + open + ' keeps the lead-in and puts the ref outside',
        f.value.includes('قوله تعالى') && f.value.includes(close + ' (البقرة:255)'), f.value);
    }

    // (2b) typedPortion must keep ALL typed words even when the Uthmani spelling
    // drifts from the user's plainer typing (e.g. تُتْلَىٰ vs تتلى — a trailing
    // superscript-alef). Alignment uses the matcher's soft equality, so a soft-tier
    // candidate no longer aligns short. Authentic text comes from the index
    // (Principle I); only the user's imperfect typing is hand-written.
    {
      const j8 = await send({ type: 'getAyahText', surahNum: 45, ayahNum: 8 });
      T('getAyahText(45,8) returns text', j8 && j8.text, JSON.stringify(j8));
      if (j8 && j8.text) {
        const jw = j8.text.split(/\s+/).filter(Boolean);
        const typedPlain = 'يسمع آيات الله تتلى عليه';          // user's plain 5-word typing
        const cand = { authenticText: j8.text, ref: { surah: 45, ayah: 8 }, surahName: 'الجاثية' };
        const r = QuranComposeInsert.buildBody(cand, 'typedPortion', { typedText: typedPlain });
        const expected = jw.slice(0, 5).join(' ');
        T('typedPortion keeps all typed words across Uthmani drift (5 words, not 3)',
          r && r.body === expected, JSON.stringify({ body: r && r.body, expected }));
      }
    }

    // (2c) Mid-word narrowing (FR-006): "الحمد لله ر" (still typing "رب") must keep
    // matching الفاتحة:2 via the drop-trailing-partial-word fallback, not vanish.
    {
      const fatiha2 = await send({ type: 'getAyahText', surahNum: 1, ayahNum: 2 });
      T('getAyahText(1,2) returns text', fatiha2 && fatiha2.text, JSON.stringify(fatiha2));
      if (fatiha2 && fatiha2.text) {
        const fw = fatiha2.text.split(/\s+/).filter(Boolean);
        const partial = fw.slice(0, 2).join(' ') + ' ' + Array.from(fw[2])[0];  // 2 words + 1st letter of 3rd
        const r = await send({ type: 'MATCH_PARTIAL', text: partial, limit: 8 });
        const cs = (r && r.candidates) || [];
        T('partial trailing word still matches الفاتحة:2 (drop-last-word fallback)',
          cs.some(c => c.ref && c.ref.surah === 1 && c.ref.ayah === 2),
          JSON.stringify({ partial, cs: cs.slice(0, 3) }));
      }
    }

    // (2) Enter on the field while the menu is open accepts like a mouse click AND
    // is NOT passed to the host page (no newline / "send on Enter" leak).
    {
      const f = document.createElement('input');
      f.type = 'text';
      host.appendChild(f);
      f.focus();
      f.value = 'قال تعالى: ' + lead4;
      f.setSelectionRange(f.value.length, f.value.length);
      f.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(() => (window.__quranCompose.candidates || []).length > 0);
      let hostSawEnter = false;
      const hostKey = (ev) => { if (ev.key === 'Enter') hostSawEnter = true; };
      f.addEventListener('keydown', hostKey);
      f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(20);
      f.removeEventListener('keydown', hostKey);
      T('Enter on the field accepts like a click (opens scope menu)',
        window.__quranCompose.active && window.__quranCompose.active.state === 'scopeMenu',
        window.__quranCompose.active && window.__quranCompose.active.state);
      T('Enter is not passed through to the host page', hostSawEnter === false);
    }

    // (3) Typing/pasting into the end-word prompt must NOT tear down the instance
    // (regression: the prompt's own <input> fired document-level input → teardown),
    // and Enter on the prompt submits the pasted word.
    {
      const vn = verseWords.map(w => QuranNormalize.tier1(w));
      let endIdx = -1;
      for (let i = 3; i < vn.length - 1; i++) { if (vn.indexOf(vn[i]) === i) { endIdx = i; break; } }
      const f = await setupCitation(verseWords.slice(0, 3).join(' '));
      window.__quranCompose.chooseScope('startToEndWord');
      await sleep(20);
      const prompt = document.querySelector('.quran-ac-endword');
      T('end-word prompt input is present', !!prompt);
      if (prompt) {
        prompt.value = verseWords[endIdx];                 // simulate a paste landing in the prompt
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(150);                                  // > debounce: a stray teardown would have fired
        T('typing/pasting in the end-word prompt keeps the instance alive',
          window.__quranCompose.active && window.__quranCompose.active.state === 'scopeMenu',
          window.__quranCompose.active && window.__quranCompose.active.state);
        prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await sleep(20);
        const ins = window.__quranCompose.lastInsertion;
        const expected = verseWords.slice(0, endIdx + 1).join(' ');
        T('end-word Enter submits the pasted word and inserts the passage',
          endIdx > 0 && ins && ins.scope === 'startToEndWord' && f.value.includes(expected),
          JSON.stringify({ value: f.value, expected, ins }));
      }
    }

    // ── US4: live verdict + Quran-font rendering, fall-through, settings ────────
    // (T025-T029). Persistent markup in contenteditable (FR-018b), text-only skip
    // in plain inputs, pre-existing-on-focus (FR-018a), caret-away fall-through
    // (FR-011a), and the live-render settings toggle (FR-019).
    const setCaretEnd = (ce) => {
      const r = document.createRange();
      const tn = ce.firstChild;
      r.setStart(tn, tn.textContent.length); r.collapse(true);
      const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
    };
    const setLiveRender = async (on) => {
      await chrome.runtime.sendMessage({ type: 'PREFS_CHANGED', payload: { prefs: {
        autocomplete: { enabled: true, liveRender: on, refFormat: 'arabicName', refPlacement: 'after', minWords: 2 } } } });
      await sleep(10);
    };

    // (a) contenteditable accept → persistent verdict markup + Quran font (FR-018/018b).
    {
      const ce = document.createElement('div');
      ce.contentEditable = 'true';
      host.appendChild(ce);
      ce.textContent = 'قال تعالى: ' + lead4;
      ce.focus();
      setCaretEnd(ce);
      ce.dispatchEvent(new Event('input', { bubbles: true }));
      await waitCandidates();
      window.__quranCompose.acceptSelected();
      await sleep(20);
      window.__quranCompose.chooseScope('whole');
      await sleep(40);
      const ins = window.__quranCompose.lastInsertion;
      T('US4 contenteditable insert persists verdict markup (persistedMarkup=true)',
        ins && ins.persistedMarkup === true, JSON.stringify(ins));
      const span = ce.querySelector('.quran-ac-cite');
      T('US4 inserted ayah is wrapped in the verdict span (.quran-green for exact)',
        !!span && span.classList.contains('quran-green'), span && span.className);
      T('US4 verdict span carries the Quran-font class',
        !!span && span.classList.contains('quran-ac-cite-quranfont'), span && span.className);
      T('US4 contenteditable markup is non-destructive (ayah + ref + lead-in intact)',
        ce.textContent.includes(ayah.text) && ce.textContent.includes('(البقرة:255)') && ce.textContent.includes('قال تعالى'),
        ce.textContent);
    }

    // (b) plain input accept → styling skipped, matching/insertion preserved (FR-018b).
    {
      const f = await setupCitation(lead4);
      window.__quranCompose.chooseScope('whole');
      await sleep(20);
      const ins = window.__quranCompose.lastInsertion;
      T('US4 plain input insert skips markup (persistedMarkup=false)',
        ins && ins.persistedMarkup === false, JSON.stringify(ins));
      T('US4 plain input still inserts authentic ayah + ref (no styling, matching intact)',
        f.value.includes(ayah.text) && f.value.includes('(البقرة:255)'), f.value);
    }

    // (c) pre-existing citation rendered on focus, NOT rewritten (FR-018a).
    {
      const ce = document.createElement('div');
      ce.contentEditable = 'true';
      const original = 'قال تعالى: ' + lead4;
      ce.textContent = original;
      host.appendChild(ce);
      ce.focus();                       // pre-existing content — no typing
      const rendered = await waitFor(() => !!ce.querySelector('.quran-ac-cite'));
      T('US4 pre-existing citation renders on focus (FR-018a)', rendered, ce.innerHTML);
      const span = ce.querySelector('.quran-ac-cite');
      T('US4 pre-existing render uses the verdict color (green for exact)',
        !!span && span.classList.contains('quran-green'), span && span.className);
      T('US4 pre-existing render does NOT rewrite the text', ce.textContent === original, ce.textContent);
      T('US4 pre-existing render records a fall-through classification',
        window.__quranCompose.lastClassification && window.__quranCompose.lastClassification.viaFallthrough === true
          && window.__quranCompose.lastClassification.verdict === 'green',
        JSON.stringify(window.__quranCompose.lastClassification));
    }

    // (d) caret-away with candidates still showing → verdict fall-through (FR-011a).
    {
      const ce = document.createElement('div');
      ce.contentEditable = 'true';
      const original = 'قال تعالى: ' + lead4;
      ce.textContent = original;
      host.appendChild(ce);
      ce.focus();
      setCaretEnd(ce);
      ce.dispatchEvent(new Event('input', { bubbles: true }));
      await waitCandidates();
      const sink = document.createElement('input');     // move the caret away (blur)
      sink.type = 'text';
      host.appendChild(sink);
      sink.focus();
      await sleep(40);
      T('US4 caret-away marks the unresolved citation by verdict (fall-through, FR-011a)',
        !!ce.querySelector('.quran-ac-cite.quran-green'), ce.innerHTML);
      T('US4 fall-through classification recorded (viaFallthrough)',
        window.__quranCompose.lastClassification && window.__quranCompose.lastClassification.viaFallthrough === true,
        JSON.stringify(window.__quranCompose.lastClassification));
      T('US4 fall-through never deletes the user text', ce.textContent === original, ce.textContent);
    }

    // (e) liveRender OFF → no markup, but matching + insertion still work (FR-019).
    {
      await setLiveRender(false);
      const ce = document.createElement('div');
      ce.contentEditable = 'true';
      host.appendChild(ce);
      ce.textContent = 'قال تعالى: ' + lead4;
      ce.focus();
      setCaretEnd(ce);
      ce.dispatchEvent(new Event('input', { bubbles: true }));
      await waitCandidates();
      window.__quranCompose.acceptSelected();
      await sleep(20);
      window.__quranCompose.chooseScope('whole');
      await sleep(40);
      const ins = window.__quranCompose.lastInsertion;
      T('US4 liveRender off → no persistent markup (FR-019)',
        ins && ins.persistedMarkup === false && !ce.querySelector('.quran-ac-cite'),
        JSON.stringify({ persisted: ins && ins.persistedMarkup, html: ce.innerHTML }));
      T('US4 liveRender off still inserts authentic ayah + ref (matching/insertion preserved)',
        ce.textContent.includes(ayah.text) && ce.textContent.includes('(البقرة:255)'), ce.textContent);
      await setLiveRender(true);
    }
  }

  return results;
}

async function main() {
  const seed = {};
  const browser = await launchSystemChromium();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const runnerHtml = buildRunnerHtml(seed);

  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/runner') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: runnerHtml });
    }
    const filePath = path.join(PROJECT_DIR, url.pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(PROJECT_DIR) || !fs.existsSync(filePath)) return route.fulfill({ status: 404, body: 'not found' });
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.js' ? 'application/javascript' : ext === '.json' ? 'application/json'
      : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html; charset=utf-8'
      : 'application/octet-stream';
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
  console.log(`\nautocomplete: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
