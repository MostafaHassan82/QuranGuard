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
const COMPOSE_BUNDLE = [
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
