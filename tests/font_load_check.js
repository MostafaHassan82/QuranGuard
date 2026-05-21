'use strict';
// Diagnostic: load each bundled Quran font via @font-face from a file:// URL and
// report whether the browser actually loaded distinct outlines, or fell back to
// a default (which makes every font "look the same"). Run: node tests/font_load_check.js
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'render', 'fonts.js'), 'utf8').replace(/'use strict';/, '');
const QuranFonts = new Function(src + '; return QuranFonts;')();
const REGISTRY = QuranFonts.REGISTRY;

async function launch() {
  const opts = { headless: true };
  const env = process.env.QURAN_TEST_BROWSER;
  if (env && fs.existsSync(env)) return chromium.launch({ ...opts, executablePath: env });
  const home = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
    home && `${home}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return chromium.launch({ ...opts, executablePath: p });
  return chromium.launch(opts);
}

(async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
    const fp = path.join(ROOT, rel);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'font/ttf', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const fileUrl = p => `http://localhost:${port}/` + encodeURI(p);
  const faces = Object.values(REGISTRY).map(r =>
    `@font-face{font-family:'${r.family}';src:url("${fileUrl(r.path)}") format('${r.path.split('.').pop().toLowerCase() === 'otf' ? 'opentype' : r.path.split('.').pop().toLowerCase() === 'woff2' ? 'woff2' : 'truetype'}');}`
  ).join('\n');

  const browser = await launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><meta charset=utf-8><style>${faces}</style><body><span id=probe>بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</span></body>`);

  const results = await page.evaluate(async (families) => {
    const out = [];
    const probe = document.getElementById('probe');
    probe.style.fontSize = '40px';
    for (const fam of families) {
      let err = '';
      try { await document.fonts.load(`40px '${fam}'`, 'بِسْمِ'); }
      catch (e) { err = String(e && e.message || e); }
      const loaded = document.fonts.check(`40px '${fam}'`, 'بِسْمِ');
      probe.style.fontFamily = `'${fam}'`;
      const w = probe.getBoundingClientRect().width;
      out.push({ fam, loaded, width: Math.round(w), err });
    }
    return out;
  }, Object.values(REGISTRY).map(r => r.family));

  await browser.close();
  server.close();
  console.log('font'.padEnd(28), 'loaded', 'renderedWidth');
  const widths = new Set();
  for (const r of results) {
    console.log(r.fam.padEnd(28), String(r.loaded).padEnd(6), r.width, r.err ? '  ERR: ' + r.err : '');
    widths.add(r.width);
  }
  console.log(`\nDistinct rendered widths: ${widths.size} of ${results.length}`);
  const failed = results.filter(r => !r.loaded);
  if (failed.length) console.log(`NOT loaded (fall back to default): ${failed.map(f => f.fam).join(', ')}`);
})();
