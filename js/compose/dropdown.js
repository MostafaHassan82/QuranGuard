'use strict';
/*
 * Writer-side autocomplete — caret-anchored suggestion dropdown (feature 003, T012).
 *
 * Pure view: renders the ranked candidate list near the caret and reports
 * selection/click back to the orchestrator. It owns no matching or insertion
 * logic. Keyboard handling (Tab/Enter/Arrows) and the "no Esc" rule live in the
 * orchestrator (index.js), which calls setSelected/accept here.
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

  function hide() {
    if (el) el.style.display = 'none';
    items = [];
    onPick = null;
  }

  function isVisible() {
    return !!(el && el.style.display !== 'none' && el.isConnected);
  }

  function count() { return items.length; }

  return { show, hide, setSelected, isVisible, count };
})();
