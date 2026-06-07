'use strict';
/*
 * Shared verdict-decoration renderer.
 *
 * Both the reader-side classifier (js/content.js) and the writer-side compose
 * autocomplete (js/compose/*) produce the same visual decoration shape — a
 * verdict-colored span over the ayah body, plus an optional .quran-ref-marker
 * over the cited reference, both carrying tooltip + ARIA + dataset hooks.
 * This module owns that markup so the two pipelines stay in lockstep.
 *
 * Constitution non-negotiable #1: rendering is purely additive. apply() and
 * wrapRefMarker() only wrap existing characters; they never delete, splice, or
 * rewrite content. The 'writer' guard additionally bails out in framework
 * editors (Lexical/Draft/ProseMirror — they reconcile foreign DOM mutations
 * away and would drop the author's text) and verifies the wrapped text is
 * byte-identical to what was there before.
 *
 * Phase 1 of refactor/unified-decoration — exposed as QuranDecoration but not
 * yet wired into either pipeline; reader and writer keep their inline wrap
 * logic until phases 2 and 3 migrate them.
 *
 * Class-name source of truth: mirrors js/content.js's CSS_BY_COLOR and
 * REF_MARKER_CLASS by construction. The reader's HIGHLIGHT_SELECTOR walker
 * filter depends on these exact strings — they must NOT diverge. Phase 3
 * makes content.js consume CSS_BY_COLOR from here directly.
 */
const QuranDecoration = (() => {
  const CSS_BY_COLOR = {
    green:      'quran-green',
    lightBlue:  'quran-lightblue',
    yellow:     'quran-yellow',
    orange:     'quran-orange',
    red:        'quran-red',
    lightGreen: 'quran-lightgreen',
  };
  const REF_MARKER_CLASS = 'quran-ref-marker';
  const ALL_COLOR_CLASSES = Object.values(CSS_BY_COLOR);

  // Mirrors js/compose/render-editable.js's isFrameworkEditor — these editors
  // maintain their own document model and reconcile any foreign DOM mutation
  // against it, which would drop the author's text. Writer guard refuses to
  // wrap inside them; the caller falls back to plain text.
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

  function classFor(color) { return CSS_BY_COLOR[color] || ''; }

  function setSpanMetadata(span, params) {
    const { color, claimedRef, matchedRef, tooltip, ariaLabel, findingId, fontFamily } = params;
    if (color != null) span.dataset.color = color;
    if (claimedRef != null) span.dataset.claimedRef = claimedRef;
    if (matchedRef != null) span.dataset.matchedRef = matchedRef;
    if (tooltip != null) span.dataset.tooltip = tooltip;
    if (findingId != null) span.dataset.findingId = findingId;
    if (fontFamily) span.style.fontFamily = fontFamily;
    span.setAttribute('tabindex', '0');
    span.setAttribute('role', 'mark');
    const label = ariaLabel != null ? ariaLabel : tooltip;
    if (label) span.setAttribute('aria-label', label);
  }

  // Wrap a Range in a verdict-colored span. Returns { ok, span } or
  // { ok: false, reason }. Caller composes — for a citation with a separate
  // reference paren, call wrapRefMarker FIRST (later offsets) then apply()
  // (earlier offsets) so each extractContents call doesn't invalidate the
  // sibling range. params.guard selects safety preconditions:
  //   'reader' — caller is trusted (text walker has already vetted the run)
  //   'writer' — runs isFrameworkEditor check + text-equality invariant
  function apply(params) {
    if (!params || !params.range || !classFor(params.color)) return { ok: false, reason: 'bad-params' };
    const { range, color, guard, extraClass, fontFamily } = params;
    const doc = (range.startContainer && range.startContainer.ownerDocument) || document;

    if (guard === 'writer') {
      const c = range.commonAncestorContainer;
      const el = c && (c.nodeType === 1 ? c : c.parentElement);
      if (!el) return { ok: false, reason: 'no-element' };
      if (isFrameworkEditor(el)) return { ok: false, reason: 'framework-editor' };
    }

    const expected = range.toString();
    if (!expected) return { ok: false, reason: 'empty-range' };

    let span;
    try {
      span = doc.createElement('span');
      span.className = classFor(color);
      if (extraClass) {
        for (const c of String(extraClass).split(/\s+/).filter(Boolean)) span.classList.add(c);
      }
      setSpanMetadata(span, params);
      span.appendChild(range.extractContents());
      range.insertNode(span);
    } catch (e) {
      return { ok: false, reason: 'dom-error', error: e };
    }

    if (guard === 'writer' && span.textContent !== expected) {
      return { ok: false, reason: 'text-drift', span };
    }
    return { ok: true, span };
  }

  // Wrap a Range in a .quran-ref-marker. Caller is responsible for any async
  // decoration (resolveReference + tooltip + quran.com link wiring) — see
  // js/content.js's decorateRefMarker which the reader keeps owning because it
  // depends on STATE.prefs and sendToBackground. We just emit the structural
  // span here so both pipelines agree on its shape.
  function wrapRefMarker(params) {
    if (!params || !params.range) return { ok: false, reason: 'bad-params' };
    const { range, claimedRef, guard } = params;
    const doc = (range.startContainer && range.startContainer.ownerDocument) || document;
    if (guard === 'writer') {
      const c = range.commonAncestorContainer;
      const el = c && (c.nodeType === 1 ? c : c.parentElement);
      if (!el) return { ok: false, reason: 'no-element' };
      if (isFrameworkEditor(el)) return { ok: false, reason: 'framework-editor' };
    }
    const expected = range.toString();
    if (!expected) return { ok: false, reason: 'empty-range' };
    let span;
    try {
      span = doc.createElement('span');
      span.className = REF_MARKER_CLASS;
      if (claimedRef) span.dataset.quranRef = claimedRef;
      span.appendChild(range.extractContents());
      range.insertNode(span);
    } catch (e) {
      return { ok: false, reason: 'dom-error', error: e };
    }
    if (guard === 'writer' && span.textContent !== expected) {
      return { ok: false, reason: 'text-drift', span };
    }
    return { ok: true, span };
  }

  // In-place class/dataset swap for an existing span — used by the reader's
  // pending → final transition. The pending span is already wrapped around the
  // text; we only need to update its verdict color and metadata, never re-wrap.
  function upgrade(span, params) {
    if (!span || !params || !classFor(params.color)) return { ok: false, reason: 'bad-params' };
    for (const c of ALL_COLOR_CLASSES) span.classList.remove(c);
    span.classList.add(classFor(params.color));
    setSpanMetadata(span, params);
    return { ok: true, span };
  }

  return { apply, wrapRefMarker, upgrade, classFor, CSS_BY_COLOR, REF_MARKER_CLASS };
})();
