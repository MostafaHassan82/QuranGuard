'use strict';
/*
 * Writer-side autocomplete — caret-anchored suggestion dropdown (feature 003,
 * T012 + T017 scope menu / end-word prompt).
 *
 * Pure view. Three renders, all anchored at the caret via the same positioner:
 *   - show()        the ranked candidate list (US1).
 *   - showScope()   the second insertion-scope menu (US2, FR-012a/015).
 *   - showEndWord() the inline end-word prompt for the start-to-end-word scope
 *                   (US2, FR-015c), optionally carrying the "not found" note
 *                   (FR-016).
 * It owns no matching/insertion logic. Keyboard handling (Tab/Enter/Arrows) and
 * the "no Esc" rule live in the orchestrator (index.js); list-item picks are
 * reported via the onPick(index) handler, scope/end-word via their callbacks.
 *
 * Exposed as the QuranComposeDropdown global.
 */
const QuranComposeDropdown = (() => {
  let el = null;
  let items = [];
  let onPick = null;          // (index) => void

  function ensureEl() {
    if (el && el.isConnected) return el;
    el = document.createElement('div');
    el.className = 'quran-ac-menu';
    el.setAttribute('role', 'listbox');
    el.dir = 'rtl';
    // Clicks must not blur the field (which would tear down the caret) — handle
    // on mousedown and preventDefault.
    el.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.quran-ac-item');
      if (!item) return;
      e.preventDefault();
      const idx = parseInt(item.getAttribute('data-idx'), 10);
      if (Number.isFinite(idx) && onPick) onPick(idx);
    });
    document.body.appendChild(el);
    return el;
  }

  function tierClass(tier) {
    return tier === 'wordLevel' ? 'quran-ac-tier-wordLevel'
      : tier === 'fuzzy' ? 'quran-ac-tier-fuzzy' : 'quran-ac-tier-exact';
  }

  function show(candidates, selectedIndex, rect, pickHandler) {
    items = candidates || [];
    onPick = pickHandler;
    const node = ensureEl();
    node.innerHTML = '';
    items.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'quran-ac-item';
      row.setAttribute('role', 'option');
      row.setAttribute('data-idx', String(i));
      row.setAttribute('aria-selected', i === selectedIndex ? 'true' : 'false');
      const ayah = document.createElement('span');
      ayah.className = 'quran-ac-ayah';
      ayah.textContent = c.authenticText;
      const ref = document.createElement('span');
      ref.className = 'quran-ac-ref';
      const dot = document.createElement('span');
      dot.className = 'quran-ac-tier ' + tierClass(c.tier);
      ref.appendChild(document.createTextNode(c.refLabel || ''));
      ref.appendChild(dot);
      row.appendChild(ayah);
      row.appendChild(ref);
      node.appendChild(row);
    });
    // Reveal before positioning so offsetHeight reflects the real rendered menu
    // (the flip-above decision below needs the measured height).
    node.style.display = 'block';
    position(node, rect);
  }

  // The second menu (US2): the three insertion scopes. `scopes` is a list of
  // { key, label }; picking one calls pickHandler(index).
  function showScope(scopes, selectedIndex, rect, pickHandler) {
    items = scopes || [];
    onPick = pickHandler;
    const node = ensureEl();
    node.innerHTML = '';
    items.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'quran-ac-item';
      row.setAttribute('role', 'option');
      row.setAttribute('data-idx', String(i));
      row.setAttribute('aria-selected', i === selectedIndex ? 'true' : 'false');
      row.textContent = s.label;
      node.appendChild(row);
    });
    node.style.display = 'block';
    position(node, rect);
  }

  // Inline end-word prompt for the start-to-end-word scope. Calls onSubmit(word)
  // on Enter. `noteText` (optional) shows a hint or the "not found" message above
  // the input. Item-pick handling is disabled here (no .quran-ac-item rows).
  function showEndWord(rect, onSubmit, promptText, noteText) {
    items = [];
    onPick = null;
    const node = ensureEl();
    node.innerHTML = '';
    if (noteText) {
      const note = document.createElement('div');
      note.className = 'quran-ac-note';
      note.textContent = noteText;
      node.appendChild(note);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'quran-ac-endword';
    input.setAttribute('dir', 'rtl');
    input.setAttribute('placeholder', promptText || '');
    input.addEventListener('keydown', (e) => {
      // Keep keystrokes local — the orchestrator's document-level capture skips
      // end-word mode, but stop bubbling so the host page never sees them.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (onSubmit) onSubmit(input.value.trim());
      }
    });
    // Don't let the mousedown-blur guard above (registered for items) swallow
    // clicks meant to focus the input.
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    node.appendChild(input);
    node.style.display = 'block';
    position(node, rect);
    // Focus so the user can type the end word immediately. index.js guards
    // focusout against focus moving into this menu.
    try { input.focus(); } catch (_) {}
    return input;
  }

  const GAP = 2;          // px between caret and menu
  const VIEWPORT_PAD = 4; // keep this far from the viewport edges

  function position(node, rect) {
    const sx = window.scrollX || window.pageXOffset || 0;
    const sy = window.scrollY || window.pageYOffset || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const caretTop = rect.top || 0;
    const caretBottom = rect.bottom || rect.top || 0;
    const caretLeft = rect.left || 0;

    const spaceBelow = vh - caretBottom;
    const spaceAbove = caretTop;
    // Measure the rendered menu; cap to whichever side we land on so a tall list
    // never spills past the viewport edge (e.g. a field at the very bottom).
    node.style.maxHeight = '';
    const menuHeight = node.offsetHeight;
    const menuWidth = node.offsetWidth;

    // ── Vertical: flip above the caret when there isn't room below AND above has
    // more space (the bottom-of-page case — anchoring below pushed the list under
    // the fold). Cap max-height to the chosen side so it never overflows.
    const flipUp = menuHeight + GAP > spaceBelow && spaceAbove > spaceBelow;
    let top;
    if (flipUp) {
      const avail = Math.max(0, spaceAbove - GAP - VIEWPORT_PAD);
      if (menuHeight > avail) node.style.maxHeight = avail + 'px';
      top = caretTop - GAP - Math.min(menuHeight, avail);
    } else {
      const avail = Math.max(0, spaceBelow - GAP - VIEWPORT_PAD);
      if (menuHeight > avail) node.style.maxHeight = avail + 'px';
      top = caretBottom + GAP;
    }
    // Final guard so the top edge never lands above the viewport either.
    top = clamp(top, VIEWPORT_PAD, Math.max(VIEWPORT_PAD, vh - VIEWPORT_PAD));

    // ── Horizontal: anchor at the caret, then slide left so the full width fits
    // inside the viewport (right-edge case), and never past the left edge.
    let left = caretLeft;
    if (left + menuWidth > vw - VIEWPORT_PAD) left = vw - VIEWPORT_PAD - menuWidth;
    left = Math.max(VIEWPORT_PAD, left);

    // Convert viewport coords → page coords (the menu is position:absolute).
    node.style.top = (top + sy) + 'px';
    node.style.left = (left + sx) + 'px';
  }

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  function setSelected(index) {
    if (!el) return;
    [...el.querySelectorAll('.quran-ac-item')].forEach((row, i) => {
      row.setAttribute('aria-selected', i === index ? 'true' : 'false');
      if (i === index) row.scrollIntoView({ block: 'nearest' });
    });
  }

  // True iff a node (e.g. focusout's relatedTarget) is inside the menu — used by
  // index.js so focusing the end-word input doesn't close the instance.
  function contains(node) { return !!(el && node && el.contains(node)); }

  function hide() {
    if (el) el.style.display = 'none';
    items = [];
    onPick = null;
  }

  function isVisible() {
    return !!(el && el.style.display !== 'none' && el.isConnected);
  }

  function count() { return items.length; }

  return { show, showScope, showEndWord, hide, setSelected, isVisible, count, contains };
})();
