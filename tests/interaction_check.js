'use strict';
/*
 * Interaction assertion gate (US4 + US2 — T073 / T074 / T075 / T056 / T070).
 * ---------------------------------------------------------------------------
 * The coverage drivers EXECUTE correct-in-place, the clipboard fallback, dismiss
 * and persistence (for the 95.2% line coverage), but assert nothing about the
 * OUTCOMES. This gate drives those paths against the full background+content
 * bundle (same MV3 mock + asset routing as run_tests_node.js) and asserts the
 * behaviour the tasks specify:
 *
 *   T073 — correct-in-place on an editable orange finding produces a green/
 *          lightGreen successor with priorFindingId back-reference, rewrites the
 *          cited reference in the page DOM, and writes a PERSIST 'correction'.
 *   T074 — correct-in-place on a finding whose ref marker can't be edited falls
 *          back to copying the corrected citation to the clipboard.
 *   T075 / T056 — QuranPanelModel.tagPersisted maps a stored 'correction' /
 *          'dismissal' entry onto the matching finding's persistedBadge so a
 *          revisit surfaces "Previously corrected/dismissed" (NOT suppressed).
 *   T070 — model-level dismiss moves a finding into the dismissed-this-session
 *          set and restore brings it back.
 *
 * Reuses the run_tests_node harness pattern (system Chromium + asset routing +
 * the MV3 chrome mock). Run: node tests/interaction_check.js
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
const CONTENT_BUNDLE = [
  'js/shared/i18n.js', 'js/themes/registry.js', 'js/panel/model.js', 'js/panel/actions.js',
  'js/panel/keyboard.js', 'js/panel/sidebar-surface.js', 'js/render/fonts.js',
  'js/render/tooltip.js', 'js/render/decoration.js', 'js/render/ref-marker.js',
  'js/render/swap.js', 'js/context-atom.js', 'js/content.js',
];

// MV3 chrome mock — mirrors run_tests_node.js chromeMockSource() (kept in sync
// by hand; the two share the same contract). Just enough for background.js +
// content.js: async-honoring messaging, in-memory storage.local, getURL, ports.
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
        __dispatchWithSender: (message, sender) => new Promise((resolve) => dispatch(message, resolve, sender || { id: 'mock' })),
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

// Two real verses cited at WRONG references → two orange findings. The verses
// and refs are pulled from the shipped JSON at build time below so we never
// hand-type Quran text (Principle I).
function fixtureBody(cases) {
  const paras = cases.map((c, i) =>
    `<p id="p${i}">قال تعالى: {${c.text}} (${c.wrongRef}).</p>`).join('\n');
  return `<article class="article-content"><h1>تصحيح في المكان</h1>\n${paras}\n</article>`;
}

function buildRunnerHtml(bodyHtml, seed) {
  const scripts = [...BACKGROUND_DEPS, 'js/background.js', ...CONTENT_BUNDLE]
    .map(p => `<script src="${ORIGIN}/${p}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<script>window.__seedStorage = ${JSON.stringify(seed || {})};</script>
<script>${chromeMockSource()}</script>
</head><body>
${bodyHtml}
${scripts}
</body></html>`;
}

// Two orange cases (real verse, wrong-but-valid ref). Reuses the machine-derived
// ground truth from the generated orange precision/recall fixture rather than
// re-deriving — so the cases stay in lock-step with the verifier and we never
// hand-type Quran text (Principle I). Run tests/gen_orange_cases.js first.
function deriveOrangeCases() {
  const p = path.join(PROJECT_DIR, 'tests', 'fixtures', 'synthetic', 'orange_cases.expected.json');
  if (!fs.existsSync(p)) {
    console.error('Missing orange_cases fixture — run: node tests/gen_orange_cases.js');
    process.exit(1);
  }
  const exp = JSON.parse(fs.readFileSync(p, 'utf8'));
  const oranges = (exp.matches || []).filter(m => m.color === 'orange').slice(0, 2);
  if (oranges.length < 2) { console.error('orange_cases has < 2 orange entries; regenerate it'); process.exit(1); }
  return oranges.map(m => ({
    text: m.text,
    trueRef: m.matchedRef,
    wrongRef: String(m.claimedRef || '').replace(/[()]/g, '').trim(),
  }));
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

// In-page battery. Drives the real content/panel APIs and returns assertions.
async function inPageTests() {
  const results = [];
  const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  await window.__quranRunScan();
  const matches = (window.__quranMatches || []).slice();
  const oranges = matches.filter(m => m.color === 'orange');
  T('scan produced ≥2 orange findings', oranges.length >= 2, `got ${oranges.length} orange of ${matches.length}`);
  if (oranges.length < 2) return results;

  // ── T073: correct-in-place on an editable orange finding ──────────────────
  const o1 = oranges[0];
  const marker1 = document.querySelector(`[data-quran-ref-for="${CSS.escape(o1.id)}"]`);
  T('T073 editable finding has a ref marker', !!marker1, 'no [data-quran-ref-for]');
  const trueRef1 = o1.matchedRef;
  const res1 = await correctInPlace(o1.id);
  T('T073 correctInPlace ok', res1 && res1.ok, JSON.stringify(res1));
  T('T073 not a clipboard fallback', res1 && res1.result && res1.result.fellBackToClipboard === false);
  const succId = res1 && res1.result && res1.result.successorFindingId;
  const succ = (window.__quranMatches || []).find(m => m.id === succId);
  T('T073 successor exists', !!succ);
  T('T073 successor has priorFindingId back-ref', succ && succ.priorFindingId === o1.id, succ && succ.priorFindingId);
  T('T073 successor color is lightGreen (corrected provenance)', succ && succ.color === 'lightGreen', succ && succ.color);
  T('T073 successor category is green verdict', succ && succ.category === 'green', succ && succ.category);
  T('T073 prior finding removed from active set', !(window.__quranMatches || []).some(m => m.id === o1.id));
  T('T073 page DOM ref rewritten to true ref', marker1 && marker1.textContent.includes(trueRef1.split(':')[1]),
    marker1 && marker1.textContent);
  // A ref-edit correction (orange reference rewrite) must have landed for this
  // page's urlKey (contracts/storage.md: CorrectionKind 'ref-edit').
  const persisted = await new Promise(r => chrome.storage.local.get(null, r));
  const corrKeys = Object.keys(persisted).filter(k => k.startsWith('persisted.v1.byUrl.'));
  const allEntries = corrKeys.flatMap(k => (persisted[k] && persisted[k].entries) || []);
  T('T073/T068 a ref-edit correction was persisted', allEntries.some(e => e.kind === 'ref-edit' && e.compositeKey === o1.id),
    JSON.stringify(allEntries));

  // ── T074: locked-DOM finding → clipboard fallback ─────────────────────────
  const o2 = oranges[1];
  const marker2 = document.querySelector(`[data-quran-ref-for="${CSS.escape(o2.id)}"]`);
  if (marker2) marker2.remove(); // simulate a ref we can't edit (shadow/contenteditable-off)
  let clipped = null;
  const realCopy = (typeof QuranActions !== 'undefined') ? QuranActions.copy : null;
  if (typeof QuranActions !== 'undefined') QuranActions.copy = async (s) => { clipped = s; };
  const res2 = await correctInPlace(o2.id);
  if (realCopy) QuranActions.copy = realCopy;
  T('T074 correctInPlace ok (fallback)', res2 && res2.ok, JSON.stringify(res2));
  T('T074 fell back to clipboard', res2 && res2.result && res2.result.fellBackToClipboard === true);
  T('T074 corrected citation was copied', clipped && clipped.includes(o2.matchedRef.split(':')[1]), clipped);

  // ── T075 / T056: tagPersisted maps stored entries onto the badge ──────────
  if (typeof QuranPanelModel !== 'undefined') {
    QuranPanelModel.reset();
    const f = { id: 'rev1', color: 'orange', text: 'x', matchedRef: 'البقرة:2', claimedRef: '(البقرة:3)', panelState: undefined };
    QuranPanelModel.upsert(f);
    QuranPanelModel.tagPersisted([{ compositeKey: 'rev1', kind: 'correction', at: '2026-05-01T00:00:00.000Z' }]);
    const tagged = QuranPanelModel.all().find(x => x.id === 'rev1');
    T('T075 correction entry tags persistedBadge', tagged && tagged.panelState.persistedBadge && tagged.panelState.persistedBadge.kind === 'corrected',
      tagged && JSON.stringify(tagged.panelState.persistedBadge));
    T('T075 badge carries the correction date', tagged && tagged.panelState.persistedBadge && tagged.panelState.persistedBadge.when === '2026-05-01',
      tagged && tagged.panelState.persistedBadge && tagged.panelState.persistedBadge.when);
    T('T075 corrected finding is NOT suppressed (still in the model)', !!tagged);

    QuranPanelModel.reset();
    const g = { id: 'dis1', color: 'orange', text: 'y', matchedRef: 'البقرة:2', claimedRef: '(البقرة:3)' };
    QuranPanelModel.upsert(g);
    QuranPanelModel.tagPersisted([{ compositeKey: 'dis1', kind: 'dismissal', at: '2026-05-02T00:00:00.000Z' }]);
    const dtag = QuranPanelModel.all().find(x => x.id === 'dis1');
    T('T056 dismissal entry tags persistedBadge=dismissed', dtag && dtag.panelState.persistedBadge && dtag.panelState.persistedBadge.kind === 'dismissed',
      dtag && JSON.stringify(dtag.panelState.persistedBadge));

    // ── T070: model-level dismiss + restore ─────────────────────────────────
    QuranPanelModel.markDismissedThisSession('dis1');
    T('T070 dismiss flags dismissedThisSession', QuranPanelModel.dismissedThisSession().some(x => x.id === 'dis1'));
    QuranPanelModel.unmarkDismissed('dis1');
    T('T070 restore clears the dismissal', !QuranPanelModel.dismissedThisSession().some(x => x.id === 'dis1'));
  } else {
    T('QuranPanelModel available', false, 'global missing');
  }

  await sleep(10);
  return results;
}

async function main() {
  const cases = deriveOrangeCases();
  const seed = { 'prefs.v1': { master: { authenticTextReplacement: false }, scanTrigger: 'manual' } };
  const browser = await launchSystemChromium();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const runnerHtml = buildRunnerHtml(fixtureBody(cases), seed);

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
      : ext === '.ttf' ? 'font/ttf' : ext === '.otf' ? 'font/otf' : ext === '.woff2' ? 'font/woff2'
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
  console.log(`\ninteraction: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
