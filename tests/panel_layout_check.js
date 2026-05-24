'use strict';
/*
 * Panel placement DOM test (panelPosition / floatAnchor + summary collapse).
 * ---------------------------------------------------------------------------
 * Mounts the real page-injected sidebar (js/panel/sidebar-surface.js) in a
 * routed page with a small chrome + QuranMsg stub, then drives the placement
 * API and asserts the resulting DOM:
 *   • auto docking follows language direction (ar→right, en→left)
 *   • explicit left/right dock + host gutter side
 *   • English panel is LTR
 *   • float overlays (no host gutter) but still docks to a side
 *   • float anchor picks the side; an unchanged anchor write is a no-op
 *   • grabbing the title bar tears the float off into a free box, and dragging
 *     it near a screen edge re-docks it
 *   • the results-summary collapse toggle hides/shows the counts grid
 *   • the swap toggle sits after the summary and before the filter chips
 *
 * Reuses the run_tests_node harness pattern (system Chromium + asset routing).
 * Run: node tests/panel_layout_check.js
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

function runnerHtml() {
  const scripts = [
    'js/shared/i18n.js',
    'js/panel/model.js',
    'js/panel/keyboard.js',
    'js/panel/sidebar-surface.js',
  ].map(p => `<script src="${ORIGIN}/${p}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<link rel="stylesheet" href="${ORIGIN}/css/sidebar.css">
<script>
  (function () {
    const store = {};
    const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    window.chrome = {
      runtime: { getURL: (p) => '${ORIGIN}/' + String(p).replace(/^\\/+/, '') },
      storage: { local: {
        get: (k, cb) => { const out = { [k]: clone(store[k]) }; if (cb) { setTimeout(() => cb(out), 0); return; } return Promise.resolve(out); },
        set: (obj, cb) => { Object.assign(store, clone(obj)); if (cb) { setTimeout(cb, 0); return; } return Promise.resolve(); },
      } },
    };
    // Messaging stub: PREFS_READ returns window.__PREFS; everything else is inert.
    window.QuranMsg = {
      sendRequest: async (type) => type === 'PREFS_READ'
        ? { payload: { result: window.__PREFS || {} } }
        : { payload: { result: {} } },
    };
  })();
</script>
</head><body>
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

// The in-page battery. Returns [{ name, pass, detail }]. Self-contained so it
// serializes cleanly into page.evaluate.
function inPageTests() {
  const results = [];
  const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });
  const panel = () => document.querySelector('.quran-ext-panel');
  const de = document.documentElement;
  const mr = () => de.style.marginRight;
  const ml = () => de.style.marginLeft;
  const fire = (el, type, x, y) => el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));

  return (async () => {
    window.__PREFS = {
      panelPosition: 'auto', floatAnchor: 'auto', lang: 'ar', font: 'uthmaniHafs',
      refLinks: true, master: { authenticTextReplacement: true },
      panelFilter: { orange: true, green: false, lightBlue: false, lightGreen: false, yellow: false, red: false },
    };
    await QuranPanelSidebar.mount();
    let pl = panel();
    T('mounts a panel', !!pl);
    if (!pl) return results;

    // auto + ar → right dock, right gutter
    T('auto+ar docks right', pl.classList.contains('quran-ext-pos-right') && !pl.classList.contains('quran-ext-pos-left'), pl.className);
    T('auto+ar reserves right gutter only', !!mr() && !ml(), `mr=${mr()} ml=${ml()}`);

    // swap toggle order: after summary, before chips
    const summary = document.querySelector('.quran-ext-summary');
    const swap = document.querySelector('.quran-ext-swap-quick');
    const chips = document.querySelector('.quran-ext-filter-chips');
    const follows = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    T('swap toggle is after the summary', follows(summary, swap));
    T('swap toggle is before the filter chips', follows(swap, chips));

    // explicit left dock
    QuranPanelSidebar.setPosition('left');
    pl = panel();
    T('left dock → pos-left', pl.classList.contains('quran-ext-pos-left') && !pl.classList.contains('quran-ext-pos-right'), pl.className);
    T('left dock reserves left gutter only', !!ml() && !mr(), `mr=${mr()} ml=${ml()}`);

    // auto + en → left dock + LTR direction
    QuranPanelSidebar.setPosition('auto');
    QuranPanelSidebar.applyLang('en');
    pl = panel();
    T('auto+en docks left', pl.classList.contains('quran-ext-pos-left'), pl.className);
    T('english panel is LTR', pl.style.direction === 'ltr', `dir=${pl.style.direction}`);
    QuranPanelSidebar.applyLang('ar'); // restore for the float checks

    // float overlays (no gutter) but still docks to a side
    QuranPanelSidebar.setPosition('float');
    pl = panel();
    T('float adds pos-float', pl.classList.contains('quran-ext-pos-float'), pl.className);
    T('float still docks to a side', pl.classList.contains('quran-ext-pos-right') || pl.classList.contains('quran-ext-pos-left'), pl.className);
    T('float reserves no host gutter', !mr() && !ml(), `mr=${mr()} ml=${ml()}`);

    // float anchor picks the side
    QuranPanelSidebar.setFloatAnchor('left');
    pl = panel();
    T('float anchor left → pos-left + pos-float', pl.classList.contains('quran-ext-pos-left') && pl.classList.contains('quran-ext-pos-float'), pl.className);
    // unchanged anchor write must not reset placement
    QuranPanelSidebar.setFloatAnchor('left');
    T('repeated anchor write is stable', panel().classList.contains('quran-ext-pos-left'));

    // tear-off via header drag, then magnetic re-dock near the right edge
    const W = window.innerWidth;
    const header = pl.querySelector('.quran-ext-panel-header');
    fire(header, 'mousedown', Math.round(W / 2), 100);
    fire(document, 'mousemove', Math.round(W / 2), 200);
    pl = panel();
    T('drag to center tears off (pos-float-free)', pl.classList.contains('quran-ext-pos-float-free'), pl.className);
    const toggleBtn = pl.querySelector('.quran-ext-panel-float-toggle');
    T('free box shows in-header collapse button', !!toggleBtn && toggleBtn.style.display !== 'none', toggleBtn && toggleBtn.style.display);
    fire(document, 'mousemove', W - 5, 200);
    pl = panel();
    T('drag near right edge re-docks', pl.classList.contains('quran-ext-pos-right') && !pl.classList.contains('quran-ext-pos-float-free'), pl.className);
    fire(document, 'mouseup', W - 5, 200);

    // results-summary collapse toggle hides/shows the counts grid
    const sumToggle = document.querySelector('.quran-ext-summary-toggle');
    const grid = document.querySelector('.quran-ext-summary-grid');
    const shown = () => getComputedStyle(grid).display !== 'none';
    const wasShown = shown();
    sumToggle.click();
    T('summary toggle collapses the grid', wasShown && !shown());
    T('summary collapsed sets class + aria', summary.classList.contains('quran-ext-summary-collapsed') && sumToggle.getAttribute('aria-expanded') === 'false');
    sumToggle.click();
    T('summary toggle re-expands the grid', shown());

    return results;
  })();
}

async function main() {
  const browser = await launchSystemChromium();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const html = runnerHtml();

  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/runner') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    const filePath = path.join(PROJECT_DIR, url.pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(PROJECT_DIR) || !fs.existsSync(filePath)) {
      return route.fulfill({ status: 404, body: 'not found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.js' ? 'application/javascript'
      : ext === '.css' ? 'text/css'
      : ext === '.html' ? 'text/html; charset=utf-8'
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
  console.log(`\npanel_layout: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
