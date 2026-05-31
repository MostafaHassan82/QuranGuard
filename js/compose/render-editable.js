'use strict';
/*
 * Writer-side autocomplete — in-editor verdict + Quran-font rendering
 * (feature 003, T025/T026).
 *
 * Applies feature-001's reader-side verdict palette (the SAME five verdicts —
 * Principle II, no new color) plus the configured Quran font to recognized
 * citations inside an editable field (FR-018):
 *   - contenteditable: applied as REAL, persistent markup the author publishes
 *     (FR-018b) — a verdict-colored span, with the Quran font on matched text.
 *   - plain <input>/<textarea>: cannot hold markup → styling is skipped without
 *     error (FR-018b); only clean text is ever written.
 *
 * NON-NEGOTIABLE: rendering is purely additive. We only WRAP existing characters
 * in a span (text content is preserved byte-for-byte); we never delete, splice,
 * or rewrite the author's text here. Every wrap is guarded by a text-equality
 * check and bails out (leaving the field untouched) if the offsets drifted.
 *
 * The verdict for a writer-side citation is derived from the matcher tier the
 * candidate was offered at (Principle V — reuse the verifier's decision, don't
 * re-classify): exact → green, wordLevel → yellow, fuzzy / no-match → red.
 *
 * Exposed as the QuranComposeRenderEditable global.
 */
const QuranComposeRenderEditable = (() => {
  // The five reader-side verdicts (Principle II). lightBlue/orange are not
  // reachable from the writer-side tier mapping but are accepted so a future
  // caller can pass a full classifier verdict without this gate inventing color.
  const VERDICTS = new Set(['green', 'lightBlue', 'yellow', 'orange', 'red']);

  function verdictForTier(tier) {
    return tier === 'exact' ? 'green' : tier === 'wordLevel' ? 'yellow' : 'red';
  }

  // Reader-side class convention: 'quran-' + lowercased verdict (lightBlue →
  // quran-lightblue). Mirrors js/content.js so the editor reuses content.css.
  function verdictClass(verdict) {
    return 'quran-' + String(verdict || '').toLowerCase();
  }

  // Map a character offset (counted over text nodes in document order — the same
  // basis as textContent / Range.toString()) to a concrete DOM point in `root`.
  // Mirrors editable.js's private textOffsetToPoint.
  function pointAt(root, offset) {
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

  // Resolve the configured Quran font family (and register its @font-face once),
  // or null when the font registry isn't present (e.g. the assertion gate loads
  // the compose bundle without js/render/fonts.js).
  function fontFamily(fontKey) {
    if (typeof QuranFonts === 'undefined') return null;
    try { QuranFonts.ensureLoaded(); return QuranFonts.familyFor(fontKey); }
    catch (_) { return null; }
  }

  // Framework editors (Lexical/Draft/ProseMirror — WhatsApp, Slack, Facebook,
  // Twitter/X, Notion, etc.) maintain their own document model and reconcile any
  // foreign DOM mutation against it, which can drop the surrounding text. Detect
  // them by ancestor signals and skip markup there — text-only is safe.
  function isFrameworkEditor(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.matches && n.matches(
        '[data-lexical-editor], [contenteditable][data-block], ' +
        '.notranslate.public-DraftEditor-content, [data-contents="true"], ' +
        '.ProseMirror, .ql-editor, .ck-editor__editable, .tiptap, ' +
        '[data-slate-editor="true"], [data-tiptap-editor], .fr-element, ' +
        '.trix-content, .mce-content-body'
      )) return true;
      n = n.parentNode;
    }
    return false;
  }

  // Wrap [start, end) of a contenteditable block in a verdict span — additively.
  // Returns true when markup was applied (and the text content verified
  // unchanged), false otherwise. Plain inputs return false (no markup possible).
  // opts: { fontFamily } — when set, the matched text also carries the Quran font.
  function mark(ctx, start, end, verdict, opts) {
    if (!ctx || ctx.surface !== 'contenteditable') return false;   // FR-018b: inputs are text-only
    if (!VERDICTS.has(verdict)) return false;
    if (!(end > start)) return false;
    const root = ctx.node;
    if (!root || !root.ownerDocument) return false;
    // Constitution #1: never alter the ayah. In framework editors the splice
    // below would be reconciled away and drop the author's text — bail out.
    if (isFrameworkEditor(ctx.el || root)) return false;
    const doc = root.ownerDocument;
    const expected = (root.textContent || '').slice(start, end);
    if (!expected) return false;
    try {
      const a = pointAt(root, start);
      const b = pointAt(root, end);
      const range = doc.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      // Offsets drifted (the field changed under us) → do NOT touch the text.
      if (range.toString() !== expected) return false;
      const span = doc.createElement('span');
      span.className = 'quran-ac-cite ' + verdictClass(verdict);
      if (opts && opts.fontFamily) {
        span.classList.add('quran-ac-cite-quranfont');
        span.style.fontFamily = opts.fontFamily;
      }
      // extractContents + insertNode only RE-PARENTS the existing characters into
      // the span; it never drops them. Verified below.
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
      return span.textContent === expected;
    } catch (_) {
      return false;       // any DOM hiccup leaves the author's text exactly as-is
    }
  }

  // Has this field already been verdict-marked? Used to keep pre-existing-on-focus
  // rendering idempotent (FR-018a) so refocus doesn't double-wrap.
  function isMarked(el) {
    return !!(el && el.querySelector && el.querySelector('.quran-ac-cite'));
  }

  return { mark, isMarked, verdictForTier, verdictClass, fontFamily, VERDICTS };
})();
