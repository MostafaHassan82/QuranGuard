'use strict';
// T095 — render icons/icon.svg to PNG at the Chrome action/extension sizes.
// Uses the already-installed headless Chromium (Playwright) so there's no new
// dependency and no build step in the extension itself. Run: node tools/render-icons.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'icons', 'icon.svg'), 'utf8');
const SIZES = [16, 32, 48, 128];

// Mirror tests/run_tests_node.js launchSystemChromium(): prefer a system browser
// so we don't require `npx playwright install`.
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
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return chromium.launch({ ...opts, executablePath: p });
  }
  return chromium.launch(opts);
}

(async () => {
  const browser = await launchSystemChromium();
  const page = await browser.newPage();
  for (const size of SIZES) {
    // Transparent background; SVG scaled to the exact target box.
    const html = `<!DOCTYPE html><html><head><style>
      html,body{margin:0;padding:0;background:transparent}
      svg{display:block}
    </style></head><body>${SVG.replace(/width="128" height="128"/, `width="${size}" height="${size}"`)}</body></html>`;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const el = await page.$('svg');
    const out = path.join(ROOT, 'icons', `icon-${size}.png`);
    await el.screenshot({ path: out, omitBackground: true });
    console.log(`wrote icons/icon-${size}.png`);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
