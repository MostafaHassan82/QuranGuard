'use strict';
// content.js is loaded alongside js/shared/messaging.js (listed first in manifest).
// QuranMsg global is therefore available.

// ── Module state ──────────────────────────────────────────────────────────────
const STATE = {
  scanning: false,
  scanId: null,
  findings: [],
  highlightedSpans: [],
  capHit: false,
  capLifted: false,
  languageDetected: null,
  mutationObserver: null,
  mutationDebounceTimer: null,
  // Cache of the active prefs.v1; refreshed at startup and on PREFS_CHANGED.
  // Used by the authentic-text swap (T060) and any other code that needs to
  // gate behavior on user preferences without an extra round-trip per call.
  prefs: null,
};

// T060 — load prefs once at startup so applySwap is ready when the first
// finding lands. PREFS_CHANGED handler later keeps this cache in sync.
(async function loadInitialPrefs() {
  try {
    const resp = await QuranMsg.sendRequest('PREFS_READ', {});
    STATE.prefs = resp?.payload?.result || null;
  } catch (_) { /* keep STATE.prefs null; gates will short-circuit safely */ }
})();

// T059 — register @font-face rules for all three Quran fonts on every page
// the content script runs on. Idempotent; safe to call before document.head
// exists (the function defers to document.documentElement).
if (typeof QuranFonts !== 'undefined') QuranFonts.ensureLoaded();

function makeEmptyStats() {
  return {
    candidatesExtracted: 0,
    candidatesDroppedSilently: 0,
    verifierCallsByStrategy: { exact: 0, tashkeelDriftOnly: 0, spellingDrift: 0, wordLevel: 0, skeletonOnly: 0, none: 0 },
    swapApplied: 0,
    swapSkippedRed: 0,
    mutationsObserved: 0,
    mutationRescans: 0,
    rescanAllInvocations: 0,
  };
}
let STATS = makeEmptyStats();

const CSS_BY_COLOR = {
  green:     'quran-green',
  lightBlue: 'quran-lightblue',
  yellow:    'quran-yellow',
  orange:    'quran-orange',
  red:       'quran-red',
};
// Invisible placeholder class used during intermediate scan passes.
// Pending spans still fragment the DOM (driving convergence) but are not visible.
const PENDING_CLASS = 'quran-pending';
const ALL_HIGHLIGHT_CLASSES = [...Object.values(CSS_BY_COLOR), PENDING_CLASS];
const HIGHLIGHT_SELECTOR = ALL_HIGHLIGHT_CLASSES.map(c => '.' + c).join(', ');
// T065 — wrapper placed around the cited reference's on-page text so
// correct-in-place can find and replace it. Distinct from the highlight span.
const REF_MARKER_CLASS = 'quran-ref-marker';

// ── Window globals (T019) — per contracts/window-globals.md ──────────────────
window.__quranScan = null;      // set on SCAN_COMPLETE, null on SCAN_START
window.__quranStats = makeEmptyStats();
window.__quranMatches = [];

// ── Debug trace ───────────────────────────────────────────────────────────────
// Toggle in the page DevTools console:  __quranDebug(true)  then rescan.
// Bridged via a DOM event because content scripts run in an isolated world,
// so a `window.__quranDebug` defined here is NOT visible to the page console.
// A tiny shim is injected into the MAIN world that defines window.__quranDebug
// to dispatch the event below; we listen for it and flip the flag.
// All trace lines start with `[QD:` so you can grep/copy them as a block when
// pasting back a bug report. Stays off by default to keep the console clean.
let QURAN_DEBUG_TRACE = false;
document.addEventListener('__quranDebugSet', (e) => {
  QURAN_DEBUG_TRACE = !!(e && e.detail && e.detail.on);
  console.log(`[QD] debug trace ${QURAN_DEBUG_TRACE ? 'ON' : 'OFF'} — rescan to capture`);
});
// Inject via src= (web-accessible resource) instead of inline textContent so
// strict-CSP pages (e.g. islamweb.net) don't log a violation on every load.
try {
  const shim = document.createElement('script');
  shim.src = chrome.runtime.getURL('js/debug-bridge.js');
  shim.onload = () => shim.remove();
  (document.documentElement || document.head || document.body).appendChild(shim);
} catch (_) {
  // Fallback: window.__quranDebug remains defined on the isolated-world `window`
  // below, accessible via the DevTools console's context dropdown.
}
window.__quranDebug = function (on) {
  QURAN_DEBUG_TRACE = !!on;
  console.log(`[QD] debug trace ${QURAN_DEBUG_TRACE ? 'ON' : 'OFF'} — rescan to capture`);
};
function dbg(section, msg) {
  if (!QURAN_DEBUG_TRACE) return;
  console.log(`[QD:${section}] ${msg}`);
}
function dbgPreview(s, max = 80) {
  if (!s) return '';
  const flat = String(s).replace(/[\x00\n\r]/g, '·').replace(/\s+/g, ' ');
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

// ── Regex constants ───────────────────────────────────────────────────────────

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const LEAD_IN_PATTERNS = [
  'قال الله تعالى', 'قال تعالى', 'وقال تعالى', 'قال سبحانه وتعالى', 'قال سبحانه',
  'قوله تعالى', 'وقوله تعالى', 'قوله سبحانه', 'قوله عز وجل', 'وقوله عز وجل',
  'قال عز وجل', 'وقال عز وجل', 'قال جل وعلا', 'قال جل جلاله', 'يقول الله تعالى',
  'يقول تعالى', 'ويقول تعالى', 'يقول عز وجل', 'ويقول عز وجل',
  'يقول سبحانه وتعالى', 'ويقول سبحانه وتعالى',
  'يقول تبارك وتعالى', 'ويقول تبارك وتعالى',
  'يقول الله عز وجل', 'يقول جل وعلا',
  'وقوله الكريم', 'قوله الكريم', 'وقوله جل وعلا', 'قوله جل وعلا',
  'وقوله جل جلاله', 'قوله جل جلاله', 'وقوله سبحانه',
  'قال ربكم', 'في كتاب الله', 'في قوله تعالى',
  'فقوله تعالى', 'فقوله سبحانه', 'فقوله عز وجل', 'فقوله جل وعلا', 'فقوله الكريم',
  // ب-/ك-/ل-prefixed forms: "بقوله تعالى" (in His saying), "كقوله تعالى"
  // (as in His saying), "لقوله تعالى" (per His saying) — all standard
  // citation introducers used in Arabic Islamic writing.
  'بقوله تعالى', 'بقوله سبحانه', 'بقوله عز وجل', 'بقوله جل وعلا', 'بقوله الكريم', 'بقول الله تعالى',
  'كقوله تعالى', 'كقوله سبحانه', 'كقوله عز وجل', 'كقوله جل وعلا', 'كقول الله تعالى',
  'لقوله تعالى', 'لقوله سبحانه', 'لقوله عز وجل',
];
// Word-boundary guard: lead-in patterns must NOT be preceded by another Arabic letter,
// or they'd false-match substrings of unrelated words (e.g. قوله inside عقولهم — "their
// minds" — once produced a phantom candidate by triggering SECONDARY extraction).
// Arabic has no native \b; lookbehind on the AR_CHAR class plays the same role.
const LEAD_IN_BOUNDARY = '(?<![\\u0621-\\u063A\\u0641-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06FA-\\u06FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF])';
const LEAD_IN_RE = new RegExp(LEAD_IN_BOUNDARY + '(' + LEAD_IN_PATTERNS.map(escapeRe).join('|') + ')\\s*[:：]?\\s*', 'u');

// Secondary lead-ins — "what he said" (قوله/وقوله/فقوله without an explicit divine epithet).
// The referent is ambiguous: only treat as a Quran citation if a primary citation ended
// within SECONDARY_WINDOW chars before this pattern (chaining is allowed).
const SECONDARY_LEAD_IN_PATTERNS = [
  'وقوله', 'فقوله', 'قوله',
];
const SECONDARY_LEAD_IN_RE = new RegExp(LEAD_IN_BOUNDARY + '(' + SECONDARY_LEAD_IN_PATTERNS.map(escapeRe).join('|') + ')\\s*[:：]?\\s*', 'u');
const SECONDARY_WINDOW = 150;

const AR_CHAR = '[\\u0621-\\u063A\\u0641-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06FA-\\u06FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]';
// Tashkeel (harakat + superscript alef) that follow Arabic letters in vocalized text.
const AR_TASHKEEL = '[\\u064B-\\u065F\\u0670]';
// WS includes \x00 (text-node boundary in combined text) so brace/run matching crosses node boundaries.
// Common pattern: <font>{</font><font color=...>ayah text</font><font>}</font> — the { and } end up
// in different text nodes, with \x00 boundaries on either side of the inner Arabic.
const WS = '[\\s\\x00]';
const AR_RUN = `${AR_CHAR}${AR_TASHKEEL}*(?:${WS}*${AR_CHAR}${AR_TASHKEEL}*)*`;
// `.` and `…` are common excerpt markers inside braced ayahs (e.g.
// `{وسيق الذين كفروا...الكافرين}` shows "first part … last part" from one ayah).
// Without them in the separator class, BRACE_RE would fail to match the brace
// at all, and the backward-ref extractor would walk past it to grab an
// unrelated earlier brace.
const BRACE_INNER_SEP = `[*.…،,\\s\\x00]+`;
const BRACE_RE = new RegExp(
  '[{«\\[]' + WS + '*(' + AR_RUN + '(?:' + BRACE_INNER_SEP + AR_RUN + ')*)' + WS + '*[}»\\]]' +
  '|\\(' + WS + '*(' + AR_RUN + '(?:' + BRACE_INNER_SEP + AR_RUN + ')*)' + WS + '*\\)',
  'u'
);
const STRONG_BRACE_RE = new RegExp(
  '[{«\\[]' + WS + '*(' + AR_RUN + '(?:' + BRACE_INNER_SEP + AR_RUN + ')*)' + WS + '*[}»\\]]',
  'u'
);
// AR_CHAR_NAME includes tatweel U+0640 so surah names like يــس are matched.
const AR_CHAR_NAME = '[\\u0621-\\u063A\\u0640-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06FA-\\u06FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]';
// Opening bracket is optional so we also catch the common typo `Surah:N)` where
// the user dropped the opening paren (e.g. `{ayah} الواقعة:82) أي: ...`).
// The closing bracket remains required so the pattern still anchors on real
// citation punctuation rather than free-floating "word:number" text. Spurious
// surah-name captures (e.g. "بقوله:5)") are filtered downstream by
// QuranReferences.resolve(), which validates the captured name against the
// surah index — unknown names fall back to the no-ref verifier path.
const REF_RE = new RegExp(
  '[({«﴿\\[]?\\s*(' + AR_CHAR_NAME + '+(?:\\s+' + AR_CHAR_NAME + '+)*)\\s*[:：]\\s*' +
  '([\\d\\u0660-\\u0669\\u06F0-\\u06F9]+(?:\\s*[-–]\\s*[\\d\\u0660-\\u0669\\u06F0-\\u06F9]+)?(?:\\s*[،,]\\s*[\\d\\u0660-\\u0669\\u06F0-\\u06F9]+)*)' +
  '\\s*[.,]?\\s*[)}»﴾\\]]',
  'gu'
);

// ── Language detection (T025 / FR-029) ────────────────────────────────────────

function detectLanguage() {
  const lang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
  if (lang.startsWith('ar')) return 'ar';

  // Fallback: sample up to 2000 chars from body text
  const bodyText = (document.body?.innerText || '').slice(0, 2000);
  if (!bodyText) return 'unknown';
  const arChars = (bodyText.match(/[؀-ۿ]/g) || []).length;
  const totalChars = bodyText.replace(/\s/g, '').length || 1;
  return (arChars / totalChars) >= 0.3 ? 'ar' : 'unknown';
}

// ── DOM traversal ─────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','IFRAME','CODE','PRE','HEAD','TEXTAREA','INPUT','SELECT','BUTTON']);

function createTextWalker(root) {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(HIGHLIGHT_SELECTOR)) return NodeFilter.FILTER_REJECT;
      // Keep short non-whitespace text nodes — single chars like "{", "}", "*"
      // often sit in their own text nodes between inline elements (e.g.
      //   {<font>v88</font> * <font>v89</font>}) and are required for BRACE_RE
      // / verse-separator extraction to span across the elements.
      if (node.textContent.trim().length === 0) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}

// ── Virtual text builder ──────────────────────────────────────────────────────

const BOUNDARY = '\x00';

function buildVirtualText(textNodes) {
  let combined = '';
  const map = [];
  for (let ni = 0; ni < textNodes.length; ni++) {
    const t = textNodes[ni].textContent;
    for (let ci = 0; ci < t.length; ci++) { map.push({ ni, ci }); combined += t[ci]; }
    combined += BOUNDARY;
    map.push({ ni, ci: t.length });
  }
  return { combined, map };
}

// T018 — getMutatedSubtreeText for incremental rescan.
function getMutatedSubtreeText(rootNode) {
  const walker = createTextWalker(rootNode);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);
  return { textNodes, ...buildVirtualText(textNodes) };
}

function resolveRange(start, end, textNodes, map) {
  const startInfo = map[start];
  const endInfo = map[Math.max(start, end - 1)];
  if (!startInfo || !endInfo) return null;
  const startNi = startInfo.ni, endNi = endInfo.ni;
  const startCi = startInfo.ci, endCi = endInfo.ci + 1;
  const nodes = textNodes.slice(startNi, endNi + 1);
  if (nodes.length === 0) return null;
  let extractedText;
  if (nodes.length === 1) {
    extractedText = nodes[0].textContent.slice(startCi, endCi);
  } else {
    const parts = [nodes[0].textContent.slice(startCi)];
    for (let i = 1; i < nodes.length - 1; i++) parts.push(nodes[i].textContent);
    parts.push(nodes[nodes.length - 1].textContent.slice(0, endCi));
    extractedText = parts.join('');
  }
  return { nodes, startOffset: startCi, endOffset: endNi === startNi ? endCi : endInfo.ci + 1, text: extractedText };
}

// ── Extraction strategies ─────────────────────────────────────────────────────

function braceContent(m) {
  // \x00 (text-node boundary) can appear inside captured Arabic spans when the ayah text
  // is split across inline tags. Normalize to space so the verifier sees clean text.
  return (m[1] ?? m[2] ?? '').replace(/\x00/g, ' ').replace(/\s+/g, ' ').trim();
}

// Find the first REF_RE match in `tail`, but only claim it if no OTHER opening
// brace ({, «, [) sits between the start of `tail` and the ref. A ref behind
// another brace belongs to that other brace, not to ours — without this guard
// a paragraph like `{cite A} … {cite B} (ref)` would mis-attribute (ref) to A.
function nearestOwnedRef(tail) {
  const refMatch = new RegExp(REF_RE.source, 'u').exec(tail);
  if (!refMatch) return null;
  const gap = tail.slice(0, refMatch.index);
  if (/[{«\[]/.test(gap)) return null;
  return refMatch[0];
}

// Max gap (in combined-chars) between a lead-in's end and the opening brace it
// claims as its citation. Real citations have at most ~15-30 chars (a colon +
// whitespace + maybe \x00 text-node boundaries). Beyond that, the lead-in's
// actual citation is missing (e.g. on a related-articles tile heading) and
// the next brace in the window typically belongs to unrelated content
// (sidebar links, footer parentheticals). Without this cap the 1000-char
// content window let lead-ins reach far across the page and mis-claim e.g.
// related-article tile parens as citations.
const LEAD_IN_BRACE_MAX_GAP = 80;

function extractLeadInBraced(combined, map, textNodes) {
  const candidates = [];
  const leadRe = new RegExp(LEAD_IN_RE.source, 'gu');
  let lm;
  while ((lm = leadRe.exec(combined)) !== null) {
    const afterLead = lm.index + lm[0].length;
    // Window must comfortably hold the longest Quran ayah with tashkeel + braces.
    // Long ayahs (e.g. الحج:18) exceed 500 chars vocalized; use 1000 to cover ranges too.
    const window = combined.slice(afterLead, afterLead + 1000);
    const bm = BRACE_RE.exec(window);
    if (!bm) continue;
    if (bm.index > LEAD_IN_BRACE_MAX_GAP) continue; // brace too far from lead-in
    // Parens (vs strong braces {…}/«…»/[…]) are weak citation signals — they're
    // also used for asides, emphasis, definitions. Require either a trailing ref
    // OR a non-trivial word count to count a paren as a citation. Strong braces
    // skip this gate (they're the standard Quran-quotation form).
    const isParen = !!bm[2];
    const braceStart = afterLead + bm.index;
    const braceEnd = braceStart + bm[0].length;
    const rawInner = bm[1] ?? bm[2] ?? '';
    const text = braceContent(bm);
    if (!text || text.length < 4) continue;
    const afterBrace = combined.slice(braceEnd, braceEnd + 80);
    const ref = nearestOwnedRef(afterBrace);
    const innerStart = braceStart + bm[0].indexOf(rawInner);
    // Use RAW captured length so the DOM range covers the full inner span.
    // braceContent() strips \x00 / collapses whitespace, so text.length is SHORTER
    // than rawInner.length — using text.length would cut off final chars.
    const innerEnd = innerStart + rawInner.length;
    const resolved = resolveRange(innerStart, innerEnd, textNodes, map);
    if (!resolved) continue;
    candidates.push({ ...resolved, ref, strategy: 'leadInBraced', confidence: 'high', charStart: innerStart, charEnd: innerEnd });
  }
  return candidates;
}

// primaryEnds: char positions where primary citations ended (text span end or ref bracket end).
// A secondary lead-in at position P fires only if some end in primaryEnds satisfies
// 0 <= P - end <= SECONDARY_WINDOW. Each new secondary match extends primaryEnds,
// allowing chains: قوله … وقوله … وقوله all within 150 chars of each predecessor.
function extractSecondaryLeadInBraced(combined, map, textNodes, primaryEnds) {
  const candidates = [];
  if (primaryEnds.length === 0) return candidates;
  const secRe = new RegExp(SECONDARY_LEAD_IN_RE.source, 'gu');
  let lm;
  while ((lm = secRe.exec(combined)) !== null) {
    const leadStart = lm.index;
    if (!primaryEnds.some(end => leadStart - end >= 0 && leadStart - end <= SECONDARY_WINDOW)) continue;
    const afterLead = leadStart + lm[0].length;
    const fwd = combined.slice(afterLead, afterLead + 1000);
    const bm = BRACE_RE.exec(fwd);
    if (!bm) continue;
    if (bm.index > LEAD_IN_BRACE_MAX_GAP) continue; // brace too far from lead-in (same cap as primary)
    const braceStart = afterLead + bm.index;
    const braceEnd = braceStart + bm[0].length;
    const rawInner = bm[1] ?? bm[2] ?? '';
    const text = braceContent(bm);
    if (!text || text.length < 4) continue;
    const afterBrace = combined.slice(braceEnd, braceEnd + 80);
    const ref = nearestOwnedRef(afterBrace);
    // Single-word brace after a SECONDARY lead-in without a trailing ref is the
    // "discussing a word" pattern, e.g. `قوله {شريك} أي: مشارك ...` — not a citation.
    // Real ayahs are sentences. If a ref follows, the ref signal is enough to proceed.
    if (!ref && text.split(/\s+/).filter(Boolean).length < 2) continue;
    const innerStart = braceStart + bm[0].indexOf(rawInner);
    // Use raw capture length (see extractLeadInBraced comment).
    const innerEnd = innerStart + rawInner.length;
    const resolved = resolveRange(innerStart, innerEnd, textNodes, map);
    if (!resolved) continue;
    candidates.push({ ...resolved, ref, strategy: 'secondaryLeadInBraced', confidence: 'high', charStart: innerStart, charEnd: innerEnd });
    // This match is itself an anchor for subsequent secondary patterns.
    primaryEnds.push(ref ? braceEnd + afterBrace.indexOf(ref) + ref.length : braceEnd);
  }
  return candidates;
}

function extractExplicitRefBackward(combined, map, textNodes, alreadyCovered, primaryEnds = [], claimedRefs = new Set()) {
  const candidates = [];
  const refRe = new RegExp(REF_RE.source, 'gu');
  let rm;
  while ((rm = refRe.exec(combined)) !== null) {
    STATS.candidatesExtracted++;
    const refStart = rm.index;
    // Skip refs already claimed by an earlier extractor (typically extractLeadInBraced).
    // Without this, the backward lead-in fallback would re-extract the same ref's text
    // (often grabbing explanatory prose between the lead-in and the actual braced ayah).
    if (claimedRefs.has(refStart)) continue;
    if (alreadyCovered.some(([s, e]) => refStart >= s && refStart < e)) continue;
    const isMetaList = /الآيات\s*\d/.test(rm[0]) || ((rm[2] || '').match(/[،,]/g) || []).length >= 2;
    if (isMetaList) continue;
    // Windows sized to cover the longest fully-vocalized Quran ayah (~500-800 chars with tashkeel).
    const BACK_WINDOW = 1200;
    const BRACE_NEAR = 1000;     // brace-before-ref search window
    const LEAD_SLICE = 1000;     // lead-in backward search window
    const MAX_AYAH_LEN = 900;    // length cap for extracted ayah text
    const rawBackStart = Math.max(0, refStart - BACK_WINDOW);
    const rawBackWindow = combined.slice(rawBackStart, refStart);
    let lastBreakEnd = -1;
    const paraRe = /\x00{2,}|[\r\n]{2,}/g;
    let pm;
    while ((pm = paraRe.exec(rawBackWindow)) !== null) lastBreakEnd = pm.index + pm[0].length;
    const backStart = lastBreakEnd !== -1 ? rawBackStart + lastBreakEnd : rawBackStart;
    const backWindow = combined.slice(backStart, refStart);
    let text = null, innerStart = null, innerEnd = null, confidence = 'medium';
    let matchedPrimary = false;
    const nearSlice = backWindow.slice(Math.max(0, backWindow.length - BRACE_NEAR));
    const nearOffset = backWindow.length - Math.min(BRACE_NEAR, backWindow.length);
    const bmGlobal = new RegExp(BRACE_RE.source, 'gu');
    let lastBm = null, bmTmp;
    while ((bmTmp = bmGlobal.exec(nearSlice)) !== null) lastBm = bmTmp;
    if (lastBm) {
      const content = braceContent(lastBm);
      if (content && content.length >= 4) {
        // Use RAW captured length, not cleaned text.length — braceContent collapses
        // \x00 boundaries and adjacent whitespace, so text.length is shorter than the
        // span actually occupied in `combined`. Underestimating innerEnd truncates the
        // candidate (e.g. trailing letters get clipped on {<font>v</font> * <font>v'</font>}
        // patterns where the inner separator collapses 2 spaces). Mirrors the comment
        // in extractLeadInBraced.
        const rawInner = lastBm[1] ?? lastBm[2] ?? '';
        text = content;
        const rawStart = backStart + nearOffset + lastBm.index + lastBm[0].indexOf(rawInner);
        innerStart = rawStart; innerEnd = rawStart + rawInner.length; confidence = 'high';
      }
    }
    // Lead-in fallback: pick the CLOSEST lead-in to the ref (not just the closest primary).
    // Without this, a far-back primary `قوله تعالى:` from an earlier paragraph would beat a
    // SECONDARY `وقوله:` that's right next to the ref, and the wrong (earlier) ayah text
    // would be extracted.
    if (!text) {
      const leadSlice = backWindow.slice(Math.max(0, backWindow.length - LEAD_SLICE));
      const leadOffset = backWindow.length - Math.min(LEAD_SLICE, backWindow.length);

      // Last PRIMARY match in window
      let lastPrim = null;
      const primGlobal = new RegExp(LEAD_IN_RE.source, 'gu');
      let pm; while ((pm = primGlobal.exec(leadSlice)) !== null) lastPrim = pm;

      // Last SECONDARY match in window, gated on a recent primary citation end
      let lastSec = null;
      const secGlobal = new RegExp(SECONDARY_LEAD_IN_RE.source, 'gu');
      let sm; while ((sm = secGlobal.exec(leadSlice)) !== null) {
        const secAbsStart = backStart + leadOffset + sm.index;
        if (primaryEnds.some(end => secAbsStart - end >= 0 && secAbsStart - end <= SECONDARY_WINDOW)) {
          lastSec = sm;
        }
      }

      // Pick whichever lead-in is CLOSEST to the ref (latest position wins).
      let chosen = null, chosenKind = null;
      if (lastPrim && (!lastSec || lastPrim.index >= lastSec.index)) { chosen = lastPrim; chosenKind = 'primary'; }
      else if (lastSec) { chosen = lastSec; chosenKind = 'secondary'; }

      if (chosen) {
        const leadEndInSlice = chosen.index + chosen[0].length;
        const between = leadSlice.slice(leadEndInSlice).replace(/[\x00{«»}()]/g, ' ');
        const arabicMatch = new RegExp('^\\s*(' + AR_RUN + ')', 'u').exec(between);
        if (arabicMatch) {
          const extracted = arabicMatch[1].trim();
          if (extracted.length >= 8 && extracted.length <= MAX_AYAH_LEN) {
            const leadEndAbs = backStart + leadOffset + leadEndInSlice;
            innerStart = leadEndAbs + between.indexOf(arabicMatch[1]);
            innerEnd = innerStart + extracted.length;
            text = extracted; confidence = 'high';
            if (chosenKind === 'primary') matchedPrimary = true;
          }
        }
      }
    }
    if (!text) {
      const arRunRe = new RegExp(AR_RUN + '$', 'u');
      // Strip braces, parens, text-node boundary, and trailing punctuation so a final `.`
      // before `{ref}` doesn't block the end-anchored match.
      const arMatch = arRunRe.exec(backWindow.replace(/[{}«»()\x00.,،;]/g, ' '));
      if (arMatch && arMatch[0].trim().length >= 8 && arMatch[0].trim().length <= MAX_AYAH_LEN) {
        const matchStart = backStart + arMatch.index;
        text = arMatch[0].trim(); innerStart = matchStart; innerEnd = matchStart + text.length; confidence = 'medium';
      }
    }
    if (!text || text.length < 4) continue;
    if (alreadyCovered.some(([s, e]) => innerStart < e && innerEnd > s)) continue;
    const resolved = resolveRange(innerStart, innerEnd, textNodes, map);
    if (!resolved) continue;
    candidates.push({ ...resolved, ref: rm[0], strategy: 'explicitRefBackward', confidence, charStart: innerStart, charEnd: innerEnd });
    alreadyCovered.push([innerStart, innerEnd]);
    // If this citation used a primary lead-in (or the brace path), it acts as an anchor
    // for subsequent secondary lead-ins. Push the ref-bracket end into primaryEnds.
    if (matchedPrimary || confidence === 'high') {
      primaryEnds.push(rm.index + rm[0].length);
    }
  }
  return candidates;
}

function extractRangeConstruct(combined, map, textNodes, alreadyCovered) {
  const candidates = [];
  const rangeSepRe = /\s+إلى\s+قوله\s*[:：]?\s*/gu;
  let sm;
  while ((sm = rangeSepRe.exec(combined)) !== null) {
    const sepStart = sm.index, sepEnd = sepStart + sm[0].length;
    const backWin = combined.slice(Math.max(0, sepStart - 150), sepStart);
    const bm1 = STRONG_BRACE_RE.exec(backWin);
    const fwdWin = combined.slice(sepEnd, sepEnd + 150);
    const bm2 = STRONG_BRACE_RE.exec(fwdWin);
    if (!bm1 || !bm2) continue;
    // If brace1 already has its own ref before the "إلى قوله" separator, this
    // isn't a true range — it's two independent citations the author narrated
    // as "from X … to Y". Skip; explicitRefBackward / leadInBraced will pair
    // each brace with its correct ref. Without this, the range extractor steals
    // brace2's ref and slaps it onto brace1, producing a wrong claimedRef.
    const between = backWin.slice(bm1.index + bm1[0].length);
    if (new RegExp(REF_RE.source, 'u').test(between)) continue;
    const text1 = braceContent(bm1), text2 = braceContent(bm2);
    if (!text1 || text1.length < 4 || !text2 || text2.length < 4) continue;
    const rawInner1 = bm1[1] ?? bm1[2] ?? '';
    const rawInner2 = bm2[1] ?? bm2[2] ?? '';
    const afterBrace2 = combined.slice(sepEnd + fwdWin.indexOf(bm2[0]) + bm2[0].length, sepEnd + 250);
    const refMatch = new RegExp(REF_RE.source, 'u').exec(afterBrace2);
    const ref = refMatch ? refMatch[0] : null;
    const backOffset = Math.max(0, sepStart - 150);
    const innerStart1 = backOffset + backWin.indexOf(bm1[0]) + bm1[0].indexOf(rawInner1);
    const innerEnd1 = innerStart1 + rawInner1.length;
    const r1 = resolveRange(innerStart1, innerEnd1, textNodes, map);
    if (r1 && !alreadyCovered.some(([s, e]) => innerStart1 < e && innerEnd1 > s)) {
      candidates.push({ ...r1, ref, strategy: 'rangeConstruct', confidence: 'high', charStart: innerStart1, charEnd: innerEnd1 });
      alreadyCovered.push([innerStart1, innerEnd1]);
    }
    const innerStart2 = sepEnd + fwdWin.indexOf(bm2[0]) + bm2[0].indexOf(rawInner2);
    const innerEnd2 = innerStart2 + rawInner2.length;
    const r2 = resolveRange(innerStart2, innerEnd2, textNodes, map);
    if (r2 && !alreadyCovered.some(([s, e]) => innerStart2 < e && innerEnd2 > s)) {
      candidates.push({ ...r2, ref, strategy: 'rangeConstruct', confidence: 'high', charStart: innerStart2, charEnd: innerEnd2 });
      alreadyCovered.push([innerStart2, innerEnd2]);
    }
  }
  return candidates;
}

function extractShortFragmentWithRef(combined, map, textNodes, alreadyCovered) {
  const candidates = [];
  const refRe = new RegExp(REF_RE.source, 'gu');
  let rm;
  while ((rm = refRe.exec(combined)) !== null) {
    const refStart = rm.index;
    if (alreadyCovered.some(([s, e]) => refStart >= s && refStart < e)) continue;
    const backWin = combined.slice(Math.max(0, refStart - 80), refStart);
    const shortRe = new RegExp(AR_RUN + '$', 'u');
    const sm = shortRe.exec(backWin.replace(/[{}«»()\x00]/g, ' '));
    if (!sm) continue;
    const text = sm[0].trim();
    if (text.length < 8 || text.length > 65) continue;
    const innerStart = Math.max(0, refStart - 80) + sm.index;
    const innerEnd = innerStart + text.length;
    if (alreadyCovered.some(([s, e]) => innerStart < e && innerEnd > s)) continue;
    const resolved = resolveRange(innerStart, innerEnd, textNodes, map);
    if (!resolved) continue;
    candidates.push({ ...resolved, ref: rm[0], strategy: 'shortFragmentRef', confidence: 'medium', charStart: innerStart, charEnd: innerEnd });
    alreadyCovered.push([innerStart, innerEnd]);
  }
  return candidates;
}

// Brace-only citation: {Arabic text} with neither a lead-in before nor a ref bracket after.
// The brace itself is a strong "this is a quotation" signal; the verifier decides whether
// the text actually matches a Quran ayah (lightBlue) or not (drops silently).
// Runs LAST so genuine lead-in / ref-bracket citations win position-based dedup.
function extractBracedOnly(combined, map, textNodes, alreadyCovered) {
  const candidates = [];
  // Strong braces only: {…}, «…», […]. Skip (…) to avoid false-positives on parenthetical asides.
  const braceGlobal = new RegExp(STRONG_BRACE_RE.source, 'gu');
  let bm;
  while ((bm = braceGlobal.exec(combined)) !== null) {
    const braceStart = bm.index;
    const braceEnd = braceStart + bm[0].length;
    if (alreadyCovered.some(([s, e]) => braceStart < e && braceEnd > s)) continue;
    const rawInner = bm[1] ?? '';
    const text = braceContent(bm);
    // Min length filters out incidental short braces; max keeps it bounded.
    if (!text || text.length < 8 || text.length > 900) continue;
    const innerStart = braceStart + bm[0].indexOf(rawInner);
    const innerEnd = innerStart + rawInner.length;
    if (alreadyCovered.some(([s, e]) => innerStart < e && innerEnd > s)) continue;
    const resolved = resolveRange(innerStart, innerEnd, textNodes, map);
    if (!resolved) continue;
    // No ref → verifier does a global lookup; returns lightBlue if found, null otherwise.
    candidates.push({ ...resolved, ref: null, strategy: 'bracedOnly', confidence: 'medium', charStart: innerStart, charEnd: innerEnd });
    alreadyCovered.push([innerStart, innerEnd]);
  }
  return candidates;
}

function runExtractionStrategies(textNodes, combined, map) {
  const covered = [];
  const s1 = extractLeadInBraced(combined, map, textNodes);
  for (const c of s1) covered.push([c.charStart, c.charEnd]);

  // Compute where each primary citation ends (after text span + ref bracket if present)
  // and which ref positions s1 already handled (so s2 doesn't re-extract the same refs).
  const primaryEnds = [];
  const claimedRefs = new Set();
  for (const c of s1) {
    if (c.ref) {
      const ri = combined.indexOf(c.ref, c.charEnd);
      if (ri !== -1 && ri - c.charEnd < 120) {
        primaryEnds.push(ri + c.ref.length);
        claimedRefs.add(ri);
        continue;
      }
    }
    primaryEnds.push(c.charEnd);
  }
  const s5 = extractSecondaryLeadInBraced(combined, map, textNodes, primaryEnds);
  for (const c of s5) {
    covered.push([c.charStart, c.charEnd]);
    if (c.ref) {
      const ri = combined.indexOf(c.ref, c.charEnd);
      if (ri !== -1 && ri - c.charEnd < 120) claimedRefs.add(ri);
    }
  }

  const s3 = extractRangeConstruct(combined, map, textNodes, covered);
  const s2 = extractExplicitRefBackward(combined, map, textNodes, covered, primaryEnds, claimedRefs);
  const s4 = extractShortFragmentWithRef(combined, map, textNodes, covered);
  const s6 = extractBracedOnly(combined, map, textNodes, covered);
  const all = [...s1, ...s5, ...s3, ...s2, ...s4, ...s6].sort((a, b) => a.charStart - b.charStart);
  const result = [];
  const finalCovered = [];
  for (const c of all) {
    if (finalCovered.some(([s, e]) => c.charStart >= s && c.charEnd <= e)) continue;
    result.push(c);
    finalCovered.push([c.charStart, c.charEnd]);
  }
  return result;
}

// ── Tooltip building ──────────────────────────────────────────────────────────

function canonicalRef(refString) {
  if (!refString) return '';
  return refString.replace(/^[\s({«\[﴿]+|[\s)}»\]﴾]+$/g, '').replace(/\s+/g, ' ').trim();
}

function buildTooltip(color, result) {
  switch (color) {
    case 'green': {
      let tip = result.matchedRef || '(تطابق)';
      const exact = result.allExactRefs || [];
      const partial = result.allPartialRefs || [];
      const otherExact = exact.filter(r => r !== result.matchedRef);
      if (otherExact.length > 0) tip += '\nيُوجد أيضاً في: ' + otherExact.join(' • ');
      if (partial.length > 0) tip += '\n(جزئي في: ' + partial.join(' • ') + ')';
      return tip;
    }
    case 'lightBlue': {
      const refs = result.matchedRefs && result.matchedRefs.length > 1 ? result.matchedRefs.join(' • ') : (result.matchedRef || '');
      return refs + '\n(لم يُذكر المرجع في الصفحة)';
    }
    case 'yellow': {
      const matched = result.matchedRef || '';
      const claimed = result.claimedRef || '';
      const refsDiffer = claimed && canonicalRef(claimed) !== canonicalRef(matched);
      const note = refsDiffer ? `\nمذكور كـ: ${claimed}\n(اختلاف لفظي + مرجع غير مطابق)` : '\n(اختلاف لفظي)';
      return matched + note;
    }
    case 'orange': return `مذكور كـ: ${result.claimedRef || '?'}\nالصواب: ${result.matchedRef || '?'}`;
    case 'red': return result.claimedRef
      ? `لم يُعثر على هذا النص في القرآن\nالمرجع المذكور: ${result.claimedRef}`
      : 'لم يُعثر على هذا النص في القرآن';
    default: return '';
  }
}

// ── DOM wrapping ──────────────────────────────────────────────────────────────

// Maps the 5 categories to the FR-005 human-readable category-name-in-words.
// Used by both the visual tooltip and the SR-only aria-describedby element so
// keyboard + assistive-tech users see the same lead text as sighted users.
const CATEGORY_LABEL_AR = {
  green:     'مطابق للقرآن مع المرجع',
  lightBlue: 'مطابق للقرآن — لم يُذكر المرجع',
  yellow:    'اختلاف لفظي',
  orange:    'مرجع غير مطابق',
  red:       'لم يُعثر عليه في القرآن',
};

// T037 helpers — composite finding ID. Synchronous (no Web Crypto) so the
// scan loop stays straightforward and doesn't introduce reentrancy hazards.
// FNV-1a 32-bit + length isn't cryptographic, but the spec's intent (a stable
// identifier per finding for FR-024 persistence) is satisfied: same composite
// string → same id, deterministic, no async surface area.
function normalizeForId(s) {
  if (!s) return '';
  return String(s)
    .replace(/[\s\x00]+/g, ' ')
    .replace(/[.,،;:()\[\]{}«»﴾﴿]/g, '')
    .trim();
}
function computeDomPath(node) {
  if (!node) return '';
  const parts = [];
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && el !== document.documentElement && parts.length < 12) {
    let idx = 0;
    let sib = el;
    while ((sib = sib.previousElementSibling) != null) if (sib.tagName === el.tagName) idx++;
    parts.unshift(`${el.tagName.toLowerCase()}[${idx}]`);
    el = el.parentElement;
  }
  return parts.join('/');
}
function fnv1a32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}
function computeCompositeFindingId(rawText, citedReference, matchedReference, domPath) {
  const composite = [
    normalizeForId(rawText),
    normalizeForId(citedReference || ''),
    matchedReference || '',
    domPath || '',
  ].join('|');
  // Length-suffixed FNV avoids collisions between same-prefix candidates.
  return fnv1a32(composite) + '-' + composite.length.toString(36);
}

function wrapTextNodes(nodes, startOffset, endOffset, cssClass, dataAttrs) {
  if (!nodes || nodes.length === 0) return null;
  try {
    const span = document.createElement('span');
    span.className = cssClass;
    for (const [k, v] of Object.entries(dataAttrs)) { if (v != null) span.dataset[k] = v; }
    // T034 — Keyboard focusable + role + aria-label for assistive tech.
    // aria-label is preferred over an appended SR-only child: no DOM mutation
    // risk, no chance of the label text being concatenated into the visible
    // span, no chance of the mutation observer / convergence loop seeing it.
    span.setAttribute('tabindex', '0');
    span.setAttribute('role', 'mark');
    const color = dataAttrs.color;
    if (color && CATEGORY_LABEL_AR[color]) {
      const tooltip = dataAttrs.tooltip || '';
      span.setAttribute('aria-label', CATEGORY_LABEL_AR[color] + (tooltip ? '. ' + tooltip : ''));
    }
    if (nodes.length === 1) {
      const node = nodes[0];
      const before = node.textContent.slice(0, startOffset);
      const middle = node.textContent.slice(startOffset, endOffset);
      const after = node.textContent.slice(endOffset);
      if (!middle) return null;
      const parent = node.parentNode;
      if (!parent) return null;
      const beforeNode = before ? document.createTextNode(before) : null;
      const afterNode = after ? document.createTextNode(after) : null;
      span.textContent = middle;
      parent.insertBefore(span, node);
      if (beforeNode) parent.insertBefore(beforeNode, span);
      if (afterNode) parent.insertBefore(afterNode, span.nextSibling);
      parent.removeChild(node);
    } else {
      const firstNode = nodes[0], lastNode = nodes[nodes.length - 1];
      const firstBefore = firstNode.textContent.slice(0, startOffset);
      const firstContent = firstNode.textContent.slice(startOffset);
      const lastContent = lastNode.textContent.slice(0, endOffset);
      const lastAfter = lastNode.textContent.slice(endOffset);
      const parent = firstNode.parentNode;
      if (!parent) return null;
      span.appendChild(document.createTextNode(firstContent));
      for (let i = 1; i < nodes.length - 1; i++) span.appendChild(nodes[i].cloneNode(true));
      if (nodes.length > 1) span.appendChild(document.createTextNode(lastContent));
      parent.insertBefore(span, firstNode);
      if (firstBefore) parent.insertBefore(document.createTextNode(firstBefore), span);
      if (lastAfter) parent.insertBefore(document.createTextNode(lastAfter), span.nextSibling);
      for (const n of nodes) { if (n.parentNode) n.parentNode.removeChild(n); }
    }
    return span;
  } catch (e) {
    console.warn('[QuranExt] wrapTextNodes error:', e);
    return null;
  }
}

// ── Highlight application ─────────────────────────────────────────────────────

function applyHighlight(candidate, result, { hidden = false } = {}) {
  const color = result.color;
  if (!color) return null;
  const cssClass = hidden ? PENDING_CLASS : CSS_BY_COLOR[color];
  if (!cssClass) return null;
  const tooltip = buildTooltip(color, result);
  // T037 — Composite finding ID derived from normalized rawText + citedRef +
  // matchedRef + domPath. Computed BEFORE wrapTextNodes mutates the DOM so
  // domPath references the original parent chain. Stable across re-scans of
  // the same page → enables FR-024 persisted corrections / dismissals to
  // survive a reload. FNV-1a (sync) instead of SHA-1 (async) avoids
  // reentrancy hazards in the convergence loop.
  const domPath = computeDomPath(candidate.nodes && candidate.nodes[0]);
  const findingId = computeCompositeFindingId(
    candidate.text, result.claimedRef, result.matchedRef, domPath
  );
  const dataAttrs = {
    tooltip, color, findingId,
    matchedRef: result.matchedRef || '',
    matchedRefs: (result.matchedRefs || []).join('|'),
    claimedRef: result.claimedRef || '',
    authenticText: result.authenticText || '',
    deviation: result.deviation || '',
    originalText: candidate.text,
    strategy: candidate.strategy,
  };
  const span = wrapTextNodes(candidate.nodes, candidate.startOffset, candidate.endOffset, cssClass, dataAttrs);
  if (span) {
    STATE.highlightedSpans.push(span);
    const finding = {
      id: findingId,
      category: color,
      rawText: candidate.text,
      domPath,
      citedReference: result.claimedRef || null,
      matchedReference: result.matchedRef || null,
      confidence: result.matchType || candidate.confidence,
      notes: {
        driftAccepted: result.deviation === 'tashkeelOnly' || result.deviation === 'spellingDrift',
        wordsMissing: 0, wordsAdded: 0, wordsSubstituted: 0,
        matchStrategy: result.matchType || 'none',
      },
      priorFindingId: null,
      persistedBadge: null,
      // Legacy fields (used by existing popup/debug code)
      color,
      text: candidate.text,
      claimedRef: result.claimedRef || null,
      matchedRef: result.matchedRef || null,
      matchedRefs: result.matchedRefs || [],
      authenticText: result.authenticText || null,
      // T058a — authentic wording for just the cited span (excerpt shape
      // preserved); swap.js prefers this over the full ayah.
      authenticExcerpt: result.authenticExcerpt || null,
      deviation: result.deviation,
      strategy: candidate.strategy,
      // T065 — exact on-page text of the cited reference (e.g. "(البقرة:3)").
      // Used to place the correct-in-place marker span by forward-search from
      // the ayah highlight, since the reference always follows the ayah text.
      refText: candidate.ref || null,
    };
    STATE.findings.push(finding);
    // T060 — authentic-text swap is DEFERRED to emitComplete (T058z). Running
    // applySwap here mutates page text mid-scan, which causes subsequent
    // convergence passes and the MutationObserver to operate on swapped text
    // instead of the page's original wording → category counts diverge.
  }
  return span;
}

function clearHighlights({ normalize = true } = {}) {
  // T065 — unwrap reference markers first so a re-scan starts from clean text
  // (otherwise the marker spans accumulate and fragment the reference text).
  // Restore the ORIGINAL cited reference for any marker that was corrected in
  // place, so a re-scan sees the page's original wording (matches a reload).
  for (const m of document.querySelectorAll('.' + REF_MARKER_CLASS)) {
    if (m.dataset.quranRefOrig != null) m.textContent = m.dataset.quranRefOrig;
    m.replaceWith(...m.childNodes);
  }
  const spans = document.querySelectorAll(HIGHLIGHT_SELECTOR);
  for (const span of spans) {
    // Revert authentic-text swaps before unwrapping. The swap engine stashes
    // the page's original text in data-quran-orig-text; without restoring it,
    // unwrapping would leave the swapped Quran text behind and the next scan
    // would re-extract authentic wording instead of the original citation.
    if (span.dataset.quranOrigText != null) span.textContent = span.dataset.quranOrigText;
    span.replaceWith(...span.childNodes);
  }
  // normalize=true (default, used for explicit user clear and before pass 1):
  //   merges the split text nodes so the next pass starts from a clean DOM.
  // normalize=false (used between scan passes 2/3):
  //   intentionally leaves the fragmented text nodes — the changed layout
  //   suppresses false-positive extractions that only appear on the pristine DOM.
  if (normalize) document.body.normalize();
  STATE.highlightedSpans = [];
  STATE.findings = [];
  STATE.capHit = false;
  STATE.capLifted = false;
  STATS = makeEmptyStats();
  window.__quranScan = null;
  window.__quranStats = makeEmptyStats();
  window.__quranMatches = [];
}

// Converts pending (hidden) spans to their real color classes after all passes finish.
function materializeHighlights() {
  const pending = document.querySelectorAll('.' + PENDING_CLASS);
  for (const span of pending) {
    const color = span.dataset.color;
    const realClass = CSS_BY_COLOR[color];
    if (realClass) {
      span.classList.remove(PENDING_CLASS);
      span.classList.add(realClass);
    }
  }
}

// ── Background messaging helpers ──────────────────────────────────────────────

function sendToBackground(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    } catch (e) { reject(e); }
  });
}

// ── Scan cap constants (T023) ─────────────────────────────────────────────────
const SCAN_CAP = 500;
// Safety ceiling for fresh full scans. Convergence is detected dynamically
// (stop when finding count is unchanged between passes); this cap prevents
// runaway loops on pathological pages.
const SCAN_SAFETY_MAX = 10;

// ── Main scan orchestrator (T017, T022, T023, T024, T025) ────────────────────

async function scanPage({ liftCap = false, subtreeRoot = null } = {}) {
  if (STATE.scanning) return;
  STATE.scanning = true;

  const scanId = QuranMsg.randomId();
  STATE.scanId = scanId;
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  // liftCap (continue after cap) and subtreeRoot (mutation rescan) are always single-pass.
  const isFreshFull = !liftCap && !subtreeRoot;
  const maxPasses = isFreshFull ? SCAN_SAFETY_MAX : 1;
  let prevCount = -1;

  // Language gate — only needs to run once.
  if (isFreshFull) {
    const lang = detectLanguage();
    STATE.languageDetected = lang;
    if (lang !== 'ar') {
      clearHighlights();
      STATE.scanning = false;
      const payload = {
        scanId, totalCount: 0, perCategoryCount: { green: 0, lightBlue: 0, yellow: 0, orange: 0, red: 0 },
        durationMs: Date.now() - startTime, languageDetected: lang, finalState: 'notArabic',
      };
      QuranMsg.emit('SCAN_COMPLETE', payload);
      updateWindowGlobals(scanId, startedAt, payload);
      return;
    }
  }

  for (let pass = 1; pass <= maxPasses; pass++) {
    // Fresh full scans: highlights are hidden (quran-pending) during every pass to
    // avoid visible flicker. materializeHighlights() reveals them after convergence.
    const useHidden = isFreshFull;

    if (isFreshFull) {
      // Pass 1: normalize to restore a clean DOM before scanning.
      // Passes 2+: skip normalize — the fragmentation from wrapping previous findings
      //   changes which extraction patterns fire, filtering false positives and
      //   revealing true positives that were occluded by other candidates.
      clearHighlights({ normalize: pass === 1 });
      STATE.findings = [];
      STATE.highlightedSpans = [];
      window.__quranScan = null;
      window.__quranMatches = [];
      if (pass === 1 && typeof QuranPanelSidebar !== 'undefined') {
        QuranPanelSidebar.reset();
        QuranPanelSidebar.clearUserClosed();
      }
    }

    STATE.capHit = false;
    STATE.capLifted = liftCap;
    STATS = makeEmptyStats();

    try {
      if (pass === 1) await sendToBackground({ type: 'ping' }).catch(() => {});

      const root = subtreeRoot || document.body;
      const walker = createTextWalker(root);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);

      if (textNodes.length === 0) break;

      const { combined, map } = buildVirtualText(textNodes);
      const candidates = runExtractionStrategies(textNodes, combined, map);
      STATS.candidatesExtracted = candidates.length;
      console.log(`[QuranExt] pass ${pass}: nodes=${textNodes.length} candidates=${candidates.length}`);

      if (QURAN_DEBUG_TRACE) {
        dbg('scan', `pass=${pass} nodes=${textNodes.length} combinedLen=${combined.length} candidates=${candidates.length}`);
        const byStrat = {};
        for (const c of candidates) byStrat[c.strategy] = (byStrat[c.strategy] || 0) + 1;
        for (const [s, n] of Object.entries(byStrat)) dbg('strat', `${s}: ${n}`);
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          dbg('cand', `#${i} [${c.strategy}/${c.confidence}] ref=${JSON.stringify(c.ref || null)} range=[${c.charStart}..${c.charEnd}] text="${dbgPreview(c.text, 100)}"`);
        }
      }

      const perCategoryCount = { green: 0, lightBlue: 0, yellow: 0, orange: 0, red: 0 };

      for (const candidate of candidates) {
        if (!liftCap && STATE.findings.length >= SCAN_CAP) {
          STATE.capHit = true;
          break;
        }

        try {
          const msg = candidate.ref
            ? { type: 'verifyFragmentByRef', text: candidate.text, ref: candidate.ref, candidateConfidence: candidate.confidence, debug: QURAN_DEBUG_TRACE }
            : { type: 'verifyFragment', text: candidate.text, candidateConfidence: candidate.confidence, debug: QURAN_DEBUG_TRACE };
          const result = await sendToBackground(msg);
          if (QURAN_DEBUG_TRACE) {
            const r = result || {};
            dbg('verify', `ref=${JSON.stringify(candidate.ref || null)} → color=${r.color ?? 'null'} matchedRef=${JSON.stringify(r.matchedRef || null)} deviation=${r.deviation || '-'} matchType=${r.matchType || '-'}`);
            if (Array.isArray(r._trace)) for (const t of r._trace) console.log(`[QD:bg] ${t}`);
          }
          if (result && !result.error && result.color) {
            const span = applyHighlight(candidate, result, { hidden: useHidden });
            if (span) {
              const finding = STATE.findings[STATE.findings.length - 1];
              if (finding && perCategoryCount[result.color] !== undefined) perCategoryCount[result.color]++;
              // Only emit live progress for single-pass scans (liftCap / mutation rescan).
              if (!useHidden) {
                QuranMsg.emit('SCAN_PROGRESS', { scanId, finding, runningCount: STATE.findings.length, perCategoryCount: { ...perCategoryCount } });
                window.__quranMatches = STATE.findings.slice();
              }
            }
          } else if (result?.color === null || result?.color === undefined) {
            STATS.candidatesDroppedSilently++;
          }
        } catch (e) {
          console.warn('[QuranExt] verification error:', candidate.text, e);
        }
      }

      // Converged? stop early. Otherwise record count and run another pass.
      const currentCount = STATE.findings.length;
      if (currentCount === prevCount) {
        console.log(`[QuranExt] stable at ${currentCount} after pass ${pass}, stopping`);
        break;
      }
      prevCount = currentCount;

    } catch (e) {
      console.error('[QuranExt] scan error (pass ' + pass + '):', e);
      break;
    }
  }

  // Reveal all hidden highlights at once — no flicker.
  if (isFreshFull) materializeHighlights();
  // Cap notification (after materialization so it fires with visible highlights).
  if (STATE.capHit) {
    const perCategoryCount = { green: 0, lightBlue: 0, yellow: 0, orange: 0, red: 0 };
    for (const f of STATE.findings) { if (perCategoryCount[f.category] !== undefined) perCategoryCount[f.category]++; }
    QuranMsg.emit('SCAN_CAP_HIT', { scanId, cap: SCAN_CAP, perCategoryCount });
  }

  emitComplete(scanId, startedAt, startTime);
  await sendToBackground({ type: 'logFindings', findings: STATE.findings }).catch(() => {});
}

function computeFinalState() {
  if (STATE.findings.length === 0) return 'empty';
  const hasDefect = STATE.findings.some(f => f.category !== 'green' && f.category !== 'lightBlue');
  return hasDefect ? 'defects' : 'clean';
}

function emitComplete(scanId, startedAt, startTime) {
  STATE.scanning = false;
  const durationMs = Math.round(Date.now() - startTime);
  const finalState = computeFinalState();
  const perCategoryCount = { green: 0, lightBlue: 0, yellow: 0, orange: 0, red: 0 };
  for (const f of STATE.findings) { if (perCategoryCount[f.category] !== undefined) perCategoryCount[f.category]++; }

  const payload = {
    scanId,
    totalCount: STATE.findings.length,
    perCategoryCount,
    durationMs,
    languageDetected: STATE.languageDetected || 'ar',
    finalState,
  };

  QuranMsg.emit('SCAN_COMPLETE', payload);
  updateWindowGlobals(scanId, startedAt, payload);

  // T058z — Apply authentic-text swap AFTER convergence. Doing this during
  // the scan loop corrupts subsequent passes because they re-walk swapped
  // text instead of the page's original wording. The observer is briefly
  // gated so the swap mutations don't trigger a phantom rescan.
  // The marker placement (T065) and swap both mutate the DOM; gate the observer
  // for the whole block so neither triggers a phantom rescan.
  STATE.swapInProgress = true;
  try {
    placeRefMarkers();
    if (typeof QuranSwap !== 'undefined' && STATE.prefs) {
      for (const f of STATE.findings) {
        try {
          if (QuranSwap.applySwap(f, STATE.prefs)) STATS.swapApplied++;
          else if (f.color === 'red') STATS.swapSkippedRed++;
        } catch (_) {}
      }
    }
  } finally {
    // Clear the flag on the next microtask so any synchronously-queued
    // mutation records from our own writes are still filtered out.
    setTimeout(() => { STATE.swapInProgress = false; }, 50);
  }

  // Mount the sidebar surface whenever the scan found something worth showing.
  // The sidebar is now the only panel surface (the popup is scan-only), so it
  // always mounts here — its initial collapsed/expanded state is restored from
  // chrome.storage.local inside mount() (FR-010, FR-027, FR-029).
  maybeMountSidebar(finalState).catch(() => {});
}

async function maybeMountSidebar(finalState) {
  if (typeof QuranPanelSidebar === 'undefined') return;
  if (finalState === 'empty' || finalState === 'notArabic') return;

  QuranPanelSidebar.reset();
  for (const f of STATE.findings) QuranPanelSidebar.upsert(f);
  // FR-024 — tag findings the user corrected/dismissed on a prior visit so the
  // sidebar shows the "صُحِّح سابقًا" badge (matched by the original finding id).
  try {
    const resp = await QuranMsg.sendRequest('PERSIST_READ', { urlKey: pageUrlKey() });
    const entries = resp?.payload?.result?.entries;
    if (entries) QuranPanelSidebar.tagPersisted(entries);
  } catch (_) {}
  await QuranPanelSidebar.mount();
}

function updateWindowGlobals(scanId, startedAt, payload) {
  window.__quranScan = {
    scanId,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: payload.durationMs,
    totalCount: payload.totalCount,
    perCategoryCount: payload.perCategoryCount,
    finalState: payload.finalState,
    capHit: STATE.capHit,
    capLifted: STATE.capLifted,
    languageDetected: payload.languageDetected,
  };
  window.__quranStats = { ...STATS };
  window.__quranMatches = STATE.findings.slice();
}

// ── MutationObserver (T028) ───────────────────────────────────────────────────

function setupMutationObserver() {
  if (STATE.mutationObserver) STATE.mutationObserver.disconnect();

  STATE.mutationObserver = new MutationObserver(mutations => {
    // T058z — ignore mutations the swap engine just generated. Without this
    // gate the swap text mutations would trigger a phantom rescan that
    // re-walks authentic text instead of the page's original wording.
    if (STATE.swapInProgress) return;
    STATS.mutationsObserved += mutations.length;
    const roots = new Set();
    for (const m of mutations) {
      if (m.addedNodes.length === 0) continue;
      // Ignore mutations inside our own sidebar (or its collapsed tab) — their
      // mount/render/collapse churn must not trigger a rescan that would re-mount
      // the sidebar or re-extract on a single pass (producing different matches).
      const OWN_UI = '.quran-ext-panel, .quran-ext-panel-tab';
      if (m.target && m.target.closest && m.target.closest(OWN_UI)) continue;
      // Ignore the body-level mutation that ADDS the sidebar or the tab itself.
      let isOurOwnAdd = true;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.classList?.contains('quran-ext-panel') || n.classList?.contains('quran-ext-panel-tab') || n.closest?.(OWN_UI))) continue;
        isOurOwnAdd = false; break;
      }
      if (isOurOwnAdd) continue;
      roots.add(m.target);
    }
    if (roots.size === 0) return;
    clearTimeout(STATE.mutationDebounceTimer);
    STATE.mutationDebounceTimer = setTimeout(() => {
      if (STATE.scanning) return;
      STATS.mutationRescans++;
      for (const root of roots) {
        scanPage({ subtreeRoot: root }).catch(() => {});
      }
    }, 500);
  });

  STATE.mutationObserver.observe(document.body, { childList: true, subtree: true });
}

// ── Autoscan path (T022) ──────────────────────────────────────────────────────

async function maybeAutoscan() {
  try {
    // QuranMsg.sendRequest handles requestId internally (works in non-secure contexts).
    const resp = await QuranMsg.sendRequest('PREFS_READ', {});
    const prefs = resp?.payload?.result || resp?.result;
    if (prefs?.scanTrigger === 'autoscan') {
      await scanPage();
      setupMutationObserver();
    }
  } catch (_) {}
}

// ── Highlight clearing ────────────────────────────────────────────────────────
// Already defined above.

// ── Highlight interaction (T035 long-press + T036 Esc) ───────────────────────
// All highlight spans share the `quran-*` classes — use event delegation so we
// don't have to attach per-span listeners (and so dynamically-added highlights
// from mutation-observer rescans Just Work).
const LONG_PRESS_MS = 500;
let longPressTimer = null;
let longPressTarget = null;
function isHighlightSpan(el) {
  return el && el.classList && (
    el.classList.contains('quran-green') || el.classList.contains('quran-lightblue') ||
    el.classList.contains('quran-yellow') || el.classList.contains('quran-orange') ||
    el.classList.contains('quran-red')
  );
}
document.addEventListener('touchstart', (e) => {
  const t = e.target && e.target.closest && e.target.closest(HIGHLIGHT_SELECTOR);
  if (!isHighlightSpan(t)) return;
  longPressTarget = t;
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    if (longPressTarget) longPressTarget.classList.add('quran-pressed');
  }, LONG_PRESS_MS);
}, { passive: true });
function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (longPressTarget) { longPressTarget.classList.remove('quran-pressed'); longPressTarget = null; }
}
document.addEventListener('touchend', cancelLongPress, { passive: true });
document.addEventListener('touchmove', cancelLongPress, { passive: true });
document.addEventListener('touchcancel', cancelLongPress, { passive: true });
// Tap outside dismisses any sticky press state.
document.addEventListener('click', (e) => {
  if (!isHighlightSpan(e.target && e.target.closest && e.target.closest(HIGHLIGHT_SELECTOR))) {
    for (const el of document.querySelectorAll('.quran-pressed')) el.classList.remove('quran-pressed');
  }
}, true);

// T036 — Esc handling on focused highlights.
// First Esc: dismiss any sticky-pressed tooltip and keep focus on highlight.
// Second Esc (highlight still focused, no sticky tooltip): blur back to page.
let escWasUsedForTooltip = false;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const focused = document.activeElement;
  if (!isHighlightSpan(focused)) return;
  if (focused.classList.contains('quran-pressed')) {
    focused.classList.remove('quran-pressed');
    escWasUsedForTooltip = true;
    e.preventDefault();
    return;
  }
  if (escWasUsedForTooltip) {
    // Already dismissed a tooltip on a prior Esc — this second press blurs.
    focused.blur();
    escWasUsedForTooltip = false;
    e.preventDefault();
    return;
  }
  // No sticky tooltip to dismiss — blur immediately (hover/focus tooltip will hide).
  focused.blur();
  e.preventDefault();
});

// ── Test bridge (Playwright DOM events) ──────────────────────────────────────

document.addEventListener('__quranBridgeScan', async () => {
  if (!document.body || document.readyState === 'loading') return;
  try { await scanPage(); } catch (e) { console.error('[QuranExt] bridge scan error:', e); }
  document.dispatchEvent(new CustomEvent('__quranBridgeDone', {
    detail: {
      stats: { ...STATS },
      findings: STATE.findings.slice(),
      matches: STATE.highlightedSpans.map(s => ({
        text: s.textContent, color: s.dataset.color,
        matchedRef: s.dataset.matchedRef, claimedRef: s.dataset.claimedRef, tooltip: s.dataset.tooltip,
      })),
    },
  }));
});

// T085 — one-shot promise bridge for the Node harness (tests/run_tests_node.js).
// Runs a full scan and resolves with the same shape the DOM bridge emits, so the
// harness can `await window.__quranRunScan()` without a poll-for-stable loop.
window.__quranRunScan = async function () {
  if (document.readyState === 'loading') {
    await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  await scanPage();
  return {
    scan: window.__quranScan,
    stats: { ...STATS },
    findings: STATE.findings.slice(),
    matches: STATE.highlightedSpans.map(s => ({
      text: s.textContent, color: s.dataset.color,
      matchedRef: s.dataset.matchedRef, claimedRef: s.dataset.claimedRef, tooltip: s.dataset.tooltip,
    })),
  };
};

// ── Popup message listener (T017) ─────────────────────────────────────────────

// ── Correct-in-place (T065, FR-012 + FR-022) ─────────────────────────────────

function cssEscapeId(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// Mirror of QuranPersisted.urlKey (which lives in the service worker) so the
// content script can compute the same key it uses for PERSIST_WRITE (FR-024).
function pageUrlKey() {
  try {
    const u = new URL(location.href);
    u.hash = '';
    const params = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b));
    u.search = new URLSearchParams(params).toString();
    return u.toString();
  } catch (_) {
    return location.href;
  }
}

// Wrap the true reference in the same bracket characters the page used for the
// cited reference, so "(البقرة:3)" → "(البقرة:2)" rather than a bare ref.
function buildCorrectedRefText(markerText, trueRef) {
  const open = (markerText || '').match(/^\s*([([«{﴿])/);
  const close = (markerText || '').match(/([)\]»}﴾])\s*$/);
  if (open && close) return open[1] + trueRef + close[1];
  return trueRef;
}

// Wrap chars [start,end) of a text node in a ref-marker span tied to findingId.
function wrapSubstringInNode(node, start, end, findingId) {
  const parent = node.parentNode;
  if (!parent) return false;
  const text = node.textContent;
  const before = text.slice(0, start);
  const middle = text.slice(start, end);
  const after = text.slice(end);
  if (!middle) return false;
  const span = document.createElement('span');
  span.className = REF_MARKER_CLASS;
  span.dataset.quranRefFor = findingId;
  span.textContent = middle;
  if (before) parent.insertBefore(document.createTextNode(before), node);
  parent.insertBefore(span, node);
  if (after) parent.insertBefore(document.createTextNode(after), node);
  parent.removeChild(node);
  return true;
}

// Forward-search from the ayah highlight span for the exact cited-reference
// text and wrap its first occurrence. The reference always follows the ayah
// for every ref-bearing extractor, so a bounded document-order walk after the
// span finds it without relying on stale char offsets from the scan buffer.
function wrapRefAfter(ayahSpan, refText, findingId) {
  if (!refText) return false;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  walker.currentNode = ayahSpan;
  let scanned = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (ayahSpan.contains(node)) continue; // skip the ayah's own text nodes
    const idx = node.textContent.indexOf(refText);
    if (idx !== -1) return wrapSubstringInNode(node, idx, idx + refText.length, findingId);
    scanned += node.textContent.length;
    if (scanned > 400) break; // the reference sits right after the ayah
  }
  return false;
}

// Place reference markers for orange findings (the correct-in-place targets:
// real verse, wrong reference). Idempotent — skips findings already marked.
function placeRefMarkers() {
  for (const f of STATE.findings) {
    if (f.category !== 'orange' || !f.refText || !f.matchedRef) continue;
    if (document.querySelector(`[data-quran-ref-for="${cssEscapeId(f.id)}"]`)) continue;
    const ayahSpan = document.querySelector(`[data-finding-id="${cssEscapeId(f.id)}"]`);
    if (!ayahSpan) continue;
    try { wrapRefAfter(ayahSpan, f.refText, f.id); } catch (_) {}
  }
}

// FR-012 + FR-022: replace the cited reference in the page with the true one,
// flip the highlight to the re-verified successor, and emit the successor
// Finding (priorFindingId set). Falls back to clipboard when the reference
// can't be edited in place (no marker — e.g. shadow DOM / cross-node ref).
async function correctInPlace(findingId) {
  const f = STATE.findings.find(x => x.id === findingId);
  if (!f) return { ok: false, error: { code: 'NOT_FOUND', message: 'finding not found' } };
  const trueRef = f.matchedRef || f.matchedReference || null;
  if (!trueRef) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'no true reference' } };

  const marker = document.querySelector(`[data-quran-ref-for="${cssEscapeId(findingId)}"]`);
  const corrected = marker ? buildCorrectedRefText(marker.textContent, trueRef) : null;

  // Re-verify the now-correct citation to produce the successor verdict.
  let vres = null;
  try {
    vres = await sendToBackground({ type: 'verifyFragmentByRef', text: f.text, ref: trueRef, candidateConfidence: 'high' });
  } catch (_) {}
  const successorColor = (vres && vres.color) || 'green';
  const successorMatchedRef = (vres && vres.matchedRef) || trueRef;
  const successorId = computeCompositeFindingId(f.text, trueRef, successorMatchedRef, f.domPath);

  let fellBackToClipboard = false;
  STATE.swapInProgress = true;
  try {
    if (marker && corrected) {
      if (marker.dataset.quranRefOrig == null) marker.dataset.quranRefOrig = marker.textContent;
      marker.textContent = corrected;
      marker.dataset.quranRefFor = successorId;
      marker.classList.add('quran-ref-corrected');
      const ayahSpan = document.querySelector(`[data-finding-id="${cssEscapeId(findingId)}"]`);
      if (ayahSpan) {
        for (const c of ALL_HIGHLIGHT_CLASSES) ayahSpan.classList.remove(c);
        if (CSS_BY_COLOR[successorColor]) ayahSpan.classList.add(CSS_BY_COLOR[successorColor]);
        const tip = buildTooltip(successorColor, { color: successorColor, claimedRef: trueRef, matchedRef: successorMatchedRef, deviation: vres && vres.deviation });
        ayahSpan.dataset.findingId = successorId;
        ayahSpan.dataset.color = successorColor;
        ayahSpan.dataset.claimedRef = trueRef;
        ayahSpan.dataset.matchedRef = successorMatchedRef;
        ayahSpan.dataset.tooltip = tip;
        if (CATEGORY_LABEL_AR[successorColor]) {
          ayahSpan.setAttribute('aria-label', CATEGORY_LABEL_AR[successorColor] + (tip ? '. ' + tip : ''));
        }
      }
    } else {
      // FR-012 fallback: copy the corrected citation for manual paste.
      fellBackToClipboard = true;
      const clip = corrected || trueRef;
      try {
        if (typeof QuranActions !== 'undefined' && QuranActions.copy) await QuranActions.copy(clip);
        else if (navigator.clipboard) await navigator.clipboard.writeText(clip);
      } catch (_) {}
    }
  } finally {
    setTimeout(() => { STATE.swapInProgress = false; }, 50);
  }

  // FR-022 successor: discard the prior Finding, add the re-verified successor
  // with a priorFindingId back-reference.
  const successor = {
    ...f,
    id: successorId,
    category: successorColor,
    color: successorColor,
    citedReference: trueRef,
    claimedRef: trueRef,
    matchedReference: successorMatchedRef,
    matchedRef: successorMatchedRef,
    authenticText: (vres && vres.authenticText) || f.authenticText,
    authenticExcerpt: (vres && vres.authenticExcerpt) || null,
    deviation: (vres && vres.deviation) || f.deviation,
    refText: corrected || f.refText,
    priorFindingId: findingId,
    persistedBadge: null,
  };
  const idx = STATE.findings.findIndex(x => x.id === findingId);
  if (idx !== -1) STATE.findings.splice(idx, 1, successor); else STATE.findings.push(successor);

  if (!fellBackToClipboard && typeof QuranSwap !== 'undefined' && STATE.prefs) {
    STATE.swapInProgress = true;
    try { QuranSwap.applySwap(successor, STATE.prefs); } catch (_) {}
    setTimeout(() => { STATE.swapInProgress = false; }, 50);
  }

  const perCategoryCount = { green: 0, lightBlue: 0, yellow: 0, orange: 0, red: 0 };
  for (const x of STATE.findings) if (perCategoryCount[x.category] !== undefined) perCategoryCount[x.category]++;
  QuranMsg.emit('SCAN_PROGRESS', { scanId: STATE.scanId, finding: successor, priorFindingId: findingId, runningCount: STATE.findings.length, perCategoryCount });
  // The sidebar runs in this content context and won't receive the cross-context
  // SCAN_PROGRESS broadcast, so update its model directly (T066).
  if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
    try { QuranPanelSidebar.ingest(successor, findingId); } catch (_) {}
  }
  window.__quranMatches = STATE.findings.slice();

  // T068 — persist the correction keyed by the ORIGINAL finding's id (FR-024).
  // A static page reverts to its wrong reference on reload, so the recurring
  // finding has the prior id; keying on the successor would never re-match.
  try {
    await QuranMsg.sendRequest('PERSIST_WRITE', { urlKey: pageUrlKey(), compositeKey: findingId, kind: 'correction', at: new Date().toISOString() });
  } catch (_) {}

  return { ok: true, result: { successorFindingId: successorId, fellBackToClipboard } };
}

if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const { type, requestId, payload = {} } = msg;

    // New envelope: SCAN_START relayed from background
    if (type === 'SCAN_START') {
      const liftCap = payload.liftCap || false;
      scanPage({ liftCap }).then(() => sendResponse(QuranMsg.okResponse(requestId, { scanId: STATE.scanId })));
      return true;
    }

    // Legacy handlers (popup.js still uses these)
    if (type === 'scan') {
      scanPage().then(() => {
        const pcc = { green: 0, lightBlue: 0, yellow: 0, orange: 0, red: 0 };
        for (const f of STATE.findings) if (pcc[f.category] !== undefined) pcc[f.category]++;
        sendResponse({ stats: STATS, perCategoryCount: pcc, totalCount: STATE.findings.length, findings: STATE.findings });
      });
      return true;
    }
    if (type === 'clear') {
      clearHighlights();
      sendResponse({ ok: true });
      return;
    }
    if (type === 'stats') {
      sendResponse({ stats: { ...STATS }, findings: STATE.findings });
      return;
    }
    if (type === 'getFindings') {
      sendResponse({ findings: STATE.findings });
      return;
    }
    // Popup-on-open state query — lets the popup show results from a scan that
    // completed before it opened (autoscan, or earlier manual scan).
    if (type === 'getState') {
      const pcc = { green: 0, lightBlue: 0, yellow: 0, orange: 0, red: 0 };
      for (const f of STATE.findings) if (pcc[f.category] !== undefined) pcc[f.category]++;
      sendResponse({
        scanId: STATE.scanId,
        scanComplete: !STATE.scanning && STATE.scanId !== null,
        scanning: STATE.scanning,
        perCategoryCount: pcc,
        totalCount: STATE.findings.length,
        languageDetected: STATE.languageDetected,
        capHit: STATE.capHit,
      });
      return;
    }

    // DATA_UNAVAILABLE — refuse to scan
    if (type === 'DATA_UNAVAILABLE') {
      console.warn('[QuranExt] Data unavailable:', payload);
      return;
    }
    // DATA_AVAILABLE — re-enable
    if (type === 'DATA_AVAILABLE') {
      return;
    }
    // JUMP_TO_FINDING — popup surface jump-to-highlight handler (FR-011a).
    if (type === 'JUMP_TO_FINDING') {
      const ok = (typeof QuranActions !== 'undefined')
        ? QuranActions.jumpInContent(msg.findingId)
        : false;
      sendResponse({ ok });
      return;
    }

    // CORRECT_IN_PLACE — panel → content (FR-012 + FR-022). Replace the cited
    // reference in the page DOM with the true one, emit the successor Finding.
    if (type === 'CORRECT_IN_PLACE') {
      const id = payload.findingId || msg.findingId;
      correctInPlace(id)
        .then(r => sendResponse(r.ok ? QuranMsg.okResponse(requestId, r.result) : QuranMsg.errResponse(requestId, r.error.code, r.error.message)))
        .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
      return true;
    }

    // PREFS_CHANGED — refresh the cache and reconcile authentic-text swap state
    // for every finding (T060). The sidebar is always the panel surface now, so
    // there's no surface-based mount/unmount here.
    if (type === 'PREFS_CHANGED') {
      const prefs = payload?.prefs;
      if (!prefs) return;
      STATE.prefs = prefs;
      // T060 — reapply / revert authentic-text swaps to match the new master,
      // per-color, and font selections (FR-008, FR-009, FR-015). Gate the
      // mutation observer so the swap's own DOM writes don't trigger a
      // phantom rescan (T058z).
      if (typeof QuranSwap !== 'undefined') {
        STATE.swapInProgress = true;
        try { QuranSwap.reconcile(STATE.findings, prefs); } catch (_) {}
        setTimeout(() => { STATE.swapInProgress = false; }, 50);
      }
      return;
    }
  });
}

// Page → panel: clicking a highlight focuses + flashes its row in the sidebar
// (the inverse of the panel → page jump). The popup can't be targeted from the
// page, so this applies only when the sidebar surface is mounted.
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;
  if (t.closest('.quran-ext-panel')) return; // ignore clicks inside the panel
  const span = t.closest(HIGHLIGHT_SELECTOR);
  const id = span && span.dataset.findingId;
  if (!id) return;
  if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
    QuranPanelSidebar.focusRow(id);
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', maybeAutoscan);
} else {
  maybeAutoscan();
}
