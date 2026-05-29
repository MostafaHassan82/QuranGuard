'use strict';
/*
 * Writer-side autocomplete — editable-surface abstraction (feature 003, T005).
 *
 * Normalizes the two surface kinds the orchestrator works with:
 *   - <input>/<textarea>: text-only; caret via selectionStart, edits via value
 *     splicing. Caret pixel position is approximate (element box) — the dropdown
 *     only needs to be near the field, not glyph-perfect.
 *   - contenteditable: markup-capable; caret/text via the Selection/Range API,
 *     scoped to the caret's current text node (a citation is typed contiguously
 *     into one node).
 *
 * Exposed as the QuranComposeEditable global.
 */
const QuranComposeEditable = (() => {

  function surfaceOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      // Only free-text inputs; skip checkbox/date/number/etc.
      return (t === 'text' || t === 'search' || t === '') ? 'input' : null;
    }
    if (el.isContentEditable) return 'contenteditable';
    return null;
  }

  // Nearest block-level ancestor of `node` within `root` (else `root` itself).
  // Managed editors (e.g. WhatsApp's Lexical composer) wrap each typed line in a
  // <p>/<div> and split it into several inline <span> text nodes; the block is
  // the right unit to read the whole line being typed.
  function blockAncestor(node, root) {
    let n = node && node.nodeType === 1 ? node : (node ? node.parentNode : null);
    while (n && n !== root && root.contains(n)) {
      const tag = n.tagName;
      if (tag === 'P' || tag === 'DIV' || tag === 'LI' || tag === 'PRE') return n;
      n = n.parentNode;
    }
    return root;
  }

  // Map a character offset (counted over text nodes, document order — the same
  // basis as Range.toString()) to a concrete {node, offset} DOM point in `root`.
  function textOffsetToPoint(root, offset) {
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = offset, node, last = null;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      last = node;
      if (remaining <= len) return { node, offset: remaining };
      remaining -= len;
    }
    if (last) return { node: last, offset: last.textContent.length };
    return { node: root, offset: 0 };
  }

  // Returns { surface, el, node, text, before, caret } or null when there is no
  // usable collapsed caret. `node` is the container being edited; `caret` is the
  // offset within `text` (character count); `before` is text up to the caret.
  function getContext(el) {
    const surface = surfaceOf(el);
    if (!surface) return null;
    if (surface === 'input' || surface === 'textarea') {
      const caret = (el.selectionStart != null) ? el.selectionStart : el.value.length;
      return { surface, el, node: el, text: el.value, before: el.value.slice(0, caret), caret };
    }
    // contenteditable
    const doc = el.ownerDocument || document;
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const anchorNode = sel.anchorNode;
    if (!anchorNode || !el.contains(anchorNode)) return null;
    // Read the whole block before the caret, not just the caret's single text
    // node — a citation's lead-in ("قال تعالى") and the ayah words can land in
    // separate text nodes inside the same line (Lexical-style editors). Reading
    // one node hid the lead-in and detection never fired. A Range from the start
    // of the block to the caret concatenates across nodes (no element-boundary
    // separators), which matches how textOffsetToPoint maps offsets back.
    const block = blockAncestor(anchorNode, el);
    let before;
    try {
      const pre = doc.createRange();
      pre.selectNodeContents(block);
      pre.setEnd(anchorNode, sel.anchorOffset);
      before = pre.toString();
    } catch (_) { return null; }
    return { surface, el, node: block, text: block.textContent || '', before, caret: before.length };
  }

  // Replace [start, end) within the editing context with newText, then place the
  // caret right after the inserted text. Plain text only (US1); styled markup is
  // layered on top in US4 (render-editable.js).
  function replaceRange(ctx, start, end, newText) {
    if (ctx.surface === 'input' || ctx.surface === 'textarea') {
      const el = ctx.el;
      const v = el.value;
      el.value = v.slice(0, start) + newText + v.slice(end);
      const pos = start + newText.length;
      try { el.setSelectionRange(pos, pos); } catch (_) {}
      return pos;
    }
    // contenteditable: delete [start, end) and insert newText via a DOM Range,
    // mapping the character offsets across however many text nodes the block
    // spans (so this works in editors that split a line into multiple nodes).
    const root = ctx.node;
    const doc = root.ownerDocument || document;
    const pos = start + newText.length;
    try {
      const a = textOffsetToPoint(root, start);
      const b = textOffsetToPoint(root, end);
      const range = doc.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      range.deleteContents();
      const tn = doc.createTextNode(newText);
      range.insertNode(tn);
      const after = doc.createRange();
      after.setStart(tn, tn.length);
      after.collapse(true);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(after);
    } catch (_) {}
    return pos;
  }

  // Wrap [start, end) in a <span class=classNames> WITHOUT changing the text — a
  // minimal in-editor mark. US3 uses this for the not-recognized red flag (FR-008);
  // US4's render-editable.js layers full verdict/Quran-font rendering on top.
  // contenteditable only — plain inputs can't carry markup (FR-018b), so it's a
  // no-op there. Returns true iff the span was applied.
  function markRange(ctx, start, end, classNames) {
    if (!ctx || ctx.surface !== 'contenteditable' || end <= start) return false;
    const root = ctx.node;
    const doc = root.ownerDocument || document;
    try {
      const a = textOffsetToPoint(root, start);
      const b = textOffsetToPoint(root, end);
      const range = doc.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const span = doc.createElement('span');
      span.className = classNames;
      // surroundContents throws when the range crosses element boundaries; fall
      // back to extract+wrap, which tolerates a multi-node span (split editors).
      try {
        range.surroundContents(span);
      } catch (_) {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }
      return true;
    } catch (_) { return false; }
  }

  // Approximate caret viewport rect for positioning the dropdown.
  function caretRect(ctx) {
    if (ctx.surface === 'contenteditable') {
      try {
        const sel = (ctx.el.ownerDocument || document).getSelection();
        if (sel && sel.rangeCount) {
          const r = sel.getRangeAt(0).getBoundingClientRect();
          if (r && (r.width || r.height || r.top || r.left)) return r;
        }
      } catch (_) {}
    }
    // input/textarea (and contenteditable fallback): anchor under the field.
    const b = ctx.el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.bottom, bottom: b.bottom, width: b.width, height: 0 };
  }

  return { surfaceOf, getContext, replaceRange, markRange, caretRect };
})();
