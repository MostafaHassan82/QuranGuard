'use strict';
// T053 — Panel keyboard model (FR-030). Scoped key handler that fires only
// while focus is inside the panel root. Implemented as a generic attach() so
// both surfaces (popup #panel-container and the page-injected sidebar root)
// can use the same key map with different DOM selectors.
//
// Key map:
//   ArrowUp / ArrowDown — move row focus through every section (active /
//                         recently corrected / dismissed / previously dismissed)
//                         in render order.
//   Enter               — primary action: jump-to-highlight (FR-011a).
//   C / S / R / J       — copy / share / report / copy-as-JSON (FR-011b–d).
//   F / D               — correct-in-place / dismiss; declared but no-op
//                         until US4 ships the writers (FR-012, FR-025).
//   Space               — toggle the focused filter chip's checkbox.
//   Escape              — exit the panel; first press returns focus to the
//                         surface root, second press blurs out (the host page
//                         in the sidebar, the popup root in the popup surface).
const QuranPanelKeyboard = (() => {
  // Single-letter shortcuts map to action kinds in QuranActions / surface
  // runAction. F + D currently dispatch a no-op kind that surfaces ignore.
  const SHORTCUTS = {
    c: 'copy',  s: 'share', r: 'report', j: 'json',
    f: 'correctInPlace', d: 'dismiss',
  };

  // Attach the key handler to `surfaceRoot` (the panel's outer container).
  // opts: { rowSelector, chipSelector, onAction(kind, findingId), onEscape() }
  //   - rowSelector + chipSelector are surface-specific class names.
  //   - onAction is the surface's existing per-row action dispatcher.
  //   - onEscape is invoked on the second Esc press; the first press just
  //     pulls focus back to surfaceRoot. If onEscape is omitted, the second
  //     press falls back to blurring the active element.
  // Returns a detach() function.
  function attach(surfaceRoot, opts) {
    if (!surfaceRoot || !opts) return () => {};
    const { rowSelector, chipSelector, onAction, onEscape } = opts;

    function rows() {
      return Array.from(surfaceRoot.querySelectorAll(rowSelector));
    }
    function focusedRow() {
      const a = document.activeElement;
      if (!a) return null;
      return a.matches(rowSelector) ? a : a.closest(rowSelector);
    }
    function moveFocus(delta) {
      const list = rows();
      if (list.length === 0) return;
      const cur = focusedRow();
      let idx = cur ? list.indexOf(cur) : -1;
      idx = idx === -1 ? (delta > 0 ? 0 : list.length - 1) : idx + delta;
      idx = Math.max(0, Math.min(list.length - 1, idx));
      list[idx].focus();
    }
    function findingIdFor(rowEl) {
      return rowEl?.dataset?.findingId || null;
    }

    function onKey(e) {
      // Scope: only fire while focus is inside our surface root.
      if (!surfaceRoot.contains(document.activeElement)) return;

      const key = e.key;
      const row = focusedRow();

      if (key === 'ArrowDown') { e.preventDefault(); moveFocus(+1); return; }
      if (key === 'ArrowUp')   { e.preventDefault(); moveFocus(-1); return; }

      if (key === 'Enter' && row) {
        e.preventDefault();
        const id = findingIdFor(row);
        if (id) onAction?.('jump', id);
        return;
      }

      if (key === 'Escape') {
        e.preventDefault();
        const a = document.activeElement;
        if (a && a !== surfaceRoot && surfaceRoot.contains(a)) {
          // First press: pull focus back to the surface root.
          if (surfaceRoot.tabIndex < 0) surfaceRoot.tabIndex = -1;
          surfaceRoot.focus({ preventScroll: true });
        } else {
          // Second press: leave the panel.
          if (onEscape) onEscape();
          else if (a && typeof a.blur === 'function') a.blur();
        }
        return;
      }

      if (key === ' ' || key === 'Spacebar') {
        // Space inside the panel must never trigger the host page's default
        // page-down scroll. Always preventDefault; toggle a chip if one is
        // focused, otherwise consume the keystroke silently.
        e.preventDefault();
        const chip = chipSelector ? document.activeElement?.closest?.(chipSelector) : null;
        if (chip) {
          const cb = chip.querySelector('input[type=checkbox]');
          if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        return;
      }

      // Single-letter shortcuts. Lowercase the key so caps lock doesn't
      // disable them. Bail when a modifier is held — Ctrl+C, ⌘+C etc. are
      // OS-level copy and must NOT be intercepted.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const kind = SHORTCUTS[key.toLowerCase()];
      if (kind && row) {
        e.preventDefault();
        const id = findingIdFor(row);
        if (id) onAction?.(kind, id);
      }
    }

    surfaceRoot.addEventListener('keydown', onKey);
    return () => surfaceRoot.removeEventListener('keydown', onKey);
  }

  return { attach };
})();
