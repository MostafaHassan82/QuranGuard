'use strict';
/*
 * T055 — in-scan performance budget regression gate (V1.2).
 * ---------------------------------------------------------------------------
 * Reuses the correction_check harness: system Chromium + MV3 chrome mock +
 * ORIGIN routing, loading the REAL background verifier.
 *
 * What this guards: the V1.2 red near-match probe (nearMatchProbe → findFuzzy
 * Global / findCrossAyahFuzzy / bestAlignWindow) runs IN-SCAN for every red
 * finding (enrichCorrection). It is bounded, but a future regression (e.g. an
 * unbounded window scan or an O(n²) candidate blow-up) would surface here as a
 * blown scan budget rather than a silent slowdown.
 *
 * The content script scans by batching every page citation into one
 * `verifyCitations { items }` message (js/content.js → runScan/sendVerify), so
 * this fixture sends ONE batch that is heavier than the live worst case
 * (live: ~15 red findings on a ~4,900-word page ≈ 200 ms) and asserts it stays
 * well under the ~5 s page-scan budget (plan T055; inherited from feature 003's
 * scan-debounce budget). Ground truth is the shipped index (Principle I) —
 * verses are never hand-typed; only the deliberate drift tokens are.
 *
 * Run: node tests/perf_check.js
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

// ~5 s page-scan budget (plan T055 / inherited feature-003 scan budget). The
// live worst case measured ~200 ms for 15 red findings, and this batch is
// several times heavier, so 5 s leaves a 10×+ margin: it will not flake on a
// slow CI box but will trip on a genuine algorithmic regression.
const BUDGET_MS = 5000;

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

async function inPageTests(budgetMs) {
  const results = [];
  const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });
  const send = (msg) => new Promise(r => chrome.runtime.sendMessage(msg, r));

  let ready = false;
  for (let i = 0; i < 200; i++) { const p = await send({ type: 'ping' }); if (p && p.indexReady) { ready = true; break; } await new Promise(r => setTimeout(r, 25)); }
  T('background index ready', ready);
  if (!ready) return { results };

  // ── Build a content-heavy scan batch from the shipped index ────────────────
  // Walk البقرة (286 ayahs) and collect verses with ≥8 words so a 7-word leading
  // fragment is well-formed. From each we synthesize:
  //   - red:    first 7 words, TWO interior substitutions → exceeds the yellow
  //             budget → red, and the fuzzy near-match probe runs (the in-scan
  //             cost this gate guards). Mirrors correction_check P1b.
  //   - yellow: first 7 words, ONE interior substitution → one diff → yellow
  //             (alignedDiff runs).
  //   - green:  the full authentic verse (no probe; represents ordinary prose
  //             citations that bulk up the page word count).
  const FOREIGNS = ['برثقومةٌ', 'ثقثقثقث', 'غضغضغضغ', 'مكمكمكم'];
  const verses = [];
  for (let a = 1; a <= 286 && verses.length < 90; a++) {
    const r = await send({ type: 'getAyahText', surahNum: 2, ayahNum: a });
    if (!r || !r.text) continue;
    const words = r.text.split(/\s+/).filter(Boolean);
    if (words.length >= 8) verses.push({ ref: r.ref, words });
  }
  T('collected enough source verses for a heavy batch', verses.length >= 60, 'verses=' + verses.length);
  if (verses.length < 60) return { results };

  const items = [];
  let citedWordCount = 0;
  // Mirror the content-script batch shape (js/content.js → verifyFragmentBatch):
  // each item carries its own `type` so the handler routes it through the
  // by-ref verifier (the path that yields yellow diffs / red near-match probes).
  const pushItem = (text, ref) => { items.push({ type: 'verifyFragmentByRef', text, ref, candidateConfidence: 'high' }); citedWordCount += text.split(/\s+/).filter(Boolean).length; };

  for (let i = 0; i < verses.length; i++) {
    const v = verses[i];
    const lead = v.words.slice(0, 7);
    if (i % 3 === 0) {
      // red — two interior substitutions
      const drifted = lead.slice();
      drifted[2] = FOREIGNS[i % FOREIGNS.length];
      drifted[4] = FOREIGNS[(i + 1) % FOREIGNS.length];
      pushItem(drifted.join(' '), v.ref);
    } else if (i % 3 === 1) {
      // yellow — one interior substitution
      const drifted = lead.slice();
      drifted[3] = FOREIGNS[i % FOREIGNS.length];
      pushItem(drifted.join(' '), v.ref);
    } else {
      // green — full authentic verse
      pushItem(v.words.join(' '), v.ref);
    }
  }
  T('synthesized a non-trivial scan batch', items.length >= 60, 'items=' + items.length);

  // ── Time the batch verification (one scan) ─────────────────────────────────
  // One warm-up (absorb first-call JIT), then time three scans and keep the
  // slowest — the budget must hold for the worst observed scan, not the best.
  await send({ type: 'verifyFragmentBatch', items });
  let worstMs = 0;
  let lastRes = null;
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    lastRes = await send({ type: 'verifyFragmentBatch', items });
    const dt = performance.now() - t0;
    if (dt > worstMs) worstMs = dt;
  }

  const arr = lastRes && Array.isArray(lastRes.results) ? lastRes.results : [];
  const reds = arr.filter(r => r && r.color === 'red');
  const redsWithProbe = reds.filter(r => r && r.nearMatch && r.nearMatch.refLabel);
  const yellows = arr.filter(r => r && r.color === 'yellow' && Array.isArray(r.diff));

  // The gate is only meaningful if the batch actually exercised the expensive
  // path: it must contain many red findings whose near-match probe resolved a
  // suggestion (more than the ~15-red live worst case).
  T('batch produced > 15 red near-match probes (heavier than live worst case)',
    redsWithProbe.length > 15, 'redsWithProbe=' + redsWithProbe.length + ' reds=' + reds.length);
  T('batch also produced yellow aligned diffs (mixed-finding load)',
    yellows.length >= 10, 'yellows=' + yellows.length);
  T('cited word count is page-scale (≥ 1,000 words across citations)',
    citedWordCount >= 1000, 'citedWordCount=' + citedWordCount);

  // The actual budget assertion.
  T(`scan stays within the ${budgetMs} ms budget`, worstMs < budgetMs,
    `worstMs=${Math.round(worstMs)} items=${items.length} redsWithProbe=${redsWithProbe.length}`);

  return {
    results,
    metrics: {
      items: items.length,
      citedWordCount,
      redsWithProbe: redsWithProbe.length,
      yellows: yellows.length,
      worstMs: Math.round(worstMs),
      budgetMs,
    },
  };
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

  let out;
  try {
    await page.goto(`${ORIGIN}/runner`, { waitUntil: 'load', timeout: 20000 });
    out = await page.evaluate(`(${inPageTests.toString()})(${BUDGET_MS})`);
  } finally {
    await context.close();
    await browser.close();
  }

  const results = out.results || [];
  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  if (out.metrics) {
    const m = out.metrics;
    console.log(`\n  [perf] ${m.worstMs} ms (budget ${m.budgetMs} ms) — ${m.items} items, ` +
      `${m.redsWithProbe} red near-match probes, ${m.yellows} yellow diffs, ${m.citedWordCount} cited words`);
  }
  console.log(`\nperf: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
