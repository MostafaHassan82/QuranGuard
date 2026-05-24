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

  // Returns { surface, el, node, text, before, caret } or null when there is no
  // usable collapsed caret. `node` is the text container being edited; `caret`
  // is the offset within `text`; `before` is text up to the caret.
  function getContext(el) {
    const surface = surfaceOf(el);
    if (!surface) return null;
    if (surface === 'input' || surface === 'textarea') {
      const caret = (el.selectionStart != null) ? el.selectionStart : el.value.length;
      return { surface, el, node: el, text: el.value, before: el.value.slice(0, caret), caret };
    }
    // contenteditable
    const sel = (el.ownerDocument || document).getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3) return null;            // need a text node
    if (!el.contains(node)) return null;
    const caret = sel.anchorOffset;
    const text = node.textContent || '';
    return { surface, el, node, text, before: text.slice(0, caret), caret };
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
    // contenteditable: splice within the text node, restore the caret.
    const node = ctx.node;
    const t = node.textContent || '';
    node.textContent = t.slice(0, start) + newText + t.slice(end);
    const pos = start + newText.length;
    try {
      const doc = node.ownerDocument || document;
      const range = doc.createRange();
      const max = (node.textContent || '').length;
      range.setStart(node, Math.min(pos, max));
      range.collapse(true);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
    return pos;
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

  return { surfaceOf, getContext, replaceRange, caretRect };
})();
