'use strict';
/*
 * Swap layout-safety gate (FR-008 / SC-013 — T063 / T064 / T103).
 * ---------------------------------------------------------------------------
 * Mounts the real swap engine (js/render/swap.js + js/render/fonts.js) plus the
 * bundled @font-face rules (css/fonts.css, css/content.css) in a routed page,
 * then for EACH supported font and a battery of citation lengths:
 *   • builds an inline highlight span carrying the original page wording,
 *   • measures its rendered box (the surrounding line-box proxy),
 *   • runs QuranSwap.applySwap with that font,
 *   • asserts the swapped span's rendered box ≤ 1.5× the original box (the
 *     FR-008 bound the engine must now enforce by measure-and-clamp),
 *   • asserts revertSwap restores the original text + box exactly.
 *
 * This replaces the brittle "10 real-page pixel-delta fixtures" idea (T063):
 * it gates the actual FR-008 invariant directly, per supported font, instead of
 * snapshotting incidental page layout. Reuses the run_tests_node harness pattern
 * (system Chromium + asset routing).
 * Run: node tests/swap_layout_check.js
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
    'js/render/fonts.js',
    'js/render/swap.js',
  ].map(p => `<script src="${ORIGIN}/${p}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<link rel="stylesheet" href="${ORIGIN}/css/fonts.css">
<link rel="stylesheet" href="${ORIGIN}/css/content.css">
<style>
  /* A realistic body line-box so the clamp has something to bound against. */
  body { font-size: 18px; line-height: 1.7; font-family: serif; margin: 0; padding: 20px; }
  p { max-width: 600px; }
</style>
<script>
  window.chrome = { runtime: { getURL: (p) => '${ORIGIN}/' + String(p).replace(/^\\/+/, '') } };
</script>
</head><body>
<p id="host">قال تعالى: <span class="cite"></span> وفي موضع آخر.</p>
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

// The in-page battery. Returns [{ name, pass, detail }]. Self-contained.
function inPageTests() {
  const results = [];
  const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });

  // Citation excerpts of increasing length (short fragment → long ayah). These
  // are the page's ORIGINAL wording; the authentic excerpt is the same shape.
  const SAMPLES = [
    'إن مع العسر يسرا',
    'الحمد لله رب العالمين الرحمن الرحيم',
    'وقوم نوح لما كذبوا الرسل أغرقناهم وجعلناهم للناس آية وأعتدنا للظالمين عذابا أليما',
  ];
  // The supported fonts the swap engine sizes for (the prefs.font enum).
  const FONTS = (typeof QuranFonts !== 'undefined' && QuranFonts.REGISTRY)
    ? Object.keys(QuranFonts.REGISTRY)
    : ['uthmaniHafs'];
  if (typeof QuranFonts !== 'undefined' && QuranFonts.ensureLoaded) QuranFonts.ensureLoaded();

  const box = (el) => el.getBoundingClientRect().height;
  const MAX_RATIO = 1.5;

  return (async () => {
    if (typeof QuranSwap === 'undefined') { T('QuranSwap loaded', false, 'global missing'); return results; }
    // Ensure fonts are actually loaded so metrics reflect the real glyphs.
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (_) {}

    const span = document.querySelector('.cite');
    let idCounter = 0;

    for (const font of FONTS) {
      const prefs = { master: { authenticTextReplacement: true }, perColor: { orange: true }, font };
      for (let i = 0; i < SAMPLES.length; i++) {
        const text = SAMPLES[i];
        const id = 'fx' + (idCounter++);
        // Reset the span to the original wording + the finding wiring the engine needs.
        span.className = 'cite quran-orange';
        span.removeAttribute('style');
        span.classList.remove('quran-swap');
        span.setAttribute('data-finding-id', id);
        span.textContent = text;
        // force layout
        const origH = box(span);
        const origText = span.textContent;

        const finding = {
          id, color: 'orange', text,
          // excerpt-preserving: authentic excerpt is the same shape/length here
          authenticExcerpt: text, authenticText: text,
          matchedRef: 'الذاريات:56', matchedRefs: ['الذاريات:56'],
        };

        const applied = QuranSwap.applySwap(finding, prefs);
        T(`[${font}] applySwap "${text.slice(0, 12)}…"`, applied, 'returned false');
        if (!applied) continue;

        const newH = box(span);
        const ratio = origH ? (newH / origH) : 0;
        T(`[${font}] len${i} box ≤ 1.5× (ratio ${ratio.toFixed(2)})`,
          origH > 0 && newH <= origH * MAX_RATIO + 0.5, // +0.5px sub-pixel tolerance
          `origH=${origH.toFixed(1)} newH=${newH.toFixed(1)} ratio=${ratio.toFixed(2)}`);

        // All sizing must stay inside the span (FR-008: no outside-span CSS).
        const hostStyle = document.getElementById('host').getAttribute('style');
        T(`[${font}] len${i} no outside-span CSS`, !hostStyle, `host style=${hostStyle}`);

        // Reversal is exact.
        QuranSwap.revertSwap(finding);
        T(`[${font}] len${i} revert restores text`, span.textContent === origText,
          `got "${span.textContent.slice(0, 20)}"`);
        const revH = box(span);
        T(`[${font}] len${i} revert restores box`, Math.abs(revH - origH) < 1.0,
          `origH=${origH.toFixed(1)} revH=${revH.toFixed(1)}`);
      }
    }

    // --- Clamp-stress: force an overflow so the clamp branch MUST engage. ---
    // A deliberately tiny original line-box (8px) against a body-sized swap
    // would render well over 1.5× without enforcement; the engine must shrink
    // span-local font-size until it fits.
    {
      const id = 'clamp0';
      span.className = 'cite quran-orange';
      span.removeAttribute('style');
      span.classList.remove('quran-swap');
      span.setAttribute('data-finding-id', id);
      span.style.fontSize = '8px';
      span.style.lineHeight = '1';
      span.textContent = 'يسرا';
      const origH = box(span);
      const finding = {
        id, color: 'orange', text: 'يسرا',
        authenticExcerpt: 'الحمد لله رب العالمين الرحمن الرحيم الذي خلق', authenticText: 'x',
        matchedRef: 'الفاتحة:2', matchedRefs: ['الفاتحة:2'],
      };
      const applied = QuranSwap.applySwap(finding, { master: { authenticTextReplacement: true }, perColor: { orange: true }, font: 'uthmaniHafs' });
      T('clamp-stress applySwap', applied);
      const newH = box(span);
      const ratio = origH ? newH / origH : 0;
      T(`clamp-stress box ≤ 1.5× after clamp (ratio ${ratio.toFixed(2)})`,
        origH > 0 && newH <= origH * 1.5 + 0.5,
        `origH=${origH.toFixed(1)} newH=${newH.toFixed(1)} ratio=${ratio.toFixed(2)}`);
      QuranSwap.revertSwap(finding);
    }

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
      : ext === '.ttf' ? 'font/ttf'
      : ext === '.otf' ? 'font/otf'
      : ext === '.woff2' ? 'font/woff2'
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
  console.log(`\nswap_layout: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
