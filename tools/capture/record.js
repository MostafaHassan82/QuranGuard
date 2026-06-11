'use strict';
/**
 * Generic scripted screen-recording ENGINE.
 *
 * Records the real Chrome window (extension loaded) while executing a
 * declarative video script, then post-produces a polished MP4. Knows nothing
 * about any particular video — everything content-specific (URLs, prefs,
 * scenes, copy, card design, caption style, output name) comes from the
 * script module. See promo-script.js for the script interface and an example.
 *
 * Usage:
 *   node tools/capture/record.js [script.js] --lang <lang>   Record + render
 *   node tools/capture/record.js [script.js] --validate      Static-check only
 *
 *   script.js  path relative to tools/capture (default: promo-script.js)
 *   --lang     one of the script's `languages` (default: the first one)
 *
 * Pipeline: FFmpeg gdigrab captures the Chrome window at device pixels; scene
 * events (caption cues, load-interval cuts, zoom keyframes) are recorded as
 * wall-clock times and anchored to the video clock after capture
 * (t0 ≈ qWall − duration); post-production trims the cuts, applies animated
 * zoompan, overlays browser-rendered caption pills, and sandwiches the result
 * between the script's intro/outro cards.
 *
 * ── Verb reference (the ACTIONS table) ──────────────────────────────────────
 *   cue            { text }                        show caption (key into script copy)
 *   zoom           { z, cx, cy, dur } or { z, target, dur }   animate camera (post)
 *   wait           { ms }
 *   mouse          { x, y }                        CDP cursor move (in-page)
 *   scrollBy       { top }                         smooth window.scrollBy
 *   scrollTop      { top }                         instant window.scrollTo
 *   scrollToEl     { sel, smooth? }                scroll element into view
 *   nativeGlide    { points, click?, log? }        OS cursor glide (reaches native popups)
 *   nativeKey      { vk }                          OS key press (0x1B = Escape)
 *   nativeClick    { x, y }                        OS click
 *   openPopup      {}                              chrome.action.openPopup; sets state.popupShown
 *   setPref        { key, value }                  merge one key into prefs.v1
 *   goto           { url, waitUntil?, timeout?, dismissOverlays? }  url = script urls key or literal
 *   waitFor        { sel, timeout?, optional? }
 *   waitForPanel   {}
 *   spotlight      { target, pad?, holdMs, scrollIntoView?, settleMs? }   on → hold → off
 *   rippleClick    { target, scrollIntoView?, settleMs?, preMs?, name? }  glide+ripple+click
 *   saveBox        { target, as }                  remember an element's box for resolvers
 *   type           { text, perCharMs? }
 *   press          { key }
 *   click          { sel }
 *   injectCss      { css }                         {EXT_ID} is replaced with the extension id
 *   cut            { steps }                       load interval — removed in post
 *
 * Any step may carry `when: '<flag>'` to run only if ctx.state[flag] is truthy.
 */

const path = require('path');
const fs   = require('fs');
const { chromium } = require('playwright');
const { serve } = require('./server.js');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXT_PATH     = PROJECT_ROOT;
const OUTPUT_DIR   = path.join(__dirname, 'output');
const VIDEO_DIR    = path.join(OUTPUT_DIR, 'video');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let LANG_ARG = null, DO_VALIDATE = false, scriptPath = 'promo-script.js';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--lang')     { LANG_ARG = args[++i]; continue; }
  if (args[i] === '--validate') { DO_VALIDATE = true; continue; }
  scriptPath = args[i];
}

const script = require(path.resolve(__dirname, scriptPath));
const LANG = script.languages.includes(LANG_ARG) ? LANG_ARG : script.languages[0];
if (LANG_ARG && LANG !== LANG_ARG) {
  console.warn(`unknown --lang ${LANG_ARG} (script supports: ${script.languages.join(', ')}) — using ${LANG}`);
}

// ── Generic helpers ───────────────────────────────────────────────────────────

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }

// Launch Playwright Chromium with the extension loaded, window pinned at (0,0)
// with fixed outer size for gdigrab alignment.
async function launchWithExtension({ winW = 1280, winH = 800 } = {}) {
  const ctxOpts = {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=0,0',
      `--window-size=${winW},${winH}`,
      '--disable-popup-blocking',
    ],
    viewport: null, // let Chrome use the natural content-area size
    ignoreDefaultArgs: ['--enable-automation'],
  };

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

// Merge keys into chrome.storage.local 'prefs.v1'.
async function setPrefs(sw, patch) {
  await sw.evaluate(async (p) => {
    const data  = await chrome.storage.local.get('prefs.v1');
    const prefs = Object.assign(data['prefs.v1'] || {}, p);
    await chrome.storage.local.set({ 'prefs.v1': prefs });
  }, patch);
}

// Wait for the sidebar panel to appear (best-effort).
async function waitForPanel(page, timeout = 18_000) {
  await page.waitForSelector('.quran-ext-panel', { timeout }).catch(() => null);
  await sleep(600); // let panel finish rendering its findings list
}

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

// ── Screen-capture helpers (gdigrab) ─────────────────────────────────────────

// Start FFmpeg gdigrab recording of the desktop region (offsetX,offsetY) → W×H.
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
// approximate wall time of the video's LAST frame. The scene timeline is
// anchored with it: videoT0 ≈ qWall − durationMs.
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

// ── Native OS input (reaches windows CDP cannot) ─────────────────────────────

// Send a real OS-level key press (keybd_event). Playwright keyboard events go
// through CDP to a page target — they can't reach a native extension-action
// popup window. vk 0x1B = Escape (closes the action popup).
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
// SetCursorPos coords are CSS-virtualized (PowerShell is DPI-unaware).
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

// ── In-page effects (spotlight, click ripple) ────────────────────────────────
// Visual emphasis: the spotlight dims the page and draws a pulsing ring around
// one element; the ripple marks clicks. Both are injected as the LAST children
// of <html> at max z-index so they paint above the extension panel (which also
// uses 2147483647).

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

// ── Target resolution ─────────────────────────────────────────────────────────
// Named lookups too page-specific for a selector. Resolvers receive (ctx, spec)
// and return an ElementHandle or null. spec.arg names a box saved via saveBox.

const RESOLVERS = {
  // The wrong-ref marker the content script renders next to an orange
  // highlight, keyed by the highlight's finding id.
  wrongRefMarker: async (ctx) => {
    const h = await ctx.page.evaluateHandle(() => {
      const ayah = document.querySelector('.quran-orange');
      const id = ayah && ayah.dataset.findingId;
      return id ? document.querySelector(`[data-quran-ref-for="${CSS.escape(id)}"]`) : null;
    });
    return h.asElement();
  },
  nearestLightGreen: (ctx, spec) =>
    _nearestLightGreen(ctx.page, ctx.saved[(spec && spec.arg) || 'orangeBox'] || null),
};

// Resolve a script target spec (see the header) to an ElementHandle.
async function resolveTarget(ctx, spec) {
  if (!spec) return null;
  if (Array.isArray(spec)) {
    for (const s of spec) {
      const el = await resolveTarget(ctx, s);
      if (el) return el;
    }
    return null;
  }
  if (typeof spec === 'string') {
    if (spec.startsWith('@')) return RESOLVERS[spec.slice(1)](ctx, null);
    return ctx.page.$(spec);
  }
  if (spec.resolver) return RESOLVERS[spec.resolver](ctx, spec);
  if (spec.row)      return _findRowButton(ctx.page, spec.row, spec.label);
  return null;
}

// ── Action vocabulary ─────────────────────────────────────────────────────────

const ACTIONS = {
  cue: async (ctx, step) => ctx.cue(ctx.copy[step.text]),

  wait: (ctx, step) => sleep(step.ms),

  // Camera zoom (applied in post via zoompan). With `target`, centers on the
  // element's current box; silently skipped if the target isn't on screen.
  zoom: async (ctx, step) => {
    if (step.target) {
      const el = await resolveTarget(ctx, step.target);
      const box = el && await el.boundingBox().catch(() => null);
      if (!box) return;
      const f = ctx.frac(box);
      ctx.zoomTo(step.z, f.cx, f.cy, step.dur ?? 0.7);
    } else {
      ctx.zoomTo(step.z, step.cx ?? 0.5, step.cy ?? 0.5, step.dur ?? 0.7);
    }
    ctx.zoomZ = step.z;
  },

  mouse: (ctx, step) => ctx.page.mouse.move(step.x, step.y),

  scrollBy: (ctx, step) =>
    ctx.page.evaluate((top) => window.scrollBy({ top, behavior: 'smooth' }), step.top),

  scrollTop: (ctx, step) =>
    ctx.page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), step.top),

  scrollToEl: async (ctx, step) => {
    if (step.smooth) {
      await ctx.page.evaluate((s) => {
        document.querySelector(s)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, step.sel);
    } else {
      const el = await ctx.page.$(step.sel);
      if (el) await el.scrollIntoViewIfNeeded().catch(() => {});
    }
  },

  nativeGlide: async (ctx, step) => {
    await _nativeMouse(step.points, { click: !!step.click });
    if (step.log) console.log(`  ✓ ${step.log}`);
  },

  nativeKey:   (ctx, step) => _nativeKey(step.vk),
  nativeClick: (ctx, step) => _nativeClick(step.x, step.y),

  // Open the extension action popup as a real native window. Falls back to
  // rendering popup.html as a tab. Sets ctx.state.popupShown for `when` gates.
  openPopup: async (ctx) => {
    try {
      await ctx.sw.evaluate(() => new Promise((res, rej) => {
        if (!chrome.action?.openPopup) { rej(new Error('not available')); return; }
        chrome.action.openPopup({}, () => {
          if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
          else res();
        });
      }));
      ctx.state.popupShown = true;
      console.log('  ✓ chrome.action.openPopup() succeeded — popup visible on screen');
    } catch (e) {
      console.log('  ⚠ openPopup failed:', e.message);
      await ctx.page.goto(ctx.popupUrl, { waitUntil: 'domcontentloaded' }); // fallback: popup as a tab
    }
  },

  setPref: (ctx, step) => setPrefs(ctx.sw, { [step.key]: step.value }),

  goto: async (ctx, step) => {
    const url = ctx.urls[step.url] || step.url;
    await ctx.page.goto(url, {
      waitUntil: step.waitUntil || 'load',
      timeout:   step.timeout ?? 30_000,
    });
    if (step.dismissOverlays) await _dismissOverlays(ctx.page);
  },

  waitFor: async (ctx, step) => {
    const p = ctx.page.waitForSelector(step.sel, { timeout: step.timeout ?? 30_000 });
    if (step.optional) await p.catch(() => null);
    else await p;
  },

  waitForPanel: (ctx) => waitForPanel(ctx.page),

  // on → hold → off. If the target doesn't resolve, holds anyway (so scene
  // timing — and therefore caption timing — never depends on page content).
  spotlight: async (ctx, step) => {
    const el = await resolveTarget(ctx, step.target);
    if (el) {
      if (step.scrollIntoView) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(step.settleMs ?? 400);
      }
      await _spotlightOn(ctx.page, el, { pad: step.pad ?? 10 });
    }
    await sleep(step.holdMs);
    await _spotlightOff(ctx.page);
  },

  // Move the in-page cursor to the target's center, ripple, click.
  // settleMs pauses after scrollIntoView; preMs pauses between move and ripple.
  rippleClick: async (ctx, step) => {
    const el = await resolveTarget(ctx, step.target);
    if (!el) { console.warn(`  ⚠ ${step.name || 'rippleClick'}: target not found`); return; }
    if (step.scrollIntoView) await el.scrollIntoViewIfNeeded().catch(() => {});
    if (step.settleMs) await sleep(step.settleMs);
    const box = await el.boundingBox().catch(() => null);
    if (box) {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await ctx.page.mouse.move(cx, cy);
      if (step.preMs) await sleep(step.preMs);
      await _ripple(ctx.page, cx, cy);
    }
    await el.click().catch(() => {});
    if (step.name) console.log(`  ✓ ${step.name}`);
  },

  saveBox: async (ctx, step) => {
    const el = await resolveTarget(ctx, step.target);
    ctx.saved[step.as] = el ? await el.boundingBox().catch(() => null) : null;
  },

  type: async (ctx, step) => {
    for (const ch of step.text) {
      await ctx.page.keyboard.type(ch);
      await sleep(step.perCharMs ?? 140);
    }
  },

  press: (ctx, step) => ctx.page.keyboard.press(step.key),

  click: (ctx, step) => ctx.page.click(step.sel),

  injectCss: (ctx, step) => ctx.page.evaluate((css) => {
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }, step.css.replace(/\{EXT_ID\}/g, ctx.extensionId)),

  // Load interval: everything inside is removed from the final video in post.
  cut: async (ctx, step) => {
    if (Math.abs(ctx.zoomZ - 1) > 0.001) {
      console.warn(`  ⚠ cut starts while zoom=${ctx.zoomZ} — zoompan will jump`);
    }
    ctx.cutStart();
    for (const s of step.steps) await execStep(ctx, s);
    ctx.cutEnd();
  },
};

async function execStep(ctx, step) {
  if (step.when && !ctx.state[step.when]) return;
  const fn = ACTIONS[step.do];
  if (!fn) throw new Error(`unknown action "${step.do}"`);
  await fn(ctx, step);
}

// ── Static validation (--validate) ────────────────────────────────────────────
// Catches script mistakes without launching anything: unknown verbs, cue keys
// missing from the copy, cuts entered while zoomed, nested cuts, `when:
// popupShown` before any openPopup.

function validateScript(scenes, copy) {
  const errors = [];
  const langs = Object.keys(copy);
  let z = 1, popupOpened = false, steps = 0;
  const walk = (list, where, inCut) => {
    for (const step of list) {
      steps++;
      if (step.do !== 'cut' && !ACTIONS[step.do]) {
        errors.push(`${where}: unknown action "${step.do}"`);
        continue;
      }
      if (step.do === 'cue') {
        for (const l of langs) {
          if (!copy[l][step.text]) errors.push(`${where}: cue key "${step.text}" missing in copy.${l}`);
        }
      }
      if (step.do === 'zoom') z = step.z;
      if (step.do === 'openPopup') popupOpened = true;
      if (step.when === 'popupShown' && !popupOpened) {
        errors.push(`${where}: when:popupShown before any openPopup`);
      }
      if (step.do === 'cut') {
        if (inCut) errors.push(`${where}: nested cut`);
        if (Math.abs(z - 1) > 0.001) errors.push(`${where}: cut entered while zoom=${z} (return to 1 first)`);
        walk(step.steps, where, true);
      }
    }
  };
  for (const sc of scenes) walk(sc.steps, `scene "${sc.scene}"`, false);
  return { errors, steps, scenes: scenes.length };
}

// ── Main recording flow ───────────────────────────────────────────────────────

async function runRecording(srv, lang) {
  ensureDir(VIDEO_DIR);
  const scenes = script.scenes({ lang });
  console.log(`\n── ${script.name} [scripted, screen capture] ────────────────────`);
  console.log('  Recording… (do not interact with the browser window)');

  const W = 1280, H = 800;
  const rawPath = path.join(VIDEO_DIR, `${script.name}-raw-${lang}.mp4`);
  console.log(`  Language: ${lang}  ·  ${scenes.length} scenes`);

  // The script's intro/outro cards, rendered off-screen before recording starts.
  const { introPng, outroPng } = await _renderCards(lang);
  console.log('  ✓ intro/outro cards rendered');

  const { context, popupUrl, optionsUrl, extensionId, sw } = await launchWithExtension({ winW: W, winH: H });
  // Reuse the persistent context's initial about:blank tab — opening a second
  // page leaves a stray "about:blank" tab visible in the tab strip on camera.
  const page = context.pages()[0] || await context.newPage();
  await page.bringToFront();

  // Pin outer window to exactly W×H at (0,0). --window-size sets the
  // *viewport* in Chromium; Browser.setWindowBounds forces the OUTER window.
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

  // Script prefs — before any extension surface renders.
  await setPrefs(sw, script.prefs(lang));

  const urls = script.urls({ srv, popupUrl, optionsUrl, extensionId });

  // Load the start page fully before recording starts so frame 1 is a clean,
  // fully-rendered page (not the desktop or a half-painted load).
  await page.goto(urls[script.startUrl] || script.startUrl, { waitUntil: 'load', timeout: 30_000 });
  await _dismissOverlays(page);

  // CDP setWindowBounds uses CSS pixels but gdigrab captures *device* pixels:
  // capture exactly W·dpr × H·dpr at Chrome's top-left, scale to W×H in post.
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

  const ffproc = _startScreenCapture(rawPath, CAP_W, CAP_H, capX, capY);
  const ffStartWall = Date.now();
  await sleep(1000); // let gdigrab deliver its first frames

  // Scene timeline: cue/cut/zoom events recorded as wall-clock times, anchored
  // to the video clock after the capture stops (t0 ≈ qWall − duration).
  const tl = { cues: [], cuts: [], _cut: null };
  const zooms = [];
  const _t0 = Date.now();
  let qWall = null;

  const ctx = {
    page, sw, context, lang, extensionId, popupUrl, optionsUrl, urls,
    copy: script.copy[lang],
    state: {},   // runtime flags for `when:` gates (popupShown, …)
    saved: {},   // boxes stored by saveBox, read by resolvers
    zoomZ: 1,

    cue: (text) => {
      const last = tl.cues[tl.cues.length - 1];
      if (last && !last.endWall) last.endWall = Date.now();
      tl.cues.push({ text, startWall: Date.now(), endWall: null });
      console.log(`  [cue] ${text}`);
    },
    cutStart: () => { tl._cut = { startWall: Date.now(), endWall: null }; tl.cuts.push(tl._cut); },
    cutEnd:   () => { if (tl._cut) { tl._cut.endWall = Date.now(); tl._cut = null; } },
    zoomTo: (z, cx, cy, dur = 0.7) => zooms.push({ wall: Date.now(), z, cx, cy, dur }),
    // Page-viewport coords → frame fractions (browser chrome sits above the page).
    frac: (box) => {
      const CONTENT_TOP = win.outerH - win.innerH > 0 ? win.outerH - win.innerH : 94;
      return {
        cx: Math.min(0.95, Math.max(0.05, (box.x + box.width / 2) / W)),
        cy: Math.min(0.95, Math.max(0.05, (box.y + box.height / 2 + CONTENT_TOP) / H)),
      };
    },
  };

  try {
    for (const scene of scenes) {
      console.log(`  [t=${((Date.now() - _t0) / 1000).toFixed(1)}s] scene: ${scene.scene}`);
      for (const step of scene.steps) await execStep(ctx, step);
    }
    console.log(`  [t=${((Date.now() - _t0) / 1000).toFixed(1)}s] all scenes done`);
  } finally {
    // Stop the recording BEFORE closing Chrome — the reverse order leaves the
    // bare desktop in the last seconds of the video.
    qWall = await _stopScreenCapture(ffproc);
    if (script.cleanupPrefs) await setPrefs(sw, script.cleanupPrefs).catch(() => {});
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
  const { introDur, outroDur, xf } = script.timing;
  const capOff = introDur - xf;
  const finalCues = cues.map(c => ({
    text:  c.text,
    start: +(c.start + capOff).toFixed(3),
    end:   +(c.end + capOff).toFixed(3),
  }));
  fs.writeFileSync(
    path.join(VIDEO_DIR, `${script.name}-${lang}.cues.json`),
    JSON.stringify(finalCues, null, 2));
  const capPngs = await _makeCaptionPngs(finalCues, lang);
  const captions = finalCues.map((c, i) => ({ png: capPngs[i], start: c.start, end: c.end }));
  console.log(`  Captions: ${captions.length} pills rendered (${lang})`);
  console.log(`  Cutting ${cuts.length} load interval(s): ${D.toFixed(1)}s → ${editedDur.toFixed(1)}s + cards`);

  await _renderFinal({
    rawPath,
    outPath: path.join(VIDEO_DIR, `${script.name}-${lang}.mp4`),
    segs, captions, introPng, outroPng,
    introDur, outroDur, xf, editedDur,
  });
}

// ── Post-production ───────────────────────────────────────────────────────────

// Render the script's intro/outro cards to PNG via a separate headless
// browser — never visible to the screen recording.
async function _renderCards(lang) {
  const { introHtml, outroHtml, viewport } = script.cards(lang);
  const introPng = path.join(VIDEO_DIR, `${script.name}-card-intro-${lang}.png`);
  const outroPng = path.join(VIDEO_DIR, `${script.name}-card-outro-${lang}.png`);
  const browser = await chromium.launch({ headless: true });
  try {
    const pg = await browser.newPage({ viewport });
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
  const browser = await chromium.launch({ headless: true });
  const out = [];
  try {
    const pg = await browser.newPage({ viewport: { width: 1280, height: 240 }, deviceScaleFactor: 2 });
    for (let i = 0; i < cues.length; i++) {
      await pg.setContent(script.captionHtml(cues[i].text, lang));
      const el = await pg.$('body > *');
      const png = path.join(VIDEO_DIR, `${script.name}-cap-${lang}-${String(i).padStart(2, '0')}.png`);
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

// Final render in one FFmpeg pass:
//   intro card ⟶ xfade ⟶ [per-segment trim + animated zoom] concat,
//   light color grade, xfade ⟶ outro card, caption-pill overlays (timed,
//   alpha-faded), fade to black.
// Zoomed segments are 2× supersampled before zoompan to avoid zoom jitter.
// captions: [{ png, start, end }] on the FINAL timeline (intro included).
function _renderFinal({ rawPath, outPath, segs, captions, introPng, outroPng, introDur, outroDur, xf, editedDur }) {
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

  const ffArgs = [
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
    execFile(_findFfmpeg(), ffArgs, { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
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
  if (DO_VALIDATE) {
    let failed = false;
    for (const l of script.languages) {
      const { errors, steps, scenes } = validateScript(script.scenes({ lang: l }), script.copy);
      console.log(`[${l}] ${scenes} scenes, ${steps} steps — ${errors.length ? errors.length + ' error(s)' : 'OK'}`);
      for (const e of errors) console.log(`  ✗ ${e}`);
      if (errors.length) failed = true;
    }
    process.exit(failed ? 1 : 0);
  }

  const { errors } = validateScript(script.scenes({ lang: LANG }), script.copy);
  if (errors.length) {
    for (const e of errors) console.error(`  ✗ ${e}`);
    throw new Error(`script validation failed — fix ${scriptPath}`);
  }

  ensureDir(OUTPUT_DIR);
  const srv = await serve(7331);
  try {
    await runRecording(srv, LANG);
  } finally {
    srv.server.close();
  }
  console.log('\nDone.');
})();
