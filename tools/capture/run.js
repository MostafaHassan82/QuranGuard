'use strict';
/**
 * QuranGuard promo capture tool
 *
 * Usage:
 *   node tools/capture/run.js --screenshots            All 7 screenshots via Playwright (1280x800)
 *   node tools/capture/run.js --screenshots --screen   All 7 screenshots via gdigrab (real Chrome window)
 *   node tools/capture/run.js --tiles                  Small (440x280) + Marquee (1400x560) tiles
 *   node tools/capture/run.js --video promo            Record ~75s promo video (Playwright webm)
 *   node tools/capture/run.js --video promo-screen     Record marketing promo via gdigrab (real Chrome)
 *   node tools/capture/run.js --video promo-screen --lang ar
 *                                                      Same, fully in Arabic (extension UI, captions, cards)
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
// gdigrab captures physical Chrome-window pixels (toolbar included) and
// cannot open chrome-extension:// popup windows — Playwright page.screenshot()
// gives cleaner, DPI-correct, content-only shots for CWS assets.
// --screen applies only to video; for screenshots it is intentionally ignored.
const doShotsScreen = false; // reserved; always use Playwright for screenshots

// Story / shot selectors — apply only to --screenshots.
// --story N,M  : run only those stories; absent = run all
// --skip-story : exclude those stories
// --shot N,M   : run only those shots; absent = run all
// --skip-shot  : exclude those shots
// --lang ar|en — language for the promo-screen video: extension UI (prefs.v1
// .lang), caption copy, and intro/outro cards all follow it. Default: en.
const _langIdx  = args.indexOf('--lang');
const VIDEO_LANG = _langIdx >= 0 && ['ar', 'en'].includes(args[_langIdx + 1]) ? args[_langIdx + 1] : 'en';

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

  // Seed a temp profile with translate disabled — Arabic pages otherwise pop
  // Chrome's "Translate this page?" bubble over the toolbar mid-recording.
  // (A --disable-features flag doesn't survive Playwright's own flag merging.)
  const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qg-capture-'));
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({ translate: { enabled: false }, translate_blocked_languages: ['ar'] })
  );

  const context = await chromium.launchPersistentContext(userDataDir, ctxOpts);

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

// Set the extension UI language (prefs.v1.lang: 'ar' | 'en'). Must run before
// any extension surface renders so popup/panel/options come up in that language.
async function setLang(sw, lang) {
  await sw.evaluate(async (l) => {
    const data  = await chrome.storage.local.get('prefs.v1');
    const prefs = data['prefs.v1'] || {};
    prefs.lang = l;
    await chrome.storage.local.set({ 'prefs.v1': prefs });
  }, lang);
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
function _startScreenCapture(outPath, w, h, offsetX = 0, offsetY = 0) {
  const { spawn } = require('child_process');
  const ffmpeg = _findFfmpeg();
  const proc = spawn(ffmpeg, [
    '-f', 'gdigrab',
    '-framerate', '30',
    '-offset_x', String(offsetX),
    '-offset_y', String(offsetY),
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
// Resolves with the wall-clock ms timestamp at which 'q' was sent — i.e. the
// approximate wall time of the video's LAST frame.  recordPromoVideoScreen
// anchors its scene timeline with it: videoT0 ≈ qWall − durationMs.
function _stopScreenCapture(proc) {
  return new Promise((resolve) => {
    const qWall = Date.now();
    const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(qWall); }, 10_000);
    proc.on('close', () => { clearTimeout(timer); resolve(qWall); });
    try { proc.stdin.write('q'); proc.stdin.end(); } catch (_) {}
  });
}

// Parse "Duration: HH:MM:SS.cc" from `ffmpeg -i file` stderr (no ffprobe in
// ffmpeg-static). ffmpeg exits non-zero without an output file — that's fine.
function _probeDurationSec(file) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(_findFfmpeg(), ['-i', file], { timeout: 15_000 }, (_err, _o, stderr) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr || '');
      if (!m) return resolve(null);
      resolve(+m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100);
    });
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

// Send a real OS-level key press (keybd_event).  Playwright keyboard events go
// through CDP to a page target — they can't reach a native extension-action
// popup window.  vk 0x1B = Escape (closes the action popup).
async function _nativeKey(vk) {
  const os  = require('os');
  const tmp = path.join(os.tmpdir(), '_qg_key.ps1');
  fs.writeFileSync(tmp,
`$sig = @'
using System; using System.Runtime.InteropServices;
public class NK { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo); }
'@
Add-Type -TypeDefinition $sig -Language CSharp
[NK]::keybd_event(${vk}, 0, 0, 0)
Start-Sleep -Milliseconds 40
[NK]::keybd_event(${vk}, 0, 2, 0)
`);
  require('child_process').execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
    { stdio: 'ignore' }
  );
  await sleep(80);
}

// Real OS-level mouse choreography in ONE PowerShell invocation: glide the
// cursor through `points`, optionally ending with a left click. A single
// process per gesture keeps timing tight (each spawn costs ~1s of Add-Type).
// OS clicks move real focus, unlike CDP clicks, so they reach native popups.
async function _nativeMouse(points, { click = false } = {}) {
  const os  = require('os');
  const tmp = path.join(os.tmpdir(), '_qg_mouse.ps1');
  const moves = points.map(([x, y]) =>
    `[NC]::SetCursorPos(${x}, ${y})\nStart-Sleep -Milliseconds 180`).join('\n');
  fs.writeFileSync(tmp,
`$sig = @'
using System; using System.Runtime.InteropServices;
public class NC {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
${moves}
${click ? '[NC]::mouse_event(2, 0, 0, 0, 0)\nStart-Sleep -Milliseconds 40\n[NC]::mouse_event(4, 0, 0, 0, 0)' : ''}
`);
  require('child_process').execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
    { stdio: 'ignore' }
  );
  await sleep(80);
}

async function _nativeClick(x, y) { return _nativeMouse([[x, y]], { click: true }); }

// ── In-page promo effects (spotlight, click ripple) ──────────────────────────
// Visual emphasis for the promo video: the spotlight dims the page and draws a
// pulsing ring around one element; the ripple marks clicks. Both are injected
// as the LAST children of <html> at max z-index so they paint above the
// extension panel (which also uses 2147483647).

// target: selector string, ElementHandle, or a plain {x, y, width, height}
// box in viewport coordinates.
async function _spotlightOn(page, target, { pad = 10 } = {}) {
  let box = null;
  if (target && typeof target === 'object' && typeof target.x === 'number') {
    box = target;
  } else {
    const el = typeof target === 'string' ? await page.$(target) : target;
    if (!el) return false;
    // For inline elements that wrap across lines, boundingBox() is the union
    // of the line fragments — a tall rect offset from the visible text.
    // Spotlight the largest fragment instead.
    box = await el.evaluate((node) => {
      const rects = Array.from(node.getClientRects());
      if (!rects.length) return null;
      const r = rects.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }).catch(() => null);
    if (!box) box = await el.boundingBox().catch(() => null);
  }
  if (!box) return false;
  await page.evaluate(({ box, pad }) => {
    // Clamp to the viewport: full-height elements (the panel) would otherwise
    // put every ring edge offscreen.
    const vw = window.innerWidth, vh = window.innerHeight;
    const L = Math.max(box.x - pad, 6), T = Math.max(box.y - pad, 6);
    const R = Math.min(box.x + box.width + pad, vw - 6);
    const B = Math.min(box.y + box.height + pad, vh - 6);
    const hole = (l, t, r, b) =>
      `polygon(evenodd, 0 0, ${vw}px 0, ${vw}px ${vh}px, 0 ${vh}px, 0 0, ` +
      `${l}px ${t}px, ${r}px ${t}px, ${r}px ${b}px, ${l}px ${b}px, ${l}px ${t}px)`;

    let dim = document.getElementById('__qg_dim');
    let ring = document.getElementById('__qg_spot');
    if (!dim) {
      const st = document.createElement('style');
      st.id = '__qg_spot_css';
      st.textContent = `
        #__qg_dim{position:fixed;inset:0;z-index:2147483647;pointer-events:none;
          background:rgba(2,10,6,.45);opacity:0;
          transition:opacity .45s ease,clip-path .55s cubic-bezier(.4,0,.2,1)}
        #__qg_spot{position:fixed;z-index:2147483647;pointer-events:none;
          border:3px solid #22c55e;border-radius:12px;
          box-shadow:0 0 0 6px rgba(34,197,94,.28),0 0 18px rgba(34,197,94,.45);
          opacity:0;transition:all .5s cubic-bezier(.4,0,.2,1)}
        #__qg_spot::after{content:'';position:absolute;inset:-3px;border-radius:12px;
          border:3px solid rgba(34,197,94,.9);animation:__qgp 1.5s ease-out infinite}
        @keyframes __qgp{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.1);opacity:0}}
      `;
      document.documentElement.appendChild(st);
      dim = document.createElement('div');
      dim.id = '__qg_dim';
      dim.style.clipPath = hole(0, 0, vw, vh); // start fully open so the hole animates shut
      document.documentElement.appendChild(dim);
      ring = document.createElement('div');
      ring.id = '__qg_spot';
      document.documentElement.appendChild(ring);
      void dim.offsetWidth; // commit initial styles so the first show transitions
    }
    dim.style.clipPath = hole(L, T, R, B);
    dim.style.opacity = '1';
    ring.style.left   = L + 'px';
    ring.style.top    = T + 'px';
    ring.style.width  = (R - L) + 'px';
    ring.style.height = (B - T) + 'px';
    ring.style.opacity = '1';
  }, { box, pad });
  return true;
}

async function _spotlightOff(page) {
  await page.evaluate(() => {
    const dim = document.getElementById('__qg_dim');
    const ring = document.getElementById('__qg_spot');
    if (dim) dim.style.opacity = '0';
    if (ring) ring.style.opacity = '0';
  }).catch(() => {});
  await sleep(480);
}

async function _ripple(page, x, y) {
  await page.evaluate(({ x, y }) => {
    if (!document.getElementById('__qg_rip_css')) {
      const st = document.createElement('style');
      st.id = '__qg_rip_css';
      st.textContent = '@keyframes __qgr{0%{transform:translate(-50%,-50%) scale(.4);opacity:.85}100%{transform:translate(-50%,-50%) scale(2.6);opacity:0}}';
      document.documentElement.appendChild(st);
    }
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:34px;height:34px;` +
      'border-radius:50%;border:3px solid #22c55e;background:rgba(34,197,94,.25);' +
      'z-index:2147483647;pointer-events:none;animation:__qgr .65s ease-out forwards';
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), 700);
  }, { x, y }).catch(() => {});
}

// First <button> inside a panel row matching rowSel whose label matches re.
// Matched by class + label regex so it works in both UI languages.
async function _findRowButton(page, rowSel, re) {
  for (const h of await page.$$(`${rowSel} button`)) {
    const txt = await h.innerText().catch(() => '');
    if (re.test(txt)) return h;
  }
  return null;
}

// The corrected (light-green) highlight closest vertically to `box` — used to
// tell apart multiple corrections on the same page.
async function _nearestLightGreen(page, box) {
  const els = await page.$$('.quran-lightgreen');
  if (!els.length) return null;
  if (!box) return els[0];
  let best = null, bestD = Infinity;
  for (const el of els) {
    const b = await el.boundingBox().catch(() => null);
    if (!b) continue;
    const d = Math.abs(b.y - box.y);
    if (d < bestD) { bestD = d; best = el; }
  }
  return best || els[0];
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
  console.log('\n── Promo video [screen capture] (~80 sec) ──────────────────────');
  console.log('  Recording… (do not interact with the browser window)');

  const W = 1280, H = 800;
  const lang = VIDEO_LANG;
  const C = PROMO_COPY[lang];
  const rawPath = path.join(VIDEO_DIR, `promo-screen-raw-${lang}.mp4`);
  console.log(`  Language: ${lang}`);

  // Branded intro/outro cards, rendered off-screen before recording starts.
  const { introPng, outroPng } = await _makePromoCards(lang);
  console.log('  ✓ intro/outro cards rendered');

  // Chrome window is at (0,0), outer size 1280×800.
  // Tab row: y≈0–35.  Toolbar (address bar + icons): y≈35–75, center y≈55.
  // With only our extension loaded, the action icon sits just left of the
  // profile button at approximately x≈1205.
  const EXT_ICON_X = 1205, EXT_ICON_Y = 55;

  // ── Launch Chrome, pin outer window to EXACTLY 1280×800 via CDP, then load
  // the first page before FFmpeg starts.
  //
  // Why CDP setWindowBounds: --window-size=W,H sets the *viewport* (inner
  // content area) in Chromium, not the outer window.  The outer window is
  // viewport + Chrome UI (tab bar ~35 + toolbar ~51 ≈ 86 px taller), so a
  // 1280×800 gdigrab clip would shave the bottom ~86 px off the page.
  // Browser.setWindowBounds forces the *outer* window to exactly W×H.
  //
  // Why page-load first: starting FFmpeg before Chrome is positioned shows
  // whatever was previously at (0,0) on screen for the first few seconds.
  // We load the article page fully, wait 5 s, then start the capture so
  // frame 1 is a clean, fully-rendered page.
  const { context, popupUrl, optionsUrl, extensionId, sw } = await launchWithExtension({ screenCapture: true, winW: W, winH: H });
  // Reuse the persistent context's initial about:blank tab — opening a second
  // page leaves a stray "about:blank" tab visible in the tab strip on camera.
  const page = context.pages()[0] || await context.newPage();
  await page.bringToFront();

  // Pin outer window to exactly 1280×800 at (0,0).
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget', {});
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 0, top: 0, width: W, height: H, windowState: 'normal' },
    });
    const after = await cdp.send('Browser.getWindowBounds', { windowId });
    console.log(`  Window bounds: ${JSON.stringify(after.bounds)}`);
  } catch (e) {
    console.log('  ⚠ setWindowBounds failed:', e.message);
  }
  await sleep(500);

  await setScanTrigger(sw, 'manual');
  await setCapturePanelPrefs(sw);
  await setLang(sw, lang); // extension UI language — before any surface renders

  // Load the first article fully before recording starts.
  await page.goto(URL_COLORS, { waitUntil: 'load', timeout: 30_000 });
  await _dismissOverlays(page);

  // Query window position/size AND devicePixelRatio.  CDP setWindowBounds uses
  // CSS pixels, but gdigrab captures *device* pixels.  On a Windows machine at
  // 125 % display scaling, a 1280-CSS-pixel-wide Chrome window is actually
  // 1280 × 1.25 = 1600 device pixels wide — so capturing 1280×800 (or even
  // 1400×900) clips the Chrome content on the right and bottom.
  //
  // Fix: capture exactly `W * dpr × H * dpr` device pixels at Chrome's
  // top-left, then scale (not crop) to 1280×800 in post.  This keeps every
  // pixel of the rendered Chrome window inside the final video, at any DPI.
  const win = await page.evaluate(() => ({
    x: window.screenX, y: window.screenY,
    outerW: window.outerWidth, outerH: window.outerHeight,
    innerW: window.innerWidth,  innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  console.log(`  JS window: outer=${win.outerW}×${win.outerH} inner=${win.innerW}×${win.innerH} pos=(${win.x},${win.y}) dpr=${win.dpr}`);

  const dpr = win.dpr || 1;
  // gdigrab requires even dimensions for libx264 (yuv420p).
  const CAP_W = Math.round(W * dpr / 2) * 2;
  const CAP_H = Math.round(H * dpr / 2) * 2;
  const capX = Math.max(0, Math.round(win.x * dpr));
  const capY = Math.max(0, Math.round(win.y * dpr));
  console.log(`  Capture region: ${CAP_W}×${CAP_H} at (${capX},${capY}) device px — will scale to ${W}×${H}`);

  await sleep(3000); // page fully painted; settle before capture begins

  // Start FFmpeg now — frame 1 is a fully-loaded Chrome page, no blank/VSCode.
  const ffproc = _startScreenCapture(rawPath, CAP_W, CAP_H, capX, capY);
  const ffStartWall = Date.now();
  await sleep(1000); // let gdigrab deliver its first frames

  // ── Scene timeline ──────────────────────────────────────────────────────
  // Subtitles used to come from a fixed-clock SRT, but real page loads drift
  // by many seconds, so cues ran ahead of the picture. Instead: record the
  // wall time of every cue and every load interval ("cut") here, anchor them
  // to the video clock once the capture stops (t0 ≈ qWall − duration), drop
  // the cut intervals in post, and generate the SRT from what actually
  // happened on screen.
  const tl = { cues: [], cuts: [], _cut: null };
  const cue = (text) => {
    const last = tl.cues[tl.cues.length - 1];
    if (last && !last.endWall) last.endWall = Date.now();
    tl.cues.push({ text, startWall: Date.now(), endWall: null });
    console.log(`  [cue] ${text}`);
  };
  const cutStart = () => { tl._cut = { startWall: Date.now(), endWall: null }; tl.cuts.push(tl._cut); };
  const cutEnd   = () => { if (tl._cut) { tl._cut.endWall = Date.now(); tl._cut = null; } };

  // Camera zooms, applied in post via zoompan: each event animates from the
  // current zoom state to (z, cx, cy) over dur seconds. cx/cy are fractions
  // of the full frame. Scenes must return to z=1 before each cut.
  const zooms = [];
  const zoomTo = (z, cx, cy, dur = 0.7) => zooms.push({ wall: Date.now(), z, cx, cy, dur });
  // Page-viewport coords → frame fractions (browser chrome sits above the page).
  const CONTENT_TOP = win.outerH - win.innerH > 0 ? win.outerH - win.innerH : 94;
  const frac = (box) => ({
    cx: Math.min(0.95, Math.max(0.05, (box.x + box.width / 2) / W)),
    cy: Math.min(0.95, Math.max(0.05, (box.y + box.height / 2 + CONTENT_TOP) / H)),
  });

  const _t0 = Date.now();
  const _mark = (label) => console.log(`  [t=${((Date.now() - _t0) / 1000).toFixed(1)}s] ${label}`);
  let qWall = null;

  try {
    // ── Scene 1 (~4.5s): hook over the real article, slow push-in ────────────
    _mark('Scene 1 start');
    cue(C.hook);
    zoomTo(1.06, 0.5, 0.45, 4.0); // subtle cinematic drift
    await page.mouse.move(640, 320);
    await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
    await sleep(4300);

    // ── Scene 2 (~7s): popup opens, camera punches in on it ──────────────────
    _mark('Scene 2 start (popup)');
    cue(C.meet);
    // Cursor glides into the toolbar extension-icon area — visual cue for click.
    await _nativeMouse([
      [EXT_ICON_X - 120, EXT_ICON_Y + 40],
      [EXT_ICON_X - 40,  EXT_ICON_Y + 10],
      [EXT_ICON_X,       EXT_ICON_Y],
    ]);

    let popupShown = false;
    try {
      await sw.evaluate(() => new Promise((res, rej) => {
        if (!chrome.action?.openPopup) { rej(new Error('not available')); return; }
        chrome.action.openPopup({}, () => {
          if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
          else res();
        });
      }));
      popupShown = true;
      console.log('  ✓ chrome.action.openPopup() succeeded — popup visible on screen');
    } catch (e) {
      console.log('  ⚠ openPopup failed:', e.message);
      await page.goto(popupUrl, { waitUntil: 'domcontentloaded' }); // fallback: popup as a tab
    }
    zoomTo(1.6, 0.75, 0.24, 0.8); // strong punch-in on the popup
    await sleep(1500);

    // Really click the popup's "Scan page" button. The popup is a native
    // window outside CDP's reach, so this is an OS-level click at the
    // button's screen position (the primary button mirrors with UI direction:
    // right side in RTL, left side in LTR).
    if (popupShown) {
      const SCAN_BTN = lang === 'ar' ? { x: 1017, y: 191 } : { x: 899, y: 191 };
      await _nativeMouse([
        [SCAN_BTN.x - 60, SCAN_BTN.y + 30],
        [SCAN_BTN.x, SCAN_BTN.y],
      ], { click: true });
      console.log('  ✓ clicked popup scan button');
      await sleep(2400); // scan runs; status + page highlights appear behind the popup
    } else {
      await sleep(2400);
    }
    zoomTo(1.0, 0.5, 0.5, 0.7);
    await sleep(800);

    // Dismiss the popup and rescan — the whole load interval is cut in post.
    // The action popup is a native window outside CDP's reach: Playwright
    // clicks/keys never dismiss it (it stayed on screen for the entire
    // previous recording). A real OS-level Escape + a focus click do.
    cutStart();
    if (popupShown) {
      await _nativeKey(0x1B);        // Escape closes the action popup…
      await _nativeClick(640, 15);   // …and a click on the empty tab strip is the backup
    }
    await setScanTrigger(sw, 'autoscan');
    await page.goto(URL_COLORS, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await _dismissOverlays(page);
    _mark('Scene 3: waiting for highlights');
    await page.waitForSelector('.quran-green, .quran-lightblue, .quran-yellow', { timeout: 40_000 });
    await waitForPanel(page);
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
    await sleep(600); // settle inside the cut — also absorbs anchor error
    cutEnd();
    _mark('Scene 3: highlights visible');

    // ── Scene 3 (~6s): results panel spotlight, then scroll the highlights ───
    cue(C.scan);
    await _spotlightOn(page, '.quran-ext-panel', { pad: 6 });
    await sleep(2700);
    await _spotlightOff(page);
    await page.evaluate(() => window.scrollBy({ top: 240, behavior: 'smooth' }));
    await sleep(2300);

    // ── Scene 4 (~5s): color verdicts, spotlight a non-green finding ─────────
    _mark('Scene 4 start');
    cue(C.colors);
    const yellowEl = await page.$('.quran-yellow');
    if (yellowEl) {
      await yellowEl.scrollIntoViewIfNeeded();
      await sleep(400);
      await _spotlightOn(page, yellowEl, { pad: 8 });
    }
    await sleep(2900);
    await _spotlightOff(page);
    await sleep(500);

    // ── Scene 5 (~14s): RED — show the error, fix it, show the result ────────
    _mark('Scene 5 start (goto URL_ERRORS)');
    cutStart();
    await page.goto(URL_ERRORS, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await _dismissOverlays(page);
    await page.waitForSelector('.quran-red, .quran-orange', { timeout: 40_000 });
    await waitForPanel(page);
    const redEl = await page.$('.quran-red');
    if (redEl) await redEl.scrollIntoViewIfNeeded();
    await sleep(600);
    cutEnd();
    _mark('Scene 5: red visible');

    cue(C.red);
    if (redEl) await _spotlightOn(page, redEl, { pad: 8 });
    await sleep(2500);
    await _spotlightOff(page);
    if (redEl) {
      const box = await redEl.boundingBox();
      if (box) {
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await _ripple(page, cx, cy);
      }
      await redEl.click().catch(() => {});
    }
    await sleep(600);
    cue(C.tap);
    zoomTo(1.28, 0.16, 0.55, 0.7); // punch in on the panel detail card
    await sleep(2600);

    // Accept the red suggestion while still zoomed on the panel.
    const redFixBtn = await _findRowButton(page, '.quran-ext-panel-row-red', /اعتماد|قبول|تصحيح|accept|correct|fix/i);
    if (redFixBtn) {
      await redFixBtn.scrollIntoViewIfNeeded().catch(() => {});
      const bb = await redFixBtn.boundingBox().catch(() => null);
      if (bb) {
        await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await sleep(350);
        await _ripple(page, bb.x + bb.width / 2, bb.y + bb.height / 2);
      }
      await redFixBtn.click().catch(() => {});
      console.log('  ✓ red: accepted suggestion');
    } else {
      console.warn('  ⚠ red fix button not found');
    }
    await sleep(900);
    zoomTo(1.0, 0.5, 0.5, 0.6);
    await sleep(700);

    cue(C.redFixed);
    const redFixedEl = await page.$('.quran-lightgreen');
    if (redFixedEl) {
      await redFixedEl.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(400);
      await _spotlightOn(page, redFixedEl, { pad: 8 });
      await sleep(2600);
      await _spotlightOff(page);
    } else {
      await sleep(2600);
    }

    // ── Scene 6 (~11s): ORANGE — jump from the panel, see it, fix it ─────────
    _mark('Scene 6 start (orange jump + fix)');
    cue(C.orangeJump);
    const orangeRow = await page.$('.quran-ext-panel-row-orange .quran-ext-panel-head');
    if (orangeRow) {
      await orangeRow.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(300);
      const bb = await orangeRow.boundingBox().catch(() => null);
      if (bb) {
        await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await _ripple(page, bb.x + bb.width / 2, bb.y + bb.height / 2);
      }
      await orangeRow.click().catch(() => {}); // row click = jump to the highlight
    }
    await sleep(1600); // page scrolls to the orange mistake
    // The orange mistake is the REFERENCE, not the ayah — spotlight the wrong
    // ref marker next to the highlight (fallback: the highlight itself).
    const orangeEl = await page.$('.quran-orange');
    let orangeBox = null;
    if (orangeEl) orangeBox = await orangeEl.boundingBox().catch(() => null);
    const wrongRefHandle = await page.evaluateHandle(() => {
      const ayah = document.querySelector('.quran-orange');
      const id = ayah && ayah.dataset.findingId;
      return id ? document.querySelector(`[data-quran-ref-for="${CSS.escape(id)}"]`) : null;
    });
    const wrongRefEl = wrongRefHandle.asElement();
    if (wrongRefEl) await _spotlightOn(page, wrongRefEl, { pad: 8 });
    else if (orangeEl) await _spotlightOn(page, orangeEl, { pad: 8 });
    await sleep(2400);
    await _spotlightOff(page);

    cue(C.orangeFix);
    const orangeFixBtn = await _findRowButton(page, '.quran-ext-panel-row-orange', /تصحيح|correct/i);
    if (orangeFixBtn) {
      await orangeFixBtn.scrollIntoViewIfNeeded().catch(() => {});
      const bb = await orangeFixBtn.boundingBox().catch(() => null);
      if (bb) {
        await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await sleep(400);
        await _ripple(page, bb.x + bb.width / 2, bb.y + bb.height / 2);
      }
      await orangeFixBtn.click().catch(() => {});
      console.log('  ✓ orange: corrected in place');
    } else {
      console.warn('  ⚠ orange fix button not found');
    }
    await sleep(900);
    // What changed is the reference text — spotlight the corrected ref marker
    // (correctInPlace tags it quran-ref-corrected), not the ayah.
    const fixedRefEl = await page.$('.quran-ref-corrected');
    const orangeFixedEl = fixedRefEl || await _nearestLightGreen(page, orangeBox);
    if (orangeFixedEl) {
      await _spotlightOn(page, orangeFixedEl, { pad: 8 });
      await sleep(2400);
      await _spotlightOff(page);
    } else {
      await sleep(2400);
    }

    // ── Scene 7 (~10s): writer demo — type, zoom on dropdown, Tab-insert ─────
    _mark('Scene 7 start (writer demo)');
    cutStart();
    await page.goto(`${srv.base}/writer-demo`, { waitUntil: 'load' });
    // Uthmani font for the dropdown candidates (same treatment as screenshots).
    await page.evaluate((extId) => {
      const s = document.createElement('style');
      s.textContent = `
        @font-face { font-family:'UthmaniHafs'; src:url('chrome-extension://${extId}/resources/fonts/uthmani-hafs.ttf') format('truetype'); }
        .quran-ac-ayah { font-family:'UthmaniHafs','Traditional Arabic',serif !important; font-size:18px !important; }
      `;
      document.head.appendChild(s);
    }, extensionId);
    await page.click('#article-body');
    await page.keyboard.press('Control+End');
    await sleep(600);
    cutEnd();

    cue(C.writer);
    for (const ch of 'فإذا قرأت') {
      await page.keyboard.type(ch);
      await sleep(140);
    }
    const dd = await page.waitForSelector('.quran-ac-menu', { timeout: 8000 }).catch(() => null);
    if (dd) {
      const box = await dd.boundingBox().catch(() => null);
      if (box) { const f = frac(box); zoomTo(1.3, f.cx, f.cy, 0.8); }
    }
    await sleep(2300);           // dropdown clearly visible
    await page.keyboard.press('Tab');
    await sleep(1500);           // scope menu clearly visible
    cue(C.tab);
    await page.keyboard.press('Tab');
    await sleep(2400);
    zoomTo(1.0, 0.5, 0.5, 0.6);
    await sleep(700);

    // ── Scene 8 (~8s): live theme switching, zoomed on the picker ────────────
    _mark('Scene 8 start (themes)');
    cutStart();
    await page.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#appearance-picker .theme-card', { timeout: 10_000 }).catch(() => null);
    const appSection = await page.$('#sec-appearance');
    if (appSection) await appSection.scrollIntoViewIfNeeded();
    await sleep(600);
    cutEnd();

    cue(C.themes);
    const picker = await page.$('#appearance-picker');
    if (picker) {
      const box = await picker.boundingBox().catch(() => null);
      if (box) { const f = frac(box); zoomTo(1.22, f.cx, f.cy, 0.8); }
    }
    for (const id of ['mihrab', 'diwan', 'tahrir']) {
      const card = await page.$(`.theme-card[data-theme-id="${id}"]`);
      if (card) {
        const box = await card.boundingBox();
        if (box) {
          const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
          await page.mouse.move(cx, cy);
          await _ripple(page, cx, cy);
        }
        await card.click().catch(() => {});
      }
      await sleep(1900);
    }
    zoomTo(1.0, 0.5, 0.5, 0.7);
    await sleep(900);

    // ── Scene 9 (~7s): options tour — much more to configure ─────────────────
    _mark('Scene 9 start (options tour)');
    cue(C.more);
    for (const sec of ['#sec-highlight', '#sec-autocomplete', '#sec-panel']) {
      await page.evaluate((s) => {
        document.querySelector(s)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, sec);
      await sleep(2200);
    }
    await sleep(500);
    _mark('All scenes done');

  } finally {
    // Stop the recording BEFORE closing Chrome — the previous order left the
    // bare desktop in the last ~6 seconds of the video.
    qWall = await _stopScreenCapture(ffproc);
    await setScanTrigger(sw, 'manual').catch(() => {});
    await context.close();
  }

  console.log(`\n  Raw screen capture: ${rawPath}`);
  const D = await _probeDurationSec(rawPath);
  if (!D) throw new Error('could not probe raw capture duration');
  // If gdigrab died mid-recording (e.g. "Failed to capture image (error 5)"
  // when the desktop is locked or a secure prompt appears), the raw file is
  // far shorter than the wall-clock recording time. Refuse to render garbage.
  const wallSec = (qWall - ffStartWall) / 1000;
  if (D < wallSec - 5) {
    throw new Error(`screen capture died mid-recording (raw ${D.toFixed(1)}s vs ${wallSec.toFixed(1)}s of scenes) — ` +
                    'keep the desktop unlocked and undisturbed, then re-run');
  }
  // Anchor: wall time of the video's first frame. Derived from the END of the
  // capture (qWall − duration) so gdigrab's startup latency cancels out.
  const t0Wall = qWall - D * 1000;
  console.log(`  Duration ${D.toFixed(2)}s; anchor vs ffmpeg spawn: +${((t0Wall - ffStartWall) / 1000).toFixed(2)}s`);
  const toVid = (w) => Math.min(Math.max((w - t0Wall) / 1000, 0), D);

  // Load intervals to drop, and the keep-segments between them.
  const cuts = tl.cuts
    .filter(c => c.endWall)
    .map(c => ({ start: toVid(c.startWall), end: toVid(c.endWall) }))
    .filter(c => c.end - c.start > 0.05);
  const keeps = [];
  let pos = 0;
  for (const c of cuts) {
    if (c.start - pos > 0.1) keeps.push({ start: pos, end: c.start });
    pos = Math.max(pos, c.end);
  }
  if (D - pos > 0.1) keeps.push({ start: pos, end: D });
  const editedDur = keeps.reduce((a, k) => a + (k.end - k.start), 0);

  // Map a raw-video time into the edited (cut) timeline.
  const editedAt = (t) => {
    let acc = 0;
    for (const k of keeps) {
      if (t >= k.end) { acc += k.end - k.start; continue; }
      if (t > k.start) acc += t - k.start;
      break;
    }
    return acc;
  };

  const lastCue = tl.cues[tl.cues.length - 1];
  if (lastCue && !lastCue.endWall) lastCue.endWall = qWall;
  let cues = tl.cues.map(c => ({
    text:  c.text,
    start: editedAt(toVid(c.startWall)),
    end:   editedAt(toVid(c.endWall)),
  }));
  for (let i = 0; i < cues.length; i++) {
    if (i + 1 < cues.length) cues[i].end = Math.min(cues[i].end, cues[i + 1].start - 0.12);
    cues[i].end = Math.min(cues[i].end, editedDur - 0.15);
    if (cues[i].end - cues[i].start < 0.4) cues[i] = null; // degenerate cue
  }
  cues = cues.filter(Boolean);

  // Attach zoom events to their keep-segments as segment-local keyframes.
  const segs = keeps.map(k => ({ ...k, events: null, kfs: null }));
  for (const ev of zooms) {
    const t = toVid(ev.wall);
    const seg = segs.find(s => t >= s.start - 0.05 && t < s.end);
    if (!seg) continue;
    (seg.events = seg.events || []).push({ ...ev, t: Math.max(0, t - seg.start) });
  }
  for (const seg of segs) {
    if (!seg.events) continue;
    seg.events.sort((a, b) => a.t - b.t);
    const kfs = [{ t: 0, z: 1, cx: 0.5, cy: 0.5 }];
    let cur = kfs[0];
    for (const e of seg.events) {
      const t0 = Math.max(e.t, cur.t + 0.02);
      if (t0 > cur.t + 0.03) kfs.push({ t: t0, z: cur.z, cx: cur.cx, cy: cur.cy }); // hold until the event
      cur = { t: t0 + Math.max(e.dur, 0.1), z: e.z, cx: e.cx, cy: e.cy };
      kfs.push(cur);
    }
    seg.kfs = kfs;
  }

  // Captions land on the final timeline: shifted right by the intro card.
  const INTRO_DUR = 2.8, OUTRO_DUR = 3.6, XF = 0.5;
  const capOff = INTRO_DUR - XF;
  const finalCues = cues.map(c => ({
    text:  c.text,
    start: +(c.start + capOff).toFixed(3),
    end:   +(c.end + capOff).toFixed(3),
  }));
  fs.writeFileSync(
    path.join(VIDEO_DIR, `promo-screen-${lang}.cues.json`),
    JSON.stringify(finalCues, null, 2));
  const capPngs = await _makeCaptionPngs(finalCues, lang);
  const captions = finalCues.map((c, i) => ({ png: capPngs[i], start: c.start, end: c.end }));
  console.log(`  Captions: ${captions.length} pills rendered (${lang})`);
  console.log(`  Cutting ${cuts.length} load interval(s): ${D.toFixed(1)}s → ${editedDur.toFixed(1)}s + cards`);

  await _renderMarketingPromo({
    rawPath,
    outPath: path.join(VIDEO_DIR, `promo-screen-${lang}.mp4`),
    segs, captions, introPng, outroPng,
    introDur: INTRO_DUR, outroDur: OUTRO_DUR, xf: XF, editedDur,
  });
}

// ── Promo post-production helpers ─────────────────────────────────────────────

// Caption + card copy for the marketing promo, per language. Cue strings may
// carry inline HTML (the caption pills are rendered by a browser, not libass —
// ffmpeg-static's libass cannot shape Arabic).
const PROMO_COPY = {
  en: {
    hook:       'Quran citations are everywhere — but are they accurate?',
    meet:       'Meet <span class="g">QuranGuard</span> — a one-click audit for any page',
    scan:       'Auto-scan verifies every citation against the mushaf',
    colors:     'Color-coded verdicts — issues at a glance',
    red:        '<span class="r">Red</span> — this text isn\'t in the Quran',
    tap:        'Tap a highlight to see the authentic wording',
    redFixed:   'One click — the authentic ayah, fixed in place',
    orangeJump: 'Wrong reference? Jump straight to it',
    orangeFix:  '…and correct it in place',
    writer:     'It even completes the ayah as you type',
    tab:        'Press Tab — the verified ayah is inserted',
    themes:     'Six hand-crafted themes',
    more:       '…and much more to fine-tune',
    cardKicker: 'QuranGuard',
    cardTag:    'Every ayah. Letter-perfect.',
    outroKicker:'QuranGuard · صون القرآن',
    outroTag:   'Guard every ayah you publish.',
    outroPill:  'Available on the Chrome Web Store',
  },
  ar: {
    hook:       'آيات القرآن تُقتبس في كل مكان — فهل هي دقيقة؟',
    meet:       'تعرَّف على <span class="g">صَوْن القرآن</span> — فحص أي صفحة بنقرة واحدة',
    scan:       'الفحص التلقائي يدقّق كل اقتباس على المصحف',
    colors:     'ألوان تكشف الحالة — والمشاكل تظهر بلمحة',
    red:        '<span class="r">الأحمر</span> — نصٌ لا وجود له في القرآن',
    tap:        'اضغط على أي تمييز لترى النص الصحيح من المصحف',
    redFixed:   'بنقرة واحدة — يُستبدل بالنص القرآني الصحيح',
    orangeJump: 'مرجع خاطئ؟ انتقل إليه مباشرةً من اللوحة',
    orangeFix:  '…وصحِّحه في مكانه',
    writer:     'بل ويُكمل الآية أثناء الكتابة',
    tab:        'اضغط Tab — وتُدرَج الآية الموثَّقة',
    themes:     'ستة مظاهر مصمَّمة بعناية',
    more:       '…والمزيد من الخيارات للتخصيص',
    cardKicker: 'QuranGuard',
    cardTag:    'كلُّ آية، بحرفها.',
    outroKicker:'QuranGuard · صون القرآن',
    outroTag:   'احرس كلَّ آية تنشرها.',
    outroPill:  'متوفر في متجر Chrome الإلكتروني',
  },
};

// Render the branded intro/outro cards (1600×1000 PNG) from styled HTML via a
// separate headless browser — never visible to the screen recording.
async function _makePromoCards(lang = 'en') {
  const iconB64 = fs.readFileSync(path.join(PROJECT_ROOT, 'icons', 'icon-128.png')).toString('base64');
  const star = encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>" +
    "<g fill='none' stroke='#ffffff' stroke-width='1'>" +
    "<path d='M60 6l14 40 40 14-40 14-14 40-14-40-40-14 40-14z'/><circle cx='60' cy='60' r='4'/></g></svg>");
  const card = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:1600px;height:1000px;display:flex;align-items:center;justify-content:center;
      font-family:'Segoe UI',system-ui,sans-serif;color:#f3faf5;overflow:hidden;
      background:radial-gradient(1200px 800px at 50% 38%,#11402a 0%,#0a2719 52%,#051710 100%)}
    .pattern{position:fixed;inset:0;opacity:.06;background-image:url("data:image/svg+xml,${star}")}
    .wrap{position:relative;text-align:center}
    .kicker{font-size:30px;letter-spacing:.38em;color:#7fd6a4;text-transform:uppercase;font-weight:600}
    .ar{font-size:96px;font-weight:700;font-family:'Traditional Arabic','Amiri',serif;margin-top:6px}
    .tag{font-size:34px;color:#cfe9da;font-weight:300;margin-top:16px}
    .rule{width:120px;height:2px;background:linear-gradient(90deg,transparent,#34c759,transparent);margin:26px auto 0}
    .pill{display:inline-block;margin-top:34px;padding:16px 44px;border-radius:999px;background:#f3faf5;
      color:#0a2719;font-size:28px;font-weight:600}
    img.logo{width:118px;height:118px;filter:drop-shadow(0 12px 32px rgba(0,0,0,.5))}
  </style></head><body><div class="pattern"></div><div class="wrap">${body}</div></body></html>`;

  const c = PROMO_COPY[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const introHtml = card(`
    <img class="logo" src="data:image/png;base64,${iconB64}">
    <div class="kicker" style="margin-top:34px">${c.cardKicker}</div>
    <div class="ar">صَوْنُ القُرْآن</div>
    <div class="rule"></div>
    <div class="tag" dir="${dir}">${c.cardTag}</div>`);
  const outroHtml = card(`
    <img class="logo" src="data:image/png;base64,${iconB64}">
    <div class="kicker" style="margin-top:34px">${c.outroKicker}</div>
    <div class="tag" dir="${dir}" style="margin-top:22px">${c.outroTag}</div>
    <div class="pill" dir="${dir}">${c.outroPill}</div>`);

  const introPng = path.join(VIDEO_DIR, `card-intro-${lang}.png`);
  const outroPng = path.join(VIDEO_DIR, `card-outro-${lang}.png`);
  const browser = await chromium.launch({ headless: true });
  try {
    const pg = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await pg.setContent(introHtml, { waitUntil: 'networkidle' });
    await pg.screenshot({ path: introPng });
    await pg.setContent(outroHtml, { waitUntil: 'networkidle' });
    await pg.screenshot({ path: outroPng });
  } finally {
    await browser.close();
  }
  return { introPng, outroPng };
}

// Render each caption as a transparent PNG pill via headless Chromium.
// Browser text shaping handles Arabic ligatures + bidi correctly — libass in
// ffmpeg-static does not. Rendered at 2× and downscaled in FFmpeg for crisp
// text. Returns one PNG path per cue.
async function _makeCaptionPngs(cues, lang) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const browser = await chromium.launch({ headless: true });
  const out = [];
  try {
    const pg = await browser.newPage({ viewport: { width: 1280, height: 240 }, deviceScaleFactor: 2 });
    for (let i = 0; i < cues.length; i++) {
      await pg.setContent(`<!doctype html><meta charset="utf-8"><style>
        body{margin:0;display:flex;align-items:flex-start;justify-content:center;background:transparent}
        .pill{display:inline-block;max-width:1100px;margin-top:8px;padding:14px 30px;border-radius:14px;
          background:rgba(7,18,11,.88);box-shadow:0 6px 22px rgba(0,0,0,.35);
          font:600 28px 'Segoe UI',system-ui,sans-serif;color:#fff;text-align:center;
          direction:${dir};line-height:1.45}
        .pill .g{color:#34c759;font-weight:700}
        .pill .r{color:#ff6b5e;font-weight:700}
      </style><body><div class="pill">${cues[i].text}</div>`);
      const el = await pg.$('.pill');
      const png = path.join(VIDEO_DIR, `cap-${lang}-${String(i).padStart(2, '0')}.png`);
      await el.screenshot({ path: png, omitBackground: true });
      out.push(png);
    }
  } finally {
    await browser.close();
  }
  return out;
}

// Build zoompan z/x/y expressions from keyframes [{t, z, cx, cy}] (segment-
// local seconds; cx/cy are frame-fraction centers). Between keyframes the
// values ease with smoothstep; after the last keyframe they hold.
function _zoomExprs(kfs) {
  const piece = (prop) => {
    let expr = String(kfs[kfs.length - 1][prop]);
    for (let i = kfs.length - 2; i >= 0; i--) {
      const a = kfs[i], b = kfs[i + 1];
      const T = a.t.toFixed(3), D = Math.max(b.t - a.t, 0.001).toFixed(3);
      const interp = `${a[prop]}+(${b[prop] - a[prop]})*pow(st(0,clip((it-${T})/${D},0,1)),2)*(3-2*ld(0))`;
      expr = `if(lt(it,${b.t.toFixed(3)}),${interp},${expr})`;
    }
    return expr;
  };
  const cx = piece('cx'), cy = piece('cy');
  return {
    z: piece('z'),
    x: `clip((${cx})*iw-iw/(2*zoom),0,iw-iw/zoom)`,
    y: `clip((${cy})*ih-ih/(2*zoom),0,ih-ih/zoom)`,
  };
}

// Final marketing render in one FFmpeg pass:
//   intro card ⟶ xfade ⟶ [per-segment trim + animated zoom] concat,
//   light color grade, xfade ⟶ outro card, caption-pill overlays (timed,
//   alpha-faded), fade to black.
// Zoomed segments are 2× supersampled before zoompan to avoid zoom jitter.
// captions: [{ png, start, end }] on the FINAL timeline (intro included).
function _renderMarketingPromo({ rawPath, outPath, segs, captions, introPng, outroPng, introDur, outroDur, xf, editedDur }) {
  const { execFile } = require('child_process');
  const parts = [];

  segs.forEach((s, i) => {
    let chain = `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS`;
    if (s.kfs && s.kfs.length > 1) {
      const e = _zoomExprs(s.kfs);
      chain += `,scale=3200:2000:flags=lanczos,zoompan=z='${e.z}':x='${e.x}':y='${e.y}':d=1:fps=30:s=1280x800`;
    } else {
      chain += ',scale=1280:800:flags=lanczos,fps=30';
    }
    parts.push(`${chain}[s${i}]`);
  });

  const cardChain = (inp, dur, zExpr, label) =>
    `[${inp}:v]scale=2560:1600:flags=lanczos,` +
    `zoompan=z='${zExpr}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:fps=30:s=1280x800,` +
    `trim=duration=${dur},setpts=PTS-STARTPTS,format=yuv420p,settb=AVTB[${label}]`;

  const total = introDur + editedDur + outroDur - 2 * xf;
  const graphParts = [
    ...parts,
    segs.map((_, i) => `[s${i}]`).join('') + `concat=n=${segs.length}:v=1:a=0[cat]`,
    `[cat]eq=contrast=1.02:saturation=1.05,format=yuv420p,settb=AVTB[main]`,
    cardChain(1, introDur, `min(1.06,1+0.06*it/${introDur})`, 'intro'),
    cardChain(2, outroDur, `max(1,1.05-0.05*it/${outroDur})`, 'outro'),
    `[intro][main]xfade=transition=fade:duration=${xf}:offset=${(introDur - xf).toFixed(3)}[im]`,
    `[im][outro]xfade=transition=fade:duration=${xf}:offset=${(introDur - xf + editedDur - xf).toFixed(3)}[imo]`,
  ];

  // Caption pills: input 3+i, halved back from the 2× render, alpha-faded in
  // and out, overlaid bottom-center only within [start, end].
  let cur = 'imo';
  captions.forEach((c, i) => {
    const s = c.start.toFixed(3), e = c.end.toFixed(3);
    graphParts.push(
      `[${3 + i}:v]scale=iw/2:-1,format=rgba,` +
      `fade=t=in:st=${s}:d=0.25:alpha=1,fade=t=out:st=${(c.end - 0.25).toFixed(3)}:d=0.25:alpha=1[cp${i}]`);
    graphParts.push(`[${cur}][cp${i}]overlay=(W-w)/2:H-h-44:enable='between(t,${s},${e})'[ov${i}]`);
    cur = `ov${i}`;
  });
  graphParts.push(`[${cur}]fade=t=out:st=${Math.max(0, total - 0.7).toFixed(2)}:d=0.7,format=yuv420p[v]`);

  const args = [
    '-i', rawPath,
    '-loop', '1', '-framerate', '30', '-t', String(introDur), '-i', introPng,
    '-loop', '1', '-framerate', '30', '-t', String(outroDur), '-i', outroPng,
    ...captions.flatMap(c => ['-loop', '1', '-framerate', '30', '-t', String(Math.ceil(total)), '-i', c.png]),
    '-filter_complex', graphParts.join(';'),
    '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-r', '30',
    '-movflags', '+faststart',
    outPath, '-y',
  ];
  return new Promise((resolve, reject) => {
    execFile(_findFfmpeg(), args, { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        console.error('  FFmpeg error:\n', (stderr || '').slice(-1200));
        reject(err);
      } else {
        console.log(`  ✓ ${path.basename(outPath)} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB, ${total.toFixed(1)}s)`);
        resolve(outPath);
      }
    });
  });
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
async function _burnSubtitles(rawFile, srtFile, outFile, fontSize, scaleTo1280 = false) {
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

  // When the raw capture is at device-pixel resolution (e.g. 1600×1000 at
  // 125 % DPI scaling), downscale to 1280×800 before burning subtitles.
  // We scale rather than crop because the capture is sized to exactly match
  // Chrome's device-pixel window — no margins, nothing to clip away.
  const scaleFilter = scaleTo1280 ? 'scale=1280:800:flags=lanczos,' : '';

  const args = [
    '-i', raw,
    '-vf', `${scaleFilter}subtitles='${srtEsc}':force_style='${style}'`,
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
