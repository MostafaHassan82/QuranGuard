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
};

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

// ── Window globals (T019) — per contracts/window-globals.md ──────────────────
window.__quranScan = null;      // set on SCAN_COMPLETE, null on SCAN_START
window.__quranStats = makeEmptyStats();
window.__quranMatches = [];

// ── Regex constants ───────────────────────────────────────────────────────────

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const LEAD_IN_PATTERNS = [
  'قال الله تعالى', 'قال تعالى', 'وقال تعالى', 'قال سبحانه وتعالى', 'قال سبحانه',
  'قوله تعالى', 'وقوله تعالى', 'قوله سبحانه', 'قوله عز وجل', 'وقوله عز وجل',
  'قال عز وجل', 'قال جل وعلا', 'قال جل جلاله', 'يقول الله تعالى',
  'قال ربكم', 'في كتاب الله', 'في قوله تعالى',
];
const LEAD_IN_RE = new RegExp('(' + LEAD_IN_PATTERNS.map(escapeRe).join('|') + ')\\s*[:：]?\\s*', 'u');

const AR_CHAR = '[\\u0621-\\u063A\\u0641-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06FA-\\u06FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]';
// Tashkeel (harakat + superscript alef) that follow Arabic letters in vocalized text.
const AR_TASHKEEL = '[\\u064B-\\u065F\\u0670]';
const AR_RUN = `${AR_CHAR}${AR_TASHKEEL}*(?:[\\s]*${AR_CHAR}${AR_TASHKEEL}*)*`;
const BRACE_RE = new RegExp('[{«\\[](' + AR_RUN + '(?:[*،,\\s]+' + AR_RUN + ')*)[}»\\]]|\\((' + AR_RUN + '(?:[*،,\\s]+' + AR_RUN + ')*)\\)', 'u');
const STRONG_BRACE_RE = new RegExp('[{«\\[](' + AR_RUN + '(?:[*،,\\s]+' + AR_RUN + ')*)[}»\\]]', 'u');
const REF_RE = new RegExp(
  '[({«﴿\\[]\\s*(' + AR_CHAR + '+(?:\\s+' + AR_CHAR + '+)*)\\s*[:：]\\s*' +
  '([\\d\\u0660-\\u0669\\u06F0-\\u06F9]+(?:\\s*[-–]\\s*[\\d\\u0660-\\u0669\\u06F0-\\u06F9]+)?(?:\\s*[،,]\\s*[\\d\\u0660-\\u0669\\u06F0-\\u06F9]+)*)' +
  '\\s*[)}»﴾\\]]',
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
      if (node.textContent.trim().length < 2) return NodeFilter.FILTER_SKIP;
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

function braceContent(m) { return (m[1] ?? m[2] ?? '').trim(); }

function extractLeadInBraced(combined, map, textNodes) {
  const candidates = [];
  const leadRe = new RegExp(LEAD_IN_RE.source, 'gu');
  let lm;
  while ((lm = leadRe.exec(combined)) !== null) {
    const afterLead = lm.index + lm[0].length;
    const window = combined.slice(afterLead, afterLead + 250);
    const bm = BRACE_RE.exec(window);
    if (!bm) continue;
    const braceStart = afterLead + bm.index;
    const braceEnd = braceStart + bm[0].length;
    const text = braceContent(bm);
    if (!text || text.length < 4) continue;
    const afterBrace = combined.slice(braceEnd, braceEnd + 80);
    const refMatch = new RegExp(REF_RE.source, 'u').exec(afterBrace);
    const ref = refMatch ? refMatch[0] : null;
    const innerStart = braceStart + bm[0].indexOf(bm[1] ?? bm[2]);
    const innerEnd = innerStart + text.length;
    const resolved = resolveRange(innerStart, innerEnd, textNodes, map);
    if (!resolved) continue;
    candidates.push({ ...resolved, ref, strategy: 'leadInBraced', confidence: 'high', charStart: innerStart, charEnd: innerEnd });
  }
  return candidates;
}

function extractExplicitRefBackward(combined, map, textNodes, alreadyCovered) {
  const candidates = [];
  const refRe = new RegExp(REF_RE.source, 'gu');
  let rm;
  while ((rm = refRe.exec(combined)) !== null) {
    STATS.candidatesExtracted++;
    const refStart = rm.index;
    if (alreadyCovered.some(([s, e]) => refStart >= s && refStart < e)) continue;
    const isMetaList = /الآيات\s*\d/.test(rm[0]) || ((rm[2] || '').match(/[،,]/g) || []).length >= 2;
    if (isMetaList) continue;
    const rawBackStart = Math.max(0, refStart - 300);
    const rawBackWindow = combined.slice(rawBackStart, refStart);
    let lastBreakEnd = -1;
    const paraRe = /\x00{2,}|[\r\n]{2,}/g;
    let pm;
    while ((pm = paraRe.exec(rawBackWindow)) !== null) lastBreakEnd = pm.index + pm[0].length;
    const backStart = lastBreakEnd !== -1 ? rawBackStart + lastBreakEnd : rawBackStart;
    const backWindow = combined.slice(backStart, refStart);
    let text = null, innerStart = null, innerEnd = null, confidence = 'medium';
    const nearSlice = backWindow.slice(Math.max(0, backWindow.length - 100));
    const nearOffset = backWindow.length - Math.min(100, backWindow.length);
    const bmGlobal = new RegExp(BRACE_RE.source, 'gu');
    let lastBm = null, bmTmp;
    while ((bmTmp = bmGlobal.exec(nearSlice)) !== null) lastBm = bmTmp;
    if (lastBm) {
      const content = braceContent(lastBm);
      if (content && content.length >= 4) {
        text = content;
        const rawStart = backStart + nearOffset + lastBm.index + lastBm[0].indexOf(lastBm[1] ?? lastBm[2]);
        innerStart = rawStart; innerEnd = rawStart + text.length; confidence = 'high';
      }
    }
    if (!text) {
      const leadSlice = backWindow.slice(Math.max(0, backWindow.length - 200));
      const leadOffset = backWindow.length - Math.min(200, backWindow.length);
      const leadGlobal = new RegExp(LEAD_IN_RE.source, 'gu');
      let lastLead = null, lm;
      while ((lm = leadGlobal.exec(leadSlice)) !== null) lastLead = lm;
      if (lastLead) {
        const leadEndInSlice = lastLead.index + lastLead[0].length;
        const between = leadSlice.slice(leadEndInSlice).replace(/[\x00{«»}()]/g, ' ');
        const arabicMatch = new RegExp('^\\s*(' + AR_RUN + ')', 'u').exec(between);
        if (arabicMatch) {
          const extracted = arabicMatch[1].trim();
          if (extracted.length >= 8 && extracted.length <= 200) {
            const leadEndAbs = backStart + leadOffset + leadEndInSlice;
            innerStart = leadEndAbs + between.indexOf(arabicMatch[1]);
            innerEnd = innerStart + extracted.length;
            text = extracted; confidence = 'high';
          }
        }
      }
    }
    if (!text) {
      const arRunRe = new RegExp(AR_RUN + '$', 'u');
      const arMatch = arRunRe.exec(backWindow.replace(/[{}«»()\x00]/g, ' '));
      if (arMatch && arMatch[0].trim().length >= 8 && arMatch[0].trim().length <= 150) {
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
    const text1 = braceContent(bm1), text2 = braceContent(bm2);
    if (!text1 || text1.length < 4 || !text2 || text2.length < 4) continue;
    const afterBrace2 = combined.slice(sepEnd + fwdWin.indexOf(bm2[0]) + bm2[0].length, sepEnd + 250);
    const refMatch = new RegExp(REF_RE.source, 'u').exec(afterBrace2);
    const ref = refMatch ? refMatch[0] : null;
    const backOffset = Math.max(0, sepStart - 150);
    const innerStart1 = backOffset + backWin.indexOf(bm1[0]) + bm1[0].indexOf(bm1[1] ?? bm1[2]);
    const innerEnd1 = innerStart1 + text1.length;
    const r1 = resolveRange(innerStart1, innerEnd1, textNodes, map);
    if (r1 && !alreadyCovered.some(([s, e]) => innerStart1 < e && innerEnd1 > s)) {
      candidates.push({ ...r1, ref, strategy: 'rangeConstruct', confidence: 'high', charStart: innerStart1, charEnd: innerEnd1 });
      alreadyCovered.push([innerStart1, innerEnd1]);
    }
    const innerStart2 = sepEnd + fwdWin.indexOf(bm2[0]) + bm2[0].indexOf(bm2[1] ?? bm2[2]);
    const innerEnd2 = innerStart2 + text2.length;
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

function runExtractionStrategies(textNodes, combined, map) {
  const covered = [];
  const s1 = extractLeadInBraced(combined, map, textNodes);
  for (const c of s1) covered.push([c.charStart, c.charEnd]);
  const s3 = extractRangeConstruct(combined, map, textNodes, covered);
  const s2 = extractExplicitRefBackward(combined, map, textNodes, covered);
  const s4 = extractShortFragmentWithRef(combined, map, textNodes, covered);
  const all = [...s1, ...s3, ...s2, ...s4].sort((a, b) => a.charStart - b.charStart);
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

function wrapTextNodes(nodes, startOffset, endOffset, cssClass, dataAttrs) {
  if (!nodes || nodes.length === 0) return null;
  try {
    const span = document.createElement('span');
    span.className = cssClass;
    for (const [k, v] of Object.entries(dataAttrs)) { if (v != null) span.dataset[k] = v; }
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
  const findingId = `qf-${STATE.findings.length + 1}`;
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
      domPath: '',       // TODO T037: compute sha1-based composite id
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
      deviation: result.deviation,
      strategy: candidate.strategy,
    };
    STATE.findings.push(finding);
  }
  return span;
}

function clearHighlights({ normalize = true } = {}) {
  const spans = document.querySelectorAll(HIGHLIGHT_SELECTOR);
  for (const span of spans) span.replaceWith(...span.childNodes);
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

  const scanId = crypto.randomUUID();
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

      const perCategoryCount = { green: 0, lightBlue: 0, yellow: 0, orange: 0, red: 0 };

      for (const candidate of candidates) {
        if (!liftCap && STATE.findings.length >= SCAN_CAP) {
          STATE.capHit = true;
          break;
        }

        try {
          let result;
          if (candidate.ref) {
            result = await sendToBackground({ type: 'verifyFragmentByRef', text: candidate.text, ref: candidate.ref, candidateConfidence: candidate.confidence });
          } else {
            result = await sendToBackground({ type: 'verifyFragment', text: candidate.text, candidateConfidence: candidate.confidence });
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
    STATS.mutationsObserved += mutations.length;
    const roots = new Set();
    for (const m of mutations) {
      if (m.addedNodes.length > 0) roots.add(m.target);
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
    const resp = await sendToBackground({ type: 'PREFS_READ', requestId: crypto.randomUUID(), payload: {} });
    const prefs = resp?.payload?.result || resp?.result;
    if (prefs?.scanTrigger === 'autoscan') {
      await scanPage();
      setupMutationObserver();
    }
  } catch (_) {}
}

// ── Highlight clearing ────────────────────────────────────────────────────────
// Already defined above.

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

// ── Popup message listener (T017) ─────────────────────────────────────────────

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

    // DATA_UNAVAILABLE — refuse to scan
    if (type === 'DATA_UNAVAILABLE') {
      console.warn('[QuranExt] Data unavailable:', payload);
      return;
    }
    // DATA_AVAILABLE — re-enable
    if (type === 'DATA_AVAILABLE') {
      return;
    }
    // PREFS_CHANGED — content can re-render if needed (stub for now)
    if (type === 'PREFS_CHANGED') {
      return;
    }
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', maybeAutoscan);
} else {
  maybeAutoscan();
}
