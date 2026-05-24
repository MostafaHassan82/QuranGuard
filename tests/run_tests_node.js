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
 *   node tests/run_tests_node.js --all --coverage --coverage-driver-lite
 *   node tests/run_tests_node.js --all --coverage --coverage-faults
 *   node tests/run_tests_node.js --coverage-diff --coverage-driver-off
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
const coverageDriverInteractions = require(path.join(TESTS_DIR, 'coverage_driver_interactions.js'));
const coverageFaultDriver = require(path.join(TESTS_DIR, 'coverage_fault_driver.js'));

// Content-script bundle, in manifest order, plus the verifier/storage modules
// background.js would importScripts. We inject the verifier modules FIRST so
// their globals exist, then neutralize importScripts before background.js runs.
const BACKGROUND_DEPS = [
  'js/shared/log.js',
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
    const connectListeners = [];
    const store = Object.assign({}, window.__seedStorage || {});
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

    function dispatch(message, callback, senderOverride) {
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
        try { ret = fn(clone(message), senderOverride || { id: 'mock' }, sendResponse); } catch (e) { /* listener threw */ }
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
        onConnect: { addListener: (fn) => connectListeners.push(fn) },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        sendMessage: (message, callback) => {
          if (typeof callback === 'function') { dispatch(message, callback); return; }
          return new Promise((resolve) => dispatch(message, resolve));
        },
        connect: (info) => {
          const disconnectListeners = [];
          const port = {
            name: (info && info.name) || '',
            onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
            disconnect: () => {
              for (const fn of disconnectListeners.slice()) {
                try { fn(port); } catch (_) {}
              }
            },
          };
          for (const fn of connectListeners.slice()) {
            try { fn(port); } catch (_) {}
          }
          return port;
        },
        __dispatchWithSender: (message, sender) => new Promise((resolve) => dispatch(message, resolve, sender || { id: 'mock' })),
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

async function runOne(context, htmlSource, label, seedSettings, covAccum, coverageOpts = { driver: 'base', faults: false }) {
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
    if (covAccum && coverageOpts.driver !== 'off') {
      const extended = coverageOpts.driver === 'extended';
      try { await page.evaluate(coverageDriverInteractions, { extended }); } catch (_) {}
    }
    if (covAccum && coverageOpts.faults) {
      try { await page.evaluate(coverageFaultDriver); } catch (_) {}
    }

    if (covAccum) {
      const entries = await page.coverage.stopJSCoverage();
      for (const e of entries) covAccum.push(e);
    }
    return normalizeResult(result, label);
  } finally {
    await page.close();
  }
}

// Coverage (T086): aggregate V8 precise (block) coverage across fixtures.
// Only the extension's own source under ${ORIGIN}/js/ is measured. V8 emits
// nested ranges, so a line is covered if any non-whitespace byte ran.
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
    // Map each non-blank line's non-ws offsets → covered?
    let ln = 1, lineStart = 0;
    for (let i = 0; i <= src.length; i++) {
      if (i === src.length || src[i] === '\n') {
        const text = src.slice(lineStart, i);
        if (text.trim()) {
          for (let j = 0; j < text.length; j++) {
            if (!/\S/.test(text[j])) continue;
            if (offsetCovered(ranges, lineStart + j)) {
              rec.coveredLines.add(ln);
              break;
            }
          }
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
      covered,
      uncovered,
    });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return files;
}

function writeCoverage(files, generatedBy) {
  const dir = path.join(TESTS_DIR, 'coverage');
  fs.mkdirSync(dir, { recursive: true });
  const totals = files.reduce((a, f) => ({ lines: a.lines + f.lines, covered: a.covered + f.coveredLines }), { lines: 0, covered: 0 });
  const overall = totals.lines ? +(100 * totals.covered / totals.lines).toFixed(1) : 0;
  const summary = {
    generatedAt: new Date().toISOString(),
    generatedBy: generatedBy || 'node tests/run_tests_node.js --all --coverage',
    overallLinePct: overall,
    totalLines: totals.lines, coveredLines: totals.covered,
    files: files.map(({ covered, uncovered, ...f }) => f),
  };
  fs.writeFileSync(path.join(dir, 'coverage-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf-8');

  let md = `# Coverage — Node fixture suite (T086)\n\nGenerated: ${summary.generatedAt}\n\n`;
  md += `> Regenerate with: \`${summary.generatedBy}\`\n`;
  md += `> A line counts as covered if **any** non-whitespace byte on it executed in any fixture run.\n\n`;
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

function coverageTotals(files) {
  const totals = files.reduce((a, f) => ({ lines: a.lines + f.lines, covered: a.covered + f.coveredLines }), { lines: 0, covered: 0 });
  return {
    lines: totals.lines,
    covered: totals.covered,
    pct: totals.lines ? +(100 * totals.covered / totals.lines).toFixed(1) : 0,
  };
}

function diffCoverageGroups(leftFiles, rightFiles, leftName, rightName) {
  const leftByFile = new Map(leftFiles.map(f => [f.file, f]));
  const rightByFile = new Map(rightFiles.map(f => [f.file, f]));
  const names = Array.from(new Set([...leftByFile.keys(), ...rightByFile.keys()])).sort();
  return names.map(file => {
    const left = leftByFile.get(file);
    const right = rightByFile.get(file);
    const leftCovered = new Set((left && left.covered) || []);
    const rightCovered = new Set((right && right.covered) || []);
    const onlyLeft = [...leftCovered].filter(l => !rightCovered.has(l)).sort((a, b) => a - b);
    const onlyRight = [...rightCovered].filter(l => !leftCovered.has(l)).sort((a, b) => a - b);
    const leftUncovered = ((left && left.uncovered) || []).slice().sort((a, b) => a - b);
    const rightUncovered = ((right && right.uncovered) || []).slice().sort((a, b) => a - b);
    const leftPct = left ? left.linePct : 0;
    const rightPct = right ? right.linePct : 0;
    return {
      file,
      lines: left ? left.lines : (right ? right.lines : 0),
      [`${leftName}Covered`]: left ? left.coveredLines : 0,
      [`${leftName}Pct`]: leftPct,
      [`${rightName}Covered`]: right ? right.coveredLines : 0,
      [`${rightName}Pct`]: rightPct,
      pctDelta: +(leftPct - rightPct).toFixed(1),
      [`only${capitalize(leftName)}`]: onlyLeft,
      [`only${capitalize(rightName)}`]: onlyRight,
      [`${leftName}Uncovered`]: leftUncovered,
      [`${rightName}Uncovered`]: rightUncovered,
    };
  });
}

function capitalize(s) {
  return String(s || '').slice(0, 1).toUpperCase() + String(s || '').slice(1);
}

function writeCoverageDiff(leftFiles, rightFiles, leftName, rightName) {
  const dir = path.join(TESTS_DIR, 'coverage');
  fs.mkdirSync(dir, { recursive: true });
  const leftTotals = coverageTotals(leftFiles);
  const rightTotals = coverageTotals(rightFiles);
  const files = diffCoverageGroups(leftFiles, rightFiles, leftName, rightName);
  const generatedAt = new Date().toISOString();
  const summary = {
    generatedAt,
    groups: {
      [leftName]: { totalLines: leftTotals.lines, coveredLines: leftTotals.covered, overallLinePct: leftTotals.pct },
      [rightName]: { totalLines: rightTotals.lines, coveredLines: rightTotals.covered, overallLinePct: rightTotals.pct },
    },
    overallPctDelta: +(leftTotals.pct - rightTotals.pct).toFixed(1),
    files: files.map(row => {
      const leftOnlyKey = `only${capitalize(leftName)}`;
      const rightOnlyKey = `only${capitalize(rightName)}`;
      const leftUncoveredKey = `${leftName}Uncovered`;
      const rightUncoveredKey = `${rightName}Uncovered`;
      const {
        [leftOnlyKey]: _leftOnly,
        [rightOnlyKey]: _rightOnly,
        [leftUncoveredKey]: _leftUncovered,
        [rightUncoveredKey]: _rightUncovered,
        ...rest
      } = row;
      return {
        ...rest,
        [`${leftName}OnlyLines`]: _leftOnly.length,
        [`${rightName}OnlyLines`]: _rightOnly.length,
        [`${leftName}UncoveredLines`]: _leftUncovered.length,
        [`${rightName}UncoveredLines`]: _rightUncovered.length,
      };
    }),
  };
  fs.writeFileSync(path.join(dir, `${leftName}-vs-${rightName}.json`), JSON.stringify(summary, null, 2) + '\n', 'utf-8');

  let md = `# Coverage diff - ${leftName} vs ${rightName}\n\nGenerated: ${generatedAt}\n\n`;
  md += `| Group | Covered | Lines | Line % |\n|---|---:|---:|---:|\n`;
  md += `| ${leftName} | ${leftTotals.covered} | ${leftTotals.lines} | ${leftTotals.pct}% |\n`;
  md += `| ${rightName} | ${rightTotals.covered} | ${rightTotals.lines} | ${rightTotals.pct}% |\n\n`;
  md += `**Overall delta (${leftName} - ${rightName}): ${summary.overallPctDelta} percentage points**\n\n`;
  md += `| File | ${leftName} % | ${rightName} % | Delta | ${leftName}-only | ${rightName}-only | ${leftName} uncovered | ${rightName} uncovered |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const row of files) {
    const leftOnly = row[`only${capitalize(leftName)}`].length;
    const rightOnly = row[`only${capitalize(rightName)}`].length;
    const leftUncovered = row[`${leftName}Uncovered`].length;
    const rightUncovered = row[`${rightName}Uncovered`].length;
    md += `| ${row.file} | ${row[`${leftName}Pct`]}% | ${row[`${rightName}Pct`]}% | ${row.pctDelta} | ${leftOnly} | ${rightOnly} | ${leftUncovered} | ${rightUncovered} |\n`;
  }
  md += `\n## Line Detail\n\n`;
  for (const row of files) {
    const leftOnly = row[`only${capitalize(leftName)}`];
    const rightOnly = row[`only${capitalize(rightName)}`];
    if (!leftOnly.length && !rightOnly.length) continue;
    md += `- \`${row.file}\`\n`;
    if (leftOnly.length) md += `  - ${leftName} only: ${compactRanges(leftOnly)}\n`;
    if (rightOnly.length) md += `  - ${rightName} only: ${compactRanges(rightOnly)}\n`;
  }
  md += `\n## Uncovered By Group\n\n`;
  for (const row of files) {
    const leftUncovered = row[`${leftName}Uncovered`];
    const rightUncovered = row[`${rightName}Uncovered`];
    if (!leftUncovered.length && !rightUncovered.length) continue;
    md += `- \`${row.file}\`\n`;
    md += `  - ${leftName} uncovered: ${leftUncovered.length ? compactRanges(leftUncovered) : 'none'}\n`;
    md += `  - ${rightName} uncovered: ${rightUncovered.length ? compactRanges(rightUncovered) : 'none'}\n`;
  }
  fs.writeFileSync(path.join(dir, `${leftName}-vs-${rightName}.md`), md, 'utf-8');
  return summary;
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
      // Oranges that would auto-correct to lightGreen (single matchedRef);
      // mirrors isOrangeAutoCorrectable. Lets orange fixtures assert which
      // oranges are correctable without running the correction.
      autoCorrectableOranges: src.filter(
        m => (m.color || m.category) === 'orange' && !(Array.isArray(m.matchedRefs) && m.matchedRefs.length > 1)
      ).length,
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
  // autoCorrectableOranges: optional — checked only when the fixture declares it
  // (so pre-existing orange fixtures without the key aren't retro-failed).
  if ('autoCorrectableOranges' in es) {
    if ((os.autoCorrectableOranges || 0) !== es.autoCorrectableOranges)
      diffs.push(`  stat autoCorrectableOranges: expected ${es.autoCorrectableOranges}, got ${os.autoCorrectableOranges || 0}`);
  }
  // Match-level check only when the fixture declares a `matches` array. Stats-
  // only fixtures (omit `matches`) validate counts alone — the lightweight form
  // used when bulk-converting verified pages from their console [stats] line.
  if (expected.matches !== undefined) {
    const ok = (arr) => new Set((arr || []).map(m => m.text + ' ' + m.color));
    const obs = ok(observed.matches), exp = ok(expected.matches);
    for (const k of exp) if (!obs.has(k)) diffs.push(`  MISSING [${k.split(' ')[1]}]: ${k.split(' ')[0].slice(0, 60)}`);
    for (const k of obs) if (!exp.has(k)) diffs.push(`  EXTRA   [${k.split(' ')[1]}]: ${k.split(' ')[0].slice(0, 60)}`);
  }
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

// Diagnostic: call the by-ref verifier directly (bypasses candidate extraction)
// so we can probe classification of a given text + cited reference at a chosen
// confidence. Used to verify the orange medium-confidence path (review #2).
async function verifyRefProbe(context, text, ref, conf) {
  const page = await context.newPage();
  const runnerHtml = buildRunnerHtml('<p>تهيئة</p>', {});
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/runner' || url.pathname === '/runner.html') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: runnerHtml });
    }
    const filePath = path.join(PROJECT_DIR, url.pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(PROJECT_DIR) || !fs.existsSync(filePath)) return route.fulfill({ status: 404, body: 'not found' });
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.js' ? 'application/javascript' : ext === '.json' ? 'application/json' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(filePath) });
  });
  try {
    await page.goto(`${ORIGIN}/runner`, { waitUntil: 'load', timeout: 20000 });
    return await page.evaluate(async ({ text, ref, conf }) => {
      if (typeof window.__quranRunScan === 'function') { try { await window.__quranRunScan(); } catch (_) {} }
      if (typeof verifyFragmentByRef !== 'function') return { error: 'verifyFragmentByRef is not a global' };
      const r = verifyFragmentByRef(text, ref, conf, true);
      return { color: r.color, matchedRef: r.matchedRef, claimedRef: r.claimedRef, matchType: r.matchType, trace: r._trace };
    }, { text, ref, conf });
  } finally {
    await page.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const verifyIdx = argv.indexOf('--verify-ref');
  const verifyText = verifyIdx !== -1 ? argv[verifyIdx + 1] : null;
  const verifyRef = verifyIdx !== -1 ? argv[verifyIdx + 2] : null;
  const verifyConf = verifyIdx !== -1 ? (argv[verifyIdx + 3] || 'medium') : null;
  const all = argv.includes('--all');
  const writeObserved = argv.includes('--write-observed');
  const coverage = argv.includes('--coverage');
  const coverageDiff = argv.includes('--coverage-diff') || argv.includes('--coverage-pages-vs-synthetic');
  const coverageDriverMode = argv.includes('--coverage-driver-off') ? 'off'
    : argv.includes('--coverage-driver-lite') ? 'lite'
    : 'full';
  const coverageFaults = argv.includes('--coverage-faults');
  const covAccum = coverage ? [] : null;
  // Per-fixture driver selection. A fixture opts into the heavy extended/fault
  // drivers via `_coverage: { extended, faults }` in its expected.json, so the
  // expensive paths stay pinned to a couple of fixtures regardless of renames.
  // --coverage-driver-lite forces base-only everywhere; --coverage-driver-off
  // disables the driver; --coverage-faults is required for any fault injection.
  const coverageOptsFor = (fx) => {
    if (coverageDriverMode === 'off') return { driver: 'off', faults: false };
    let extended = false, faults = false;
    try {
      const exp = JSON.parse(fs.readFileSync(fx.replace(/\.html$/, '.expected.json'), 'utf-8'));
      if (exp && exp._coverage) { extended = !!exp._coverage.extended; faults = !!exp._coverage.faults; }
    } catch (_) {}
    if (coverageDriverMode === 'lite') extended = false;
    return { driver: extended ? 'extended' : 'base', faults: coverageFaults && faults };
  };
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
    if (verifyText && verifyRef) {
      const r = await verifyRefProbe(context, verifyText, verifyRef, verifyConf);
      console.log(JSON.stringify(r, null, 2));
    } else if (textSnippet) {
      const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"></head><body><p>${textSnippet}</p></body></html>`;
      const r = await runOne(context, html, '--text', {});
      console.log(JSON.stringify(r, null, 2));
    } else {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.html') ? [path.join(d, e.name)] : []));
      const runFixtureSet = async (files, accum) => {
        let setPassed = 0, setTotal = 0;
        for (const fx of files) {
          const rel = path.relative(FIXTURES_DIR, fx).replace(/\\/g, '/');
          const label = rel.replace(/\.html$/, '');
          const html = fs.readFileSync(fx, 'utf-8');
          const observed = await runOne(context, html, label, {}, accum, coverageOptsFor(fx));
          if (writeObserved) {
            fs.writeFileSync(fx.replace(/\.html$/, '.observed.json'), JSON.stringify(observed, null, 2), 'utf-8');
          }
          const expPath = fx.replace(/\.html$/, '.expected.json');
          if (!fs.existsSync(expPath)) {
            console.log(`[${label}] REVIEW (no expected) - ${statLine(observed)}`);
            continue;
          }
          const expected = JSON.parse(fs.readFileSync(expPath, 'utf-8'));
          if (expected._skip) { console.log(`[${label}] SKIP - ${statLine(observed)}`); continue; }
          setTotal++;
          const cmp = compare(observed, expected);
          if (cmp.passed) { setPassed++; console.log(`[${label}] PASS`); }
          else { console.log(`[${label}] FAIL`); cmp.diffs.forEach(d => console.log(d)); }
        }
        return { passed: setPassed, total: setTotal };
      };
      if (coverageDiff) {
        const groups = [
          { name: 'pages', files: walk(path.join(FIXTURES_DIR, 'pages')), cov: [] },
          { name: 'synthetic', files: walk(path.join(FIXTURES_DIR, 'synthetic')), cov: [] },
        ];
        for (const group of groups) {
          console.log(`\n[coverage-diff] Running ${group.name} fixtures (${group.files.length})`);
          const r = await runFixtureSet(group.files, group.cov);
          passed += r.passed; total += r.total;
          console.log(`[coverage-diff] ${group.name}: ${r.passed}/${r.total} passed`);
        }
        const summary = writeCoverageDiff(
          aggregateCoverage(groups[0].cov),
          aggregateCoverage(groups[1].cov),
          groups[0].name,
          groups[1].name
        );
        console.log(`\nResults: ${passed}/${total} passed`);
        console.log(`Coverage diff: pages ${summary.groups.pages.overallLinePct}% vs synthetic ${summary.groups.synthetic.overallLinePct}% (${summary.overallPctDelta} pts) -> tests/coverage/pages-vs-synthetic.md`);
        return;
      }
      // --all walks fixtures/; a path arg may be a single .html OR a directory
      // (e.g. tests/fixtures/pages) which is walked recursively.
      const files = all
        ? walk(FIXTURES_DIR)
        : fixtureArg
          ? (fs.statSync(path.resolve(fixtureArg)).isDirectory() ? walk(path.resolve(fixtureArg)) : [path.resolve(fixtureArg)])
          : [];
      if (files.length === 0) { console.error('Usage: node tests/run_tests_node.js [--all | <fixture.html> | --text "…"]'); process.exit(1); }
      for (const fx of files) {
        const label = path.basename(fx, '.html');
        const html = fs.readFileSync(fx, 'utf-8');
        const observed = await runOne(context, html, label, {}, covAccum, coverageOptsFor(fx));
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
        const flags = ['--all', '--coverage'];
        if (coverageDriverMode !== 'full') flags.push(`--coverage-driver-${coverageDriverMode}`);
        if (coverageFaults) flags.push('--coverage-faults');
        const { overall } = writeCoverage(files, `node tests/run_tests_node.js ${flags.join(' ')}`);
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
