'use strict';
/*
 * Quran Citation Extension — Node fixture runner (T084/T085)
 * ----------------------------------------------------------
 * A faster, flake-free alternative to the persistent-profile / real-extension
 * Python runner (tests/run_tests.py). Instead of loading a real MV3 extension,
 * it injects the extension's own JS into a single page and replaces `chrome`
 * with an MV3-shaped in-page mock. This removes the SW-init races, the
 * crypto.randomUUID secure-context failures, the cross-world event drops, and
 * the browser_profile state bleed the real-extension model produces.
 *
 * Per Principle V: this harvests the *harness pattern* only. None of the
 * advanced copy's V2 selectors / popup scenario / autocomplete code is ported.
 *
 * STATUS: requires `npm i playwright` + a Chrome/Chromium install. It has NOT
 * been run in CI yet — keep tests/run_tests.py as the authoritative runner until
 * this passes on every fixture (see T085: "no flipping over half-tested").
 *
 * Usage:
 *   node tests/run_tests_node.js --all
 *   node tests/run_tests_node.js tests/fixtures/174389.html
 *   node tests/run_tests_node.js --text "قوله تعالى: {…} (سبأ:13)"
 *
 * ── chrome mock contract (injected into the page before any extension JS) ──
 * The mock implements just enough of MV3 for background.js + content.js:
 *   chrome.runtime.onMessage.addListener(fn)
 *       fn(message, sender, sendResponse) — registered for BOTH the background
 *       and content listeners (they share one page here). A listener that wants
 *       to answer asynchronously MUST `return true` and call sendResponse later
 *       (the messaging.md contract). The first sendResponse call resolves the
 *       sender's callback exactly once.
 *   chrome.runtime.sendMessage(message, callback?)
 *       Dispatches to every registered listener. If none answers, sets
 *       chrome.runtime.lastError before invoking callback (so sendToBackground's
 *       error path still fires). Returns a Promise when no callback is given.
 *   chrome.runtime.getURL(path) -> 'http://quran.test/<path>'
 *   chrome.runtime.lastError    -> {message} during a failed callback, else undefined
 *   chrome.storage.local.{get,set,remove} over an in-memory dict seeded from the
 *       per-test settings object (structured-clone-safe values only).
 *   chrome.tabs.query()/sendMessage() route back into the same page's listeners
 *       (background broadcasts reach the content listener).
 *   chrome.action / chrome.runtime.onInstalled etc. are no-op stubs.
 * Extend this contract here (not in messaging.md) when a new chrome API is used.
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
const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures');
const ORIGIN = 'http://quran.test';

// Content-script bundle, in manifest order, plus the verifier/storage modules
// background.js would importScripts. We inject the verifier modules FIRST so
// their globals exist, then neutralize importScripts before background.js runs.
const BACKGROUND_DEPS = [
  'js/shared/messaging.js',
  'js/verifier/normalize.js',
  'js/verifier/indexes.js',
  'js/verifier/references.js',
  'js/verifier/classify.js',
  'js/verifier/orange.js',
  'js/storage/prefs.js',
  'js/storage/persisted.js',
  'js/badge/badge.js',
];
const CONTENT_BUNDLE = [
  'js/panel/model.js',
  'js/panel/actions.js',
  'js/panel/keyboard.js',
  'js/panel/sidebar-surface.js',
  'js/render/fonts.js',
  'js/render/swap.js',
  'js/content.js',
];

// ── The in-page chrome mock (stringified; runs as the first <script>) ─────────
function chromeMockSource() {
  return `
  (function () {
    const listeners = [];
    const store = Object.assign({}, window.__seedStorage || {});
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

    function dispatch(message, callback) {
      let answered = false;
      let willAnswerAsync = false;
      const sendResponse = (resp) => {
        if (answered) return;
        answered = true;
        window.chrome.runtime.lastError = undefined;
        if (callback) setTimeout(() => callback(clone(resp)), 0);
      };
      for (const fn of listeners.slice()) {
        let ret;
        try { ret = fn(clone(message), { id: 'mock' }, sendResponse); } catch (e) { /* listener threw */ }
        if (ret === true) willAnswerAsync = true;
        if (answered) break;
      }
      if (!answered && !willAnswerAsync && callback) {
        window.chrome.runtime.lastError = { message: 'no response' };
        setTimeout(() => { callback(undefined); window.chrome.runtime.lastError = undefined; }, 0);
      }
    }

    window.chrome = {
      runtime: {
        lastError: undefined,
        id: 'mock-extension-id',
        getURL: (p) => '${ORIGIN}/' + String(p).replace(/^\\/+/, ''),
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        sendMessage: (message, callback) => {
          if (typeof callback === 'function') { dispatch(message, callback); return; }
          return new Promise((resolve) => dispatch(message, resolve));
        },
      },
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            const list = keys == null ? Object.keys(store)
              : Array.isArray(keys) ? keys
              : typeof keys === 'string' ? [keys] : Object.keys(keys);
            for (const k of list) out[k] = (k in store) ? clone(store[k]) : (typeof keys === 'object' && keys ? keys[k] : undefined);
            if (cb) { setTimeout(() => cb(out), 0); return; }
            return Promise.resolve(out);
          },
          set: (obj, cb) => { Object.assign(store, clone(obj)); if (cb) { setTimeout(cb, 0); return; } return Promise.resolve(); },
          remove: (keys, cb) => { for (const k of [].concat(keys)) delete store[k]; if (cb) { setTimeout(cb, 0); return; } return Promise.resolve(); },
        },
      },
      tabs: {
        query: (q, cb) => { const t = [{ id: 1, url: location.href }]; if (cb) { setTimeout(() => cb(t), 0); return; } return Promise.resolve(t); },
        sendMessage: (tabId, message, callback) => window.chrome.runtime.sendMessage(message, callback),
      },
      action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
    };
    // background.js calls importScripts at module top; the deps are already
    // injected as <script> tags, so make it a no-op rather than a ReferenceError.
    window.importScripts = function () {};
  })();
  `;
}

function buildRunnerHtml(fixtureBodyHtml, seedSettings) {
  const scripts = [...BACKGROUND_DEPS, 'js/background.js', ...CONTENT_BUNDLE]
    .map(p => `<script src="${ORIGIN}/${p}"></script>`)
    .join('\n');
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<script>window.__seedStorage = ${JSON.stringify(seedSettings || {})};</script>
<script>${chromeMockSource()}</script>
</head>
<body>
${fixtureBodyHtml}
${scripts}
</body></html>`;
}

// Pull the <body> innerHTML out of a fixture file (or wrap a raw snippet).
function fixtureBody(htmlSource) {
  const m = htmlSource.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : htmlSource;
}

async function runOne(context, htmlSource, label, seedSettings) {
  const page = await context.newPage();
  const bodyHtml = fixtureBody(htmlSource);
  const runnerHtml = buildRunnerHtml(bodyHtml, seedSettings);

  // Serve the runner page + every extension asset from the project dir.
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/runner' || url.pathname === '/runner.html') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: runnerHtml });
    }
    const filePath = path.join(PROJECT_DIR, url.pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(PROJECT_DIR) || !fs.existsSync(filePath)) {
      return route.fulfill({ status: 404, body: 'not found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.js' ? 'application/javascript'
      : ext === '.json' ? 'application/json'
      : ext === '.css' ? 'text/css'
      : ext === '.html' ? 'text/html; charset=utf-8'
      : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(filePath) });
  });
  // Block any non-mock external request so the page settles fast.
  await page.route('**/*', (route) => {
    if (route.request().url().startsWith(ORIGIN)) return route.fallback();
    return route.abort();
  });

  try {
    await page.goto(`${ORIGIN}/runner`, { waitUntil: 'load', timeout: 20000 });
    const result = await page.evaluate(async () => {
      if (typeof window.__quranRunScan !== 'function') return { error: 'content script not loaded' };
      return await window.__quranRunScan();
    });
    return normalizeResult(result, label);
  } finally {
    await page.close();
  }
}

function normalizeResult(raw, label) {
  if (!raw || raw.error) return { source_label: label, error: raw && raw.error, stats: {}, matches: [] };
  const pcc = (raw.scan && raw.scan.perCategoryCount) || {};
  return {
    source_label: label,
    stats: {
      greenMatches: pcc.green || 0,
      lightBlueMatches: pcc.lightBlue || 0,
      yellowMatches: pcc.yellow || 0,
      orangeMatches: pcc.orange || 0,
      redMatches: pcc.red || 0,
      totalFindings: (raw.scan && raw.scan.totalCount) || (raw.matches ? raw.matches.length : 0),
    },
    matches: (raw.matches || []).map(m => ({
      text: m.text || '', color: m.color || '',
      matchedRef: m.matchedRef || '', claimedRef: m.claimedRef || '',
    })),
  };
}

function compare(observed, expected) {
  const diffs = [];
  const os = observed.stats || {}, es = expected.stats || {};
  for (const k of ['greenMatches', 'lightBlueMatches', 'yellowMatches', 'orangeMatches', 'redMatches', 'totalFindings']) {
    if ((os[k] || 0) !== (es[k] || 0)) diffs.push(`  stat ${k}: expected ${es[k] || 0}, got ${os[k] || 0}`);
  }
  const ok = (arr) => new Set((arr || []).map(m => m.text + ' ' + m.color));
  const obs = ok(observed.matches), exp = ok(expected.matches);
  for (const k of exp) if (!obs.has(k)) diffs.push(`  MISSING [${k.split(' ')[1]}]: ${k.split(' ')[0].slice(0, 60)}`);
  for (const k of obs) if (!exp.has(k)) diffs.push(`  EXTRA   [${k.split(' ')[1]}]: ${k.split(' ')[0].slice(0, 60)}`);
  return { passed: diffs.length === 0, diffs };
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const textIdx = argv.indexOf('--text');
  const textSnippet = textIdx !== -1 ? argv[textIdx + 1] : null;
  const fixtureArg = argv.find(a => !a.startsWith('--') && a !== textSnippet);

  // Prefer the system Chrome (T084: "headless Playwright + system Chrome") so we
  // don't need Playwright's bundled Chromium download (which fails behind TLS
  // intercepting proxies). Fall back to bundled Chromium if Chrome isn't found.
  let browser;
  try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
  catch (_) { browser = await chromium.launch({ headless: true }); }
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  let passed = 0, total = 0;
  try {
    if (textSnippet) {
      const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"></head><body><p>${textSnippet}</p></body></html>`;
      const r = await runOne(context, html, '--text', {});
      console.log(JSON.stringify(r, null, 2));
    } else {
      const files = all
        ? fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.html')).map(f => path.join(FIXTURES_DIR, f))
        : fixtureArg ? [path.resolve(fixtureArg)] : [];
      if (files.length === 0) { console.error('Usage: node tests/run_tests_node.js [--all | <fixture.html> | --text "…"]'); process.exit(1); }
      for (const fx of files) {
        const label = path.basename(fx, '.html');
        const html = fs.readFileSync(fx, 'utf-8');
        const observed = await runOne(context, html, label, {});
        const expPath = fx.replace(/\.html$/, '.expected.json');
        if (!fs.existsSync(expPath)) { console.log(`[${label}] REVIEW (no expected file)`); continue; }
        const expected = JSON.parse(fs.readFileSync(expPath, 'utf-8'));
        if (expected._skip) { console.log(`[${label}] SKIP`); continue; }
        total++;
        const cmp = compare(observed, expected);
        if (cmp.passed) { passed++; console.log(`[${label}] PASS`); }
        else { console.log(`[${label}] FAIL`); cmp.diffs.forEach(d => console.log(d)); }
      }
      console.log(`\nResults: ${passed}/${total} passed`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
  if (total > 0 && passed < total) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
