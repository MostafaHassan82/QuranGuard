'use strict';
/**
 * QuranGuard promo capture tool
 *
 * Usage:
 *   node tools/capture/run.js --screenshots            All 7 screenshots via Playwright (1280x800)
 *   node tools/capture/run.js --screenshots --screen   All 7 screenshots via gdigrab (real Chrome window)
 *   node tools/capture/run.js --tiles                  Small (440x280) + Marquee (1400x560) tiles
 *   node tools/capture/run.js --video promo            Record ~75s promo video (Playwright webm)
 *   node tools/capture/run.js --video promo-screen     Record ~75s promo video via gdigrab (real Chrome)
 *   node tools/capture/run.js --video promo --screen   Same as --video promo-screen
 *   node tools/capture/run.js --video tutorial         Record ~5-min tutorial video (webm)
 *   node tools/capture/run.js --all                    All of the above (Playwright mode)
 *
 * Screenshot stories (--screenshots only):
 *   Story 1 — Reader baseline  : shots 01, 02, 03  (real islamweb.net 241627)
 *   Story 2 — Error detail     : shot  04           (real islamweb.net 220324)
 *   Story 3 — Writer flow      : shots 05, 06, 07  (local writer demo)
 *
 * Selective capture:
 *   --story 1,3          run only stories 1 and 3
 *   --skip-story 2       skip story 2 (run 1 and 3)
 *   --shot 5             run only shot 5
 *   --shot 5,6,7         run shots 5, 6, 7
 *   --skip-shot 1        skip shot 1 (run all others)
 */

const path      = require('path');
const fs        = require('fs');
const { chromium } = require('playwright');
const sharp     = require('sharp');
const { serve } = require('./server.js');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXT_PATH     = PROJECT_ROOT;
const OUTPUT_DIR   = path.join(__dirname, 'output');
const SHOTS_DIR    = path.join(OUTPUT_DIR, 'screenshots');
const TILES_DIR    = path.join(OUTPUT_DIR, 'tiles');
const VIDEO_DIR    = path.join(OUTPUT_DIR, 'video');

// Real source URLs (from fixture expected.json) — navigated directly so the
// extension runs on the live site exactly as end users experience it.
const URL_COLORS = 'https://www.islamweb.net/ar/article/241627/%D8%AD%D8%B0%D9%81-%D8%A7%D9%84%D8%AA%D9%86%D9%88%D9%8A%D9%86-%D8%AA%D8%AE%D9%81%D9%8A%D9%81%D8%A7%D9%8B';
const URL_ERRORS = 'https://www.islamweb.net/ar/article/220324/%D8%AC%D9%85%D9%88%D8%B9-%D8%A7%D9%84%D8%AA%D9%83%D8%B3%D9%8A%D8%B1-%D9%81%D9%8A-%D8%A7%D9%84%D9%82%D8%B1%D8%A2%D9%86-%D8%A7%D9%84%D9%83%D8%B1%D9%8A%D9%85-%D8%AC%D9%85%D9%88%D8%B9-%D8%A7%D9%84%D9%83%D8%AB%D8%B1%D8%A9-8';

// Keep these for tiles / video modes that stay on local fixtures for speed.
const FIXTURE_COLORS = '241627';
const FIXTURE_ERRORS = '220324';

// ── CLI args ──────────────────────────────────────────────────────────────────

function _parseCsv(s) {
  return (s || '').split(',').map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n));
}

const args          = process.argv.slice(2);
const doShots       = args.includes('--screenshots') || args.includes('--all');
const doTiles       = args.includes('--tiles')       || args.includes('--all');
const doScreen      = args.includes('--screen');
const videoArg      = args.indexOf('--video');
const doPromo       = (videoArg >= 0 && args[videoArg + 1] === 'promo')    || args.includes('--all');
const doPromoScreen = (videoArg >= 0 && args[videoArg + 1] === 'promo-screen') ||
                      (doPromo && doScreen);
const doTutorial    = (videoArg >= 0 && args[videoArg + 1] === 'tutorial') || args.includes('--all');
const doShotsScreen = doShots && doScreen;

// Story / shot selectors — apply only to --screenshots.
// --story N,M  : run only those stories; absent = run all
// --skip-story : exclude those stories
// --shot N,M   : run only those shots; absent = run all
// --skip-shot  : exclude those shots
const _storyIdx      = args.indexOf('--story');
const _skipStoryIdx  = args.indexOf('--skip-story');
const _shotIdx       = args.indexOf('--shot');
const _skipShotIdx   = args.indexOf('--skip-shot');

const _onlyStories  = _storyIdx     >= 0 ? new Set(_parseCsv(args[_storyIdx + 1]))     : null;
const _skipStories  = _skipStoryIdx >= 0 ? new Set(_parseCsv(args[_skipStoryIdx + 1])) : new Set();
const _onlyShots    = _shotIdx      >= 0 ? new Set(_parseCsv(args[_shotIdx + 1]))       : null;
const _skipShots    = _skipShotIdx  >= 0 ? new Set(_parseCsv(args[_skipShotIdx + 1]))  : new Set();

// filter.story(N) / filter.shot(N) — true if that story/shot should run.
const filter = {
  story: (n) => {
    if (_onlyStories && !_onlyStories.has(n)) return false;
    if (_skipStories.has(n)) return false;
    return true;
  },
  shot: (n) => {
    if (_onlyShots && !_onlyShots.has(n)) return false;
    if (_skipShots.has(n)) return false;
    return true;
  },
};

if (!doShots && !doTiles && !doPromo && !doPromoScreen && !doTutorial) {
  console.log('Usage: node tools/capture/run.js [--screenshots [--screen]] [--tiles]');
  console.log('                                  [--video promo|promo-screen|tutorial]');
  console.log('                                  [--video promo --screen] [--all]');
  console.log('       Screenshot filters: [--story N,M] [--skip-story N] [--shot N,M] [--skip-shot N]');
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }

// Launch Playwright Chromium with the extension loaded.
// screenCapture: true → position window at 0,0 with fixed outer size (for gdigrab alignment)
async function launchWithExtension({ recordVideo, screenCapture, winW = 1280, winH = 800 } = {}) {
  const ctxOpts = {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--enable-automation'],
  };

  if (screenCapture) {
    // Pin window top-left so gdigrab offset_x=0 offset_y=0 captures the exact window.
    // Disable popup blocking so window.open() for the popup scene creates a floating window.
    ctxOpts.args.push(
      '--window-position=0,0',
      `--window-size=${winW},${winH}`,
      '--disable-popup-blocking',
    );
    ctxOpts.viewport = null; // let Chrome use the natural content-area size
  }

  if (recordVideo) {
    ctxOpts.recordVideo = {
      dir: VIDEO_DIR,
      size: { width: 1280, height: 720 },
    };
  }

  const context = await chromium.launchPersistentContext('', ctxOpts);

  // Wait for the MV3 service worker so we can read the extension ID.
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const extensionId = sw.url().split('/')[2];
  const popupUrl    = `chrome-extension://${extensionId}/html/popup.html`;
  const optionsUrl  = `chrome-extension://${extensionId}/html/options.html`;

  return { context, extensionId, popupUrl, optionsUrl, sw };
}

// Set scanTrigger in prefs.v1 so content scripts autoscan on page load.
async function setScanTrigger(sw, value) {
  return sw.evaluate(async (v) => {
    const data   = await chrome.storage.local.get('prefs.v1');
    const prefs  = data['prefs.v1'] || {};
    const prev   = prefs.scanTrigger || 'manual';
    prefs.scanTrigger = v;
    await chrome.storage.local.set({ 'prefs.v1': prefs });
    return prev;
  }, value);
}

// Set panel prefs for capture: all categories visible, panel floats on the left
// so it doesn't squeeze the page text (float = overlay, not side-by-side).
async function setCapturePanelPrefs(sw) {
  await sw.evaluate(async () => {
    const data  = await chrome.storage.local.get('prefs.v1');
    const prefs = data['prefs.v1'] || {};
    prefs.panelFilter   = { orange: true, green: true, lightBlue: true, lightGreen: true, yellow: true, red: true };
    prefs.panelPosition = 'float';
    prefs.floatAnchor   = 'left';
    await chrome.storage.local.set({ 'prefs.v1': prefs });
  });
}

// Navigate to a fixture URL and wait until the content script's autoscan
// has placed at least one highlight in the DOM.
async function gotoAndScan(page, url, { timeout = 30_000 } = {}) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector(
    '.quran-green, .quran-red, .quran-orange, .quran-yellow, .quran-lightblue',
    { timeout }
  );
  await sleep(400); // let the panel mount
}

// Scroll to the first element matching selector.
async function scrollTo(page, selector) {
  const el = await page.$(selector);
  if (el) await el.scrollIntoViewIfNeeded();
  return el;
}

// Wait for the sidebar panel to appear (best-effort).
async function waitForPanel(page, timeout = 18_000) {
  await page.waitForSelector('.quran-ext-panel', { timeout }).catch(() => null);
  await sleep(600); // let panel finish rendering its findings list
}

// ── Screen-capture helpers (gdigrab) ─────────────────────────────────────────

// Start FFmpeg gdigrab recording of the desktop region 0,0 → W×H.
// Returns the child process. Call _stopScreenCapture() when done.
function _startScreenCapture(outPath, w, h) {
  const { spawn } = require('child_process');
  const ffmpeg = _findFfmpeg();
  const proc = spawn(ffmpeg, [
    '-f', 'gdigrab',
    '-framerate', '30',
    '-offset_x', '0',
    '-offset_y', '0',
    '-video_size', `${w}x${h}`,
    '-i', 'desktop',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-y', outPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => {
    const line = d.toString();
    if (/error|failed/i.test(line) && !/Last message repeated/.test(line)) {
      process.stderr.write('[ffmpeg] ' + line);
    }
  });
  proc.on('error', (e) => console.error('FFmpeg spawn error:', e.message));
  return proc;
}

// Stop FFmpeg gracefully by sending 'q' to stdin; waits for process to exit.
function _stopScreenCapture(proc) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(); }, 10_000);
    proc.on('close', () => { clearTimeout(timer); resolve(); });
    try { proc.stdin.write('q'); proc.stdin.end(); } catch (_) {}
  });
}

// Capture a single frame of the desktop region (x, y, w, h) and write to outPath.
async function _captureScreenFrame(x, y, w, h, outPath) {
  const { execFile } = require('child_process');
  const ffmpeg = _findFfmpeg();
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, [
      '-f', 'gdigrab',
      '-framerate', '1',
      '-offset_x', String(x),
      '-offset_y', String(y),
      '-video_size', `${w}x${h}`,
      '-i', 'desktop',
      '-vframes', '1',
      '-y', outPath,
    ], { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) { console.error('[gdigrab frame]', stderr.slice(-300)); reject(err); }
      else resolve(outPath);
    });
  });
}

// Open the extension popup as a real floating window using a Playwright-synthesized
// click (which counts as a user gesture, allowing window.open to create a popup).
// Returns the new page, or null on failure.
async function _openPopupWindow(context, page, popupUrl) {
  // Inject a tiny invisible button whose click handler opens the popup window.
  await page.evaluate((url) => {
    const btn = document.createElement('button');
    btn.id = '__qg_popup_trigger';
    btn.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:all;z-index:99999';
    btn.onclick = () => window.open(url, 'qgpopup',
      'width=380,height=560,left=880,top=50,resizable=no,menubar=no,toolbar=no,location=no,status=no');
    document.body.appendChild(btn);
  }, popupUrl);

  const [popupPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 6000 }).catch(() => null),
    page.click('#__qg_popup_trigger'),
  ]);

  await page.evaluate(() => document.getElementById('__qg_popup_trigger')?.remove());
  if (popupPage) {
    await popupPage.waitForLoadState('domcontentloaded').catch(() => {});
  }
  return popupPage;
}

// ── Screenshot capture (Playwright) ──────────────────────────────────────────

async function captureScreenshots(srv) {
  ensureDir(SHOTS_DIR);

  // Print which stories/shots will run
  const runningStories = [1, 2, 3].filter(n => filter.story(n));
  console.log('\n── Screenshots (1280×800) ──────────────────────────────────────');
  console.log(`  Stories: ${runningStories.join(', ') || '(none)'}`);

  const { context, popupUrl, extensionId, sw } = await launchWithExtension();
  await setScanTrigger(sw, 'manual');
  await setCapturePanelPrefs(sw);

  // Scroll position where citations start — shared by shots 01, 02, 03.
  const ARTICLE_SCROLL_Y = 600;

  try {

    // ════════════════════════════════════════════════════════════════════════
    // Story 1 — Reader baseline: clean page → popup → scan results
    // Shots: 01, 02, 03
    // ════════════════════════════════════════════════════════════════════════
    if (filter.story(1)) {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 800 });

      console.log('  [Story 1] Loading real site (241627)…');
      await page.goto(URL_COLORS, { waitUntil: 'networkidle', timeout: 45_000 });
      await _dismissOverlays(page);
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), ARTICLE_SCROLL_Y);
      await sleep(800);

      // ── Shot 01 ────────────────────────────────────────────────────────────
      if (filter.shot(1)) {
        await page.screenshot({ path: path.join(SHOTS_DIR, '01-page-before-scan.png') });
        console.log('  ✓ 01-page-before-scan.png');
      }

      // ── Shot 02: popup composited over shot 01's page ─────────────────────
      if (filter.shot(2)) {
        const popupPage = await context.newPage();
        await popupPage.setViewportSize({ width: 340, height: 560 });
        await popupPage.goto(popupUrl, { waitUntil: 'domcontentloaded' });
        await sleep(1200);
        const popupBodyH = await popupPage.evaluate(() => document.body.scrollHeight);
        const popupBuf = await popupPage.screenshot({
          clip: { x: 0, y: 0, width: 340, height: Math.min(popupBodyH + 2, 560) },
        });
        const popupWithBorder = await sharp(popupBuf)
          .extend({ top: 1, bottom: 1, left: 1, right: 1, background: { r: 180, g: 180, b: 180, alpha: 255 } })
          .toBuffer();
        // Use shot 01 file as background; fall back to a live page screenshot.
        const shot01Path = path.join(SHOTS_DIR, '01-page-before-scan.png');
        const pageBuf = fs.existsSync(shot01Path)
          ? await fs.promises.readFile(shot01Path)
          : await page.screenshot();
        const composited = await sharp(pageBuf)
          .composite([{ input: popupWithBorder, top: 8, left: 930 }])
          .toBuffer();
        await fs.promises.writeFile(path.join(SHOTS_DIR, '02-popup-open.png'), composited);
        console.log('  ✓ 02-popup-open.png');
      }

      // ── Shot 03: same page + same scroll, with highlights ─────────────────
      if (filter.shot(3)) {
        await setScanTrigger(sw, 'autoscan');
        await page.bringToFront();
        await page.reload({ waitUntil: 'networkidle', timeout: 45_000 });
        await _dismissOverlays(page);
        await page.waitForSelector('.quran-green, .quran-lightblue, .quran-yellow', { timeout: 35_000 });
        await waitForPanel(page);
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), ARTICLE_SCROLL_Y);
        await sleep(700);
        await page.screenshot({ path: path.join(SHOTS_DIR, '03-scan-results.png') });
        console.log('  ✓ 03-scan-results.png');
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Story 2 — Error detail: red highlight + floating panel
    // Shot: 04
    // ════════════════════════════════════════════════════════════════════════
    if (filter.story(2) && filter.shot(4)) {
      // Re-use an existing page if story 1 already opened one, else open fresh.
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 800 });

      await setScanTrigger(sw, 'autoscan');
      console.log('  [Story 2] Loading real site (220324)…');
      await gotoAndScan(page, URL_ERRORS, { timeout: 45_000 });
      await sleep(2000);          // 220324 has 53 findings to render
      await waitForPanel(page);
      const redEl = await scrollTo(page, '.quran-red');
      if (redEl) {
        await page.evaluate(() => window.scrollBy({ top: -200, behavior: 'instant' }));
        await sleep(400);
        await redEl.click();
        await sleep(1000);
      }
      await page.screenshot({ path: path.join(SHOTS_DIR, '04-red-highlight-detail.png') });
      console.log('  ✓ 04-red-highlight-detail.png');
    }

    // ════════════════════════════════════════════════════════════════════════
    // Story 3 — Writer autocomplete flow
    // Shots: 05 (candidates), 06 (scope menu), 07 (ayah inserted)
    //
    // Typed text: "فإذا قرأت" — the beginning of النحل:98, the ayah explicitly
    // cited in Islamic scholarship when introducing the ruling on Isti'aaza
    // before Quranic recitation.  The article's pre-filled content ends with
    // "...بقوله تعالى: ﴿" so the detection context is correct.
    // ════════════════════════════════════════════════════════════════════════
    if (filter.story(3)) {
      const writerPage = await context.newPage();
      await writerPage.setViewportSize({ width: 1280, height: 800 });
      await writerPage.goto(`${srv.base}/writer-demo`, { waitUntil: 'load' });
      await sleep(800);

      // Uthmani font only for dropdown candidates — the editor body stays in
      // normal Arabic so ﴿ renders as a plain bracket.
      await writerPage.evaluate((extId) => {
        const s = document.createElement('style');
        s.textContent = `
          @font-face {
            font-family: 'UthmaniHafs';
            src: url('chrome-extension://${extId}/resources/fonts/uthmani-hafs.ttf') format('truetype');
          }
          .quran-ac-ayah {
            font-family: 'UthmaniHafs', 'Traditional Arabic', serif !important;
            font-size: 18px !important;
          }
        `;
        document.head.appendChild(s);
      }, extensionId);
      await sleep(500);

      // Ctrl+End after click ensures the caret is at the very end of the
      // pre-filled text (a plain click lands at the element's centre).
      await writerPage.click('#article-body');
      await sleep(200);
      await writerPage.keyboard.press('Control+End');
      await sleep(200);
      await writerPage.keyboard.type('فإذا قرأت', { delay: 110 });

      const dropdownVisible = await writerPage.waitForSelector('.quran-ac-menu', { timeout: 8000 })
        .then(() => true).catch(() => { console.warn('  ⚠ dropdown not detected'); return false; });
      await sleep(600);

      async function applySpotlight() {
        await writerPage.evaluate(() => {
          document.querySelectorAll('.__spotlight').forEach(n => n.remove());
          const s = document.createElement('style');
          s.className = '__spotlight';
          s.textContent = `
            .editor-bar    { filter: blur(5px); opacity: 0.60; }
            .meta-row      { filter: blur(4px); opacity: 0.60; }
            .article-title { filter: blur(4px); opacity: 0.70; }
            .fmt-bar       { filter: blur(3px); opacity: 0.65; }
          `;
          document.head.appendChild(s);
          const v = document.createElement('div');
          v.className = '__spotlight';
          v.style.cssText = [
            'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:9999',
            'background:linear-gradient(to bottom,rgba(0,0,0,0.50) 0%,rgba(0,0,0,0.18) 34%,transparent 52%)',
          ].join(';');
          document.body.appendChild(v);
        });
      }

      // ── Shot 05 ────────────────────────────────────────────────────────────
      if (filter.shot(5)) {
        await applySpotlight();
        await writerPage.screenshot({ path: path.join(SHOTS_DIR, '05-writer-autocomplete.png') });
        console.log('  ✓ 05-writer-autocomplete.png');
      }

      // ── Shot 06: Tab → accept candidate → scope menu ──────────────────────
      let scopeMenuVisible = false;
      if (filter.shot(6) && dropdownVisible) {
        await writerPage.evaluate(() => document.querySelectorAll('.__spotlight').forEach(n => n.remove()));
        await writerPage.keyboard.press('Tab');   // accept first candidate → scope menu
        await sleep(700);
        scopeMenuVisible = await writerPage.$('.quran-ac-menu').then(el => !!el).catch(() => false);
        await applySpotlight();
        await writerPage.screenshot({ path: path.join(SHOTS_DIR, '06-writer-scope-menu.png') });
        console.log('  ✓ 06-writer-scope-menu.png');
      } else if (filter.shot(6)) {
        console.warn('  ⚠ shot 06 skipped — dropdown was not visible');
      }

      // ── Shot 07: Tab → accept "whole" scope → ayah inserted ───────────────
      if (filter.shot(7) && scopeMenuVisible) {
        await writerPage.evaluate(() => document.querySelectorAll('.__spotlight').forEach(n => n.remove()));
        await writerPage.keyboard.press('Tab');   // picks index 0 = "whole" → doInsert
        await sleep(1000);
        await writerPage.screenshot({ path: path.join(SHOTS_DIR, '07-writer-inserted.png') });
        console.log('  ✓ 07-writer-inserted.png');
      } else if (filter.shot(7)) {
        console.warn('  ⚠ shot 07 skipped — scope menu was not visible');
      }
    }

  } finally {
    await setScanTrigger(sw, 'manual');
    await context.close();
  }

  console.log('\n  Screenshots saved to', SHOTS_DIR);
}

// ── Screenshot capture (screen / gdigrab) ────────────────────────────────────
// Same stories/shots as captureScreenshots, but Chrome is positioned at 0,0
// and each frame is captured via gdigrab so the real browser chrome (address
// bar, extension icon) is visible.  Shot 02 opens the popup as a real floating
// window via window.open() triggered by a synthesized click.

async function captureScreenshotsScreen(srv) {
  ensureDir(SHOTS_DIR);
  const W = 1280, H = 800;

  const runningStories = [1, 2, 3].filter(n => filter.story(n));
  console.log('\n── Screenshots [screen capture] (1280×800) ─────────────────────');
  console.log(`  Stories: ${runningStories.join(', ') || '(none)'}`);

  const { context, popupUrl, extensionId, sw } = await launchWithExtension({ screenCapture: true, winW: W, winH: H });
  await setScanTrigger(sw, 'manual');
  await setCapturePanelPrefs(sw);

  const ARTICLE_SCROLL_Y = 600;

  async function grabScreen(outPath) {
    await sleep(400); // let Chrome finish rendering to screen
    return _captureScreenFrame(0, 0, W, H, outPath);
  }

  try {
    // ════════════════════════════════════════════════════════════════════════
    // Story 1 — Reader baseline
    // ════════════════════════════════════════════════════════════════════════
    if (filter.story(1)) {
      const page = await context.newPage();
      await page.bringToFront();

      console.log('  [Story 1] Loading real site (241627)…');
      await page.goto(URL_COLORS, { waitUntil: 'networkidle', timeout: 45_000 });
      await _dismissOverlays(page);
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), ARTICLE_SCROLL_Y);
      await sleep(800);

      // Shot 01
      if (filter.shot(1)) {
        await grabScreen(path.join(SHOTS_DIR, '01-page-before-scan.png'));
        console.log('  ✓ 01-page-before-scan.png');
      }

      // Shot 02: real floating popup window
      if (filter.shot(2)) {
        const popupPage = await _openPopupWindow(context, page, popupUrl);
        await sleep(1500);
        await grabScreen(path.join(SHOTS_DIR, '02-popup-open.png'));
        console.log('  ✓ 02-popup-open.png');
        if (popupPage) await popupPage.close().catch(() => {});
        await page.bringToFront();
        await sleep(400);
      }

      // Shot 03: scan results
      if (filter.shot(3)) {
        await setScanTrigger(sw, 'autoscan');
        await page.bringToFront();
        await page.reload({ waitUntil: 'networkidle', timeout: 45_000 });
        await _dismissOverlays(page);
        await page.waitForSelector('.quran-green, .quran-lightblue, .quran-yellow', { timeout: 35_000 });
        await waitForPanel(page);
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), ARTICLE_SCROLL_Y);
        await sleep(700);
        await grabScreen(path.join(SHOTS_DIR, '03-scan-results.png'));
        console.log('  ✓ 03-scan-results.png');
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Story 2 — Error detail
    // ════════════════════════════════════════════════════════════════════════
    if (filter.story(2) && filter.shot(4)) {
      const page = await context.newPage();
      await page.bringToFront();

      await setScanTrigger(sw, 'autoscan');
      console.log('  [Story 2] Loading real site (220324)…');
      await gotoAndScan(page, URL_ERRORS, { timeout: 45_000 });
      await sleep(2000);
      await waitForPanel(page);
      const redEl = await scrollTo(page, '.quran-red');
      if (redEl) {
        await page.evaluate(() => window.scrollBy({ top: -200, behavior: 'instant' }));
        await sleep(400);
        await redEl.click();
        await sleep(1000);
      }
      await grabScreen(path.join(SHOTS_DIR, '04-red-highlight-detail.png'));
      console.log('  ✓ 04-red-highlight-detail.png');
    }

    // ════════════════════════════════════════════════════════════════════════
    // Story 3 — Writer flow
    // ════════════════════════════════════════════════════════════════════════
    if (filter.story(3)) {
      const writerPage = await context.newPage();
      await writerPage.bringToFront();
      await writerPage.goto(`${srv.base}/writer-demo`, { waitUntil: 'load' });
      await sleep(800);

      await writerPage.evaluate((extId) => {
        const s = document.createElement('style');
        s.textContent = `
          @font-face { font-family:'UthmaniHafs'; src:url('chrome-extension://${extId}/resources/fonts/uthmani-hafs.ttf') format('truetype'); }
          .quran-ac-ayah { font-family:'UthmaniHafs','Traditional Arabic',serif !important; font-size:18px !important; }
        `;
        document.head.appendChild(s);
      }, extensionId);
      await sleep(500);

      await writerPage.click('#article-body');
      await sleep(200);
      await writerPage.keyboard.press('Control+End');
      await sleep(200);
      await writerPage.keyboard.type('فإذا قرأت', { delay: 110 });

      const dropdownVisible = await writerPage.waitForSelector('.quran-ac-menu', { timeout: 8000 })
        .then(() => true).catch(() => { console.warn('  ⚠ dropdown not detected'); return false; });
      await sleep(600);

      if (filter.shot(5)) {
        await grabScreen(path.join(SHOTS_DIR, '05-writer-autocomplete.png'));
        console.log('  ✓ 05-writer-autocomplete.png');
      }

      let scopeMenuVisible = false;
      if (filter.shot(6) && dropdownVisible) {
        await writerPage.keyboard.press('Tab');
        await sleep(700);
        scopeMenuVisible = await writerPage.$('.quran-ac-menu').then(el => !!el).catch(() => false);
        await grabScreen(path.join(SHOTS_DIR, '06-writer-scope-menu.png'));
        console.log('  ✓ 06-writer-scope-menu.png');
      } else if (filter.shot(6)) {
        console.warn('  ⚠ shot 06 skipped — dropdown was not visible');
      }

      if (filter.shot(7) && scopeMenuVisible) {
        await writerPage.keyboard.press('Tab');
        await sleep(1000);
        await grabScreen(path.join(SHOTS_DIR, '07-writer-inserted.png'));
        console.log('  ✓ 07-writer-inserted.png');
      } else if (filter.shot(7)) {
        console.warn('  ⚠ shot 07 skipped — scope menu was not visible');
      }
    }

  } finally {
    await setScanTrigger(sw, 'manual');
    await context.close();
  }

  console.log('\n  Screenshots saved to', SHOTS_DIR);
}

// Dismiss common cookie / consent banners on islamweb.net
async function _dismissOverlays(page) {
  const selectors = [
    'button[id*="accept"]', 'button[class*="accept"]',
    'button[id*="cookie"]', 'button[class*="cookie"]',
    '[id*="cookieConsent"] button', '[class*="gdpr"] button',
    'button[id*="agree"]',  'button[class*="agree"]',
  ];
  for (const sel of selectors) {
    await page.click(sel, { timeout: 1500 }).catch(() => {});
  }
  await sleep(400);
}

// ── Tile capture ──────────────────────────────────────────────────────────────

async function captureTiles(srv) {
  ensureDir(TILES_DIR);
  console.log('\n── Promo tiles ─────────────────────────────────────────────────');

  const { context, sw } = await launchWithExtension();
  await setScanTrigger(sw, 'autoscan');

  try {
    // Small tile: 440×280
    {
      const page = await context.newPage();
      await page.setViewportSize({ width: 440, height: 280 });
      await gotoAndScan(page, `${srv.base}/fixture/${FIXTURE_COLORS}`);
      await page.screenshot({ path: path.join(TILES_DIR, 'small-tile-440x280.png') });
      console.log('  ✓ small-tile-440x280.png');
    }

    // Marquee tile: 1400×560
    {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1400, height: 560 });
      await gotoAndScan(page, `${srv.base}/fixture/${FIXTURE_ERRORS}`);
      await waitForPanel(page);
      await page.screenshot({ path: path.join(TILES_DIR, 'marquee-tile-1400x560.png') });
      console.log('  ✓ marquee-tile-1400x560.png');
    }

  } finally {
    await setScanTrigger(sw, 'manual');
    await context.close();
  }

  console.log('\n  Tiles saved to', TILES_DIR);
}

// ── Promo video — Playwright recording (~75 sec) ──────────────────────────────
//
// IMPORTANT: All scenes navigate through a SINGLE page object so that
// Playwright writes one continuous video file.  Creating extra pages
// (context.newPage) causes those scenes to land in separate files that are
// never saved — the result is blank/empty sections in the main recording.

async function recordPromoVideo(srv) {
  ensureDir(VIDEO_DIR);
  console.log('\n── Promo video (~75 sec) ────────────────────────────────────────');
  console.log('  Recording… (do not interact with the browser window)');

  const { context, popupUrl, optionsUrl, sw } = await launchWithExtension({ recordVideo: true });
  // ONE page — all scenes navigate here.
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });

  try {
    await setScanTrigger(sw, 'manual');

    // ── Scene 1 (~7s): Real article — no highlights yet ──────────────────────
    await page.goto(URL_COLORS, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await _dismissOverlays(page);
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
    await sleep(5000);

    // ── Scene 2 (~5s): Extension popup (popup.html navigated as a full tab) ──
    // The popup HTML renders correctly as a regular page; the 420 px-wide body
    // sits in the centre of a 1280-wide viewport with a neutral background.
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });
    await sleep(4500);

    // ── Scene 3 (~9s): Autoscan — highlights and panel appear ────────────────
    await setScanTrigger(sw, 'autoscan');
    await setCapturePanelPrefs(sw);
    await page.goto(URL_COLORS, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await _dismissOverlays(page);
    await page.waitForSelector(
      '.quran-green, .quran-lightblue, .quran-yellow', { timeout: 40_000 }
    );
    await waitForPanel(page);
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
    await sleep(2500);

    // ── Scene 4 (~5s): Scroll through color variety (green/lightblue/yellow) ─
    await page.evaluate(() => window.scrollBy({ top: 280, behavior: 'smooth' }));
    await sleep(2000);
    const yellowEl = await page.$('.quran-yellow');
    if (yellowEl) await yellowEl.scrollIntoViewIfNeeded();
    await sleep(2500);

    // ── Scene 5 (~10s): Error article — orange + red highlights ─────────────
    await page.goto(URL_ERRORS, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await _dismissOverlays(page);
    await page.waitForSelector('.quran-red, .quran-orange', { timeout: 40_000 });
    await waitForPanel(page);
    const redEl = await page.$('.quran-red');
    if (redEl) {
      await redEl.scrollIntoViewIfNeeded();
      await sleep(600);
      await redEl.click();
    }
    await sleep(4500);

    // ── Scene 6 (~5s): Correct in place ─────────────────────────────────────
    const btns = await page.$$('.quran-ext-panel button');
    for (const btn of btns) {
      const txt = await btn.innerText().catch(() => '');
      if (txt.includes('تصحيح') || txt.includes('orrect')) {
        await btn.scrollIntoViewIfNeeded();
        await sleep(400);
        await btn.click();
        break;
      }
    }
    await sleep(4000);

    // ── Scene 7 (~13s): Writer demo — type → dropdown → Tab → scope → Tab ───
    await page.goto(`${srv.base}/writer-demo`, { waitUntil: 'load' });
    await sleep(800);
    await page.click('#article-body');
    await sleep(150);
    await page.keyboard.press('Control+End');
    await sleep(150);
    for (const ch of 'فإذا قرأت') {
      await page.keyboard.type(ch);
      await sleep(130);
    }
    await sleep(2500);           // dropdown clearly visible
    await page.keyboard.press('Tab');
    await sleep(1800);           // scope menu clearly visible
    await page.keyboard.press('Tab');
    await sleep(3000);           // ayah inserted and readable

    // ── Scene 8 (~7s): Options page — theme picker ───────────────────────────
    await page.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const appSection = await page.$('#sec-appearance');
    if (appSection) await appSection.scrollIntoViewIfNeeded();
    await sleep(5500);

    // End card (2s)
    await sleep(2000);

  } finally {
    await setScanTrigger(sw, 'manual');
  }

  const video = page.video();
  await context.close();

  if (video) {
    const rawPath  = await video.path();
    const destPath = path.join(VIDEO_DIR, 'promo-raw.webm');
    if (rawPath && fs.existsSync(rawPath)) fs.renameSync(rawPath, destPath);
    console.log(`\n  Raw webm: ${destPath}`);
    console.log('  Converting to MP4…');
    await _burnSubtitles('promo-raw.webm', 'promo-short.srt', 'promo.mp4', 22);
  }
}

// ── Promo video — gdigrab screen capture (~75 sec) ────────────────────────────
//
// Chrome is pinned at 0,0 with a fixed outer window size so gdigrab captures
// the exact same rectangle throughout.  The popup scene uses window.open()
// triggered by a synthesized click so the popup appears as a real floating
// window overlaid on the article page.

async function recordPromoVideoScreen(srv) {
  ensureDir(VIDEO_DIR);
  console.log('\n── Promo video [screen capture] (~75 sec) ──────────────────────');
  console.log('  Recording… (do not interact with the browser window)');

  const W = 1280, H = 800;
  const rawPath = path.join(VIDEO_DIR, 'promo-screen-raw.mp4');

  // Start FFmpeg before the browser opens so frame 1 captures the blank desktop,
  // then the Chrome window appears naturally.
  const ffproc = _startScreenCapture(rawPath, W, H);
  await sleep(1500); // let FFmpeg settle before Chrome paints

  const { context, popupUrl, optionsUrl, sw } = await launchWithExtension({ screenCapture: true, winW: W, winH: H });
  const page = await context.newPage();
  await page.bringToFront();
  await sleep(1500); // let Chrome render its initial frame

  try {
    await setScanTrigger(sw, 'manual');

    // ── Scene 1 (~7s): Real article — clean ──────────────────────────────────
    await page.goto(URL_COLORS, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await _dismissOverlays(page);
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
    await sleep(5000);

    // ── Scene 2 (~5s): Real floating popup window ─────────────────────────────
    const popupPage = await _openPopupWindow(context, page, popupUrl);
    await sleep(4500);
    if (popupPage) await popupPage.close().catch(() => {});
    await page.bringToFront();
    await sleep(300);

    // ── Scene 3 (~9s): Autoscan ──────────────────────────────────────────────
    await setScanTrigger(sw, 'autoscan');
    await setCapturePanelPrefs(sw);
    await page.goto(URL_COLORS, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await _dismissOverlays(page);
    await page.waitForSelector('.quran-green, .quran-lightblue, .quran-yellow', { timeout: 40_000 });
    await waitForPanel(page);
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
    await sleep(2500);

    // ── Scene 4 (~5s): Scroll colors ─────────────────────────────────────────
    await page.evaluate(() => window.scrollBy({ top: 280, behavior: 'smooth' }));
    await sleep(2000);
    const yellowEl = await page.$('.quran-yellow');
    if (yellowEl) await yellowEl.scrollIntoViewIfNeeded();
    await sleep(2500);

    // ── Scene 5 (~10s): Error article ────────────────────────────────────────
    await page.goto(URL_ERRORS, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await _dismissOverlays(page);
    await page.waitForSelector('.quran-red, .quran-orange', { timeout: 40_000 });
    await waitForPanel(page);
    const redEl = await page.$('.quran-red');
    if (redEl) { await redEl.scrollIntoViewIfNeeded(); await sleep(600); await redEl.click(); }
    await sleep(4500);

    // ── Scene 6 (~5s): Correct in place ──────────────────────────────────────
    const btns = await page.$$('.quran-ext-panel button');
    for (const btn of btns) {
      const txt = await btn.innerText().catch(() => '');
      if (txt.includes('تصحيح') || txt.includes('orrect')) {
        await btn.scrollIntoViewIfNeeded();
        await sleep(400);
        await btn.click();
        break;
      }
    }
    await sleep(4000);

    // ── Scene 7 (~13s): Writer demo ───────────────────────────────────────────
    await page.goto(`${srv.base}/writer-demo`, { waitUntil: 'load' });
    await sleep(800);
    await page.click('#article-body');
    await sleep(150);
    await page.keyboard.press('Control+End');
    await sleep(150);
    for (const ch of 'فإذا قرأت') {
      await page.keyboard.type(ch);
      await sleep(130);
    }
    await sleep(2500);
    await page.keyboard.press('Tab');
    await sleep(1800);
    await page.keyboard.press('Tab');
    await sleep(3000);

    // ── Scene 8 (~7s): Options / themes ──────────────────────────────────────
    await page.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const appSection = await page.$('#sec-appearance');
    if (appSection) await appSection.scrollIntoViewIfNeeded();
    await sleep(5500);

    // End card (2s)
    await sleep(2000);

  } finally {
    await setScanTrigger(sw, 'manual');
    await context.close();
  }

  // Stop FFmpeg gracefully; it finalises the MP4 container on shutdown.
  await _stopScreenCapture(ffproc);
  console.log(`\n  Raw screen capture: ${rawPath}`);
  console.log('  Converting to MP4 with subtitles…');
  await _burnSubtitles('promo-screen-raw.mp4', 'promo-short.srt', 'promo-screen.mp4', 22);
}

// ── Tutorial video (~5 min) ───────────────────────────────────────────────────

async function recordTutorialVideo(srv) {
  ensureDir(VIDEO_DIR);
  console.log('\n── Tutorial video (~5 min) ──────────────────────────────────────');
  console.log('  Recording… (do not interact with the browser window)');

  const { context, popupUrl, optionsUrl, sw } = await launchWithExtension({ recordVideo: true });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });

  const T = (ms) => sleep(ms);

  try {
    // ── Intro (28s): real islamweb.net page, explain the problem ─────────────
    await page.goto(URL_COLORS, { waitUntil: 'networkidle', timeout: 45_000 });
    await _dismissOverlays(page);
    await T(6000);
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
    await T(4000);
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
    await T(4000);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await T(6000);

    // ── Scanning (20s): show popup, trigger scan ──────────────────────────────
    const popupPage = await context.newPage();
    await popupPage.setViewportSize({ width: 420, height: 460 });
    await popupPage.goto(popupUrl, { waitUntil: 'domcontentloaded' });
    await T(5000);

    await setScanTrigger(sw, 'autoscan');
    await setCapturePanelPrefs(sw);
    await page.bringToFront();
    await page.reload({ waitUntil: 'networkidle', timeout: 45_000 });
    await _dismissOverlays(page);
    await page.waitForSelector('.quran-green, .quran-lightblue, .quran-yellow', { timeout: 45_000 });
    await T(3000);

    // ── Color tour (60s): each color explained ────────────────────────────────
    for (const selector of ['.quran-green', '.quran-lightblue', '.quran-yellow']) {
      await scrollTo(page, selector);
      await T(3000);
      const el = await page.$(selector);
      if (el) {
        await el.click();
        await T(5000);
        await page.keyboard.press('Escape');
        await T(500);
      }
    }

    await page.goto(URL_ERRORS, { waitUntil: 'networkidle', timeout: 45_000 });
    await _dismissOverlays(page);
    await page.waitForSelector('.quran-green, .quran-red, .quran-orange', { timeout: 45_000 });
    await waitForPanel(page);
    await T(3000);

    for (const selector of ['.quran-orange', '.quran-red']) {
      await scrollTo(page, selector);
      await T(3000);
      const el = await page.$(selector);
      if (el) {
        await el.click();
        await T(5000);
        await page.keyboard.press('Escape');
        await T(500);
      }
    }

    // ── Correct in place (20s) ────────────────────────────────────────────────
    await waitForPanel(page);
    await T(2000);
    const btns = await page.$$('.quran-ext-panel button');
    for (const btn of btns) {
      const txt = await btn.innerText().catch(() => '');
      if (txt.includes('تصحيح') || txt.includes('orrect')) {
        await btn.scrollIntoViewIfNeeded();
        await T(1000);
        await btn.click();
        await T(4000);
        break;
      }
    }
    await T(4000);

    // ── Panel deep-dive (35s) ─────────────────────────────────────────────────
    await waitForPanel(page);
    await T(3000);
    const tabEl = await page.$('.quran-ext-panel-tab');
    if (tabEl) {
      await tabEl.click(); await T(2500);
      await tabEl.click(); await T(2500);
    }
    const chips = await page.$$('.quran-ext-panel [class*="chip"], .quran-ext-panel [class*="filter"]');
    for (const chip of chips.slice(0, 4)) {
      await chip.click().catch(() => {});
      await T(1800);
    }
    await T(4000);

    // ── Options page (30s) ────────────────────────────────────────────────────
    const optPage = await context.newPage();
    await optPage.setViewportSize({ width: 1280, height: 720 });
    await optPage.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
    await T(3000);
    for (const sec of ['#sec-appearance', '#sec-language', '#sec-highlight', '#sec-autocomplete', '#sec-panel']) {
      const el = await optPage.$(sec);
      if (el) { await el.scrollIntoViewIfNeeded(); await T(3500); }
    }

    // ── Writer side (40s) ────────────────────────────────────────────────────
    const writerPage = await context.newPage();
    await writerPage.setViewportSize({ width: 1280, height: 720 });
    await writerPage.goto(`${srv.base}/writer-demo`, { waitUntil: 'load' });
    await T(3000);
    // Ctrl+End to land caret at the true end of pre-filled content
    await writerPage.click('#article-body');
    await T(200);
    await writerPage.keyboard.press('Control+End');
    await T(200);
    // First citation: النحل:98 (Isti'aaza ayah — matches the article topic)
    for (const ch of 'فإذا قرأت') {
      await writerPage.keyboard.type(ch);
      await sleep(130);
    }
    await T(2200);
    await writerPage.keyboard.press('Tab');   // accept candidate
    await T(1500);
    await writerPage.keyboard.press('Tab');   // accept "whole" scope → ayah inserted
    await T(3000);
    // Second citation: start a new sentence and type another ayah
    await writerPage.keyboard.type(' وقال أيضاً: ﴿');
    await T(600);
    for (const ch of 'وما خلقت الجن') {
      await writerPage.keyboard.type(ch);
      await sleep(110);
    }
    await T(2000);
    await writerPage.keyboard.press('Tab');
    await T(1500);
    await writerPage.keyboard.press('Tab');
    await T(3000);

    // ── Themes (20s) ─────────────────────────────────────────────────────────
    const themePage = await context.newPage();
    await themePage.setViewportSize({ width: 1280, height: 720 });
    await themePage.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
    const appSection = await themePage.$('#sec-appearance');
    if (appSection) await appSection.scrollIntoViewIfNeeded();
    await T(2500);
    const swatches = await themePage.$$('[data-theme], [class*="swatch"]');
    for (const sw_ of swatches.slice(0, 6)) {
      await sw_.click().catch(() => {});
      await T(2500);
    }
    await T(2000);

  } finally {
    await setScanTrigger(sw, 'manual');
  }

  const video = page.video();
  await context.close();

  if (video) {
    const rawPath  = await video.path();
    const destPath = path.join(VIDEO_DIR, 'tutorial-raw.webm');
    if (rawPath && fs.existsSync(rawPath)) fs.renameSync(rawPath, destPath);
    console.log(`\n  Raw video: ${destPath}`);
  }

  await _burnSubtitles('tutorial-raw.webm', 'tutorial-long.srt', 'tutorial.mp4', 20);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

// Run FFmpeg to burn subtitles and produce an MP4.  Returns the output path.
async function _burnSubtitles(rawFile, srtFile, outFile, fontSize) {
  const { execFile } = require('child_process');
  const raw = path.join(VIDEO_DIR, rawFile);
  // Drive-letter colon must be escaped so FFmpeg's subtitles filter does not
  // interpret it as a key=value separator (C:/path → C\:/path).
  const srtEsc = path.join(__dirname, 'subtitles', srtFile)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1\\:');
  const out = path.join(VIDEO_DIR, outFile);
  const style = `FontName=Arial,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1`;
  const ffmpeg = _findFfmpeg();

  const args = [
    '-i', raw,
    '-vf', `subtitles='${srtEsc}':force_style='${style}'`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    out, '-y',
  ];

  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, (err, _stdout, stderr) => {
      if (err) {
        console.error('  FFmpeg error:\n', stderr.slice(-600));
        reject(err);
      } else {
        console.log(`  ✓ ${outFile} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
        resolve(out);
      }
    });
  });
}

function _findFfmpeg() {
  const candidates = [
    (() => { try { return require('ffmpeg-static'); } catch (_) { return null; } })(),
    'ffmpeg',
    'C:\\Program Files\\Studio 2.0\\PhotoRealisticRenderer\\win\\64\\ffmpeg.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      require('child_process').execFileSync(c, ['-version'], { stdio: 'ignore' });
      return c;
    } catch (_) {}
  }
  return candidates[0];
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  ensureDir(OUTPUT_DIR);
  const srv = await serve(7331);

  try {
    if (doShotsScreen)             await captureScreenshotsScreen(srv);
    else if (doShots)              await captureScreenshots(srv);
    if (doTiles)                   await captureTiles(srv);
    if (doPromo && !doPromoScreen) await recordPromoVideo(srv);
    if (doPromoScreen)             await recordPromoVideoScreen(srv);
    if (doTutorial)                await recordTutorialVideo(srv);
  } finally {
    srv.server.close();
  }

  console.log('\nDone.');
})();
