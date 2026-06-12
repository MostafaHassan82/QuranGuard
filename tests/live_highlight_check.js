'use strict';
/*
 * T140 — Dynamic-content live-highlight regression gate (Phase 14, feature 001).
 * ---------------------------------------------------------------------------
 * Captures field report #3: on dynamic SPAs (WhatsApp Web, Telegram-web) an
 * Arabic ayah that streams in AFTER the initial scan is NOT highlighted —
 * a manual Scan Page is required. Root cause: non-Arabic UI churn (presence /
 * typing / timestamps) counts toward MUT_MAX_RESCANS in setupMutationObserver,
 * and the T128 circuit-breaker permanently disconnects the MutationObserver.
 *
 * Shape of the gate: initial body carries one valid ayah → initial scan
 * classifies as Arabic and arms the observer → blast >MUT_MAX_RESCANS
 * non-Arabic mutations spaced past the 500 ms debounce so each is its own
 * rescan tick → on shipped code the breaker trips and the observer is gone.
 * Then a fresh Arabic ayah is inserted; the assertion is that within a short
 * post-mutation window the inserted node carries a `.quran-*` highlight span.
 *
 * Today: FAILS — observer dead, no highlight on the inserted ayah.
 * After T141 (gate rescans on AR_CHAR) + T142 (back-off + re-arm): PASSES.
 *
 * Reuses the chrome-mock harness from tests/perf_check.js (same MV3 shape).
 *
 * Run: node tests/live_highlight_check.js
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

// Body is mixed: a valid initial Arabic ayah so the first scan classifies as
// Arabic and arms the observer, plus an English chat-shell host where we'll
// inject non-Arabic churn and (later) a fresh Arabic message. The initial
// Arabic snippet is identical to tests/fixtures/synthetic/cap_hit.html so the
// extractor + verifier behaviour is well-established (الإخلاص:1).
const INITIAL_BODY = `
<div id="header">WhatsApp-style English shell — typing indicators, timestamps, presence.</div>
<article id="initial">
  <p>قال تعالى: {قل هو الله أحد} (الإخلاص:1).</p>
</article>
<div id="chat"><!-- streamed messages land here --></div>`;

function buildRunnerHtml(seed) {
  const scripts = [...BACKGROUND_DEPS, 'js/background.js', ...CONTENT_BUNDLE]
    .map(p => `<script src="${ORIGIN}/${p}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<script>window.__seedStorage = ${JSON.stringify(seed || {})};</script>
<script>${chromeMockSource()}</script>
</head><body>${INITIAL_BODY}
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

// Run inside the page. Drives the scenario and returns named results.
async function inPageTests() {
  const results = [];
  const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Run the initial scan via the test bridge so the observer is armed.
  const first = await window.__quranRunScan();
  const initialHighlights = document.querySelectorAll('.quran-green,.quran-lightblue,.quran-yellow,.quran-orange,.quran-red').length;
  T('initial scan classified as Arabic (≥1 highlight on الإخلاص:1)', initialHighlights >= 1,
    `initialHighlights=${initialHighlights} finalState=${first?.scan?.finalState}`);
  if (initialHighlights === 0) return { results };

  // Burst non-Arabic UI churn into the chat shell. MUT_MAX_RESCANS=8 in 5s; the
  // debounce is 500 ms, so each insertion spaced 600 ms apart fires its own
  // rescan tick. 11 ticks blows the 8-in-5s budget — on shipped code the
  // breaker disconnects the observer here.
  const chat = document.getElementById('chat');
  const churnCount = 11;
  for (let i = 0; i < churnCount; i++) {
    const node = document.createElement('div');
    node.className = 'message';
    node.textContent = `${new Date().toISOString()} — typing… presence change #${i}`;
    chat.appendChild(node);
    await sleep(600);
  }
  // Drain the last debounce.
  await sleep(700);

  // Now insert a fresh Arabic ayah — the "Arabic message arrives after the
  // English shell is loaded" case. Use a different surah to avoid coalescing
  // with the initial finding.
  const ayah = document.createElement('p');
  ayah.id = 'streamed-ayah';
  ayah.textContent = 'وقال أيضًا: {الحمد لله رب العالمين} (الفاتحة:2).';
  chat.appendChild(ayah);

  // Wait long enough for: debounce (500 ms) + subtree scan (≤ a few hundred ms
  // on the test box) + materialise. 2 s is a generous ceiling — perf_check
  // shows a much heavier batch lands in ~85 ms.
  await sleep(2000);

  const highlighted = !!ayah.querySelector('.quran-green,.quran-lightblue,.quran-yellow,.quran-orange,.quran-red')
    || ayah.classList.contains('quran-green') || ayah.classList.contains('quran-lightblue')
    || ayah.classList.contains('quran-yellow') || ayah.classList.contains('quran-orange')
    || ayah.classList.contains('quran-red');
  T('streamed Arabic ayah is live-highlighted without a manual scan', highlighted,
    `ayahHTML=${ayah.outerHTML.slice(0, 200)}`);

  // T143 — observer must be armed even when the initial scan finds no Arabic
  // (English-shell SPA case). Tear down the body, re-run the scan, then stream
  // an Arabic ayah. After scanPage's 50ms swapInProgress grace window clears,
  // the mutation must trigger a subtree rescan and highlight the inserted node.
  document.body.innerHTML = `
    <div id="english-header">All-English shell — no Arabic anywhere yet.</div>
    <div id="english-chat"></div>`;
  const second = await window.__quranRunScan();
  // An html[lang=ar] shell with no Arabic content returns finalState:'empty'
  // (the lang gate passes, body walk finds nothing). For an html[lang=en]
  // shell it would return 'notArabic'. The contract this gate enforces is
  // "no findings + observer armed," which both states satisfy.
  T('T143 — English-shell scan has no findings',
    (second?.scan?.finalState === 'empty' || second?.scan?.finalState === 'notArabic'),
    `finalState=${second?.scan?.finalState}`);
  T('T143 — observer is armed after a no-Arabic scan',
    !!window.__quranLiveProbe?.().observerArmed);

  // Wait past the swap-window guard (50 ms) so the next mutation isn't
  // filtered out by `if (STATE.swapInProgress) return;` — SPA conversations
  // arrive far later than 50 ms in real usage; the test just needs to clear
  // the same window.
  await sleep(150);

  const chat2 = document.getElementById('english-chat');
  const lateAyah = document.createElement('p');
  lateAyah.id = 'late-ayah';
  lateAyah.textContent = 'وقال: {الحمد لله رب العالمين} (الفاتحة:2).';
  chat2.appendChild(lateAyah);
  await sleep(2000);
  const lateHighlighted = !!lateAyah.querySelector('.quran-green,.quran-lightblue,.quran-yellow,.quran-orange,.quran-red')
    || lateAyah.classList.contains('quran-green') || lateAyah.classList.contains('quran-lightblue')
    || lateAyah.classList.contains('quran-yellow') || lateAyah.classList.contains('quran-orange')
    || lateAyah.classList.contains('quran-red');
  T('T143 — Arabic arriving after a no-Arabic shell is live-highlighted',
    lateHighlighted, `lateAyahHTML=${lateAyah.outerHTML.slice(0, 200)} latestScan=${window.__quranScan?.finalState}`);

  // Duplicate-citation gate: two identical Quranic messages streamed in
  // sequence should EACH produce a ref marker. Reproduces a field report
  // where the second of two identical WhatsApp messages didn't show the
  // gold ref highlight even though both ayahs are extracted and verified.
  document.body.innerHTML = '<div id="dup-shell">Chat shell</div><div id="dup-feed"></div>';
  await window.__quranRunScan();
  await sleep(150); // past swap-window

  const feed = document.getElementById('dup-feed');
  const MSG = 'قوله تعالى: {كَذَٰلِكَ يُبَيِّنُ ٱللَّهُ لَكُمْ ءَايَٰتِهِۦ لَعَلَّكُمْ تَعْقِلُونَ} (البقرة:242).';
  const m1 = document.createElement('div'); m1.className = 'message'; m1.textContent = MSG;
  feed.appendChild(m1);
  await sleep(1500);
  const m2 = document.createElement('div'); m2.className = 'message'; m2.textContent = MSG;
  feed.appendChild(m2);
  await sleep(2000);

  const refMarkers = document.querySelectorAll('.quran-ref-marker');
  const ayahHighlights = document.querySelectorAll('.quran-green');
  T('dup-citations: both ayahs highlighted',
    ayahHighlights.length === 2, `ayahHighlights=${ayahHighlights.length}`);
  T('dup-citations: both refs got gold markers',
    refMarkers.length === 2, `refMarkers=${refMarkers.length}`);

  // Deep-nest variant: WhatsApp Web buries each message bubble 15-20+ levels
  // deep inside identically-structured wrapper divs. If computeDomPath caps
  // its ancestor walk too shallow, two identical bubbles get the same
  // composite findingId, and placeRefMarkers skips the second one (the marker
  // selector finds the first finding's marker and bails). Field-reported.
  document.body.innerHTML = '<div id="deep-shell">Chat shell</div><div id="deep-feed"></div>';
  await window.__quranRunScan();
  await sleep(150);
  function deepBubble(msg) {
    let outer = document.createElement('div'); outer.className = 'bubble';
    let cur = outer;
    for (let i = 0; i < 20; i++) {
      const w = document.createElement('div'); w.className = 'w'; cur.appendChild(w); cur = w;
    }
    cur.textContent = msg;
    return outer;
  }
  const deepFeed = document.getElementById('deep-feed');
  deepFeed.appendChild(deepBubble(MSG));
  await sleep(1500);
  deepFeed.appendChild(deepBubble(MSG));
  await sleep(2000);
  const deepGreens = document.querySelectorAll('#deep-feed .quran-green').length;
  const deepMarkers = document.querySelectorAll('#deep-feed .quran-ref-marker').length;
  const deepFids = new Set([...document.querySelectorAll('#deep-feed .quran-green')].map(g => g.dataset.findingId));
  T('deep-nest dup-citations: both ayahs highlighted',
    deepGreens === 2, `deepGreens=${deepGreens}`);
  T('deep-nest dup-citations: distinct findingIds',
    deepFids.size === 2, `distinctIds=${deepFids.size}`);
  T('deep-nest dup-citations: both refs got gold markers',
    deepMarkers === 2, `deepMarkers=${deepMarkers}`);

  // WhatsApp bidi-injection scenario: after a clean message is rendered,
  // WhatsApp Web sometimes rewrites mixed-direction text nodes by inserting
  // directional/zero-width marks (U+200E, U+202B/C, U+2068/9 etc.) around the
  // Arabic ref's parens+digits. Our extractor read the clean text at scan
  // time, but the rendered DOM text node now differs — wrapRefAfter must
  // tolerate that delta or the gold marker is lost.
  document.body.innerHTML = '<div id="bidi-shell">Chat shell</div><div id="bidi-feed"></div>';
  await window.__quranRunScan();
  await sleep(150);

  const bidiFeed = document.getElementById('bidi-feed');
  // Insert a clean message — extractor will record refText="(البقرة:242)".
  const bm = document.createElement('div'); bm.className = 'message';
  bm.textContent = MSG;
  bidiFeed.appendChild(bm);
  await sleep(1500);
  // Now mutate the ref text node IN PLACE the way WhatsApp would: pad the
  // ref with LRM + RLE + PDF marks. The marker must end up on this node
  // (the bidi-tolerant fallback in wrapRefAfter handles this).
  const bidiMsg = document.createElement('div'); bidiMsg.className = 'message';
  // Build the mixed-bidi version inline; the marks are invisible to the eye
  // but live in the underlying string. ‎ = LRM, ‫ = RLE, ‬ = PDF.
  // ‎ = LRM (U+200E), ‫ = RLE (U+202B), ‬ = PDF (U+202C), ؜ = ALM (U+061C).
  // ALM is the one WhatsApp Web actually injects most often around Arabic refs;
  // it lives outside the U+200B-U+200F range so was missed by an earlier fix.
  bidiMsg.textContent = 'قوله تعالى: {كَذَٰلِكَ يُبَيِّنُ ٱللَّهُ لَكُمْ ءَايَٰتِهِۦ لَعَلَّكُمْ تَعْقِلُونَ} ‎‫؜(البقرة:242)؜‬.';
  bidiFeed.appendChild(bidiMsg);
  await sleep(2000);

  const bidiMarkers = document.querySelectorAll('.quran-ref-marker').length;
  const bidiGreens = document.querySelectorAll('.quran-green').length;
  T('bidi-injection: both ayahs highlighted',
    bidiGreens === 2, `bidiGreens=${bidiGreens}`);
  T('bidi-injection: both refs got markers (bidi-tolerant wrap)',
    bidiMarkers === 2, `bidiMarkers=${bidiMarkers}`);

  return { results };
}

async function main() {
  const browser = await launchSystemChromium();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  // Seed prefs so autoscan would run by itself — the test bridge also drives a
  // scan explicitly via __quranRunScan, so this is belt-and-suspenders.
  const runnerHtml = buildRunnerHtml({ prefs: { scanTrigger: 'autoscan' } });

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

  if (process.env.QURAN_TEST_VERBOSE) page.on('console', (msg) => console.log('[page]', msg.type(), msg.text()));
  let out;
  try {
    await page.goto(`${ORIGIN}/runner`, { waitUntil: 'load', timeout: 20000 });
    out = await page.evaluate(`(${inPageTests.toString()})()`);
  } finally {
    await context.close();
    await browser.close();
  }

  const results = out.results || [];
  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\nlive-highlight: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
