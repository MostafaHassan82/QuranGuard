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
  'js/shared/i18n.js',
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
      action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve(), setTitle: () => Promise.resolve() },
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

async function runOne(context, htmlSource, label, seedSettings, covAccum) {
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
    if (covAccum) await page.coverage.startJSCoverage();
    await page.goto(`${ORIGIN}/runner`, { waitUntil: 'load', timeout: 20000 });
    const result = await page.evaluate(async () => {
      if (typeof window.__quranRunScan !== 'function') return { error: 'content script not loaded' };
      return await window.__quranRunScan();
    });
    // In coverage mode, drive the interaction paths the scan alone never hits
    // (panel actions, keyboard, correct-in-place, dismiss/restore, prefs/swap
    // toggles, persistence) so coverage reflects real usage, not just scanning.
    // Wrapped so a driver hiccup never changes the pass/fail result.
    if (covAccum) { try { await page.evaluate(exerciseInteractions); } catch (_) {} }

    if (covAccum) {
      const entries = await page.coverage.stopJSCoverage();
      for (const e of entries) covAccum.push(e);
    }
    return normalizeResult(result, label);
  } finally {
    await page.close();
  }
}

// Runs in the page (coverage mode only): exercises the interaction-driven code
// paths so coverage reflects real usage. Every step is independently guarded.
async function exerciseInteractions() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const step = async (fn) => { try { await fn(); } catch (_) {} };
  // These are `const` module globals (lexical scope), not window properties —
  // reference them as barewords, guarded by typeof.
  const Actions = (typeof QuranActions !== 'undefined') ? QuranActions : null;
  const Model = (typeof QuranPanelModel !== 'undefined') ? QuranPanelModel : null;
  const Sidebar = (typeof QuranPanelSidebar !== 'undefined') ? QuranPanelSidebar : null;
  const Msg = (typeof QuranMsg !== 'undefined') ? QuranMsg : null;
  const Badge = (typeof QuranBadge !== 'undefined') ? QuranBadge : null;
  const correct = (typeof correctInPlace !== 'undefined') ? correctInPlace : null;
  const send = (type, payload) => Msg ? Msg.sendRequest(type, payload || {}) : Promise.resolve();

  // Ensure the sidebar is mounted and expanded.
  await step(async () => { if (Sidebar && !Sidebar.isMounted()) await Sidebar.mount(); });
  await step(() => { const b = document.querySelector('.quran-ext-panel-collapse'); if (b) b.click(); });          // collapse
  await step(() => { const t = document.querySelector('.quran-ext-panel-tab'); if (t) t.click(); });               // expand

  const findings = (window.__quranMatches || []).slice();
  const orange = findings.find(f => f.color === 'orange');
  const any = findings[0];

  // Per-finding actions via QuranActions (copy/share/report/json).
  if (any && Actions) {
    await step(() => Actions.copyRecord(any, {}));
    await step(() => Actions.copyShareArtifact(any, {}));
    await step(() => Actions.copyReport(any, {}));
    await step(() => Actions.copyRecordJson(any, {}));
    await step(() => Actions.jumpInContent(any.id));
    await step(() => Actions.buildShareArtifact(any, { pageUrl: location.href }));
  }

  // Correct-in-place on an orange finding (DOM mutate + successor + persist).
  if (orange && correct) {
    await step(() => correct(orange.id));
    await sleep(60);
  }

  // Dismiss + restore through the model + persistence.
  if (any && Model) {
    await step(() => Model.markDismissedThisSession(any.id));
    await step(() => Actions && Actions.dismiss(any, {}));
    await step(() => Model.unmarkDismissed(any.id));
    await step(() => Actions && Actions.restore(any, {}));
  }

  // Keyboard model: focus a row and fire the shortcut keys.
  await step(async () => {
    const row = document.querySelector('.quran-ext-panel-row');
    if (!row) return;
    row.focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'c', 's', 'r', 'j', 'd', ' ', 'Escape', 'Escape']) {
      row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await sleep(2);
    }
  });

  // Filter chips + swap controls + font (drive PREFS_WRITE → PREFS_CHANGED).
  await step(() => { document.querySelectorAll('.quran-ext-filter-chip input').forEach(cb => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }); });
  await step(() => { const m = document.querySelector('.quran-ext-swap-master'); if (m) { m.checked = false; m.dispatchEvent(new Event('change', { bubbles: true })); } });
  await step(() => { const m = document.querySelector('.quran-ext-swap-master'); if (m) { m.checked = true; m.dispatchEvent(new Event('change', { bubbles: true })); } });
  await step(() => { document.querySelectorAll('[data-swap-color]').forEach(cb => { if (cb.dataset.swapColor !== 'red') { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); } }); });
  await step(() => { const f = document.querySelector('.quran-ext-font-select'); if (f) { f.value = 'indoPak'; f.dispatchEvent(new Event('change', { bubbles: true })); } });
  await step(() => { const c = document.querySelector('.quran-ext-clear-persisted'); if (c) c.click(); });

  // Prefs + persistence message round-trips.
  await step(() => send('PREFS_READ'));
  await step(() => send('PREFS_WRITE', { patch: { scanTrigger: 'autoscan' } }));
  await step(() => send('PERSIST_WRITE', { urlKey: location.href, compositeKey: 'cov-key', kind: 'dismissal', at: new Date().toISOString() }));
  await step(() => send('PERSIST_READ', { urlKey: location.href }));
  await step(() => send('PERSIST_REMOVE', { urlKey: location.href, compositeKey: 'cov-key', kind: 'dismissal' }));
  await step(() => send('CLEAR_PERSISTED'));

  // Page → panel jump on a highlight, then a re-scan (clearHighlights revert path).
  await step(() => { const h = document.querySelector('.quran-green,[data-finding-id]'); if (h) h.click(); });
  await sleep(20);

  // Badge state machine (runs in the SW normally; drive it directly here).
  await step(() => {
    const B = Badge; if (!B) return;
    const pcc = { green: 3, lightBlue: 1, yellow: 1, orange: 1, red: 1 };
    B.onScanStart(1);
    B.onScanProgress(1, pcc, 6);
    B.onScanComplete(1, 'defects', pcc, 7);
    B.onScanComplete(1, 'clean', { green: 5 }, 5);
    B.onScanComplete(1, 'empty', {}, 0);
    B.onScanComplete(1, 'notArabic', {}, 0);
    B.onCapHit(1, pcc);
    B.onDataUnavailable(1, 'missing');
    B.onDataAvailable(1);
  });
}

// ── Coverage (T086) — aggregate V8 precise (block) coverage across fixtures ──
// Only the extension's own source under ${ORIGIN}/js/ is measured. V8 emits
// nested ranges: a byte's execution count is the count of the SMALLEST range
// containing it (an inner count:0 range is a hole inside an executed function).
// A line is covered if its first non-whitespace char's innermost range ran > 0
// in ANY fixture; line coverage is unioned across all fixture runs.
function offsetCovered(ranges, off) {
  let best = null; // smallest range containing off
  for (const r of ranges) {
    if (off >= r.s && off < r.e) {
      if (!best || (r.e - r.s) < (best.e - best.s)) best = r;
    }
  }
  return best ? best.count > 0 : false;
}

function aggregateCoverage(entries) {
  // url -> { source, coveredLines:Set<number> }
  const byUrl = new Map();
  for (const e of entries) {
    if (!e.url || !e.url.startsWith(`${ORIGIN}/js/`)) continue;
    if (!byUrl.has(e.url)) byUrl.set(e.url, { source: e.source || '', coveredLines: new Set() });
    const rec = byUrl.get(e.url);
    if (!rec.source && e.source) rec.source = e.source;
    const src = rec.source;
    if (!src) continue;
    const ranges = [];
    for (const fn of e.functions || []) for (const r of fn.ranges || []) ranges.push({ s: r.startOffset, e: r.endOffset, count: r.count });
    if (!ranges.length) continue;
    // Map each non-blank line's first non-ws offset → covered?
    let ln = 1, lineStart = 0;
    for (let i = 0; i <= src.length; i++) {
      if (i === src.length || src[i] === '\n') {
        const text = src.slice(lineStart, i);
        const m = text.match(/\S/);
        if (m) {
          const off = lineStart + m.index;
          if (offsetCovered(ranges, off)) rec.coveredLines.add(ln);
        }
        ln++; lineStart = i + 1;
      }
    }
  }
  const files = [];
  for (const [url, rec] of byUrl) {
    const src = rec.source || '';
    let total = 0; const allLines = [];
    let ln = 1, lineStart = 0;
    for (let i = 0; i <= src.length; i++) {
      if (i === src.length || src[i] === '\n') {
        if (src.slice(lineStart, i).trim()) { total++; allLines.push(ln); }
        ln++; lineStart = i + 1;
      }
    }
    const covered = allLines.filter(l => rec.coveredLines.has(l));
    const uncovered = allLines.filter(l => !rec.coveredLines.has(l));
    files.push({
      file: url.replace(`${ORIGIN}/`, ''),
      lines: total, coveredLines: covered.length,
      linePct: total ? +(100 * covered.length / total).toFixed(1) : 0,
      uncovered,
    });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return files;
}

function writeCoverage(files) {
  const dir = path.join(TESTS_DIR, 'coverage');
  fs.mkdirSync(dir, { recursive: true });
  const totals = files.reduce((a, f) => ({ lines: a.lines + f.lines, covered: a.covered + f.coveredLines }), { lines: 0, covered: 0 });
  const overall = totals.lines ? +(100 * totals.covered / totals.lines).toFixed(1) : 0;
  const summary = {
    generatedAt: new Date().toISOString(),
    overallLinePct: overall,
    totalLines: totals.lines, coveredLines: totals.covered,
    files: files.map(({ uncovered, ...f }) => f),
  };
  fs.writeFileSync(path.join(dir, 'coverage-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf-8');

  let md = `# Coverage — Node fixture suite (T086)\n\nGenerated: ${summary.generatedAt}\n\n`;
  md += `**Overall line coverage: ${overall}%** (${totals.covered}/${totals.lines} non-blank lines)\n\n`;
  md += `| File | Lines | Covered | Line % |\n|---|---|---|---|\n`;
  for (const f of files) md += `| ${f.file} | ${f.lines} | ${f.coveredLines} | ${f.linePct}% |\n`;
  md += `\n## Uncovered lines\n\n`;
  for (const f of files) {
    if (!f.uncovered.length) { md += `- \`${f.file}\` — fully covered\n`; continue; }
    md += `- \`${f.file}\` (${f.uncovered.length} lines): ${compactRanges(f.uncovered)}\n`;
  }
  fs.writeFileSync(path.join(dir, 'uncovered.md'), md, 'utf-8');
  return { overall, totals };
}

function compactRanges(nums) {
  const out = []; let s = nums[0], p = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === p + 1) { p = nums[i]; continue; }
    out.push(s === p ? `${s}` : `${s}-${p}`); s = p = nums[i];
  }
  out.push(s === p ? `${s}` : `${s}-${p}`);
  return out.join(', ');
}

function normalizeResult(raw, label) {
  if (!raw || raw.error) return { source_label: label, error: raw && raw.error, stats: {}, matches: [] };
  const pcc = (raw.scan && raw.scan.perCategoryCount) || {};
  // Capture from findings (the ORIGINAL page text in `text`), not from the
  // highlight span's textContent — the authentic-text swap rewrites the span's
  // text to Uthmani+tashkeel, but expected.json records the page's wording.
  const src = (raw.findings && raw.findings.length) ? raw.findings : (raw.matches || []);
  return {
    source_label: label,
    stats: {
      greenMatches: pcc.green || 0,
      lightBlueMatches: pcc.lightBlue || 0,
      yellowMatches: pcc.yellow || 0,
      orangeMatches: pcc.orange || 0,
      redMatches: pcc.red || 0,
      totalFindings: (raw.scan && raw.scan.totalCount) || src.length,
    },
    matches: src.map(m => ({
      text: m.text || m.rawText || '', color: m.color || m.category || '',
      matchedRef: m.matchedRef || m.matchedReference || '',
      claimedRef: m.claimedRef || m.citedReference || '',
    })),
  };
}

function statLine(o) {
  const s = o.stats || {};
  return `g${s.greenMatches || 0} lb${s.lightBlueMatches || 0} y${s.yellowMatches || 0} o${s.orangeMatches || 0} r${s.redMatches || 0} (total ${s.totalFindings || 0})`;
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

// Launch a system Chromium-based browser. Set QURAN_TEST_BROWSER to an
// executable path to override detection (any Chromium build works: Chrome,
// Brave, Edge, Chromium).
async function launchSystemChromium() {
  const opts = { headless: true };
  const env = process.env.QURAN_TEST_BROWSER;
  if (env && fs.existsSync(env)) return chromium.launch({ ...opts, executablePath: env });

  const home = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    home && `${home}/Google/Chrome/Application/chrome.exe`,
    home && `${home}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return chromium.launch({ ...opts, executablePath: p });
  }
  // Last resort: Playwright's bundled Chromium (needs `npx playwright install`).
  return chromium.launch(opts);
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const writeObserved = argv.includes('--write-observed');
  const coverage = argv.includes('--coverage');
  const covAccum = coverage ? [] : null;
  const textIdx = argv.indexOf('--text');
  const textSnippet = textIdx !== -1 ? argv[textIdx + 1] : null;
  const fixtureArg = argv.find(a => !a.startsWith('--') && a !== textSnippet);

  // Use a system Chromium-based browser (T084: "headless Playwright + system
  // Chrome") so we don't need Playwright's bundled Chromium download (which
  // fails behind TLS-intercepting proxies). Order: explicit env override →
  // first detected install (Chrome / Brave / Edge — all Chromium) → bundled.
  const browser = await launchSystemChromium();
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
        const observed = await runOne(context, html, label, {}, covAccum);
        if (writeObserved) {
          fs.writeFileSync(fx.replace(/\.html$/, '.observed.json'), JSON.stringify(observed, null, 2), 'utf-8');
        }
        const expPath = fx.replace(/\.html$/, '.expected.json');
        if (!fs.existsSync(expPath)) {
          console.log(`[${label}] REVIEW (no expected) — ${statLine(observed)}`);
          continue;
        }
        const expected = JSON.parse(fs.readFileSync(expPath, 'utf-8'));
        if (expected._skip) { console.log(`[${label}] SKIP — ${statLine(observed)}`); continue; }
        total++;
        const cmp = compare(observed, expected);
        if (cmp.passed) { passed++; console.log(`[${label}] PASS`); }
        else { console.log(`[${label}] FAIL`); cmp.diffs.forEach(d => console.log(d)); }
      }
      console.log(`\nResults: ${passed}/${total} passed`);
      if (covAccum) {
        const files = aggregateCoverage(covAccum);
        const { overall } = writeCoverage(files);
        console.log(`Coverage: ${overall}% overall line coverage → tests/coverage/`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
  if (total > 0 && passed < total) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
