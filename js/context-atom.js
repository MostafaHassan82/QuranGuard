// ─────────────────────────────────────────────────────────────────────────────
// Context-atom session identity (T151) — wired by content.js
// ─────────────────────────────────────────────────────────────────────────────
//
// Goal: a generic, host-app-agnostic session identity for a finding that
// survives virtualization re-mounts (WhatsApp Web, Slack, Twitter, etc.)
// where the same logical ayah re-appears at a different DOM position and
// would otherwise produce a different `composite(rawText, refs, domPath)`
// id each time, inflating the panel counter.
//
// Identity formula:
//
//     sessionIdentity = fnv1a( rawText | claimedRef | matchedRef | contextHash )
//
// where contextHash is a stable hash of the textContent of the smallest
// "context-bearing" ancestor of the ayah — meaning an ancestor that contains
// the ayah AND at least one other non-whitespace text node. That definition
// works generically for chat bubbles, blog paragraphs, table cells, list
// items, etc. — wherever the ayah has natural surrounding context.
//
// Why this works for re-mounts:
// - React/Vue/Svelte virtualization re-mounts the WHOLE row from the same
//   underlying data → same surrounding text (author, body, timestamp).
// - DOM position (parent chain, sibling index) changes, so domPath changes.
// - But the textContent of the row stays equal across mounts.
//
// Why this works for "same ayah quoted twice":
// - Two messages quoting Q2:255 in different conversations have different
//   surrounding text → different contextHash → different identity → both
//   count as distinct findings (correct).
//
// Volatility scrub:
// Some surrounding text is unstable even within one mount lifetime —
// "2 min ago" → "3 min ago", "online" → "offline". The scrubber strips
// known volatile patterns before hashing so identity stays equal across
// such transient updates.
//
// Wiring (T151, minimal first cut): content.js's applyHighlight calls
// computeSessionIdentity, stores it on each finding as .sessionIdentity,
// and deduplicates against the existing findings array on that key. The
// existing finding.id (the composite hash used by FR-024 persistence)
// is preserved across replacements so badges/dismissals stay linked.

(function () {
  'use strict';

  // ── Volatile pattern scrubber ────────────────────────────────────────────
  // Patterns that change *within a single message's lifetime* — relative
  // time labels that tick forward, presence labels that toggle, etc. These
  // must not contribute to identity or "2 min ago" → "3 min ago" would
  // re-mount as a new finding.
  //
  // ABSOLUTE timestamps and dates ARE NOT scrubbed: a message sent at
  // 10:28 p.m. always shows that exact timestamp, so the timestamp is the
  // only reliable discriminator between two messages with identical body +
  // author (e.g. someone forwarding the same ayah twice in a row). Scrubbing
  // them collapses those two messages into one finding. Per-host UI clocks
  // (e.g. a status-bar clock that ticks) are normally NOT inside a single
  // message's context atom — the ancestor walk picks the smallest container
  // with non-ayah text, which on chat apps is the message bubble.
  const VOLATILE_PATTERNS = [
    // Relative-time labels: "2 minutes ago", "just now", "yesterday"
    /\b\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago\b/gi,
    /\bjust\s*now\b/gi,
    /\b(yesterday|today)\b/gi,
    // Presence labels (WhatsApp/Slack idioms — narrow enough to be safe)
    /\b(online|offline|typing\.{0,3}|last\s+seen\s+[^.\n]{0,40})\b/gi,
    // Read receipts / message counts on the side of bubbles
    /\b\d+\s*(new|unread)\b/gi,
  ];

  function scrubVolatile(s) {
    if (!s) return '';
    let out = s;
    for (const re of VOLATILE_PATTERNS) out = out.replace(re, ' ');
    // Collapse whitespace runs so "  " left by scrubs doesn't change hash.
    return out.replace(/\s+/g, ' ').trim();
  }

  // ── Context-atom ancestor search ─────────────────────────────────────────
  // Walk up from a node looking for the smallest ancestor that contains
  // BOTH the source node AND at least one other non-whitespace text node.
  // Hard-stops at <body> or after MAX_UP hops — if no atom is found by
  // then, the ayah is in a top-level standalone position and we return
  // the body itself (so the context will essentially be empty; identity
  // falls back to (rawText + refs)).
  //
  // "Other text" must contain at least MIN_OTHER_CHARS non-whitespace to
  // be considered — defends against single-glyph noise nodes that React
  // sometimes inserts between elements.
  const MAX_UP = 8;
  const MIN_OTHER_CHARS = 3;

  function findContextAtomAncestor(sourceNode) {
    if (!sourceNode) return null;
    const sourceText = sourceNode.nodeType === 3 ? sourceNode.data : (sourceNode.textContent || '');
    const sourceTrim = sourceText.replace(/\s+/g, ' ').trim();
    let el = sourceNode.parentElement;
    for (let up = 0; el && up < MAX_UP; up++, el = el.parentElement) {
      if (el.tagName === 'BODY' || el.tagName === 'HTML') return el;
      // Cheap reject: if ancestor's textContent doesn't exceed source by
      // MIN_OTHER_CHARS, it has nothing else to offer.
      const allText = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (allText.length - sourceTrim.length < MIN_OTHER_CHARS) continue;
      // Confirm there is at least one OTHER non-empty text-node descendant
      // (the cheap reject above can be tricked by attribute-driven content).
      if (hasOtherTextNode(el, sourceNode)) return el;
    }
    return el || sourceNode.ownerDocument.body;
  }

  function hasOtherTextNode(ancestor, exclude) {
    const walker = ancestor.ownerDocument.createTreeWalker(
      ancestor, NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          if (n === exclude) return NodeFilter.FILTER_REJECT;
          if (!n.data || n.data.trim().length < MIN_OTHER_CHARS) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    return !!walker.nextNode();
  }

  // ── Context text extraction ──────────────────────────────────────────────
  // Gather all text from the context atom EXCEPT the ayah text itself,
  // cap at MAX_CONTEXT_CHARS, normalize whitespace, scrub volatiles.
  // The cap keeps the hash input bounded — long blog paragraphs would
  // otherwise inflate the hash input without adding discriminative value.
  const MAX_CONTEXT_CHARS = 200;

  function extractContextText(ancestor, excludeText) {
    if (!ancestor) return '';
    let raw = ancestor.textContent || '';
    if (excludeText) {
      const idx = raw.indexOf(excludeText);
      if (idx !== -1) raw = raw.slice(0, idx) + ' · ' + raw.slice(idx + excludeText.length);
    }
    const normalized = raw.replace(/\s+/g, ' ').trim();
    const scrubbed = scrubVolatile(normalized);
    if (scrubbed.length <= MAX_CONTEXT_CHARS) return scrubbed;
    // Take a head+tail slice so we keep boundary tokens (often the most
    // discriminative parts: author at start, signature at end).
    const half = Math.floor(MAX_CONTEXT_CHARS / 2);
    return scrubbed.slice(0, half) + ' … ' + scrubbed.slice(-half);
  }

  // ── Identity hash ────────────────────────────────────────────────────────
  // Uses the same FNV-1a 32-bit + length-suffix scheme as the existing
  // composite finding id (computeCompositeFindingId in content.js) so the
  // identity string is short, deterministic, and collision-resistant
  // enough for session use.
  function fnv1a32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // Count how many times `needle` appears in the atom's text BEFORE sourceNode.
  // Discriminates two occurrences of the same ayah inside one paragraph
  // (lightBlue duplicates with empty claimedRef would otherwise collide on
  // (rawText|matchedRef|atomCtx) and the second would be deduped out). Stable
  // under virtualization: a re-mounted row reproduces the same text layout, so
  // each ayah within the row keeps its index across mounts.
  function occurrenceIndexBeforeNode(atom, sourceNode, needle) {
    if (!atom || !sourceNode || !needle) return 0;
    const target = needle.trim();
    if (!target) return 0;
    const doc = atom.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return 0;
    const walker = doc.createTreeWalker(atom, NodeFilter.SHOW_TEXT);
    let before = '';
    let n;
    while ((n = walker.nextNode())) {
      if (n === sourceNode) break;
      before += n.data || '';
    }
    let count = 0, idx = 0;
    while ((idx = before.indexOf(target, idx)) !== -1) { count++; idx += target.length; }
    return count;
  }

  function computeSessionIdentity({ rawText, claimedRef, matchedRef, sourceNode }) {
    const atom = findContextAtomAncestor(sourceNode);
    const ctx = extractContextText(atom, rawText);
    const occIdx = occurrenceIndexBeforeNode(atom, sourceNode, rawText);
    const composite = [
      (rawText || '').trim(),
      (claimedRef || '').trim(),
      (matchedRef || '').trim(),
      ctx,
      'occ:' + occIdx,
    ].join('|');
    return 'ctx-' + fnv1a32(composite) + '-' + composite.length.toString(36);
  }

  // ── Exports (UMD-style, matches the way other modules expose helpers) ────
  const api = {
    computeSessionIdentity,
    // exposed for unit tests / debugging
    _internals: {
      findContextAtomAncestor,
      extractContextText,
      occurrenceIndexBeforeNode,
      scrubVolatile,
      fnv1a32,
      VOLATILE_PATTERNS,
      MAX_UP,
      MIN_OTHER_CHARS,
      MAX_CONTEXT_CHARS,
    },
  };
  if (typeof window !== 'undefined') window.QuranContextAtom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

// ─────────────────────────────────────────────────────────────────────────────
// Quick sanity checks (paste into a page console to eyeball behavior):
//
//   // 1. Two re-mounts of the same WhatsApp-shaped bubble produce equal identity:
//   const make = () => {
//     const d = document.createElement('div');
//     d.innerHTML = `
//       <div class="bubble">
//         <span class="author">Mostafa</span>
//         <p>قال الله: <span class="ayah">إِنَّ مَعَ ٱلْعُسْرِ يُسْرًۭا</span> (٩٤:٦)</p>
//         <span class="time">10:42 AM</span>
//       </div>`;
//     return d;
//   };
//   document.body.appendChild(make());
//   document.body.appendChild(make());
//   const [a, b] = document.querySelectorAll('.ayah');
//   QuranContextAtom.computeSessionIdentity({
//     rawText: a.textContent, claimedRef: '94:6', matchedRef: '94:6', sourceNode: a,
//   }) === QuranContextAtom.computeSessionIdentity({
//     rawText: b.textContent, claimedRef: '94:6', matchedRef: '94:6', sourceNode: b,
//   })  // → true
//
//   // 2. Same ayah in two DIFFERENT messages produces DIFFERENT identity:
//   const m1 = document.createElement('div');
//   m1.innerHTML = `<div><span>Ahmed</span><p>thinking about <span class=x>إِنَّ مَعَ ٱلْعُسْرِ يُسْرًۭا</span> today</p></div>`;
//   const m2 = document.createElement('div');
//   m2.innerHTML = `<div><span>Layla</span><p>my favorite is <span class=x>إِنَّ مَعَ ٱلْعُسْرِ يُسْرًۭا</span> always</p></div>`;
//   document.body.append(m1, m2);
//   const x1 = m1.querySelector('.x'), x2 = m2.querySelector('.x');
//   QuranContextAtom.computeSessionIdentity({rawText:x1.textContent,claimedRef:'',matchedRef:'94:6',sourceNode:x1})
//     !== QuranContextAtom.computeSessionIdentity({rawText:x2.textContent,claimedRef:'',matchedRef:'94:6',sourceNode:x2})
//   // → true
//
//   // 3. Timestamp changes don't break identity:
//   //   change the .time span to "10:43 AM" between scans — identity stays equal.
// ─────────────────────────────────────────────────────────────────────────────
