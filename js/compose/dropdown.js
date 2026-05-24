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
    position(node, rect);
    node.style.display = 'block';
  }

  function position(node, rect) {
    const sx = window.scrollX || window.pageXOffset || 0;
    const sy = window.scrollY || window.pageYOffset || 0;
    // Anchor below the caret; clamp into the viewport horizontally.
    let left = (rect.left || 0) + sx;
    const top = (rect.bottom || rect.top || 0) + sy + 2;
    node.style.top = top + 'px';
    node.style.left = Math.max(4 + sx, left) + 'px';
  }

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
