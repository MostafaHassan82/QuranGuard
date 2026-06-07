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

  // Wrap [start, end) of a contenteditable block in a verdict-colored span,
  // and (when opts.refStart/refEnd are supplied) wrap the cited reference in
  // a .quran-ref-marker sibling — same decoration shape the reader-side
  // emits. Returns true when both wraps land cleanly and the text content
  // verifies unchanged; false otherwise (the author's text stays exactly as
  // it was — no partial mutation reaches the user).
  //
  // Plain <input>/<textarea> return false (cannot hold markup). Framework
  // editors (Lexical/Draft/ProseMirror) return false — their reconcilers
  // would drop the wrap.
  //
  // opts:
  //   fontFamily — applied to the ayah span (Quran font).
  //   refStart, refEnd — root-relative offsets of the cited reference inside
  //                      the inserted text. Omit for single-span rendering
  //                      (fall-through and focus-render paths that don't know
  //                      the body/ref split).
  //   claimedRef, matchedRef — written to the ayah span's dataset.
  //   tooltip   — pre-built tooltip text (caller uses QuranTooltip.build).
  function mark(ctx, start, end, verdict, opts) {
    if (!ctx || ctx.surface !== 'contenteditable') return false;   // FR-018b: inputs are text-only
    if (!VERDICTS.has(verdict)) return false;
    if (!(end > start)) return false;
    const root = ctx.node;
    if (!root || !root.ownerDocument) return false;
    // Constitution #1: never alter the ayah. In framework editors the splice
    // below would be reconciled away and drop the author's text — bail out.
    if (isFrameworkEditor(ctx.el || root)) return false;
    if (typeof QuranDecoration === 'undefined') return false;
    const doc = root.ownerDocument;
    const tc = root.textContent || '';
    const expectedAyah = tc.slice(start, end);
    if (!expectedAyah) return false;

    const wantRef = opts && Number.isFinite(opts.refStart) && Number.isFinite(opts.refEnd)
      && opts.refEnd > opts.refStart;
    const expectedRef = wantRef ? tc.slice(opts.refStart, opts.refEnd) : null;

    let refSpanOut = null;
    try {
      // Wrap the reference first when present. Order is incidental for
      // textContent (slice offsets stay valid across either order), but
      // doing the smaller/optional one first keeps the failure mode
      // simple — if ayah wrapping fails afterward, we bail with only the
      // ref marker in place, which still satisfies Constitution #1
      // (text content byte-identical).
      if (wantRef) {
        const ra = pointAt(root, opts.refStart);
        const rb = pointAt(root, opts.refEnd);
        const refRange = doc.createRange();
        refRange.setStart(ra.node, ra.offset);
        refRange.setEnd(rb.node, rb.offset);
        if (refRange.toString() !== expectedRef) return false;
        const refRes = QuranDecoration.wrapRefMarker({
          range: refRange,
          claimedRef: opts && opts.claimedRef,
          guard: 'writer',
        });
        if (!refRes.ok) return false;
        refSpanOut = refRes.span;
      }

      // Build the ayah range fresh from the current DOM — pointAt walks
      // live text nodes, so a prior ref wrap doesn't invalidate offsets.
      const aa = pointAt(root, start);
      const ab = pointAt(root, end);
      const ayahRange = doc.createRange();
      ayahRange.setStart(aa.node, aa.offset);
      ayahRange.setEnd(ab.node, ab.offset);
      if (ayahRange.toString() !== expectedAyah) return false;

      const extraClass = 'quran-ac-cite' + (opts && opts.fontFamily ? ' quran-ac-cite-quranfont' : '');
      const ayahRes = QuranDecoration.apply({
        range: ayahRange,
        color: verdict,
        claimedRef: opts && opts.claimedRef,
        matchedRef: opts && opts.matchedRef,
        tooltip:    opts && opts.tooltip,
        ariaLabel:  opts && opts.ariaLabel,
        fontFamily: opts && opts.fontFamily,
        extraClass,
        guard: 'writer',
      });
      if (!ayahRes.ok) return false;
      // Async ref-marker decoration (tooltip ayah text + quran.com link).
      // Fire-and-forget — the structural wrap is already in place, so even
      // if the resolve fails the marker stays correctly classed.
      if (refSpanOut && opts && opts.refDecorationDeps && typeof QuranRefDecoration !== 'undefined') {
        QuranRefDecoration.decorate(refSpanOut, opts.claimedRef, opts.refDecorationDeps);
      }
      return true;
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
