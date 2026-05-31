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

// T140 — read-only probe so the live_highlight_check gate can introspect the
// observer/breaker state from the page world. Intentionally narrow: surfaces a
// handful of scalar signals, not the live STATE object.
window.__quranLiveProbe = function () {
  return {
    observerArmed: !!STATE.mutationObserver,
    backoffStep: STATE.mutationBackoffStep || 0,
    rescanTimes: (STATE.rescanTimes || []).length,
    noProgressRescans: STATE.noProgressRescans || 0,
    rearmPending: !!STATE.mutationRearmTimer,
    lastScanUrl: STATE.lastScanUrl || null,
    findings: STATE.findings.length,
  };
};

// T060 — load prefs once at startup so applySwap is ready when the first
// finding lands. PREFS_CHANGED handler later keeps this cache in sync.
(async function loadInitialPrefs() {
  try {
    const resp = await QuranMsg.sendRequest('PREFS_READ', {});
    STATE.prefs = resp?.payload?.result || null;
    // T088 — set the tooltip/aria language from prefs (sidebar sets its own).
    if (typeof QuranI18n !== 'undefined') QuranI18n.setLang(QuranI18n.detect(STATE.prefs?.lang));
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
  // Provenance color (not a classifier verdict): a citation we corrected
  // in place. Verification-wise it is green; lightGreen marks that WE fixed it,
  // so the user can filter corrected citations apart from natively-correct ones.
  lightGreen: 'quran-lightgreen',
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
  // Noun-phrase forms ("the saying of Allah") — common in everyday Arabic and
  // chat messages, e.g. "فردِّد دائمًا قول الله تعالى: {…}". The verb forms
  // ('قال الله تعالى' etc.) and the noun-with-ب/ك prefixes are already above;
  // the bare noun form was missing.
  'قول الله تعالى', 'وقول الله تعالى', 'فقول الله تعالى',
  'قول الله سبحانه', 'قول الله عز وجل', 'قول الله جل جلاله',
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
// Standalone single-char Arabic test (T141 — mutation-rescan gate). Kept next
// to AR_CHAR so the class definition stays the single source of truth.
const AR_CHAR_RE = new RegExp(AR_CHAR);
// Tashkeel (harakat + superscript alef) that follow Arabic letters in vocalized text.
// Range U+06D6–U+06ED covers the Quranic annotation marks the standard mushaf
// orthography sprinkles through fully-vocalized verses (small high seen, small
// high meem isolated, small high madda, small high dotless head of khah ۡ, the
// end-of-ayah marker, etc.). Without these, an AR_RUN breaks mid-ayah on any
// mushaf-style copy (e.g. مِنۡ هَمَزَٰتِ where ۡ is U+06E1) and BRACE_RE
// fails to match the whole braced ayah.
const AR_TASHKEEL = '[\\u064B-\\u065F\\u0670\\u06D6-\\u06ED]';
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
// One surah-name "word": letters each optionally followed by tashkeel, so
// vocalized names like "الحِجْر" match (the kasra/sukun would otherwise break
// the run). Grouped so the repetition is valid (a bare `[...]*+` is an illegal
// JS quantifier). Captured marks are harmless — QuranReferences.resolve
// tier1-normalizes them away.
const AR_NAME_WORD = '(?:' + AR_CHAR_NAME + AR_TASHKEEL + '*)+';
// Opening bracket is optional so we also catch the common typo `Surah:N)` where
// the user dropped the opening paren (e.g. `{ayah} الواقعة:82) أي: ...`).
// The closing bracket remains required so the pattern still anchors on real
// citation punctuation rather than free-floating "word:number" text. Spurious
// surah-name captures (e.g. "بقوله:5)") are filtered downstream by
// QuranReferences.resolve(), which validates the captured name against the
// surah index — unknown names fall back to the no-ref verifier path.
const REF_RE = new RegExp(
  '[({«﴿\\[]?\\s*(' + AR_NAME_WORD + '(?:\\s+' + AR_NAME_WORD + ')*)\\s*[:：]\\s*' +
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
      // T109 — allow optional trailing whitespace before the (ref) so "text (ref)" citations
      // are extracted at medium confidence (the common case in Arabic articles).
      const arRunRe = new RegExp(AR_RUN + '\\s*$', 'u');
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
    // T109 — allow trailing whitespace before (ref) so "text (ref)" fires at medium confidence.
    const shortRe = new RegExp(AR_RUN + '\\s*$', 'u');
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

function tt(key, vars) { return (typeof QuranI18n !== 'undefined') ? QuranI18n.t(key, vars) : key; }

function buildTooltip(color, result) {
  switch (color) {
    case 'green': {
      let tip = result.matchedRef || tt('tip_match');
      const exact = result.allExactRefs || [];
      const partial = result.allPartialRefs || [];
      const otherExact = exact.filter(r => r !== result.matchedRef);
      if (otherExact.length > 0) tip += '\n' + tt('tip_also_in', { refs: otherExact.join(' • ') });
      if (partial.length > 0) tip += '\n' + tt('tip_partial_in', { refs: partial.join(' • ') });
      return tip;
    }
    case 'lightBlue': {
      const refs = result.matchedRefs && result.matchedRefs.length > 1 ? result.matchedRefs.join(' • ') : (result.matchedRef || '');
      return refs + '\n' + tt('tip_no_ref');
    }
    case 'yellow': {
      const matched = result.matchedRef || '';
      const claimed = result.claimedRef || '';
      const refsDiffer = claimed && canonicalRef(claimed) !== canonicalRef(matched);
      const note = refsDiffer ? '\n' + tt('tip_word_level_and_ref', { cited: claimed }) : '\n' + tt('tip_word_level');
      return matched + note;
    }
    case 'lightGreen': return tt('tip_corrected', { from: result.correctedFromRef || '?', to: result.matchedRef || '?' });
    case 'orange': return tt('tip_orange', { cited: result.claimedRef || '?', matched: result.matchedRef || '?' });
    case 'red': return result.claimedRef
      ? tt('tip_red_with_ref', { ref: result.claimedRef })
      : tt('tip_red');
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
  lightGreen: 'صُحِّح المرجع',
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
  // Cap = 30: WhatsApp Web (and other deeply-nested SPAs) routinely bury text
  // nodes 15-20+ levels deep. A cap of 12 collapsed two distinct message
  // bubbles to the same path because their first 12 inner ancestors were
  // identical — only the chat-list ancestor's siblingIndex distinguished them.
  // Path remains deterministic, so FR-024 persistence is unaffected.
  while (el && el !== document.documentElement && parts.length < 30) {
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
      span.setAttribute('aria-label', tt('cat_' + color) + (tooltip ? '. ' + tooltip : ''));
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
    QuranLog.warn('wrapTextNodes error:', e);
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
    // Single-pass scans (liftCap / mutation rescan) wrap with the real color
    // class directly (not hidden), so apply the style modifier now. Fresh full
    // scans wrap hidden and get their modifier in materializeHighlights().
    if (!hidden) applyHighlightStyleClass(span);
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
      // T201 V1.2 correction (P1, info-only): aligned word diff for yellow,
      // fuzzy near-match suggestion for red. The panel surfaces these; they
      // never alter the page.
      diff: result.diff || null,
      nearMatch: result.nearMatch || null,
      // T011 (FR-014) — a yellow whose match is too shaky to safely rewrite the
      // page text (boundary-spanning `*` excerpt or ambiguous multi-ref). The
      // diff is still shown (panel + inline where eligible), but the panel
      // withholds "Fix in place" (T018) and surfaces the explanation instead.
      unsafeToRewrite: color === 'yellow'
        && typeof QuranSwap !== 'undefined' && typeof QuranSwap.isShakyMatch === 'function'
        && QuranSwap.isShakyMatch({ text: candidate.text, matchedRef: result.matchedRef, matchedRefs: result.matchedRefs }),
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
      applyHighlightStyleClass(span);
    }
  }
}

// Item 5 — apply the per-category on-page highlight STYLE (highlight / underline
// / off) from prefs.highlightStyle. The base `quran-<color>` class still carries
// the category identity (and the tooltip + focusability are unaffected — they
// stay available regardless of style, including 'off'); these modifier classes
// only change the visible mark. red can't go 'off' (clamped in prefs.js, guarded
// here too). 'highlight' is the default and needs no modifier.
function applyHighlightStyleClass(span) {
  if (!span || !span.dataset) return;
  const color = span.dataset.color;
  const style = STATE.prefs?.highlightStyle?.[color] || 'highlight';
  span.classList.remove('quran-style-underline', 'quran-style-off');
  if (style === 'underline') span.classList.add('quran-style-underline');
  // red + yellow can't go 'off' (clamped in prefs.js, guarded here too) — the two
  // highest-severity findings must stay visible.
  else if (style === 'off' && color !== 'red' && color !== 'yellow') span.classList.add('quran-style-off');
}

// Re-apply highlight styles to every live highlight (PREFS_CHANGED, no rescan).
function reapplyHighlightStyles() {
  for (const span of STATE.highlightedSpans) applyHighlightStyleClass(span);
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
// MutationObserver circuit breaker: if more than MUT_MAX_RESCANS subtree
// rescans fire within MUT_WINDOW_MS, pause the observer (a page framework is
// re-rendering over our highlights in a loop we can't otherwise detect).
const MUT_MAX_RESCANS = 8;
const MUT_WINDOW_MS = 5000;
// Pause the observer after this many consecutive rescans that produce the
// IDENTICAL finding set — that's a page re-rendering over our highlights (a
// no-win fight), not real new content. Catches slow loops the rate cap misses.
const MUT_MAX_NOPROGRESS = 2;
// T142 — both breakers used to permanently disconnect the observer (fatal on
// chat apps that keep streaming Arabic). Now they pause + re-arm with
// exponential back-off: 5s → 10s → 20s → 40s → cap (60s). A productive rescan
// (the finding signature changes) resets the back-off step. The disconnect
// stays cheap during the actual fight; the re-arm restores live highlighting
// once the page settles.
const MUT_REARM_BASE_MS = 5000;
const MUT_REARM_CAP_MS = 60000;
const MUT_REARM_FACTOR = 2;
// T144 — when multiple sibling roots arrive in one mutation tick, walk up at
// most this many parents from each looking for a shared ancestor. Bounds the
// coalesce search so we never accidentally widen to document.body via a long
// chain. Five hops is enough to cover the typical chat row → list → container
// → article → main shape; deeper than that, prefer per-root scans.
const MUT_LCA_MAX_UP = 5;

// Bounded lowest-common-ancestor for a set of DOM nodes. Walks each node's
// parent chain up to maxUp levels, returns the deepest node present in every
// chain or null if no common ancestor is found within the bound. Used by the
// mutation-rescan coalescer (T144).
function boundedCommonAncestor(nodes, maxUp) {
  if (!nodes || nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  const chains = nodes.map((n) => {
    const chain = new Set();
    let cur = n;
    for (let i = 0; i <= maxUp && cur; i++) { chain.add(cur); cur = cur.parentNode; }
    return chain;
  });
  let cur = nodes[0];
  for (let i = 0; i <= maxUp && cur; i++) {
    let inAll = true;
    for (let j = 1; j < chains.length; j++) { if (!chains[j].has(cur)) { inAll = false; break; } }
    if (inAll) return cur;
    cur = cur.parentNode;
  }
  return null;
}

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

  // FR-019 — record the URL this fresh scan ran against so the MutationObserver
  // can tell an SPA route change (URL changed) from in-page content growth.
  if (isFreshFull) STATE.lastScanUrl = location.href;

  // ── Timing instrumentation (paste the [QuranExt][timing] summary to profile) ──
  const T = { passes: 0, pingMs: 0, extractMs: 0, verifyMs: 0, bgMs: 0, verifyCalls: 0, cacheHits: 0, roundTrips: 0, walkMs: 0, materializeMs: 0 };

  // Verdict memo for the convergence loop. A verdict is a pure function of
  // (type, text, ref, confidence) and the static Quran index, so candidates that
  // recur across passes (the common case) skip the service-worker round-trip.
  const verdictCache = new Map();

  // Language gate — only needs to run once.
  if (isFreshFull) {
    const lang = detectLanguage();
    STATE.languageDetected = lang;
    if (lang !== 'ar') {
      clearHighlights();
      STATE.scanning = false;
      const payload = {
        scanId, totalCount: 0, perCategoryCount: { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 },
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
      if (pass === 1) {
        const tPing = performance.now();
        await sendToBackground({ type: 'ping' }).catch(() => {});
        T.pingMs = performance.now() - tPing;
      }

      const tExtractStart = performance.now();
      const root = subtreeRoot || document.body;
      const walker = createTextWalker(root);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);

      if (textNodes.length === 0) break;
      const tWalkDone = performance.now();

      const { combined, map } = buildVirtualText(textNodes);
      const candidates = runExtractionStrategies(textNodes, combined, map);
      const tExtractDone = performance.now();
      T.walkMs += tWalkDone - tExtractStart;
      T.extractMs += tExtractDone - tWalkDone;
      STATS.candidatesExtracted = candidates.length;
      QuranLog.scope('scan').debug(`pass ${pass}: nodes=${textNodes.length} candidates=${candidates.length} walk=${Math.round(tWalkDone - tExtractStart)}ms extract=${Math.round(tExtractDone - tWalkDone)}ms`);

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

      const perCategoryCount = { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 };

      const tVerifyStart = performance.now();

      // Phase 1 — build the per-candidate verify message + cache key, and
      // collect the unique cache misses into one batch. A verdict is a pure
      // function of (type, text, ref, confidence) and the static index, so
      // candidates already memoized (from a prior pass) or duplicated within
      // this pass cost no round-trip. Everything else goes in ONE postMessage
      // instead of one per candidate — the round-trip tax dominates scan
      // time under worker contention, so this is the main latency win.
      const candKeys = new Array(candidates.length);
      const batchItems = [];
      const batchKeys = [];
      const seenMiss = new Set();
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const msg = c.ref
          ? { type: 'verifyFragmentByRef', text: c.text, ref: c.ref, candidateConfidence: c.confidence, debug: QURAN_DEBUG_TRACE }
          : { type: 'verifyFragment', text: c.text, candidateConfidence: c.confidence, debug: QURAN_DEBUG_TRACE };
        const key = msg.type + ' ' + msg.text + ' ' +
          (msg.ref ? JSON.stringify(msg.ref) : '') + ' ' + (msg.candidateConfidence || '');
        candKeys[i] = key;
        if (verdictCache.has(key)) { T.cacheHits++; continue; }
        if (seenMiss.has(key)) continue;
        seenMiss.add(key);
        batchKeys.push(key);
        batchItems.push(msg);
      }

      // Phase 2 — single round-trip for all cache misses this pass.
      if (batchItems.length > 0) {
        try {
          const tCallStart = performance.now();
          const resp = await sendToBackground({ type: 'verifyFragmentBatch', items: batchItems, debug: QURAN_DEBUG_TRACE });
          T.verifyMs += performance.now() - tCallStart;
          T.roundTrips++;
          if (resp && typeof resp._bgMs === 'number') T.bgMs += resp._bgMs;
          const results = (resp && Array.isArray(resp.results)) ? resp.results : [];
          for (let b = 0; b < batchKeys.length; b++) {
            verdictCache.set(batchKeys[b], results[b] ?? null);
            T.verifyCalls++;
          }
        } catch (e) {
          QuranLog.warn('batch verification error:', e);
        }
      }

      // Phase 3 — apply verdicts in candidate order so finding order, the
      // SCAN_CAP cutoff, and live SCAN_PROGRESS all behave exactly as before.
      for (let i = 0; i < candidates.length; i++) {
        if (!liftCap && STATE.findings.length >= SCAN_CAP) {
          STATE.capHit = true;
          break;
        }
        const candidate = candidates[i];
        const result = verdictCache.get(candKeys[i]) ?? null;
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
            // T100 — emit SCAN_PROGRESS for ALL scans so the popup count updates live (FR-023).
            // During hidden (multi-pass) scans the count may reset between passes — that's
            // acceptable; the user sees activity rather than a frozen UI. window.__quranMatches
            // is only written post-convergence (updateWindowGlobals) to avoid test-harness
            // instability during intermediate passes.
            QuranMsg.emit('SCAN_PROGRESS', { scanId, finding, runningCount: STATE.findings.length, perCategoryCount: { ...perCategoryCount } });
          }
        } else if (result?.color === null || result?.color === undefined) {
          STATS.candidatesDroppedSilently++;
        }
      }

      const tVerifyDone = performance.now();
      T.passes = pass;
      QuranLog.scope('scan').debug(`pass ${pass}: verifyLoop=${Math.round(tVerifyDone - tVerifyStart)}ms over ${candidates.length} candidates`);

      // Converged? stop early. Otherwise record count and run another pass.
      const currentCount = STATE.findings.length;
      if (currentCount === prevCount) {
        QuranLog.scope('scan').debug(`stable at ${currentCount} after pass ${pass}, stopping`);
        break;
      }
      prevCount = currentCount;

    } catch (e) {
      QuranLog.error('scan error (pass ' + pass + '):', e);
      break;
    }
  }

  // Reveal all hidden highlights at once — no flicker.
  if (isFreshFull) {
    const tMat = performance.now();
    materializeHighlights();
    T.materializeMs = performance.now() - tMat;
  }
  // T147 — bound retained state on long-lived SPAs. Subtree rescans never
  // clear STATE.findings / STATE.highlightedSpans, so detached spans (rows the
  // page has dropped from its DOM) pin memory and unrelated findings grow
  // without bound. After a subtree pass, prune spans no longer connected and
  // drop findings whose span is gone. Full scans already clear-and-rebuild.
  if (!isFreshFull) {
    const connected = STATE.highlightedSpans.filter((s) => s && s.isConnected);
    if (connected.length !== STATE.highlightedSpans.length) {
      const keepIds = new Set();
      for (const s of connected) if (s.dataset && s.dataset.findingId) keepIds.add(s.dataset.findingId);
      STATE.highlightedSpans = connected;
      STATE.findings = STATE.findings.filter((f) => keepIds.has(f.id));
    }
  }
  // Cap notification (after materialization so it fires with visible highlights).
  if (STATE.capHit) {
    const perCategoryCount = { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 };
    for (const f of STATE.findings) { if (perCategoryCount[f.color] !== undefined) perCategoryCount[f.color]++; }
    QuranMsg.emit('SCAN_CAP_HIT', { scanId, cap: SCAN_CAP, perCategoryCount });
  }

  // T025/T026 — materialize the lightBlue reference resolution onto each Finding
  // now that the whole findings list exists in DOM order, so the autocorrect
  // dispatcher (T048) and the integrity guard can read it off the Finding rather
  // than recomputing at render time. Runs once per scan.
  materializeLightBlueResolution(STATE.findings);

  const totalMs = Math.round(Date.now() - startTime);
  QuranLog.scope('timing').info(
    `total=${totalMs}ms passes=${T.passes} ` +
    `ping=${Math.round(T.pingMs)}ms materialize=${Math.round(T.materializeMs)}ms ` +
    `walk=${Math.round(T.walkMs)}ms extract=${Math.round(T.extractMs)}ms ` +
    `verify=${Math.round(T.verifyMs)}ms (${T.verifyCalls} calls, ` +
    `avg=${T.verifyCalls ? (T.verifyMs / T.verifyCalls).toFixed(1) : 0}ms/call, ` +
    `bgCompute=${Math.round(T.bgMs)}ms, ${T.cacheHits} cacheHits, ${T.roundTrips} roundTrips) ` +
    `findings=${STATE.findings.length}`
  );

  emitComplete(scanId, startedAt, startTime);
  await sendToBackground({ type: 'logFindings', findings: STATE.findings, url: location.href }).catch(() => {});

  // T099 — install mutation + SPA observer after ANY initial full scan, not only autoscan.
  // (The autoscan path also calls setupMutationObserver() explicitly after scanPage(); the
  // guard inside setupMutationObserver() disconnects and rebuilds, which is harmless.)
  if (isFreshFull) setupMutationObserver();
}

function computeFinalState() {
  if (STATE.findings.length === 0) return 'empty';
  const VERIFIED = new Set(['green', 'lightBlue', 'lightGreen']);
  const hasDefect = STATE.findings.some(f => !VERIFIED.has(f.color));
  return hasDefect ? 'defects' : 'clean';
}

function emitComplete(scanId, startedAt, startTime) {
  STATE.scanning = false;
  const durationMs = Math.round(Date.now() - startTime);
  const finalState = computeFinalState();
  const perCategoryCount = { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 };
  for (const f of STATE.findings) { if (perCategoryCount[f.color] !== undefined) perCategoryCount[f.color]++; }

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

// Safety gate for bulk "auto-correct all orange". Orange means the words are
// already verified-correct; only the CITED REFERENCE is wrong. Auto-correcting
// orange rewrites that reference over verified text — it never alters the ayah
// wording, so the text-swap hazards that apply to yellow (collapsing a `*`
// multi-verse excerpt onto one verse, trusting a short fragment) do NOT apply
// here. The one genuine risk is ambiguity: if the correct words occur at more
// than one reference we can't know which single ref to write, so we skip those.
// Manual correct-in-place is unaffected — the user can still review + fix them.
function isOrangeAutoCorrectable(f) {
  if (!f) return false;
  if (!Array.isArray(f.matchedRefs) || f.matchedRefs.length <= 1) return true;
  // Multi-ref orange: still safe to auto-correct when the cited reference's
  // surah disambiguates to exactly one candidate (the common "right surah,
  // wrong ayah" typo — e.g. claimed مريم:45, text "رحمتنا" matches مريم:50
  // and also 21:75/21:86; the surah anchor picks مريم:50 unambiguously).
  // f.matchedRef carries the preferred candidate; verify it (a) belongs to
  // the claimed surah, and (b) is the ONLY same-surah candidate.
  const claimed = String(f.claimedRef || f.citedReference || '');
  const matched = String(f.matchedRef || '');
  const claimedSurah = claimed.split(':')[0].trim();
  const matchedSurah = matched.split(':')[0].trim();
  if (!claimedSurah || matchedSurah !== claimedSurah) return false;
  const sameSurah = f.matchedRefs.filter(r => String(r).split(':')[0].trim() === claimedSurah);
  return sameSurah.length === 1 && sameSurah[0] === matched;
}

// Correct orange findings in place (silently, without re-persisting).
//   - persistedKeys: ids the user already corrected before (FR-024a) — always
//     re-applied, since the user already vetted them (the safety gate is skipped).
//   - autoAll: when true (prefs.autoCorrect.orange), also correct every OTHER
//     orange finding that passes isOrangeAutoCorrectable.
// Returns the count actually applied to the DOM.
async function autoCorrectOranges({ persistedKeys, autoAll }) {
  const oranges = STATE.findings.filter(f => f.color === 'orange');
  let n = 0;
  for (const f of oranges) {
    const vetted = persistedKeys && persistedKeys.has(f.id);
    if (!vetted) {
      if (!autoAll) continue;
      if (!isOrangeAutoCorrectable(f)) continue;
    }
    try {
      const r = await correctInPlace(f.id, { persist: false, silent: true });
      if (r?.ok && !r.result.fellBackToClipboard) n++;
    } catch (_) {}
  }
  return n;
}

// Re-apply prior user-VETTED text-replace corrections on revisit (FR-021) for
// both yellow (Fix-in-place) and red (accepted near-match) — both run through
// correctTextInPlace, and an accepted-red correction is persisted keyed on the
// original red finding, which re-classifies red on reload.
// FR-018 / FR-045 (SC-006) — yellow and red are MANUAL by rule: callers pass
// autoAll:false. The assertion below makes the red-never-auto guarantee explicit
// and defensive: a red finding is corrected ONLY when the user vetted it before;
// it is NEVER auto-corrected, regardless of any preference.
async function autoCorrectYellows({ persistedKeys, autoAll }) {
  const candidates = STATE.findings.filter(f =>
    f.color === 'yellow' || (f.color === 'red' && f.nearMatch));
  let n = 0;
  for (const f of candidates) {
    const vetted = persistedKeys && persistedKeys.has(f.id);
    // T045 (FR-018, SC-006): red is never auto-corrected — only re-applied when
    // the user already accepted it (vetted). Yellow is likewise vetted-only here
    // (autoAll is always false for this path).
    if (f.color === 'red' && !vetted) continue;
    if (!vetted && !autoAll) continue;
    try {
      const r = await correctTextInPlace(f.id, { persist: false, silent: true });
      if (r?.ok && !r.result.fellBackToClipboard) n++;
    } catch (_) {}
  }
  return n;
}

// T025/T026 (FR-008/FR-009/FR-010) — resolve the missing reference for every
// lightBlue finding and stamp it on the finding:
//   • single matchedRef                → resolvedLightBlueRef
//   • multi matchedRefs + adjacency hit → resolvedLightBlueRef (the neighbor's surah)
//   • multi, no adjacency              → candidateLightBlueRefs (manual choice, FR-010)
// Adjacency (FR-009, clarification 2026-05-29): the immediately previous/next
// finding in DOM order (±1, regardless of block boundaries); if exactly one is
// green / lightGreen-corrected / orange-corrected AND its surah is among the
// candidates, adopt that surah. This mirrors QuranPanelModel.suggestRefForLightBlue
// but writes the result onto the Finding so downstream paths read it directly.
function surahOfRefLabel(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const i = ref.lastIndexOf(':');
  return i < 0 ? ref.trim() : ref.slice(0, i).trim();
}
function materializeLightBlueResolution(findings) {
  if (!Array.isArray(findings)) return;
  const isResolvedNeighbor = (nf) =>
    nf && (nf.color === 'green' || nf.color === 'lightGreen'
      || nf.panelState?.persistedBadge?.kind === 'corrected' || nf.correctionKind);
  for (let idx = 0; idx < findings.length; idx++) {
    const f = findings[idx];
    if (!f || f.color !== 'lightBlue') continue;
    const candidates = (Array.isArray(f.matchedRefs) && f.matchedRefs.length)
      ? f.matchedRefs.slice() : (f.matchedRef ? [f.matchedRef] : []);
    f.resolvedLightBlueRef = null;
    f.candidateLightBlueRefs = null;
    if (candidates.length === 0) continue;
    if (candidates.length === 1) { f.resolvedLightBlueRef = candidates[0]; continue; }

    const candSurahs = new Set(candidates.map(surahOfRefLabel));
    let resolved = null;
    for (const j of [idx - 1, idx + 1]) {
      const nf = (j >= 0 && j < findings.length) ? findings[j] : null;
      if (!isResolvedNeighbor(nf)) continue;
      const ns = surahOfRefLabel(nf.matchedRef || nf.claimedRef);
      if (ns && candSurahs.has(ns)) {
        const picked = candidates.find(c => surahOfRefLabel(c) === ns);
        if (picked) { resolved = picked; break; }
      }
    }
    if (resolved) f.resolvedLightBlueRef = resolved;
    else f.candidateLightBlueRefs = candidates;   // FR-010: ambiguous → manual choice
  }
  // T028 — reflect the resolution into the lightBlue span tooltip (suggestion
  // only; FR-007 — NEVER inserted into the page body). Guarded for non-DOM tests.
  if (typeof document !== 'undefined') updateLightBlueTooltips(findings);
}

// T028 (FR-007) — append the resolved/ambiguous reference to each lightBlue
// span's hover tooltip + aria-label. Pure display: no page-body mutation.
function updateLightBlueTooltips(findings) {
  for (const f of findings) {
    if (!f || f.color !== 'lightBlue') continue;
    const span = document.querySelector(`[data-finding-id="${cssEscapeId(f.id)}"]`);
    if (!span) continue;
    let line;
    if (f.resolvedLightBlueRef) line = tt('corr_suggest_ref') + ' ' + f.resolvedLightBlueRef;
    else if (Array.isArray(f.candidateLightBlueRefs) && f.candidateLightBlueRefs.length) line = tt('corr_ambiguous');
    else continue;
    const base = span.dataset.tooltip || (f.matchedRef || '');
    if (base.includes(line)) continue;            // idempotent across re-scans
    span.dataset.tooltip = `${line}\n${base}`;
    if (span.getAttribute('aria-label')) {
      span.setAttribute('aria-label', tt('cat_lightBlue') + '. ' + line);
    }
  }
}

// T036/T049 — re-apply / auto-apply lightBlue reference-attribution (FR-021/FR-018).
//   • refByKey: id → chosen ref from a prior persisted correction; always re-applied.
//   • autoAll (prefs.autoCorrect.lightBlue): auto-attribute every UNAMBIGUOUS lightBlue
//     (resolvedLightBlueRef set). Ambiguous matches are never auto-attributed (FR-019).
// reference-attribution never edits page text, so this is safe to default ON.
async function autoCorrectLightBlue({ refByKey, autoAll }) {
  const lightBlues = STATE.findings.filter(f => f.color === 'lightBlue');
  let n = 0;
  for (const f of lightBlues) {
    const priorRef = refByKey && refByKey.get(f.id);
    let ref = null;
    if (priorRef) ref = priorRef;                                  // vetted re-apply (any prior choice)
    else if (autoAll && f.resolvedLightBlueRef) ref = f.resolvedLightBlueRef; // unambiguous auto
    if (!ref) continue;
    try {
      const r = await correctReferenceAttribution(f.id, { ref, persist: false, silent: true });
      if (r?.ok) n++;
    } catch (_) {}
  }
  return n;
}

async function maybeMountSidebar(finalState) {
  if (typeof QuranPanelSidebar === 'undefined') return;
  if (finalState === 'empty' || finalState === 'notArabic') return;

  // Read the persisted corrections/dismissals for this URL first (FR-024).
  let entries = null;
  try {
    const resp = await QuranMsg.sendRequest('PERSIST_READ', { urlKey: pageUrlKey() });
    entries = resp?.payload?.result?.entries || null;
  } catch (_) {}

  // Auto-correct orange findings in place:
  //  - always re-apply prior corrections on revisit (a static page re-serves
  //    its original wrong reference), and
  //  - if prefs.autoCorrectOrange is set, correct EVERY orange finding.
  // We don't re-persist (auto-correct re-runs each load anyway, and re-applies
  // keep their original correction date) and stay silent (one consolidated
  // badge refresh below). See FR-024a.
  // A persisted correction is any kind except 'dismissal' (ref-edit /
  // text-replace / reference-attribution, or legacy 'correction' / missing-kind
  // which the storage read-path normalizes to 'ref-edit'). All are re-applied on
  // revisit (FR-021); dismissals are not corrections.
  const correctedKeys = new Set();
  // T036 — map of prior reference-attribution corrections → the chosen ref, so
  // the lightBlue re-apply uses the exact reference the user picked (which may be
  // a non-default candidate of an ambiguous match), not just the materialized one.
  const lightBlueRefByKey = new Map();
  if (Array.isArray(entries)) {
    for (const e of entries) {
      const kind = e.kind || e.action || 'ref-edit';
      if (kind === 'dismissal' || kind === 'dismiss') continue;
      correctedKeys.add(e.compositeKey);
      if (kind === 'reference-attribution' && e.payload && e.payload.resolvedRef) {
        lightBlueRefByKey.set(e.compositeKey, e.payload.resolvedRef);
      }
    }
  }
  const autoAll = STATE.prefs?.autoCorrect?.orange === true;
  let reapplied = await autoCorrectOranges({ persistedKeys: correctedKeys, autoAll });
  // FR-018: yellow is MANUAL by rule — never auto-corrected regardless of prefs.
  // Only prior user-vetted yellow corrections are re-applied on revisit (FR-021);
  // hence autoAll is hard-false here, never a preference.
  reapplied += await autoCorrectYellows({ persistedKeys: correctedKeys, autoAll: false });
  // T036/T049 — lightBlue reference-attribution: re-apply prior vetted ones on
  // revisit (FR-021), and — when prefs.autoCorrect.lightBlue (default ON, FR-018,
  // never edits page text) — auto-attribute every unambiguously-resolved lightBlue.
  reapplied += await autoCorrectLightBlue({
    refByKey: lightBlueRefByKey,
    autoAll: STATE.prefs?.autoCorrect?.lightBlue === true,
  });

  // If anything changed, re-settle the badge/popup to the post-correction state.
  if (reapplied) {
    const perCategoryCount = { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 };
    for (const f of STATE.findings) if (perCategoryCount[f.color] !== undefined) perCategoryCount[f.color]++;
    QuranMsg.emit('SCAN_COMPLETE', {
      scanId: STATE.scanId, totalCount: STATE.findings.length, perCategoryCount,
      finalState: computeFinalState(), languageDetected: STATE.languageDetected || 'ar',
    });
    window.__quranMatches = STATE.findings.slice();
  }

  QuranPanelSidebar.reset();
  for (const f of STATE.findings) QuranPanelSidebar.upsert(f);
  // FR-024 — tag findings the user corrected/dismissed on a prior visit so the
  // sidebar shows the "صُحِّح سابقًا" badge. Matched by the original finding id,
  // or — for an auto-re-applied correction — by the successor's priorFindingId.
  if (entries) QuranPanelSidebar.tagPersisted(entries);
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

// ── SPA route changes (FR-019 / FR-026) ──────────────────────────────────────

// A history navigation (popstate) or a pushState/replaceState document swap is a
// "fresh page": stale highlights from the prior route must not linger, and
// Autoscan must re-trigger per FR-026. Debounced so the SPA framework has time to
// render the new route before we scan it.
async function handleRouteChange() {
  if (STATE.scanning) return;
  if (location.href === STATE.lastScanUrl) return;
  clearTimeout(STATE.routeDebounceTimer);
  STATE.routeDebounceTimer = setTimeout(async () => {
    if (STATE.scanning) return;
    QuranLog.scope('route').debug(`SPA route change → ${location.href}`);
    // Drop everything tied to the prior route. Gate the observer (as the `clear`
    // handler does) so clearHighlights()'s own DOM edits don't queue a phantom
    // rescan; the autoscan branch then re-gates via STATE.scanning.
    STATE.swapInProgress = true;
    clearHighlights();
    STATE.findings = [];
    STATE.highlightedSpans = [];
    STATE.lastScanUrl = location.href;
    if (typeof QuranPanelSidebar !== 'undefined') QuranPanelSidebar.unmount();
    setTimeout(() => { STATE.swapInProgress = false; }, 600);
    // FR-026: Autoscan re-scans the new document; Manual leaves the page reset to
    // idle (no stale highlights) and waits for the user. scanPage() reinstalls the
    // MutationObserver for the new route on completion (T099).
    if (STATE.prefs?.scanTrigger === 'autoscan') {
      try { await scanPage(); } catch (_) {}
    }
  }, 500);
}

// popstate covers back/forward navigation; the MutationObserver URL check covers
// pushState/replaceState content swaps (see setupMutationObserver). Installed once.
window.addEventListener('popstate', () => { handleRouteChange().catch(() => {}); });

// ── MutationObserver (T028) ───────────────────────────────────────────────────

function setupMutationObserver() {
  if (STATE.mutationObserver) STATE.mutationObserver.disconnect();
  // T142 — clear any pending re-arm from a previous (paused) observer so the
  // fresh setup isn't tripped by a delayed observe() against the new body.
  clearTimeout(STATE.mutationRearmTimer);
  STATE.mutationRearmTimer = null;
  STATE.mutationBackoffStep = 0;
  // Seed the no-progress baseline with the initial scan's findings so the first
  // rescan that changes nothing already counts toward the no-progress streak.
  STATE.lastRescanSig = STATE.findings.map(f => `${f.id}:${f.color}`).sort().join('|');
  STATE.noProgressRescans = 0;
  STATE.rescanTimes = [];

  STATE.mutationObserver = new MutationObserver(mutations => {
    // Ignore mutations we cause ourselves: those observed mid-scan (our own
    // highlight wrapping / ref decoration) and swap-engine text edits. Without
    // this they queue a phantom rescan after the scan finishes.
    if (STATE.scanning) return;
    // T058z — ignore mutations the swap engine just generated. Without this
    // gate the swap text mutations would trigger a phantom rescan that
    // re-walks authentic text instead of the page's original wording.
    if (STATE.swapInProgress) return;
    // FR-019 — a URL change since the last scan means this DOM churn is an SPA
    // route navigation (pushState/replaceState swapping the document content),
    // not in-page growth. Content scripts run in an isolated world and cannot
    // intercept the page's own history.pushState calls, so we detect the route
    // change by its effect (URL + DOM both changed) here and on popstate below.
    // Handle it as a fresh page rather than an incremental subtree rescan.
    if (STATE.lastScanUrl && location.href !== STATE.lastScanUrl) {
      handleRouteChange();
      return;
    }
    STATS.mutationsObserved += mutations.length;
    const roots = new Set();
    // T141 — require at least one added node carrying Arabic text before we
    // schedule a rescan. Chat-app churn (presence/typing/timestamps) used to
    // count toward MUT_MAX_RESCANS and trip the breaker before any ayah
    // arrived; gating on AR_CHAR makes the rate breaker measure RELEVANT
    // mutations only. AR_CHAR_RE is the same class used to match Quranic runs.
    let sawArabicAdd = false;
    for (const m of mutations) {
      if (m.addedNodes.length === 0) continue;
      // Ignore mutations inside our own sidebar (or its collapsed tab) — their
      // mount/render/collapse churn must not trigger a rescan that would re-mount
      // the sidebar or re-extract on a single pass (producing different matches).
      const OWN_UI = '.quran-ext-panel, .quran-ext-panel-tab, .quran-ext-ref-tip';
      if (m.target && m.target.closest && m.target.closest(OWN_UI)) continue;
      // Ignore the body-level mutation that ADDS the sidebar, tab, or ref tooltip.
      let isOurOwnAdd = true;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.classList?.contains('quran-ext-panel') || n.classList?.contains('quran-ext-panel-tab') || n.classList?.contains('quran-ext-ref-tip') || n.closest?.(OWN_UI))) continue;
        isOurOwnAdd = false;
        // Check the added node's text for Arabic. textContent on a text node
        // is its data; on an element it's the concatenated descendants — both
        // covered by one read. Stop checking once we've seen Arabic anywhere.
        if (!sawArabicAdd) {
          const txt = n.nodeType === 3 ? n.data : (n.textContent || '');
          if (txt && AR_CHAR_RE.test(txt)) sawArabicAdd = true;
        }
      }
      if (isOurOwnAdd) continue;
      roots.add(m.target);
    }
    if (roots.size === 0) return;
    // T141 — bail if nothing Arabic was added. The page might still be doing
    // heavy non-Arabic work (typing indicators, timestamps), but no ayah can
    // appear from that, so we neither rescan nor count it toward the breaker.
    if (!sawArabicAdd) return;
    // Diagnostic (debug): what's driving the rescan — our own highlight/swap
    // nodes (a feedback loop) or the page's own dynamic content?
    if (QuranLog.enabled('debug')) {
      const sample = [];
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (sample.length >= 6) break;
          sample.push(n.nodeType === 1 ? `${n.tagName.toLowerCase()}.${(n.className || '').toString().slice(0, 40)}` : `#text"${(n.textContent || '').trim().slice(0, 25)}"`);
        }
      }
      QuranLog.scope('mutation').debug(`rescan trigger: ${mutations.length} mutations, ${roots.size} roots; added: ${sample.join(' | ')}`);
    }
    clearTimeout(STATE.mutationDebounceTimer);
    STATE.mutationDebounceTimer = setTimeout(async () => {
      if (STATE.scanning) return;
      const pause = (why) => {
        // T142 — disconnect + exponential re-arm (not a life-of-page kill).
        // info, not warn: pausing is a normal handled outcome (not an error).
        if (!STATE.mutationObserver) return;
        STATE.mutationObserver.disconnect();
        clearTimeout(STATE.mutationRearmTimer);
        const step = (STATE.mutationBackoffStep = (STATE.mutationBackoffStep || 0) + 1);
        const ms = Math.min(MUT_REARM_BASE_MS * Math.pow(MUT_REARM_FACTOR, step - 1), MUT_REARM_CAP_MS);
        QuranLog.scope('mutation').info(`${why} — pausing the MutationObserver; re-arming in ${ms} ms (step ${step}).`);
        STATE.mutationRearmTimer = setTimeout(() => {
          if (!STATE.mutationObserver) return; // teardown / route change cleared us
          STATE.rescanTimes = [];
          STATE.noProgressRescans = 0;
          STATE.lastRescanSig = STATE.findings.map(f => `${f.id}:${f.color}`).sort().join('|');
          try { STATE.mutationObserver.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
          QuranLog.scope('mutation').info(`MutationObserver re-armed after ${ms} ms back-off`);
        }, ms);
      };
      // Rate breaker: a fast rescan↔re-render loop (page framework re-inserting
      // its OWN nodes over our highlights — our filter can't detect those).
      const now = performance.now();
      STATE.rescanTimes = (STATE.rescanTimes || []).filter(t => now - t < MUT_WINDOW_MS);
      STATE.rescanTimes.push(now);
      if (STATE.rescanTimes.length > MUT_MAX_RESCANS) {
        pause(`runaway rescan loop (>${MUT_MAX_RESCANS}/${MUT_WINDOW_MS / 1000}s)`);
        return;
      }
      STATS.mutationRescans++;
      // T144 — coalesce sibling roots to a bounded common ancestor. Streamed
      // chat messages produce many sibling mutation targets (each row is its
      // own root); scanning each subtree independently multiplies extract+
      // verify cost N× and bumps the rate breaker N× too. If the roots share
      // an ancestor within MUT_LCA_MAX_UP hops (and it isn't document.body,
      // which defeats the point of a subtree rescan), scan the ancestor once.
      const rootList = [...roots];
      const lca = rootList.length > 1 ? boundedCommonAncestor(rootList, MUT_LCA_MAX_UP) : null;
      const scanTargets = (lca && lca !== document.body && lca.nodeType === 1) ? [lca] : rootList;
      for (const root of scanTargets) {
        await scanPage({ subtreeRoot: root }).catch(() => {});
      }
      // No-progress breaker: a SLOW re-render fight evades the rate cap, but its
      // rescans never change the findings. If the finding set is identical for
      // MUT_MAX_NOPROGRESS consecutive rescans, stop. A genuinely-updating page
      // changes findings → resets the streak → keeps rescanning.
      const sig = STATE.findings.map(f => `${f.id}:${f.color}`).sort().join('|');
      if (sig === STATE.lastRescanSig) {
        if ((STATE.noProgressRescans = (STATE.noProgressRescans || 0) + 1) >= MUT_MAX_NOPROGRESS) {
          pause('rescans are not changing the findings (page re-rendering over our highlights)');
        }
      } else {
        STATE.noProgressRescans = 0;
        STATE.lastRescanSig = sig;
        // T142 — a productive rescan (findings changed) clears the back-off
        // step so the next breaker trip starts the ladder fresh.
        STATE.mutationBackoffStep = 0;
      }
    }, 500);
  });

  STATE.mutationObserver.observe(document.body, { childList: true, subtree: true });
}

// ── Autoscan path (T022) ──────────────────────────────────────────────────────

// Resilient PREFS_READ: a refocused tab's reload races a (sometimes very slow
// to start) MV3 service worker — on a resource-starved browser the first
// message has been observed to hang 20–90s or reject with "Could not establish
// connection" before the worker wakes. Rather than one shot (which then never
// scanned) or one slow attempt (which blocks for the whole hang), fire
// PREFS_READ and RE-KICK every few seconds with a fresh message — a new send
// can start a stuck/cold worker sooner — without abandoning earlier attempts,
// so an eventually-slow worker still yields a scan. Resolve on the first reply.
function readPrefsResilient({ kickEveryMs = 3000, giveUpMs = 90000 } = {}) {
  const log = QuranLog.scope('autoscan');
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false, attempts = 0, iv = null, giveUp = null;
    const finish = (prefs) => {
      if (done) return;
      done = true; clearInterval(iv); clearTimeout(giveUp);
      log.debug(`prefs after ${Math.round(performance.now() - t0)}ms (${attempts} attempts)`);
      resolve(prefs);
    };
    const tryOnce = () => {
      attempts++;
      const a = attempts;
      const tA = performance.now();
      QuranMsg.sendRequest('PREFS_READ', {})
        .then(resp => {
          const prefs = resp?.payload?.result || resp?.result || null;
          log.debug(`  attempt ${a}: ${Math.round(performance.now() - tA)}ms → ${prefs ? 'prefs' : 'empty'}`);
          if (prefs) finish(prefs);
        })
        .catch(e => log.debug(`  attempt ${a}: ${Math.round(performance.now() - tA)}ms → rejected (${e.message})`));
    };
    tryOnce();
    iv = setInterval(() => { if (!done) tryOnce(); }, kickEveryMs);
    giveUp = setTimeout(() => finish(null), giveUpMs);
  });
}

async function maybeAutoscan() {
  const log = QuranLog.scope('autoscan');
  log.debug(`start @ ${new Date().toISOString()} (readyState=${document.readyState})`);
  const tStart = performance.now();
  const prefs = await readPrefsResilient();
  const prefsWaitMs = performance.now() - tStart;
  if (prefs?.scanTrigger === 'autoscan') {
    log.info(`prefsWait=${Math.round(prefsWaitMs)}ms — scan starting`);
    try {
      await scanPage();
      setupMutationObserver();
    } catch (e) { log.warn('autoscan failed:', e); }
  }
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
    if (longPressTarget) { longPressTarget.classList.add('quran-pressed'); showTipFor(longPressTarget, true); }
  }, LONG_PRESS_MS);
}, { passive: true });
function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (longPressTarget) { longPressTarget.classList.remove('quran-pressed'); longPressTarget = null; hideRefTip(); }
}
document.addEventListener('touchend', cancelLongPress, { passive: true });
document.addEventListener('touchmove', cancelLongPress, { passive: true });
document.addEventListener('touchcancel', cancelLongPress, { passive: true });
// Tap outside dismisses any sticky press state.
document.addEventListener('click', (e) => {
  if (!isHighlightSpan(e.target && e.target.closest && e.target.closest(HIGHLIGHT_SELECTOR))) {
    for (const el of document.querySelectorAll('.quran-pressed')) el.classList.remove('quran-pressed');
    hideRefTip();
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
    hideRefTip();
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

document.addEventListener('__quranBridgeScan', async (e) => {
  // T098 — reject synthetic events from page-world scripts.
  if (!e.isTrusted) return;
  if (!document.body || document.readyState === 'loading') return;
  try { await scanPage(); } catch (e) { QuranLog.error('bridge scan error:', e); }
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
// Bidi controls + zero-width chars that WhatsApp Web (and other rich text
// surfaces) routinely inject around mixed-direction text. The extractor reads
// the DOM at scan time and records refText WITHOUT these marks; the rendered
// text node may contain them by the time placeRefMarkers runs, which breaks a
// literal indexOf. We strip on both sides for matching and map the offsets
// back to the original text node for wrapping. Covers:
//   U+061C       (ALM — Arabic Letter Mark; WhatsApp Web injects this heavily)
//   U+200B-U+200F (ZWSP, ZWNJ, ZWJ, LRM, RLM)
//   U+202A-U+202E (LRE, RLE, PDF, LRO, RLO)
//   U+2066-U+2069 (LRI, RLI, FSI, PDI)
//   U+FEFF       (zero-width NBSP / BOM)
const BIDI_ZW_RE = /[؜​-‏‪-‮⁦-⁩﻿]/g;
const BIDI_ZW_ONE = /[؜​-‏‪-‮⁦-⁩﻿]/;
function stripBidiZw(s) { return s.replace(BIDI_ZW_RE, ''); }
// Map an offset in the stripped string back to an offset in the original.
function origOffsetFromStripped(orig, strippedOffset) {
  let s = 0;
  for (let o = 0; o < orig.length; o++) {
    if (s >= strippedOffset) return o;
    if (!BIDI_ZW_ONE.test(orig[o])) s++;
  }
  return orig.length;
}
function wrapRefAfter(ayahSpan, refText, findingId) {
  if (!refText) return false;
  const refClean = stripBidiZw(refText);
  if (!refClean) return false;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  walker.currentNode = ayahSpan;
  let scanned = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (ayahSpan.contains(node)) continue; // skip the ayah's own text nodes
    const raw = node.textContent;
    // Fast path: exact match in the unaltered text.
    let idx = raw.indexOf(refText);
    let endIdx = idx === -1 ? -1 : idx + refText.length;
    // Fallback: WhatsApp-style bidi/zero-width injection — strip both sides,
    // match, then map the stripped offsets back to the original node text.
    if (idx === -1) {
      const cleaned = stripBidiZw(raw);
      const cIdx = cleaned.indexOf(refClean);
      if (cIdx !== -1) {
        idx = origOffsetFromStripped(raw, cIdx);
        endIdx = origOffsetFromStripped(raw, cIdx + refClean.length);
      }
    }
    if (idx !== -1) return wrapSubstringInNode(node, idx, endIdx, findingId);
    scanned += raw.length;
    if (scanned > 400) break; // the reference sits right after the ayah
  }
  return false;
}

// Place reference markers for every finding that carries a cited reference on
// the page (any color), so the reference is always highlighted, hover-shows the
// full ayah text, and (when prefs.refLinks) links to quran.com. Orange findings
// double as the correct-in-place targets. Idempotent — skips marked findings.
function placeRefMarkers() {
  for (const f of STATE.findings) {
    if (!f.refText) continue;
    if (document.querySelector(`[data-quran-ref-for="${cssEscapeId(f.id)}"]`)) continue;
    const ayahSpan = document.querySelector(`[data-finding-id="${cssEscapeId(f.id)}"]`);
    if (!ayahSpan) continue;
    try {
      if (wrapRefAfter(ayahSpan, f.refText, f.id)) {
        const marker = document.querySelector(`[data-quran-ref-for="${cssEscapeId(f.id)}"]`);
        if (marker) decorateRefMarker(marker, f.refText);
      }
    } catch (_) {}
  }
}

// Resolve the cited reference to its surah/ayah numbers + full ayah text, then
// stash both on the marker: data-tooltip carries the complete ayah(s) for the
// hover/focus tooltip, and the surah/ayah numbers drive the quran.com link.
// The link is enabled by toggling the .quran-ref-link class (gated by prefs).
async function decorateRefMarker(marker, refString) {
  if (!marker || !refString) return;
  let resolved = null;
  try { resolved = await sendToBackground({ type: 'resolveReference', ref: refString }); } catch (_) {}
  if (!resolved || !resolved.surahNum || !Array.isArray(resolved.ayahNums) || resolved.ayahNums.length === 0) return;
  const texts = Array.isArray(resolved.ayahTexts) ? resolved.ayahTexts.filter(Boolean) : [];
  if (texts.length) marker.dataset.tooltip = texts.join(' ۝ ');
  // Render the ayah text in the user's selected Quran font (independent of
  // whether authentic-text swap is enabled). The tooltip reads this var; the
  // font key drives the downscale rule that mirrors the swap engine.
  if (typeof QuranFonts !== 'undefined') {
    marker.style.setProperty('--quran-ref-tooltip-font', QuranFonts.familyFor(STATE.prefs?.font));
  }
  marker.dataset.quranFont = STATE.prefs?.font || 'uthmaniHafs';
  marker.dataset.quranSurah = String(resolved.surahNum);
  marker.dataset.quranAyahFirst = String(resolved.ayahNums[0]);
  marker.dataset.quranAyahLast = String(resolved.ayahNums[resolved.ayahNums.length - 1]);
  if (STATE.prefs?.refLinks !== false) marker.classList.add('quran-ref-link');
  applyRefHighlightStyle(marker);
}

// Item 1 — apply the reference highlight toggle (prefs.refHighlight). When off,
// the marker keeps its tooltip + link but drops the gold visual mark. Idempotent.
function applyRefHighlightStyle(marker) {
  if (!marker || !marker.classList) return;
  if (STATE.prefs?.refHighlight === false) marker.classList.add('quran-ref-style-off');
  else marker.classList.remove('quran-ref-style-off');
}

// Build the quran.com URL for a surah + ayah range, honoring the Arabic UI
// locale. Format per product spec: quran.com/2/3-4 (and quran.com/ar/2/3-4).
function quranComUrl(surah, first, last) {
  const isAr = (typeof QuranI18n !== 'undefined')
    ? QuranI18n.detect(STATE.prefs?.lang) === 'ar'
    : (STATE.prefs?.lang !== 'en');
  const ayahPart = (last && last !== first) ? `${first}-${last}` : `${first}`;
  return `https://quran.com/${isAr ? 'ar/' : ''}${surah}/${ayahPart}`;
}

// FR-012 + FR-022: replace the cited reference in the page with the true one,
// flip the highlight to the re-verified successor, and emit the successor
// Finding (priorFindingId set). Falls back to clipboard when the reference
// can't be edited in place (no marker — e.g. shadow DOM / cross-node ref).
// options.persist=false  → don't write a PERSIST record (used by auto-re-apply
//                          on reload, so the original correction date is kept).
// options.silent=true    → don't emit SCAN_COMPLETE or ingest into the sidebar
//                          (the caller re-syncs the panel + badge once).
async function correctInPlace(findingId, options = {}) {
  const persist = options.persist !== false;
  const silent = options.silent === true;
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
  // The reference we just replaced (the wrong one), kept so the panel/tooltip
  // can show "what was wrong" on the corrected finding.
  const correctedFromRef = f.claimedRef || f.citedReference || null;
  // Provenance color: a now-verified correction renders as lightGreen so the
  // user can tell it apart from natively-correct green. If the corrected text
  // still isn't a clean verify (e.g. yellow), keep that verdict's color.
  const displayColor = (successorColor === 'green') ? 'lightGreen' : successorColor;

  let fellBackToClipboard = false;
  STATE.swapInProgress = true;
  try {
    if (marker && corrected) {
      if (marker.dataset.quranRefOrig == null) marker.dataset.quranRefOrig = marker.textContent;
      marker.textContent = corrected;
      marker.dataset.quranRefFor = successorId;
      marker.classList.add('quran-ref-corrected');
      // The marker now shows the TRUE reference — re-resolve so its tooltip and
      // quran.com link follow the corrected reference rather than the old one.
      decorateRefMarker(marker, successorMatchedRef);
      const ayahSpan = document.querySelector(`[data-finding-id="${cssEscapeId(findingId)}"]`);
      if (ayahSpan) {
        for (const c of ALL_HIGHLIGHT_CLASSES) ayahSpan.classList.remove(c);
        if (CSS_BY_COLOR[displayColor]) ayahSpan.classList.add(CSS_BY_COLOR[displayColor]);
        const tip = buildTooltip(displayColor, { color: displayColor, claimedRef: trueRef, matchedRef: successorMatchedRef, correctedFromRef, deviation: vres && vres.deviation });
        ayahSpan.dataset.findingId = successorId;
        ayahSpan.dataset.color = displayColor;
        ayahSpan.dataset.claimedRef = trueRef;
        ayahSpan.dataset.matchedRef = successorMatchedRef;
        ayahSpan.dataset.tooltip = tip;
        if (CATEGORY_LABEL_AR[displayColor]) {
          ayahSpan.setAttribute('aria-label', tt('cat_' + displayColor) + (tip ? '. ' + tip : ''));
        }
      }
    } else {
      // FR-012 fallback: copy the corrected citation for manual paste. Skipped
      // on silent auto-re-apply (FR-024a) — we must never hijack the clipboard
      // on every page reload; auto-re-apply degrades to badge-only instead.
      fellBackToClipboard = true;
      if (!silent) {
        const clip = corrected || trueRef;
        try {
          if (typeof QuranActions !== 'undefined' && QuranActions.copy) await QuranActions.copy(clip);
          else if (navigator.clipboard) await navigator.clipboard.writeText(clip);
        } catch (_) {}
      }
    }
  } finally {
    setTimeout(() => { STATE.swapInProgress = false; }, 50);
  }

  // Auto-re-apply that couldn't edit the DOM: leave the finding as-is (still
  // orange) so the page's true state is reflected; the "previously corrected"
  // badge still attaches via the original id. Do NOT create a green successor.
  if (silent && fellBackToClipboard) {
    return { ok: true, result: { successorFindingId: null, fellBackToClipboard: true } };
  }

  // FR-022 successor: discard the prior Finding, add the re-verified successor
  // with a priorFindingId back-reference.
  const successor = {
    ...f,
    id: successorId,
    category: successorColor,   // the verification verdict (usually green)
    color: displayColor,        // provenance color shown in UI (lightGreen)
    correctedFromRef,           // the wrong reference we replaced
    citedReference: trueRef,
    claimedRef: trueRef,
    matchedReference: successorMatchedRef,
    matchedRef: successorMatchedRef,
    authenticText: (vres && vres.authenticText) || f.authenticText,
    authenticExcerpt: (vres && vres.authenticExcerpt) || null,
    deviation: (vres && vres.deviation) || f.deviation,
    refText: corrected || f.refText,
    priorFindingId: findingId,
    correctionKind: 'ref-edit',   // FR-002: orange reference rewrite
    persistedBadge: null,
    // Snapshot of the pre-correction finding so revertCorrection can rebuild
    // the original row (color, refs, …) without re-running the verifier.
    priorFinding: { ...f, priorFinding: undefined },
  };
  const idx = STATE.findings.findIndex(x => x.id === findingId);
  if (idx !== -1) STATE.findings.splice(idx, 1, successor); else STATE.findings.push(successor);

  if (!fellBackToClipboard && typeof QuranSwap !== 'undefined' && STATE.prefs) {
    STATE.swapInProgress = true;
    try { QuranSwap.applySwap(successor, STATE.prefs); } catch (_) {}
    setTimeout(() => { STATE.swapInProgress = false; }, 50);
  }

  const perCategoryCount = { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 };
  for (const x of STATE.findings) if (perCategoryCount[x.color] !== undefined) perCategoryCount[x.color]++;
  // A correction is a discrete, completed change — not an in-progress scan.
  // Emit SCAN_COMPLETE (not SCAN_PROGRESS) so the badge re-settles to its
  // ✓ / ! glyph with the updated counts instead of getting stuck showing a
  // progress count (FR-028). The sidebar runs in this content context and is
  // updated directly via ingest below; the cross-context emit is for the badge
  // + popup only.
  if (!silent) {
    QuranMsg.emit('SCAN_COMPLETE', {
      scanId: STATE.scanId,
      totalCount: STATE.findings.length,
      perCategoryCount,
      finalState: computeFinalState(),
      languageDetected: STATE.languageDetected || 'ar',
    });
    // The sidebar runs in this content context and won't receive the
    // cross-context emit, so update its model directly (T066).
    if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
      try { QuranPanelSidebar.ingest(successor, findingId); } catch (_) {}
    }
  }
  window.__quranMatches = STATE.findings.slice();

  // T068 — persist the correction keyed by the ORIGINAL finding's id (FR-024).
  // A static page reverts to its wrong reference on reload, so the recurring
  // finding has the prior id; keying on the successor would never re-match.
  if (persist) {
    try {
      await QuranMsg.sendRequest('PERSIST_WRITE', {
        urlKey: pageUrlKey(), compositeKey: findingId, kind: 'ref-edit',
        at: new Date().toISOString(), payload: { resolvedRef: trueRef },
      });
    } catch (_) {}
  }

  return { ok: true, result: { successorFindingId: successorId, fellBackToClipboard } };
}

// T201 P3 (FR-012/FR-022, ratified Q-B) — replace the cited TEXT in the page
// with the AUTHENTIC mushaf wording and re-verify to a green/lightGreen
// successor. Used by the yellow "fix wording" action and the red "accept
// near-match" action. INTEGRITY (Principle I): we only ever write the authentic
// JSON wording — never a guess, never the user's drift — so the citation becomes
// MORE correct, never less; the write is gated so we never rewrite on a shaky
// match. Mirrors correctInPlace's successor/persist/ingest plumbing.
//   options.persist=false / options.silent=true: as in correctInPlace.
async function correctTextInPlace(findingId, options = {}) {
  const persist = options.persist !== false;
  const silent = options.silent === true;
  const f = STATE.findings.find(x => x.id === findingId);
  if (!f) return { ok: false, error: { code: 'NOT_FOUND', message: 'finding not found' } };

  // Resolve the authentic wording + the reference to re-verify against.
  let authentic = null, verifyRef = null;
  if (f.color === 'yellow') {
    authentic = f.authenticExcerpt || f.authenticText || null;
    verifyRef = f.matchedRef || f.matchedReference || null;
  } else if (f.color === 'red' && (options.candidate || f.nearMatch)) {
    // options.candidate = a specific rival chosen from the manual-choice list
    // (T035/T043 tie case); otherwise the top near-match. Prefer the boundary-
    // aligned excerpt so we replace only the cited window (with dropped words
    // restored), not the whole surrounding verse.
    const cand = options.candidate || f.nearMatch;
    authentic = cand.authenticExcerpt || cand.authenticText || null;
    verifyRef = cand.refLabel || cand.ref || null;
  }
  if (!authentic || !verifyRef) {
    return { ok: false, error: { code: 'NOT_CORRECTABLE', message: 'no authentic wording / reference' } };
  }
  // Integrity gate: refuse shaky matches (multi-location text, or a `*` ayah-span
  // excerpt that collapsed onto a single verse). Replacing on those could corrupt
  // a possibly-correct citation.
  const text = String(f.text || '');
  const shaky = (text.includes('*') && !String(verifyRef).includes('-'))
    || (Array.isArray(f.matchedRefs) && f.matchedRefs.length > 1);
  if (shaky) return { ok: false, error: { code: 'AMBIGUOUS', message: 'match too shaky to rewrite' } };

  const ayahSpan = document.querySelector(`[data-finding-id="${cssEscapeId(findingId)}"]`);

  // Re-verify the authentic wording at its reference → the successor verdict
  // (expected green; we never fabricate it).
  let vres = null;
  try { vres = await sendToBackground({ type: 'verifyFragmentByRef', text: authentic, ref: verifyRef, candidateConfidence: 'high' }); } catch (_) {}
  const successorColor = (vres && vres.color) || 'green';
  const successorMatchedRef = (vres && vres.matchedRef) || verifyRef;
  const displayColor = (successorColor === 'green') ? 'lightGreen' : successorColor;
  const successorId = computeCompositeFindingId(authentic, verifyRef, successorMatchedRef, f.domPath);
  const correctedFromText = f.text;

  let fellBackToClipboard = false;
  STATE.swapInProgress = true;
  try {
    if (ayahSpan) {
      // Permanent rewrite: stash the original page wording for transparency, then
      // write the authentic text. (This is intentionally NOT the reversible swap;
      // the citation is being corrected, not merely display-swapped.)
      if (ayahSpan.dataset.quranCorrectedFrom == null) ayahSpan.dataset.quranCorrectedFrom = ayahSpan.textContent;
      ayahSpan.textContent = authentic;
      for (const c of ALL_HIGHLIGHT_CLASSES) ayahSpan.classList.remove(c);
      if (CSS_BY_COLOR[displayColor]) ayahSpan.classList.add(CSS_BY_COLOR[displayColor]);
      const tip = buildTooltip(displayColor, { color: displayColor, claimedRef: verifyRef, matchedRef: successorMatchedRef, deviation: vres && vres.deviation });
      ayahSpan.dataset.findingId = successorId;
      ayahSpan.dataset.color = displayColor;
      ayahSpan.dataset.claimedRef = verifyRef;
      ayahSpan.dataset.matchedRef = successorMatchedRef;
      ayahSpan.dataset.tooltip = tip;
      if (CATEGORY_LABEL_AR[displayColor]) ayahSpan.setAttribute('aria-label', tt('cat_' + displayColor) + (tip ? '. ' + tip : ''));
    } else {
      // No editable span (shadow DOM / cross-node) → copy the authentic citation
      // for manual paste, like correctInPlace. Skipped on silent auto-apply.
      fellBackToClipboard = true;
      if (!silent) {
        const clip = `${authentic} (${successorMatchedRef})`;
        try {
          if (typeof QuranActions !== 'undefined' && QuranActions.copy) await QuranActions.copy(clip);
          else if (navigator.clipboard) await navigator.clipboard.writeText(clip);
        } catch (_) {}
      }
    }
  } finally {
    setTimeout(() => { STATE.swapInProgress = false; }, 50);
  }

  if (silent && fellBackToClipboard) {
    return { ok: true, result: { successorFindingId: null, fellBackToClipboard: true } };
  }

  const successor = {
    ...f,
    id: successorId,
    category: successorColor,
    color: displayColor,
    correctedFromText,               // the original (drifted) wording we replaced
    correctedFromRef: f.claimedRef || f.citedReference || null,
    text: authentic,
    citedReference: verifyRef,
    claimedRef: verifyRef,
    matchedReference: successorMatchedRef,
    matchedRef: successorMatchedRef,
    matchedRefs: [],
    authenticText: (vres && vres.authenticText) || authentic,
    authenticExcerpt: (vres && vres.authenticExcerpt) || authentic,
    deviation: (vres && vres.deviation) || null,
    diff: null,
    nearMatch: null,
    priorFindingId: findingId,
    correctionKind: 'text-replace',   // FR-002: yellow Fix-in-place / accepted red near-match
    persistedBadge: null,
    // Snapshot of the pre-correction finding so revertCorrection can rebuild
    // the original row (color, refs, diff, …) without re-running the verifier.
    priorFinding: { ...f, priorFinding: undefined },
  };
  const idx = STATE.findings.findIndex(x => x.id === findingId);
  if (idx !== -1) STATE.findings.splice(idx, 1, successor); else STATE.findings.push(successor);

  if (!fellBackToClipboard && typeof QuranSwap !== 'undefined' && STATE.prefs) {
    STATE.swapInProgress = true;
    try { QuranSwap.applySwap(successor, STATE.prefs); } catch (_) {}
    setTimeout(() => { STATE.swapInProgress = false; }, 50);
  }

  const perCategoryCount = { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 };
  for (const x of STATE.findings) if (perCategoryCount[x.color] !== undefined) perCategoryCount[x.color]++;
  if (!silent) {
    QuranMsg.emit('SCAN_COMPLETE', {
      scanId: STATE.scanId, totalCount: STATE.findings.length, perCategoryCount,
      finalState: computeFinalState(), languageDetected: STATE.languageDetected || 'ar',
    });
    if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
      try { QuranPanelSidebar.ingest(successor, findingId); } catch (_) {}
    }
  }
  window.__quranMatches = STATE.findings.slice();

  if (persist) {
    try {
      await QuranMsg.sendRequest('PERSIST_WRITE', {
        urlKey: pageUrlKey(), compositeKey: findingId, kind: 'text-replace',
        at: new Date().toISOString(),
        payload: { authenticExcerpt: authentic, originalCitedText: correctedFromText },
      });
    } catch (_) {}
  }
  return { ok: true, result: { successorFindingId: successorId, fellBackToClipboard, lockedDom: fellBackToClipboard } };
}

// T032/T035 (FR-007/FR-008) — lightBlue "accept reference": attribute the
// resolved reference to a lightBlue finding WITHOUT editing the page body. The
// span is recolored to a lightGreen successor and the resolved ref is surfaced
// in the tooltip + panel; the ayah text is never touched (this is the spec's
// override of the design-predecessor's ref-insert). options.ref = a manually
// chosen candidate (T035); falls back to the materialized resolvedLightBlueRef.
async function correctReferenceAttribution(findingId, options = {}) {
  const persist = options.persist !== false;
  const silent = options.silent === true;
  const f = STATE.findings.find(x => x.id === findingId);
  if (!f || f.color !== 'lightBlue') return { ok: false, error: { code: 'NOT_CORRECTABLE', message: 'not a lightBlue finding' } };
  const resolvedRef = options.ref || f.resolvedLightBlueRef || null;
  if (!resolvedRef) return { ok: false, error: { code: 'AMBIGUOUS', message: 'no resolved reference' } };

  // Re-verify the cited text AT the resolved reference (Principle I — confirm the
  // attribution against the index; lightBlue text is authentic, so this is green).
  let vres = null;
  try { vres = await sendToBackground({ type: 'verifyFragmentByRef', text: f.text, ref: resolvedRef, candidateConfidence: 'high' }); } catch (_) {}
  const successorColor = (vres && vres.color) || 'green';
  const displayColor = 'lightGreen';
  const successorMatchedRef = (vres && vres.matchedRef) || resolvedRef;
  const successorId = computeCompositeFindingId(f.text, resolvedRef, successorMatchedRef, f.domPath);

  const ayahSpan = document.querySelector(`[data-finding-id="${cssEscapeId(findingId)}"]`);
  // FR-005 clipboard fallback is N/A here (no DOM text edit to fall back from);
  // a missing span just means we can't recolor → report span-missing.
  if (!ayahSpan) return { ok: false, reason: 'span-missing' };

  STATE.swapInProgress = true;
  try {
    // NO text edit (FR-007): recolor + tooltip carries the resolved ref only.
    for (const c of ALL_HIGHLIGHT_CLASSES) ayahSpan.classList.remove(c);
    if (CSS_BY_COLOR[displayColor]) ayahSpan.classList.add(CSS_BY_COLOR[displayColor]);
    const tip = buildTooltip(displayColor, { color: displayColor, correctedFromRef: tt('tip_no_ref'), matchedRef: successorMatchedRef });
    ayahSpan.dataset.findingId = successorId;
    ayahSpan.dataset.color = displayColor;
    ayahSpan.dataset.claimedRef = resolvedRef;
    ayahSpan.dataset.matchedRef = successorMatchedRef;
    ayahSpan.dataset.tooltip = tip;
    if (CATEGORY_LABEL_AR[displayColor]) ayahSpan.setAttribute('aria-label', tt('cat_' + displayColor) + (tip ? '. ' + tip : ''));
  } finally {
    setTimeout(() => { STATE.swapInProgress = false; }, 50);
  }

  const successor = {
    ...f,
    id: successorId,
    category: successorColor,
    color: displayColor,
    correctedFromRef: null,          // lightBlue carried no cited reference
    citedReference: resolvedRef,
    claimedRef: resolvedRef,
    matchedReference: successorMatchedRef,
    matchedRef: successorMatchedRef,
    matchedRefs: [],
    authenticText: (vres && vres.authenticText) || f.authenticText,
    resolvedLightBlueRef: resolvedRef,
    candidateLightBlueRefs: null,
    diff: null,
    nearMatch: null,
    priorFindingId: findingId,
    correctionKind: 'reference-attribution',
    persistedBadge: null,
    priorFinding: { ...f, priorFinding: undefined },
  };
  const idx = STATE.findings.findIndex(x => x.id === findingId);
  if (idx !== -1) STATE.findings.splice(idx, 1, successor); else STATE.findings.push(successor);

  const perCategoryCount = { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 };
  for (const x of STATE.findings) if (perCategoryCount[x.color] !== undefined) perCategoryCount[x.color]++;
  if (!silent) {
    QuranMsg.emit('SCAN_COMPLETE', {
      scanId: STATE.scanId, totalCount: STATE.findings.length, perCategoryCount,
      finalState: computeFinalState(), languageDetected: STATE.languageDetected || 'ar',
    });
    if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
      try { QuranPanelSidebar.ingest(successor, findingId); } catch (_) {}
    }
  }
  window.__quranMatches = STATE.findings.slice();

  if (persist) {
    try {
      await QuranMsg.sendRequest('PERSIST_WRITE', {
        urlKey: pageUrlKey(), compositeKey: findingId, kind: 'reference-attribution',
        at: new Date().toISOString(), payload: { resolvedRef },
      });
    } catch (_) {}
  }
  return { ok: true, result: { successorFindingId: successorId } };
}

// Restore a corrected (lightGreen) finding to its pre-correction state: rewrite
// the page span back to the original text/color/refs, swap the successor in
// STATE.findings for the snapshot taken when the correction was applied, and
// clear the matching persisted entry so revisits won't re-apply the correction.
async function revertCorrection(findingId) {
  const f = STATE.findings.find(x => x.id === findingId);
  if (!f || !f.priorFinding) return { ok: false, error: { code: 'NOT_REVERTABLE', message: 'no prior snapshot' } };
  const original = { ...f.priorFinding };

  const ayahSpan = document.querySelector(`[data-finding-id="${cssEscapeId(findingId)}"]`);
  STATE.swapInProgress = true;
  try {
    if (ayahSpan) {
      // Prefer the on-span stash (verbatim original textContent) over the
      // serialised finding.text in case the swap engine or correctInPlace had
      // mutated the span beyond what was reflected in the finding.
      const origText = ayahSpan.dataset.quranCorrectedFrom != null
        ? ayahSpan.dataset.quranCorrectedFrom
        : (original.text || '');
      ayahSpan.textContent = origText;
      delete ayahSpan.dataset.quranCorrectedFrom;
      for (const c of ALL_HIGHLIGHT_CLASSES) ayahSpan.classList.remove(c);
      if (CSS_BY_COLOR[original.color]) ayahSpan.classList.add(CSS_BY_COLOR[original.color]);
      ayahSpan.dataset.findingId = original.id;
      ayahSpan.dataset.color = original.color;
      ayahSpan.dataset.claimedRef = original.claimedRef || '';
      ayahSpan.dataset.matchedRef = original.matchedRef || '';
      const tip = buildTooltip(original.color, {
        color: original.color,
        claimedRef: original.claimedRef,
        matchedRef: original.matchedRef,
        deviation: original.deviation,
      });
      ayahSpan.dataset.tooltip = tip;
      if (CATEGORY_LABEL_AR[original.color]) {
        ayahSpan.setAttribute('aria-label', tt('cat_' + original.color) + (tip ? '. ' + tip : ''));
      }
    }
  } finally {
    setTimeout(() => { STATE.swapInProgress = false; }, 50);
  }

  const idx = STATE.findings.findIndex(x => x.id === findingId);
  if (idx !== -1) STATE.findings.splice(idx, 1, original); else STATE.findings.push(original);

  // Clear the persisted correction so the revert sticks across reloads (FR-006).
  // Remove the entry matching this correction's kind; also clear the interim
  // 'correction' literal so pre-migration dev entries revert cleanly too.
  const revertKind = f.correctionKind || 'ref-edit';
  try { await QuranMsg.sendRequest('PERSIST_REMOVE', { urlKey: pageUrlKey(), compositeKey: findingId, kind: revertKind }); } catch (_) {}
  if (revertKind !== 'correction') {
    try { await QuranMsg.sendRequest('PERSIST_REMOVE', { urlKey: pageUrlKey(), compositeKey: findingId, kind: 'correction' }); } catch (_) {}
  }

  if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
    try { QuranPanelSidebar.revertCorrection(findingId, original); } catch (_) {}
  }
  window.__quranMatches = STATE.findings.slice();
  return { ok: true, result: { originalFindingId: original.id } };
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
        const pcc = { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 };
        for (const f of STATE.findings) if (pcc[f.category] !== undefined) pcc[f.category]++;
        sendResponse({ stats: STATS, perCategoryCount: pcc, totalCount: STATE.findings.length, findings: STATE.findings });
      });
      return true;
    }
    if (type === 'clear') {
      // Gate the mutation observer: clearHighlights() unwraps spans and calls
      // document.body.normalize(), which the observer would otherwise treat as
      // page edits and rescan ~500ms later — re-painting the highlights the
      // user just cleared. Reuse the swap suppression flag; reset after the
      // observer's debounce window so the queued mutations are ignored.
      STATE.swapInProgress = true;
      clearHighlights();
      setTimeout(() => { STATE.swapInProgress = false; }, 600);
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
      const pcc = { green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, orange: 0, red: 0 };
      for (const f of STATE.findings) if (pcc[f.color] !== undefined) pcc[f.color]++;
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

    // DATA_UNAVAILABLE — refuse to scan + show the fail-loud error surface (FR-020).
    if (type === 'DATA_UNAVAILABLE') {
      QuranLog.warn('Data unavailable:', payload);
      if (typeof QuranPanelSidebar !== 'undefined') {
        try { QuranPanelSidebar.showError(payload?.reason); } catch (_) {}
      }
      return;
    }
    // DATA_AVAILABLE — clear the error surface; normal operation resumes on next scan.
    if (type === 'DATA_AVAILABLE') {
      if (typeof QuranPanelSidebar !== 'undefined') {
        try { QuranPanelSidebar.clearError(); } catch (_) {}
      }
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

    // CORRECT_TEXT_IN_PLACE — panel → content (T201 P3). Replace the cited TEXT
    // with the authentic mushaf wording (yellow "fix wording" / red "accept
    // near-match") and emit the green/lightGreen successor.
    if (type === 'CORRECT_TEXT_IN_PLACE') {
      const id = payload.findingId || msg.findingId;
      correctTextInPlace(id)
        .then(r => sendResponse(r.ok ? QuranMsg.okResponse(requestId, r.result) : QuranMsg.errResponse(requestId, r.error.code, r.error.message)))
        .catch(e => sendResponse(QuranMsg.errResponse(requestId, 'INTERNAL', e.message)));
      return true;
    }

    // PERSISTED_CLEARED — the options page cleared saved corrections/dismissals;
    // drop stale badges from the open sidebar (T094 follow-up).
    if (type === 'PERSISTED_CLEARED') {
      if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
        try { QuranPanelSidebar.clearPersistedBadges(); } catch (_) {}
      }
      return;
    }

    // PREFS_CHANGED — refresh the cache and reconcile authentic-text swap state
    // for every finding (T060). The sidebar is always the panel surface now, so
    // there's no surface-based mount/unmount here.
    if (type === 'PREFS_CHANGED') {
      const prefs = payload?.prefs;
      if (!prefs) return;
      STATE.prefs = prefs;
      // T089 — language switch: update tooltip language + re-localize the sidebar.
      if (typeof QuranI18n !== 'undefined') QuranI18n.setLang(QuranI18n.detect(prefs.lang));
      if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
        try { QuranPanelSidebar.applyLang(prefs.lang); } catch (_) {}
        try { QuranPanelSidebar.setPosition(prefs.panelPosition); } catch (_) {}
        try { QuranPanelSidebar.setFloatAnchor(prefs.floatAnchor); } catch (_) {}
      }
      // T060 — reapply / revert authentic-text swaps to match the new master,
      // per-color, and font selections (FR-008, FR-009, FR-015). Gate the
      // mutation observer so the swap's own DOM writes don't trigger a
      // phantom rescan (T058z).
      if (typeof QuranSwap !== 'undefined') {
        STATE.swapInProgress = true;
        try { QuranSwap.reconcile(STATE.findings, prefs); } catch (_) {}
        setTimeout(() => { STATE.swapInProgress = false; }, 50);
      }
      // Item 5 — live highlight-style change (highlight / underline / off).
      try { reapplyHighlightStyles(); } catch (_) {}
      // Item 2 — refresh the sidebar's results-summary 3-state toggles so a
      // highlight-style change made on the options page reflects in the panel.
      if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
        try { QuranPanelSidebar.applyHighlightPrefs(prefs); } catch (_) {}
      }
      // Live ref-link + ref-highlight toggle: add/remove the clickable affordance
      // and the gold visual mark on every already-placed reference marker without
      // needing a rescan.
      try {
        const enable = prefs.refLinks !== false;
        const fontFamily = (typeof QuranFonts !== 'undefined') ? QuranFonts.familyFor(prefs.font) : null;
        for (const m of document.querySelectorAll('.' + REF_MARKER_CLASS)) {
          if (enable && m.dataset.quranSurah) m.classList.add('quran-ref-link');
          else m.classList.remove('quran-ref-link');
          applyRefHighlightStyle(m);
          if (fontFamily) m.style.setProperty('--quran-ref-tooltip-font', fontFamily);
          m.dataset.quranFont = prefs.font || 'uthmaniHafs';
        }
      } catch (_) {}
      // Live "auto-correct all orange" toggle: if it's now on and the current
      // scan still has uncorrected orange findings, correct them in place now
      // and re-sync the sidebar/badge (rather than waiting for the next scan).
      // Only orange and lightBlue are autocorrectable (FR-018); yellow/red never.
      const acOrange = prefs.autoCorrect?.orange === true;
      if (acOrange && STATE.findings.some(f => f.color === 'orange')) {
        maybeMountSidebar(computeFinalState()).catch(() => {});
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

  // Reference marker → open quran.com (gated by prefs.refLinks). The surah/ayah
  // numbers were resolved + stashed when the marker was placed (decorateRefMarker).
  const refMarker = t.closest('.' + REF_MARKER_CLASS);
  if (refMarker && STATE.prefs?.refLinks !== false && refMarker.dataset.quranSurah) {
    e.preventDefault();
    e.stopPropagation();
    const url = quranComUrl(refMarker.dataset.quranSurah, refMarker.dataset.quranAyahFirst, refMarker.dataset.quranAyahLast);
    window.open(url, '_blank', 'noopener');
    return;
  }

  const span = t.closest(HIGHLIGHT_SELECTOR);
  const id = span && span.dataset.findingId;
  if (!id) return;
  if (typeof QuranPanelSidebar !== 'undefined' && QuranPanelSidebar.isMounted()) {
    QuranPanelSidebar.focusRow(id);
  }
});

// ── Hover/focus tooltips (reference ayah text + highlight verdict) ───────────
// Both are rendered as a single position:fixed element on document.body — NOT a
// CSS ::after — so no ancestor's overflow:hidden or stacking context can clip or
// bury them. Always paints on top (max z-index in the root stacking context).
//   - Reference markers  → full ayah text in the selected Quran font.
//   - Highlight spans     → the classification tooltip (verdict) in the UI font.
let refTipEl = null;
// The highlight span currently under the pointer/focus, so an async tooltip
// enrichment (lazy alternate-ref lookup) only re-renders if still hovered.
let currentTipAnchor = null;
function ensureRefTip() {
  if (refTipEl && document.body.contains(refTipEl)) return refTipEl;
  refTipEl = document.createElement('div');
  refTipEl.className = 'quran-ext-ref-tip';
  refTipEl.setAttribute('role', 'tooltip');
  (document.body || document.documentElement).appendChild(refTipEl);
  return refTipEl;
}
// Show the tooltip for an anchor element. `verdict` selects the highlight
// styling (UI font, multi-line) vs. the reference styling (Quran font).
function showTipFor(anchor, verdict) {
  currentTipAnchor = anchor;
  const text = anchor.dataset.tooltip;
  if (!text) return;
  const tip = ensureRefTip();
  tip.textContent = text;
  tip.classList.toggle('quran-ext-tip-verdict', !!verdict);
  const font = anchor.style.getPropertyValue('--quran-ref-tooltip-font');
  if (font) tip.style.setProperty('--quran-ref-tooltip-font', font);
  // Mirror the swap engine: downscale only the legacy uthmaniHafs font, and only
  // for the reference (ayah-text) tooltip — the verdict tooltip uses the UI font.
  tip.classList.toggle('quran-ext-tip-downscale', !verdict && anchor.dataset.quranFont === 'uthmaniHafs');
  tip.style.visibility = 'hidden';
  tip.style.display = 'block';
  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let top = a.bottom + 6;
  if (top + t.height > window.innerHeight - 8) top = Math.max(8, a.top - t.height - 6);
  let left = a.right - t.width; // align to the anchor's right edge (RTL)
  left = Math.min(Math.max(8, left), window.innerWidth - 8 - t.width);
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  tip.style.visibility = 'visible';
  if (verdict) maybeEnrichGreenTip(anchor);
}
function hideRefTip() { currentTipAnchor = null; if (refTipEl) refTipEl.style.display = 'none'; }

// Lazy companion to the deferred green verify path: the "also/partially
// appears in …" lines are computed on first hover (one cheap bg round-trip)
// rather than during every scan, then cached back onto the span's tooltip so
// later hovers are instant. Only green findings carry these extra lines.
async function maybeEnrichGreenTip(anchor) {
  if (anchor.dataset.color !== 'green' || anchor.dataset.tipEnriched) return;
  anchor.dataset.tipEnriched = '1'; // also dedupes concurrent in-flight fetches
  const text = anchor.dataset.originalText;
  if (!text) return;
  let resp;
  try { resp = await sendToBackground({ type: 'alternateRefs', text }); }
  catch (_) { delete anchor.dataset.tipEnriched; return; } // allow retry next hover
  const matchedRef = anchor.dataset.matchedRef || '';
  const otherExact = (resp?.allExactRefs || []).filter(r => r !== matchedRef);
  const partial = resp?.allPartialRefs || [];
  if (otherExact.length === 0 && partial.length === 0) return;
  let tip = anchor.dataset.tooltip || matchedRef || tt('tip_match');
  if (otherExact.length > 0) tip += '\n' + tt('tip_also_in', { refs: otherExact.join(' • ') });
  if (partial.length > 0) tip += '\n' + tt('tip_partial_in', { refs: partial.join(' • ') });
  anchor.dataset.tooltip = tip;
  // Keep the screen-reader label in sync (mirrors the scan-time construction):
  // a keyboard/SR user focusing a green span should hear the "also/partially
  // in …" lines too. The fetch is async, so the very first focus may announce
  // the base label; the enriched label is in place for any later focus.
  const color = anchor.dataset.color;
  if (color && CATEGORY_LABEL_AR[color]) {
    anchor.setAttribute('aria-label', tt('cat_' + color) + '. ' + tip);
  }
  // Re-render only if this anchor is still the hovered one (the pointer may
  // have moved away during the await); showTipFor short-circuits the re-entry
  // because tipEnriched is now set.
  if (currentTipAnchor === anchor) showTipFor(anchor, true);
}

// Resolve an event target to a tooltip anchor: a reference marker (verdict
// false) or a highlight span (verdict true). Returns null for neither.
function tipAnchorFor(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const ref = target.closest('.' + REF_MARKER_CLASS);
  if (ref) return { anchor: ref, verdict: false };
  const hl = target.closest(HIGHLIGHT_SELECTOR);
  if (hl) return { anchor: hl, verdict: true };
  return null;
}

document.addEventListener('mouseover', (e) => {
  const a = tipAnchorFor(e.target);
  if (a) showTipFor(a.anchor, a.verdict);
});
document.addEventListener('mouseout', (e) => {
  if (tipAnchorFor(e.target)) hideRefTip();
});
document.addEventListener('focusin', (e) => {
  const a = tipAnchorFor(e.target);
  if (a) showTipFor(a.anchor, a.verdict);
});
document.addEventListener('focusout', (e) => {
  if (tipAnchorFor(e.target)) hideRefTip();
});
// The tooltip is fixed-positioned; scrolling moves the anchor out from under it.
window.addEventListener('scroll', hideRefTip, { passive: true, capture: true });

// ── Keep the service worker warm ──────────────────────────────────────────────
// Cold-starting the MV3 worker on a resource-starved browser (e.g. very many
// tabs) was measured at 20–90s, which is the dominant "stall before highlights"
// cost. Holding an open port resets the worker's idle-eviction timer, so while
// this page is VISIBLE the worker stays warm and the next scan skips the cold
// start. Visible-only so we don't pin 90+ idle ports; reconnect on disconnect
// (eviction / Chrome's periodic port recycle).
(function keepWorkerWarm() {
  let port = null;
  function connect() {
    if (port || document.visibilityState !== 'visible') return;
    try {
      port = chrome.runtime.connect({ name: 'quran-keepalive' });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; // swallow "worker stopped" noise
        port = null;
        if (document.visibilityState === 'visible') setTimeout(connect, 1000);
      });
    } catch (_) { port = null; }
  }
  function disconnect() { if (port) { try { port.disconnect(); } catch (_) {} port = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') connect(); else disconnect();
  });
  connect();
})();

// T146 — release the MutationObserver on hidden tabs. A background tab keeps
// no useful state by observing the page (we can't highlight what the user
// can't see, and a real conversation that streams while the tab is hidden
// will be picked up by the rescan-on-visible path). Reduces idle CPU and
// retained closures across many backgrounded tabs (field report #5).
(function releaseObserverOnHidden() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (STATE.mutationObserver) {
        try { STATE.mutationObserver.disconnect(); } catch (_) {}
      }
      clearTimeout(STATE.mutationDebounceTimer);
      clearTimeout(STATE.mutationRearmTimer);
      STATE.mutationRearmTimer = null;
    } else if (document.visibilityState === 'visible') {
      // Re-arm if a scan has already run on this page. setupMutationObserver
      // is safe to call repeatedly (it disconnect/rebuilds), and re-running it
      // here also re-scans nothing — the next mutation triggers the work.
      // Skip if no scan has run yet; the autoscan-when-visible path will arm.
      if (STATE.lastScanUrl) setupMutationObserver();
    }
  });
})();

// ── Startup ───────────────────────────────────────────────────────────────────

// Autoscan only once the tab is VISIBLE. A backgrounded tab (e.g. session
// restore of many tabs at once) shouldn't pile a scan onto the single shared
// service worker before the user looks at it — dozens of simultaneous scans
// starve the worker (observed: bgCompute stretched to ~16s for ~200ms of real
// work). Deferring keeps the worker free for the foreground tab; hidden tabs
// scan when first shown.
function autoscanWhenVisible() {
  if (document.visibilityState === 'visible') { maybeAutoscan(); return; }
  QuranLog.scope('autoscan').debug('tab hidden — deferring scan until visible');
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onVisible);
    maybeAutoscan();
  };
  document.addEventListener('visibilitychange', onVisible);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoscanWhenVisible);
} else {
  autoscanWhenVisible();
}
