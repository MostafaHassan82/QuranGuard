'use strict';
// T050 — Page-injected sidebar surface. Runs in the content-script world and
// is the ONLY panel surface (the popup is scan-only). Mounts whenever a scan
// produces findings; the user can collapse it to a tab but not close it. Hosts
// the findings list, filters, swap controls, and saved-corrections settings
// (FR-010, FR-027, FR-029).
const QuranPanelSidebar = (() => {
  const CATEGORY_GLYPH = { green: '✓', lightBlue: '✓', lightGreen: '✎', yellow: '~', orange: '⚠', red: '✗' };
  // i18n helpers (fall back to the key if QuranI18n isn't loaded for some reason).
  const T = (k, v) => (typeof QuranI18n !== 'undefined') ? QuranI18n.t(k, v) : k;
  const catLabel = (color) => T('cat_' + color);

  let rootEl = null;
  // Local filter mirrors prefs.panelFilter. Updated from chip toggles and
  // persisted via PREFS_WRITE so popup + sidebar stay in sync across surfaces.
  let activeFilter = null;
  // Whether references render as clickable quran.com links (prefs.refLinks),
  // and the effective UI language for the /ar/ locale prefix in those links.
  let refLinksEnabled = true;
  // Item 2 — local mirror of prefs.highlightStyle, so the results-summary cells
  // can render + cycle their 3-state (highlight / underline / off) marking.
  // Updated on mount, on each toggle click, and on PREFS_CHANGED (applyHighlightPrefs).
  let highlightStyle = {};
  // Item 2 — local mirror of prefs.refHighlight (the gold reference marker on/off),
  // toggled from the summary's Total cell.
  let refHighlightEnabled = true;
  let uiLang = 'ar';
  let uiFont = 'uthmaniHafs';
  // Sticky for this page session: once the user closes the sidebar (X button),
  // don't auto-remount on subsequent scans. Cleared explicitly by the caller
  // when a fresh-full scan begins (so the next user-initiated scan reopens it).
  let userClosed = false;
  // Keyboard listener detacher; set on mount, called on unmount.
  let detachKeyboard = null;

  // Collapsible + resizable layout state (persisted in chrome.storage.local so
  // it survives reloads without touching the prefs.v1 schema).
  let panelWidth = 320;
  let collapsed = false;
  let summaryCollapsed = false;   // results-summary counts grid collapsed?
  let resultsCollapsed = false;   // item 1 — filter chips + findings list collapsed?
  let tabEl = null;
  const MIN_PANEL_W = 240;
  const TAB_W = 26;
  const UI_KEY = 'quran.sidebar.ui';

  // Panel docking preference (prefs.v1.panelPosition): auto | left | right | float.
  // 'auto' (and the resting side used by 'float') follow the UI language: Arabic
  // docks right, English docks left.
  //
  // 'float' has two runtime sub-states:
  //   • DOCKED  — rests as a full-height overlay pinned to a side, with the edge
  //               collapse tab, but reserves no host gutter (overlays the page).
  //   • UNDOCKED— grab the title bar to tear it off into a free-floating box at
  //               an arbitrary top/left. Drag it back near either screen edge and
  //               it re-docks to that side.
  let panelPosition = 'auto';
  // Which edge a floating panel anchors to from the options page (auto|left|right).
  let floatAnchor = 'auto';
  // Runtime float sub-state (persisted in the UI key, not prefs):
  let floatUndocked = false;          // true → free-floating box
  let floatSide = null;               // 'left'|'right' edge chosen by dragging, overrides floatAnchor
  let floatTop = null;                // free-box top/left; null until first placed
  let floatLeft = null;
  const SNAP_PX = 40;                 // drag within this of an edge → (re)dock to it

  function resolveSide() {
    if (panelPosition === 'left') return 'left';
    if (panelPosition === 'right') return 'right';
    if (panelPosition === 'float') {
      if (floatSide === 'left' || floatSide === 'right') return floatSide;   // chosen by dragging
      if (floatAnchor === 'left') return 'left';
      if (floatAnchor === 'right') return 'right';
    }
    return uiLang === 'en' ? 'left' : 'right';   // auto (docked + float) follows language dir
  }
  function isFloat() { return panelPosition === 'float'; }

  // Set the host root's gutter (inline + important so it beats any host
  // stylesheet) on the docking side to match the visible sidebar width — or the
  // tab when collapsed. Float mode reserves no gutter (px === 0), so it overlays.
  function setHostMargin(px, side) {
    const de = document.documentElement.style;
    de.removeProperty('margin-left');
    de.removeProperty('margin-right');
    if (px > 0) de.setProperty('margin-' + side, px + 'px', 'important');
  }

  function clampWidth(w) {
    const max = Math.round(window.innerWidth * 0.9);
    return Math.max(MIN_PANEL_W, Math.min(max, w));
  }
  function clampFloatLeft(x) { return Math.max(0, Math.min(x, window.innerWidth - 60)); }
  function clampFloatTop(y) { return Math.max(0, Math.min(y, window.innerHeight - 40)); }

  // Position the free-floating box at its saved (or default-by-side) corner.
  function applyFloatPosition() {
    if (floatTop == null) floatTop = 16;
    if (floatLeft == null) {
      const side = resolveSide();
      floatLeft = side === 'left' ? 16 : Math.max(16, window.innerWidth - panelWidth - 16);
    }
    rootEl.style.top = clampFloatTop(floatTop) + 'px';
    rootEl.style.left = clampFloatLeft(floatLeft) + 'px';
    rootEl.style.right = 'auto';
  }

  // Chevron icons for the persistent edge toggle. Left = expand (pull the panel
  // out); right = collapse (push it to the edge).
  const CHEVRON_LEFT  = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Up = collapse the free-floating box to its header bar; down = expand it again.
  const CHEVRON_UP   = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M5 15l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHEVRON_DOWN = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Pin (thumbtack). Filled + upright = pinned/docked; outlined + tilted = the
  // pin is "loose", i.e. the panel is floating and can be torn off.
  const PIN_FILLED  = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M14.5 3l6.5 6.5-1.4 1.4-1-1-3.3 3.3.2 4.2-1.5 1.5-3.5-3.5L5.6 21H4v-1.6l5.9-5.9-3.5-3.5L7.9 8.5l4.2.2 3.3-3.3-1-1z" fill="currentColor"/></svg>';
  const PIN_OUTLINE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" style="transform:rotate(40deg)"><path d="M14.5 3l6.5 6.5-1.4 1.4-1-1-3.3 3.3.2 4.2-1.5 1.5-3.5-3.5L5.6 21H4v-1.6l5.9-5.9-3.5-3.5L7.9 8.5l4.2.2 3.3-3.3-1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  // Position the edge tab on `side` at `offsetPx` from that edge, with the
  // chevron pointing the right way: toward the page center when collapsed (it
  // opens) and toward the edge when expanded (it collapses).
  function placeTab(side, offsetPx, isCollapsed) {
    const tab = ensureTab();
    tab.style.left = '';
    tab.style.right = '';
    tab.style[side] = offsetPx + 'px';
    const openIcon = side === 'right' ? CHEVRON_LEFT : CHEVRON_RIGHT;
    const collapseIcon = side === 'right' ? CHEVRON_RIGHT : CHEVRON_LEFT;
    tab.innerHTML = isCollapsed ? openIcon : collapseIcon;
    tab.setAttribute('aria-label', isCollapsed ? T('tab_open_aria') : T('collapse_aria'));
    tab.title = isCollapsed ? T('tab_open_aria') : T('collapse');
  }

  // Reflect collapsed/width/position state into the DOM (panel, host margin,
  // tab).
  //
  // Docked (incl. docked-float): the edge tab stays mounted in both states and
  // on whichever side the panel sits; docked-float renders identically to a
  // docked panel but reserves no host gutter (overlays the page). Position
  // classes drive the side-specific CSS (shadow, resize edge, tab corner).
  //
  // Undocked float: a free-floating box at an inline top/left, no edge tab, with
  // an all-around shadow and rounded corners (the pos-float-free class).
  function applyLayout() {
    if (!rootEl) return;
    updatePinButton();
    const tab = ensureTab();
    const side = resolveSide();
    const float = isFloat();
    const undocked = float && floatUndocked;

    rootEl.classList.toggle('quran-ext-pos-left', !undocked && side === 'left');
    rootEl.classList.toggle('quran-ext-pos-right', !undocked && side === 'right');
    rootEl.classList.toggle('quran-ext-pos-float', float && !undocked);
    rootEl.classList.toggle('quran-ext-pos-float-free', undocked);
    tab.classList.toggle('quran-ext-tab-left', side === 'left');

    // Free-floating box: no edge tab; its own header button collapses it to just
    // the header bar (kept at the float position), matching the docked behavior.
    if (undocked) {
      tab.style.display = 'none';
      rootEl.style.display = 'flex';
      rootEl.style.width = panelWidth + 'px';
      rootEl.classList.toggle('quran-ext-float-collapsed', collapsed);
      applyFloatPosition();
      setHostMargin(0, side);
      updateFloatToggle();
      return;
    }

    rootEl.classList.remove('quran-ext-float-collapsed');
    updateFloatToggle();   // hides the header button unless free-floating
    tab.style.display = 'flex';
    const gutter = float ? 0 : panelWidth;     // float overlays; docked reserves space
    if (collapsed) {
      rootEl.style.display = 'none';
      placeTab(side, 0, true);
      setHostMargin(float ? 0 : TAB_W, side);
      return;
    }

    rootEl.style.display = 'flex';
    rootEl.style.width = panelWidth + 'px';
    // Clear any free-box inline geometry so the CSS edge pin governs.
    rootEl.style.left = '';
    rootEl.style.right = '';
    rootEl.style.top = '';
    placeTab(side, panelWidth, false);
    setHostMargin(gutter, side);
  }

  // Sync the in-header collapse/expand button (shown only when free-floating;
  // the docked states use the edge tab instead).
  function updateFloatToggle() {
    if (!rootEl) return;
    const btn = rootEl.querySelector('.quran-ext-panel-float-toggle');
    if (!btn) return;
    if (!(isFloat() && floatUndocked)) { btn.style.display = 'none'; return; }
    btn.style.display = 'flex';
    btn.innerHTML = collapsed ? CHEVRON_DOWN : CHEVRON_UP;
    btn.setAttribute('aria-label', collapsed ? T('tab_open_aria') : T('collapse_aria'));
    btn.title = collapsed ? T('tab_open_aria') : T('collapse');
  }

  // Sync the title-bar pin icon + aria. Pressed (filled, upright) = docked: the
  // panel reserves a host gutter, never overlays the page, and can't be torn off.
  // Unpressed (outlined, tilted) = float: it overlays and can be dragged/torn off.
  function updatePinButton() {
    if (!rootEl) return;
    const btn = rootEl.querySelector('.quran-ext-panel-pin');
    if (!btn) return;
    const pinned = !isFloat();
    btn.innerHTML = pinned ? PIN_FILLED : PIN_OUTLINE;
    btn.setAttribute('aria-pressed', String(pinned));
    const k = pinned ? 'pin_pinned' : 'pin_unpinned';
    btn.setAttribute('aria-label', T(k));
    btn.title = T(k);
  }

  // Flip between docked (pinned) and float (unpinned). Persists panelPosition via
  // PREFS_WRITE so the options page stays in sync and the choice survives reloads;
  // the resulting PREFS_CHANGED also re-drives setPosition across other tabs.
  function togglePin() {
    if (isFloat()) {
      panelPosition = closestSide();   // dock to whichever edge it's nearest
    } else {
      panelPosition = 'float';
    }
    applyLayout();
    QuranMsg.sendRequest('PREFS_WRITE', { patch: { panelPosition } }).catch(() => {});
  }

  // Which screen edge the panel currently sits nearest, by its horizontal center.
  // Used when pinning a floating panel so it docks to the closest side rather
  // than a fixed default.
  function closestSide() {
    if (!rootEl) return resolveSide();
    const r = rootEl.getBoundingClientRect();
    return (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right';
  }

  function ensureTab() {
    if (tabEl && document.body.contains(tabEl)) return tabEl;
    tabEl = document.createElement('div');
    tabEl.className = 'quran-ext-panel-tab';
    tabEl.setAttribute('role', 'button');
    tabEl.setAttribute('tabindex', '0');
    tabEl.innerHTML = CHEVRON_LEFT;
    // Mirror the panel root's data-theme so same-element theme rules
    // (&.quran-ext-panel-tab in css/themes/mihrab.css) match. The tab is a
    // sibling of the panel root in DOM, not a descendant.
    if (rootEl && rootEl.dataset && rootEl.dataset.theme) {
      tabEl.dataset.theme = rootEl.dataset.theme;
    }
    const toggle = () => { if (collapsed) expand(); else collapse(); };
    tabEl.addEventListener('click', toggle);
    tabEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    document.body.appendChild(tabEl);
    return tabEl;
  }

  function persistUi() {
    try {
      chrome.storage.local.set({ [UI_KEY]: {
        width: panelWidth, collapsed, summaryCollapsed, resultsCollapsed,
        floatUndocked, floatSide, floatTop, floatLeft,
      } });
    } catch (_) {}
  }

  async function loadUi() {
    try {
      const r = await chrome.storage.local.get(UI_KEY);
      const ui = r?.[UI_KEY] || {};
      if (typeof ui.width === 'number') panelWidth = clampWidth(ui.width);
      collapsed = !!ui.collapsed;
      summaryCollapsed = !!ui.summaryCollapsed;
      resultsCollapsed = !!ui.resultsCollapsed;
      floatUndocked = !!ui.floatUndocked;
      floatSide = (ui.floatSide === 'left' || ui.floatSide === 'right') ? ui.floatSide : null;
      if (typeof ui.floatTop === 'number') floatTop = ui.floatTop;
      if (typeof ui.floatLeft === 'number') floatLeft = ui.floatLeft;
    } catch (_) {}
  }

  function collapse() { collapsed = true; applyLayout(); persistUi(); }
  function expand() { collapsed = false; applyLayout(); persistUi(); focusFirstRow(); }

  // Drag the inner edge to resize. The handle sits on whichever edge faces the
  // page: left edge when the panel sits on the right (width = distance to the
  // right viewport edge), right edge when it sits on the left or floats free
  // (width = cursor − panel left). Float reserves no host gutter, so only docked
  // updates it.
  function wireResize() {
    const handle = rootEl.querySelector('.quran-ext-panel-resize');
    if (!handle) return;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const side = resolveSide();
      const float = isFloat();
      const free = float && floatUndocked && !collapsed;
      const onMove = (ev) => {
        if (free || side === 'left') {
          panelWidth = clampWidth(ev.clientX - rootEl.getBoundingClientRect().left);
        } else {
          panelWidth = clampWidth(window.innerWidth - ev.clientX);
        }
        rootEl.style.width = panelWidth + 'px';
        if (!float) setHostMargin(panelWidth, side);
        if (tabEl && !free) { tabEl.style.left = ''; tabEl.style.right = ''; tabEl.style[side] = panelWidth + 'px'; }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        persistUi();
      };
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Float only: grab the title bar to tear the panel off into a free-floating
  // box; drag it near a screen edge and it re-docks to that side. No-op when
  // the panel is docked left/right (that's a fixed dock, not a float).
  function wireHeaderDrag() {
    const header = rootEl.querySelector('.quran-ext-panel-header');
    if (!header) return;
    header.addEventListener('mousedown', (e) => {
      if (!isFloat() || e.target.closest('button')) return;
      e.preventDefault();
      const rect = rootEl.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      const onMove = (ev) => {
        if (ev.clientX <= SNAP_PX) {
          // magnetic dock to the left edge
          if (!(floatSide === 'left' && !floatUndocked)) { floatSide = 'left'; floatUndocked = false; applyLayout(); }
        } else if (ev.clientX >= window.innerWidth - SNAP_PX) {
          if (!(floatSide === 'right' && !floatUndocked)) { floatSide = 'right'; floatUndocked = false; applyLayout(); }
        } else {
          floatUndocked = true;
          floatLeft = clampFloatLeft(ev.clientX - dx);
          floatTop = clampFloatTop(ev.clientY - dy);
          applyLayout();
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        persistUi();
      };
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  async function fetchTemplate() {
    const url = chrome.runtime.getURL('html/sidebar.html');
    const resp = await fetch(url);
    return await resp.text();
  }

  // quran.com URL for a surah + ayah range, per spec: quran.com/2/3-4
  // (and quran.com/ar/2/3-4 when the UI language is Arabic).
  function quranComUrl(surah, first, last) {
    const ayahPart = (last && last !== first) ? `${first}-${last}` : `${first}`;
    return `https://quran.com/${uiLang === 'ar' ? 'ar/' : ''}${surah}/${ayahPart}`;
  }

  // Resolve a reference to {surahNum, ayahNums, ayahTexts}, memoized so repeated
  // renders (filter toggles) don't re-hit the background per row.
  const refCache = new Map();
  async function resolveRefCached(refString) {
    if (refCache.has(refString)) return refCache.get(refString);
    let r = null;
    try {
      const resp = await QuranMsg.sendRequest('resolveReference', { ref: refString });
      const res = resp?.payload?.result || resp?.result || resp;
      if (res && res.surahNum && Array.isArray(res.ayahNums) && res.ayahNums.length) r = res;
    } catch (_) {}
    refCache.set(refString, r);
    return r;
  }

  // A single styled tooltip element (matching the in-page hover) lives on
  // document.body as position:fixed so the panel's overflow can't clip it.
  let refTipEl = null;
  function ensureRefTip() {
    if (refTipEl && document.body.contains(refTipEl)) return refTipEl;
    refTipEl = document.createElement('div');
    refTipEl.className = 'quran-ext-ref-tip';
    refTipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(refTipEl);
    return refTipEl;
  }
  function showRefTip(anchor, text) {
    const tip = ensureRefTip();
    tip.textContent = text;
    if (typeof QuranFonts !== 'undefined') tip.style.setProperty('--quran-ref-tooltip-font', QuranFonts.familyFor(uiFont));
    // Mirror the swap engine: downscale only the legacy uthmaniHafs font.
    tip.classList.toggle('quran-ext-tip-downscale', uiFont === 'uthmaniHafs');
    tip.style.visibility = 'hidden';
    tip.style.display = 'block';
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let top = a.bottom + 6;
    if (top + t.height > window.innerHeight - 8) top = Math.max(8, a.top - t.height - 6);
    let left = a.right - t.width;
    left = Math.min(Math.max(8, left), window.innerWidth - 8 - t.width);
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    tip.style.visibility = 'visible';
  }
  function hideRefTip() { if (refTipEl) refTipEl.style.display = 'none'; }

  // Render a single reference token. Always shows the full ayah text(s) on hover
  // (styled tooltip, matching the in-page hover), so any ref (right or wrong)
  // can be verified. When prefs.refLinks is on it's also a clickable link that
  // opens quran.com. Plain text when the ref is empty.
  function refToken(refString) {
    const el = document.createElement('span');
    el.textContent = refString || '';
    if (!refString) return el;
    el.className = 'quran-ext-panel-ref';
    // Warm the cache so the first hover is instant.
    resolveRefCached(refString);
    const showOnHover = async () => {
      const r = await resolveRefCached(refString);
      if (!r || !Array.isArray(r.ayahTexts) || !r.ayahTexts.length) return;
      showRefTip(el, r.ayahTexts.filter(Boolean).join(' ۝ '));
    };
    el.addEventListener('mouseenter', showOnHover);
    el.addEventListener('mouseleave', hideRefTip);
    el.addEventListener('focus', showOnHover);
    el.addEventListener('blur', hideRefTip);
    if (refLinksEnabled) {
      el.classList.add('quran-ext-panel-ref-link');
      el.setAttribute('role', 'link');
      el.setAttribute('tabindex', '0');
      const open = async (e) => {
        e.stopPropagation();
        const r = await resolveRefCached(refString);
        if (r) window.open(quranComUrl(r.surahNum, r.ayahNums[0], r.ayahNums[r.ayahNums.length - 1]), '_blank', 'noopener');
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
    }
    return el;
  }

  function makeRow(finding) {
    const row = document.createElement('div');
    row.className = `quran-ext-panel-row quran-ext-panel-row-${finding.color}`;
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.findingId = finding.id;
    row.dataset.color = finding.color;

    const head = document.createElement('div');
    head.className = 'quran-ext-panel-head';
    const glyph = document.createElement('span');
    glyph.className = 'quran-ext-panel-glyph';
    glyph.textContent = CATEGORY_GLYPH[finding.color] || '•';
    glyph.setAttribute('aria-hidden', 'true');
    const swatch = document.createElement('span');
    swatch.className = `quran-ext-panel-swatch quran-ext-panel-swatch-${finding.color}`;
    swatch.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = catLabel(finding.color);
    head.append(glyph, swatch, label);

    const snippet = document.createElement('div');
    snippet.className = 'quran-ext-panel-snippet';
    // For a corrected (lightGreen) successor we have the original wording on the
    // finding (correctedFromText). Render it as a two-line "Now: <new> / Was:
    // <old>" so the reader can see exactly what the correction changed.
    if (finding.color === 'lightGreen' && finding.correctedFromText) {
      const now = document.createElement('div');
      now.className = 'quran-ext-panel-snippet-now';
      now.textContent = `${T('corr_now')}: ${finding.text || ''}`;
      const was = document.createElement('div');
      was.className = 'quran-ext-panel-snippet-was';
      was.textContent = `${T('corr_was')}: ${finding.correctedFromText}`;
      snippet.append(now, was);
    } else {
      snippet.textContent = finding.text || '';
    }

    const refs = document.createElement('div');
    refs.className = 'quran-ext-panel-refs';
    const cited = finding.claimedRef || finding.citedReference || '';
    const matched = finding.matchedRef || '';
    let refsLabel = '';
    if (finding.color === 'lightGreen' && finding.correctedFromRef) {
      // Corrected: the wrong ref ✎→ the true ref. Both are linkable/hoverable so
      // the user can open quran.com for each and verify the old ref was wrong.
      refs.append(refToken(finding.correctedFromRef), document.createTextNode(' ✎→ '), refToken(matched || cited));
      refsLabel = `${finding.correctedFromRef} ✎→ ${matched || cited}`;
    } else if (cited && matched && cited !== matched) {
      refs.append(refToken(cited), document.createTextNode(' → '), refToken(matched));
      refsLabel = `${cited} → ${matched}`;
    } else if (matched || cited) {
      refs.append(refToken(matched || cited));
      refsLabel = matched || cited;
    }

    row.setAttribute('aria-label',
      `${catLabel(finding.color)}. ${finding.text || ''}${refsLabel ? '. ' + refsLabel : ''}`);

    row.append(head, snippet);
    if (refsLabel) row.append(refs);

    // T201 P1 — yellow aligned diff: show the cited words vs the authentic ayah,
    // missing words marked as insertions, extra words struck through, subs paired.
    // Pure information (the design's §2a); never edits the page.
    if (finding.color === 'yellow' && Array.isArray(finding.diff) && finding.diff.length) {
      row.append(makeDiffBlock(finding));
    }
    // T201 P1 / T041 — red near-match suggestion ("هل تقصد …؟"). When rival
    // candidates are present (tie/near-tie) the block renders a ranked manual-
    // choice list instead of a single auto-offered suggestion (FR-015).
    if (finding.color === 'red' && finding.nearMatch && finding.nearMatch.authenticText) {
      row.append(makeNearMatchBlock(finding.nearMatch, finding));
    } else if (finding.color === 'red') {
      // T041 shape (c) / FR-017 — no candidate within threshold: this is a
      // deliberate "nothing safe to suggest" state, not an error.
      const noAuto = document.createElement('div');
      noAuto.className = 'quran-ext-panel-noauto';
      noAuto.textContent = T('corr_no_auto');
      row.append(noAuto);
    }
    // T201 P2 — lightBlue missing-reference suggestion (suggestion-only, no page
    // edit — ratified Q-A). Context-disambiguated when the text occurs at several
    // refs; otherwise the candidate refs are offered for the user to copy.
    if (finding.color === 'lightBlue' && typeof QuranPanelModel !== 'undefined') {
      const sug = QuranPanelModel.suggestRefForLightBlue(finding.id);
      if (sug) row.append(makeLightBlueSuggestBlock(sug, finding));
    }

    // Action buttons (T052). Primary action is row click = jump (FR-011a).
    const actions = document.createElement('div');
    actions.className = 'quran-ext-panel-actions';
    if (finding.color === 'orange') {
      actions.append(makeActionBtn(T('act_correct'), () => runAction('correctInPlace', finding)));
    }
    // T201 P3 — gated text-replace to authentic wording (manual). yellow drift →
    // "fix wording"; a red finding WITH a near-match → "accept suggestion".
    if (finding.color === 'yellow') {
      // T018 (FR-014) — withhold "Fix in place" when the match is too shaky to
      // safely rewrite the page text (boundary-spanning / ambiguous); the diff is
      // still shown above, but we surface the explanation in the button's place.
      if (finding.unsafeToRewrite) {
        const note = document.createElement('span');
        note.className = 'quran-ext-action-note';
        note.textContent = T('corr_unsafe_rewrite');
        actions.append(note);
      } else {
        actions.append(makeActionBtn(T('act_fix_wording'), () => runAction('correctTextInPlace', finding)));
      }
    } else if (finding.color === 'red' && finding.nearMatch && finding.nearMatch.authenticText
               && !(Array.isArray(finding.nearMatch.rivalCandidates) && finding.nearMatch.rivalCandidates.length)) {
      // Single unambiguous near-match → one-click accept. On a tie the per-
      // candidate accepts in the ranked list are the only way in (FR-015).
      actions.append(makeActionBtn(T('act_accept_near'), () => runAction('correctTextInPlace', finding)));
    } else if (finding.color === 'lightGreen' && finding.priorFinding) {
      // Revert a correction back to its pre-correction state (page + panel +
      // persisted entry). Mirrors the dismiss/restore label so the affordance
      // reads the same way across sections.
      actions.append(makeActionBtn(T('act_restore'), () => runAction('revertCorrection', finding)));
    }
    actions.append(
      makeActionBtn(T('act_copy'),   () => runAction('copy',   finding)),
      makeActionBtn(T('act_share'),  () => runAction('share',  finding)),
      makeActionBtn(T('act_report'), () => runAction('report', finding)),
      makeActionBtn(T('act_json'),   () => runAction('json',   finding)),
    );
    const isDismissed = finding.panelState?.dismissedThisSession === true ||
                        finding.panelState?.persistedBadge?.kind === 'dismissed';
    actions.append(isDismissed
      ? makeActionBtn(T('act_restore'), () => runAction('restore', finding))
      : makeActionBtn(T('act_dismiss'), () => runAction('dismiss', finding)));
    row.append(actions);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.quran-ext-panel-action-btn')) return;
      runAction('jump', finding);
    });

    const persist = finding.panelState?.persistedBadge;
    if (persist) {
      const badge = document.createElement('span');
      badge.className = `quran-ext-panel-persisted quran-ext-panel-persisted-${persist.kind}`;
      badge.textContent = T(persist.kind === 'corrected' ? 'badge_corrected' : 'badge_dismissed') +
                          (persist.when ? ` — ${persist.when}` : '');
      row.append(badge);
    }
    return row;
  }

  // Render an aligned word-level diff (T201 P1 §2a). `keep` words are plain,
  // `sub` shows authentic (the cited form is in the snippet above), `missing`
  // (omitted by the author) is added, `extra` (in the citation, not the ayah) is
  // struck through. Authentic-side wording only — never the author's drift.
  function makeDiffBlock(finding) {
    const diff = finding.diff || [];
    const wrap = document.createElement('div');
    wrap.className = 'quran-ext-panel-diff';
    const heading = document.createElement('div');
    heading.className = 'quran-ext-panel-diff-heading';
    // Name the matched ayah(s) in the heading so the reader knows which
    // reference the diff is being computed against. Multi-ref matches list
    // every candidate (comma-separated). Each ref is a hover/linkable token
    // so the reader can verify on quran.com without scrolling away.
    const refs = (Array.isArray(finding.matchedRefs) && finding.matchedRefs.length)
      ? finding.matchedRefs.slice()
      : (finding.matchedRef ? [finding.matchedRef] : []);
    heading.append(document.createTextNode(T('corr_diff_heading')));
    if (refs.length) {
      heading.append(document.createTextNode(' '));
      refs.forEach((ref, i) => {
        if (i > 0) heading.append(document.createTextNode('، '));
        heading.append(refToken(ref));
      });
      heading.append(document.createTextNode(':'));
    } else {
      // No matched ref available — keep a trailing colon so the heading reads
      // as a complete phrase instead of dangling on the connector ("in"/"في").
      heading.append(document.createTextNode(':'));
    }
    wrap.append(heading);
    const line = document.createElement('div');
    line.className = 'quran-ext-panel-diff-line quran-swap';
    line.dir = 'rtl';
    diff.forEach((d, i) => {
      const w = document.createElement('span');
      if (d.op === 'keep') { w.className = 'quran-ext-diff-keep'; w.textContent = d.authentic || d.cited || ''; }
      else if (d.op === 'sub') { w.className = 'quran-ext-diff-sub'; w.textContent = d.authentic || ''; w.title = `${T('corr_cited_label')}: ${d.cited || ''}`; }
      else if (d.op === 'missing') { w.className = 'quran-ext-diff-missing'; w.textContent = d.authentic || ''; w.title = T('corr_diff_missing'); }
      else if (d.op === 'extra') { w.className = 'quran-ext-diff-extra'; w.textContent = d.cited || ''; w.title = T('corr_diff_extra'); }
      if (w.textContent) { wrapAppendWord(line, w, i); }
    });
    wrap.append(line);
    return wrap;
  }
  function wrapAppendWord(line, w, i) {
    if (i > 0) line.append(document.createTextNode(' '));
    line.append(w);
  }

  // Render a red near-match suggestion (T201 P1 §3): "هل تقصد: <ref> — <ayah>".
  // Show the boundary-aligned excerpt (the exact span that "accept suggestion"
  // will paste back into the page) when the verifier produced one; fall back to
  // the full ayah text otherwise.
  function makeNearMatchBlock(nm, finding) {
    const wrap = document.createElement('div');
    wrap.className = 'quran-ext-panel-nearmatch';
    const rivals = Array.isArray(nm.rivalCandidates) ? nm.rivalCandidates : null;
    const heading = document.createElement('span');
    heading.className = 'quran-ext-panel-nearmatch-heading';
    // Tie/near-tie → ranked manual choice (FR-015); otherwise a single suggestion.
    heading.textContent = (rivals ? T('corr_choose_candidate') : T('corr_did_you_mean')) + ' ';
    wrap.append(heading);

    if (!rivals) {
      wrap.append(refToken(nm.refLabel || nm.ref || ''));
      const ayah = document.createElement('div');
      ayah.className = 'quran-ext-panel-nearmatch-text quran-swap';
      ayah.dir = 'rtl';
      ayah.textContent = nm.authenticExcerpt || nm.authenticText || '';
      wrap.append(ayah);
      return wrap;
    }

    // Ranked list: the top suggestion plus each rival, every one individually
    // acceptable (auto-accept never fires on a tie — FR-015). Numbered for clarity.
    const list = document.createElement('div');
    list.className = 'quran-ext-panel-nearmatch-list';
    const candidates = [{ ref: nm.ref, refLabel: nm.refLabel, authenticText: nm.authenticText, authenticExcerpt: nm.authenticExcerpt }].concat(rivals);
    candidates.forEach((cand, i) => {
      const item = document.createElement('div');
      item.className = 'quran-ext-panel-nearmatch-item';
      const opt = document.createElement('span');
      opt.className = 'quran-ext-panel-nearmatch-rank';
      opt.textContent = T('corr_candidate_option', { n: i + 1 }) + ' ';
      item.append(opt, refToken(cand.refLabel || cand.ref || ''));
      const ayah = document.createElement('div');
      ayah.className = 'quran-ext-panel-nearmatch-text quran-swap';
      ayah.dir = 'rtl';
      ayah.textContent = cand.authenticExcerpt || cand.authenticText || '';
      item.append(ayah);
      if (finding) {
        item.append(makeActionBtn(T('act_accept_near'),
          () => runAction('correctTextInPlace', finding, { candidate: cand })));
      }
      list.append(item);
    });
    wrap.append(list);
    return wrap;
  }

  // lightBlue suggested-reference block (T201 P2). Resolved → show the ref + a
  // copy button; ambiguous → list the candidate refs, each copyable. Copying
  // writes ONLY the reference text — the page DOM is never modified (Q-A).
  function makeLightBlueSuggestBlock(sug, finding) {
    const wrap = document.createElement('div');
    wrap.className = 'quran-ext-panel-suggest';
    const heading = document.createElement('div');
    heading.className = 'quran-ext-panel-suggest-heading';
    heading.textContent = sug.ambiguous ? T('corr_ambiguous') : T('corr_suggest_ref');
    wrap.append(heading);
    const refs = sug.ambiguous ? sug.candidates : [sug.ref];
    const list = document.createElement('div');
    list.className = 'quran-ext-panel-suggest-list';
    refs.forEach(ref => {
      const item = document.createElement('span');
      item.className = 'quran-ext-panel-suggest-item';
      item.append(refToken(ref));
      // T032/T035 — accept this reference: stamp it onto the finding as the
      // resolved ref (color stays lightBlue — uncited authentic text is not a
      // mistake; the ref is a reading aid, not a correction). No page-text edit
      // (FR-007). For the ambiguous case each candidate gets its own accept
      // (manual choice, FR-010).
      const accept = makeActionBtn(sug.ambiguous ? T('corr_choose_ref') : T('act_correct'),
        () => runAction('correctReferenceAttribution', finding, { ref }));
      accept.classList.add('quran-ext-panel-suggest-accept');
      item.append(accept);
      const btn = makeActionBtn(T('corr_copy_ref'), async () => {
        try { await navigator.clipboard.writeText(`(${ref})`); btn.textContent = T('corr_copied'); }
        catch (_) { /* clipboard unavailable — the ref is still shown/linkable */ }
      });
      btn.classList.add('quran-ext-panel-suggest-copy');
      item.append(btn);
      list.append(item);
    });
    wrap.append(list);
    return wrap;
  }

  function makeActionBtn(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quran-ext-panel-action-btn';
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  // T020 (FR-005) — transient, aria-live note appended to the panel root. Used to
  // explain the locked-DOM clipboard fallback (the span couldn't be edited, so the
  // corrected citation was copied for manual paste). Auto-clears after a few s.
  let noteTimer = null;
  function showTransientNote(message) {
    if (!rootEl || !message) return;
    let note = rootEl.querySelector('.quran-ext-panel-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'quran-ext-panel-note';
      note.setAttribute('role', 'status');
      note.setAttribute('aria-live', 'polite');
      rootEl.appendChild(note);
    }
    note.textContent = message;
    note.style.display = 'block';
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { if (note) note.style.display = 'none'; }, 6000);
  }

  // FR-005: a locked-DOM text-replace fallback copied to the clipboard. When the
  // cited text lives in a cross-origin/sandboxed iframe the content script can't
  // reach the span at all — name the iframe boundary so the explanation is true.
  function surfaceCorrectionResult(res) {
    const r = res && res.result;
    if (r && r.lockedDom) showTransientNote(T(r.iframeBoundary ? 'corr_locked_dom_iframe' : 'corr_locked_dom'));
  }

  async function runAction(kind, finding, extra) {
    if (typeof QuranActions === 'undefined') return;
    const opts = { pageUrl: location.href };
    try {
      switch (kind) {
        // T032/T035 — lightBlue accept-reference (recolor + tooltip ref, no page
        // text edit). extra.ref = a manually chosen candidate (ambiguous case).
        case 'correctReferenceAttribution':
          surfaceCorrectionResult(await QuranActions.correctRefAttributionInContent(finding.id, extra && extra.ref));
          break;
        case 'jump':   QuranActions.jumpInContent(finding.id); break;
        case 'copy':   await QuranActions.copyRecord(finding, opts); break;
        case 'share':  await QuranActions.copyShareArtifact(finding, opts); break;
        case 'report': await QuranActions.copyReport(finding, opts); break;
        case 'json':   await QuranActions.copyRecordJson(finding, opts); break;
        // T067 — correct-in-place runs directly in this content context; the
        // sidebar model is updated by content.js via QuranPanelSidebar.ingest.
        case 'correctInPlace': surfaceCorrectionResult(await QuranActions.correctInContent(finding.id)); break;
        case 'correctTextInPlace': surfaceCorrectionResult(await QuranActions.correctTextInContent(finding.id, extra && extra.candidate)); break;
        case 'revertCorrection': await QuranActions.revertInContent(finding.id); break;
        // T069/T070 — dismiss; T071 — restore. Update this surface's model + persist.
        case 'dismiss':
          QuranPanelModel.markDismissedThisSession(finding.id);
          await QuranActions.dismiss(finding, opts);
          render();
          break;
        case 'restore':
          QuranPanelModel.unmarkDismissed(finding.id);
          await QuranActions.restore(finding, opts);
          render();
          break;
      }
    } catch (_) {}
  }

  function makeSection(title, findings) {
    const section = document.createElement('section');
    section.className = 'quran-ext-panel-section';
    const h = document.createElement('h3');
    h.className = 'quran-ext-panel-section-title';
    h.textContent = `${title} (${findings.length})`;
    section.append(h);
    for (const f of findings) section.append(makeRow(f));
    return section;
  }

  // Item 2 — per-category highlight-style cycle for the results-summary cells.
  // red + yellow can't go 'off' (the two highest-severity findings stay visible),
  // so they cycle between highlight ↔ underline only; everything else cycles
  // highlight → underline → off → highlight. Mirrors the clamp in prefs.js.
  function styleSeqFor(color) {
    return (color === 'red' || color === 'yellow')
      ? ['highlight', 'underline']
      : ['highlight', 'underline', 'off'];
  }
  function nextStyleFor(color, current) {
    const seq = styleSeqFor(color);
    let i = seq.indexOf(current);
    if (i === -1) i = 0;
    return seq[(i + 1) % seq.length];
  }
  function styleLabel(style) {
    return T(style === 'underline' ? 'hl_style_underline' : style === 'off' ? 'hl_style_off' : 'hl_style_highlight');
  }

  // Re-render the summary while preserving keyboard focus on the cell the user
  // just activated (renderSummary rebuilds every cell), so repeated Space/Enter
  // presses keep operating on the same cell.
  function rerenderSummaryKeepingFocus(selector) {
    const hadFocus = rootEl && rootEl.querySelector(selector) === document.activeElement;
    renderSummary();
    if (hadFocus) {
      const cell = rootEl && rootEl.querySelector(selector);
      if (cell) cell.focus();
    }
  }

  // Cycle a category's on-page highlight style and persist it. PREFS_WRITE
  // broadcasts PREFS_CHANGED, which content.js uses to reapply styles on the page
  // (and to call applyHighlightPrefs back here, which re-renders the summary).
  function cycleCategoryStyle(color) {
    const cur = highlightStyle[color] || 'highlight';
    const next = nextStyleFor(color, cur);
    highlightStyle = { ...highlightStyle, [color]: next };
    rerenderSummaryKeepingFocus(`.quran-ext-summary-toggle-cell[data-color="${color}"]`);
    QuranMsg.sendRequest('PREFS_WRITE', { patch: { highlightStyle: { [color]: next } } }).catch(() => {});
  }

  // Item 2 — the Total cell toggles the gold reference highlight (prefs.refHighlight,
  // on/off). content.js reconciles the on-page markers on the resulting PREFS_CHANGED.
  function toggleRefHighlight() {
    refHighlightEnabled = !refHighlightEnabled;
    rerenderSummaryKeepingFocus('.quran-ext-summary-total');
    QuranMsg.sendRequest('PREFS_WRITE', { patch: { refHighlight: refHighlightEnabled } }).catch(() => {});
  }

  // Turn a cell into an activatable toggle (mouse + Space/Enter), rejecting
  // page-world synthetic events (T098).
  function wireToggleCell(cell, onActivate) {
    cell.setAttribute('role', 'button');
    cell.setAttribute('tabindex', '0');
    cell.addEventListener('click', (e) => { if (e.isTrusted) onActivate(); });
    cell.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onActivate(); }
    });
  }

  // Results summary table (moved from the popup; T094). Counts derive from the
  // panel model so the sidebar owns perCategoryCount without extra messaging.
  // Item 2 — every category cell is a 3-state toggle whose label PREVIEWS the
  // ayah's actual on-page appearance (the category color, highlighted / underlined
  // / plain). The Total cell toggles the gold reference highlight on/off.
  function renderSummary() {
    if (!rootEl) return;
    const grid = rootEl.querySelector('.quran-ext-summary-grid');
    if (!grid) return;
    const all = QuranPanelModel.all();
    const counts = { orange: 0, green: 0, lightBlue: 0, lightGreen: 0, yellow: 0, red: 0 };
    for (const f of all) if (counts[f.color] != null) counts[f.color]++;
    const cells = [
      ['total', all.length],
      ['orange', counts.orange],
      ['green', counts.green],
      ['lightBlue', counts.lightBlue],
      ['lightGreen', counts.lightGreen],
      ['yellow', counts.yellow],
      ['red', counts.red],
    ];
    grid.replaceChildren();
    for (const [key, n] of cells) {
      const cell = document.createElement('div');
      const label = document.createElement('span');
      label.className = 'quran-ext-summary-label';
      label.textContent = T(key === 'total' ? 'stat_total'
        : key === 'lightBlue' ? 'stat_lightblue' : 'stat_' + key);
      const value = document.createElement('span');
      value.className = 'quran-ext-summary-value';
      value.textContent = n;

      if (key === 'total') {
        // The Total cell doubles as the gold reference-highlight on/off toggle.
        const state = refHighlightEnabled ? 'highlight' : 'off';
        cell.className = 'quran-ext-summary-cell quran-ext-summary-total quran-ext-summary-toggle-cell quran-ext-summary-ref';
        cell.dataset.state = state;
        cell.setAttribute('aria-label',
          T('summary_ref_aria', { state: T(refHighlightEnabled ? 'state_on' : 'state_off') }));
        cell.title = T('summary_ref_title');
        wireToggleCell(cell, toggleRefHighlight);
        cell.append(label, value);
      } else {
        const style = highlightStyle[key] || 'highlight';
        cell.className = `quran-ext-summary-cell quran-ext-summary-toggle-cell quran-ext-summary-${key}`;
        cell.dataset.color = key;
        cell.dataset.state = style;
        cell.setAttribute('aria-label',
          T('summary_state_aria', { label: label.textContent, n, state: styleLabel(style) }));
        cell.title = styleLabel(style);
        wireToggleCell(cell, () => cycleCategoryStyle(key));
        cell.append(label, value);
      }
      grid.append(cell);
    }
  }

  // T154 — visibility filter. A finding whose page-span is disconnected is
  // out of the user's current view (typical on virtualized chat apps where
  // rows un/mount as they scroll). Hide the row from the panel sections but
  // keep it in the model — when the row comes back, its identity matches a
  // memory entry, the page is re-wrapped with the preserved id, and the
  // next render call sees it as connected again.
  //
  // Panel rows also stamp data-finding-id (panel/sidebar-surface.js:455), so
  // restrict the lookup to NOT match our own UI — same reason swap.js does
  // (see js/render/swap.js T153). Without that the panel row itself would
  // count as "connected" and nothing would ever hide.
  function isPageConnected(id) {
    if (!id) return false;
    try {
      const sel = `[data-finding-id="${(typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : String(id).replace(/[^a-zA-Z0-9_-]/g, '\\$&')}"]`;
      const matches = document.querySelectorAll(sel);
      for (const el of matches) {
        if (el.closest('.quran-ext-panel, .quran-ext-panel-tab, .quran-ext-ref-tip')) continue;
        return true;
      }
      return false;
    } catch (_) { return false; }
  }
  function visibleOnly(arr) {
    // Visibility applies to active + previously-dismissed sections (rows the
    // user is browsing in their current page state). "Recently corrected"
    // and "dismissed this session" are intentional pins from this session;
    // we keep them even if the host scrolled the row off — losing them
    // mid-session would erase the user's just-taken action.
    return arr.filter(f => isPageConnected(f.id));
  }

  function render() {
    if (!rootEl) return;
    renderSummary();
    const container = rootEl.querySelector('.quran-ext-panel-container');
    container.replaceChildren();

    const filter = activeFilter || {};
    const active = visibleOnly(QuranPanelModel.activeView(filter));
    const recent = QuranPanelModel.recentlyCorrected();
    const dismissed = QuranPanelModel.dismissedThisSession();
    const prior = visibleOnly(QuranPanelModel.previouslyDismissed());

    if (!active.length && !recent.length && !dismissed.length && !prior.length) {
      const empty = document.createElement('div');
      empty.className = 'quran-ext-panel-empty';
      empty.textContent = QuranPanelModel.size() === 0
        ? T('empty_no_results')
        : T('empty_no_match_filter');
      container.append(empty);
      return;
    }
    // FR-022 — "Recently corrected" pinned at the top, regardless of filter.
    if (recent.length)    container.append(makeSection(T('section_recent'), recent));
    if (active.length)    container.append(makeSection(T('section_results'), active));
    if (dismissed.length) container.append(makeSection(T('section_dismissed'), dismissed));
    if (prior.length)     container.append(makeSection(T('section_prior_dismissed'), prior));
  }

  function syncChips() {
    if (!rootEl) return;
    rootEl.querySelectorAll('.quran-ext-filter-chip input[type=checkbox]').forEach(cb => {
      cb.checked = activeFilter?.[cb.dataset.color] === true;
    });
  }

  // Reflect the results-summary collapsed state into the DOM (hides the counts
  // grid; the chevron rotates via CSS). The toggle button is the title row.
  function applySummaryCollapsed() {
    if (!rootEl) return;
    const summary = rootEl.querySelector('.quran-ext-summary');
    const btn = rootEl.querySelector('.quran-ext-summary-toggle');
    const chev = rootEl.querySelector('.quran-ext-summary-chevron');
    if (chev && !chev.firstChild) chev.innerHTML = CHEVRON_DOWN;
    if (summary) summary.classList.toggle('quran-ext-summary-collapsed', summaryCollapsed);
    if (btn) btn.setAttribute('aria-expanded', String(!summaryCollapsed));
  }

  // Item 1 — collapse/expand the Results section (filter chips + findings list).
  function applyResultsCollapsed() {
    if (!rootEl) return;
    const results = rootEl.querySelector('.quran-ext-results');
    const btn = rootEl.querySelector('.quran-ext-results-toggle');
    const chev = rootEl.querySelector('.quran-ext-results-chevron');
    if (chev && !chev.firstChild) chev.innerHTML = CHEVRON_DOWN;
    if (results) results.classList.toggle('quran-ext-results-collapsed', resultsCollapsed);
    if (btn) btn.setAttribute('aria-expanded', String(!resultsCollapsed));
  }

  function wireEvents() {
    wireResize();
    wireHeaderDrag();
    const pin = rootEl.querySelector('.quran-ext-panel-pin');
    if (pin) pin.addEventListener('click', (e) => {
      // T098 — reject synthetic events from page-world scripts.
      if (!e.isTrusted) return;
      e.stopPropagation();
      togglePin();
    });
    const floatToggle = rootEl.querySelector('.quran-ext-panel-float-toggle');
    if (floatToggle) floatToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (collapsed) expand(); else collapse();
    });
    const summaryToggle = rootEl.querySelector('.quran-ext-summary-toggle');
    if (summaryToggle) summaryToggle.addEventListener('click', () => {
      summaryCollapsed = !summaryCollapsed;
      applySummaryCollapsed();
      persistUi();
    });
    const resultsToggle = rootEl.querySelector('.quran-ext-results-toggle');
    if (resultsToggle) resultsToggle.addEventListener('click', () => {
      resultsCollapsed = !resultsCollapsed;
      applyResultsCollapsed();
      persistUi();
    });
    // The ref tooltip is position:fixed, so hide it when the list scrolls
    // (otherwise it lingers detached from its anchor). The findings container is
    // the scroll surface now (the panel itself no longer scrolls).
    rootEl.addEventListener('scroll', hideRefTip, { passive: true });
    const scroller = rootEl.querySelector('.quran-ext-panel-container');
    if (scroller) scroller.addEventListener('scroll', hideRefTip, { passive: true });
    rootEl.querySelectorAll('.quran-ext-filter-chip input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', (e) => {
        // T098 — reject synthetic events from page-world scripts.
        if (!e.isTrusted) return;
        activeFilter = { ...(activeFilter || {}), [cb.dataset.color]: cb.checked };
        render();
        QuranMsg.sendRequest('PREFS_WRITE', { patch: { panelFilter: activeFilter } }).catch(() => {});
      });
    });
    wireSwapAndPersist();
  }

  // Reflect the saved master swap state into the sidebar's quick-toggle. The
  // per-color + font defaults now live in the options page (T094).
  function syncSwapControls(prefs) {
    const master = rootEl.querySelector('.quran-ext-swap-master');
    const on = prefs?.master?.authenticTextReplacement !== false;
    if (master) master.checked = on;
    const label = rootEl.querySelector('.quran-ext-swap-quick');
    if (label) label.setAttribute('aria-checked', String(on)); // item 2 — role="switch" state
  }

  // Wire the master swap quick-toggle. This is the SAME global
  // prefs.v1.master.authenticTextReplacement setting the options page exposes —
  // surfaced here for quick access while reading (prefs.v1 has no session-scoped
  // field; T094 kept the schema unchanged). PREFS_WRITE broadcasts PREFS_CHANGED,
  // which content.js uses to reconcile the on-page swaps across tabs — so no
  // extra plumbing is needed here. (Per-color + font + clear-persisted moved to
  // the options page; T094.)
  function wireSwapAndPersist() {
    const master = rootEl.querySelector('.quran-ext-swap-master');
    const label = rootEl.querySelector('.quran-ext-swap-quick');
    if (!master) return;
    const persist = () => {
      if (label) label.setAttribute('aria-checked', String(master.checked));
      QuranMsg.sendRequest('PREFS_WRITE', { patch: { master: { authenticTextReplacement: master.checked } } }).catch(() => {});
    };
    // Mouse: clicking the label toggles the (display:none) checkbox natively and
    // fires a trusted change event.
    master.addEventListener('change', (e) => {
      // T098 — reject synthetic events from page-world scripts.
      if (!e.isTrusted) return;
      persist();
    });
    // Item 2 — keyboard: the chip is a role="switch" with a hidden checkbox, so
    // Space/Enter on the focused label must toggle + persist directly (a
    // synthetic .click() would be isTrusted=false and blocked by the guard above).
    if (label) label.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        master.checked = !master.checked;
        persist();
      }
    });
  }

  // Localize the static markup + set dir/lang on the panel root (T088/T089).
  function setLangDom(lang) {
    if (typeof QuranI18n === 'undefined' || !rootEl) return;
    QuranI18n.setLang(QuranI18n.detect(lang));
    rootEl.setAttribute('lang', QuranI18n.getLang());
    rootEl.setAttribute('dir', QuranI18n.dir());
    // The panel's base CSS sets `direction: rtl`, and the CSS property beats the
    // `dir` attribute — so pin direction inline to match the language (LTR for
    // English) or the whole panel keeps reading right-to-left.
    rootEl.style.direction = QuranI18n.dir() === 'ltr' ? 'ltr' : 'rtl';
    QuranI18n.applyDom(rootEl);
  }

  // Called by content.js on PREFS_CHANGED so a language switch re-localizes the
  // open sidebar (static markup + dynamic rows) without a reload.
  function applyLang(lang) {
    if (!rootEl) return;
    uiLang = lang === 'en' ? 'en' : 'ar';
    setLangDom(lang);
    applyLayout();   // 'auto'/'float' docking side tracks the language direction
    render();
  }

  // Called by content.js on PREFS_CHANGED when panelPosition changes, so the
  // open sidebar re-docks (or floats) without a reload.
  function setPosition(pos) {
    panelPosition = (pos === 'left' || pos === 'right' || pos === 'float') ? pos : 'auto';
    if (rootEl) applyLayout();
  }

  // Called on every PREFS_CHANGED. Only act when the anchor pref actually
  // changed (PREFS_CHANGED also fires for unrelated edits like the swap toggle);
  // otherwise we'd wipe the user's drag-chosen side/undocked state and snap the
  // panel back to the anchor default on every pref write. An explicit anchor
  // change clears the runtime override so the options choice wins.
  function setFloatAnchor(anchor) {
    const next = (anchor === 'left' || anchor === 'right') ? anchor : 'auto';
    if (next === floatAnchor) return;
    floatAnchor = next;
    floatSide = null;
    floatUndocked = false;
    if (isFloat() && rootEl) { applyLayout(); persistUi(); }
  }

  // Item 2 — called by content.js on PREFS_CHANGED so a highlight-style change
  // made elsewhere (e.g. the options page) re-renders the summary's 3-state
  // toggles without a reload.
  function applyHighlightPrefs(prefs) {
    if (!prefs) return;
    if (prefs.highlightStyle) highlightStyle = prefs.highlightStyle;
    if (typeof prefs.refHighlight === 'boolean') refHighlightEnabled = prefs.refHighlight;
    renderSummary();
  }

  // Mount the sidebar into the host page if not already present. Reads filter
  // from PREFS_READ so chips render in the saved state.
  //
  // mount() is async (fetchTemplate / loadUi / PREFS_READ all await). On busy
  // SPAs (WhatsApp Web) the mutation-rescan path and PREFS_CHANGED can both call
  // it in quick succession; without a latch, two callers pass the rootEl guard
  // while it's still null, both append a panel, and the second overwrites the
  // module's rootEl/tabEl refs — leaving the first one orphaned in the DOM as a
  // dead panel with no working pin or collapse tab. Serialize by returning the
  // pending promise to any concurrent caller.
  let mountInFlight = null;
  async function mount() {
    if (userClosed) return;
    if (mountInFlight) return mountInFlight;
    if (rootEl && document.body.contains(rootEl)) { render(); return; }
    if (!document.body) return;
    mountInFlight = (async () => { try { await doMount(); } finally { mountInFlight = null; } })();
    return mountInFlight;
  }
  // T021 — One-shot chrome.storage.onChanged listener for cross-surface theme
  // updates (feature 004, Clarifications Q1, FR-004). If the options page (or
  // any other surface) writes a new appearance.theme to prefs.v1, every page
  // with the sidebar mounted flips the panel root's data-theme attribute
  // within one frame. Installed once per page load; idempotent.
  let themeChangeHooked = false;
  function hookThemeChangeOnce() {
    if (themeChangeHooked) return;
    themeChangeHooked = true;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const c = changes['prefs.v1'];
      if (!c) return;
      const next = c.newValue && c.newValue.appearance && c.newValue.appearance.theme;
      const prev = c.oldValue && c.oldValue.appearance && c.oldValue.appearance.theme;
      if (!next || next === prev) return;
      if (!rootEl) return;
      const id = (typeof QuranThemes !== 'undefined' && QuranThemes.isValidId(next))
        ? next
        : (typeof QuranThemes !== 'undefined' ? QuranThemes.defaultId() : 'default');
      rootEl.dataset.theme = id;
      // Keep the edge tab (a sibling of the panel root in DOM) in sync so
      // same-element theme rules like &.quran-ext-panel-tab match.
      if (tabEl) tabEl.dataset.theme = id;
    });
  }

  async function doMount() {
    const html = await fetchTemplate();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    rootEl = wrapper.firstElementChild;

    // T020 — Apply the persisted theme BEFORE inserting into the DOM so the
    // sidebar never appears in an unthemed flash. Read chrome.storage.local
    // directly; QuranPrefs isn't loaded in content scripts, but the registry
    // is (manifest.json content_scripts.js).
    try {
      const r = await chrome.storage.local.get('prefs.v1');
      const stored = r && r['prefs.v1'] && r['prefs.v1'].appearance && r['prefs.v1'].appearance.theme;
      const themeId = (typeof QuranThemes !== 'undefined' && QuranThemes.isValidId(stored))
        ? stored
        : (typeof QuranThemes !== 'undefined' ? QuranThemes.defaultId() : 'default');
      rootEl.dataset.theme = themeId;
    } catch (_) {
      rootEl.dataset.theme = (typeof QuranThemes !== 'undefined' ? QuranThemes.defaultId() : 'default');
    }

    // Like the theme above, resolve everything that decides the panel's first
    // paint — docking side (lang/panelPosition/float state), width, collapsed —
    // BEFORE inserting into the DOM. The base CSS pins the panel at right:0, so
    // awaiting these after appendChild painted a right-docked panel for a frame
    // or two and then jumped it left for English/left-docked users.
    await loadUi();

    let prefs = {};
    try {
      const resp = await QuranMsg.sendRequest('PREFS_READ', {});
      prefs = resp?.payload?.result || {};
      activeFilter = prefs.panelFilter || { orange: true };
      highlightStyle = prefs.highlightStyle || {};
      refHighlightEnabled = prefs.refHighlight !== false;
      refLinksEnabled = prefs.refLinks !== false;
      uiLang = prefs.lang === 'en' ? 'en' : 'ar';
      uiFont = prefs.font || 'uthmaniHafs';
      panelPosition = prefs.panelPosition || 'auto';
      floatAnchor = prefs.floatAnchor || 'auto';
    } catch (_) { activeFilter = { orange: true }; }

    setLangDom(prefs.lang); // localize static markup + set dir/lang on the panel

    // Defensive sweep: drop any stray panel/tab nodes left over from an earlier
    // orphaned mount (e.g. if the host page tore the DOM down and back up
    // without our unmount running).
    document.querySelectorAll('.quran-ext-panel:not(.quran-ext-panel-error), .quran-ext-panel-tab').forEach(n => {
      if (n !== rootEl) n.remove();
    });
    tabEl = null;
    document.body.appendChild(rootEl);
    hookThemeChangeOnce();
    // Reserve gutter space on <html> so the sidebar doesn't overlap content.
    document.documentElement.classList.add('quran-ext-sidebar-mounted');

    // T154 — drive visibility re-renders on a 1s tick. Scans already trigger
    // render() via SCAN_PROGRESS/SCAN_COMPLETE, which covers active scrolling.
    // The tick covers the "user stopped scrolling and a row scrolled out of
    // view" case where no further scans fire but a span has disconnected.
    // Cheap: it only calls render() when the set of connected ids changed.
    startVisibilityTick();

    syncChips();
    wireEvents();
    syncSwapControls(prefs);
    applySummaryCollapsed(); // restore saved summary collapsed state + chevron
    applyResultsCollapsed(); // restore saved results collapsed state + chevron
    render();
    // Everything from appendChild to here is synchronous, so the browser never
    // paints the CSS-default (right-docked) position — the first visible frame
    // already has the resolved side, width, and collapsed state.
    applyLayout();

    // Page-level shortcut: Alt+Shift+Q from anywhere on the host page toggles
    // the panel. When collapsed it expands and pulls focus into the first row
    // (so keyboard users can hop back without Tabbing through the whole page);
    // when open it collapses to the edge tab.
    if (!window.__quranSidebarHotkey) {
      window.__quranSidebarHotkey = (e) => {
        if (e.altKey && e.shiftKey && (e.key === 'Q' || e.key === 'q')) {
          e.preventDefault();
          if (collapsed) focusFirstRow(); // focusFirstRow expands first
          else collapse();
        }
      };
      document.addEventListener('keydown', window.__quranSidebarHotkey);
    }

    // T054 — attach the panel keyboard model to the sidebar root (FR-030).
    if (typeof QuranPanelKeyboard !== 'undefined') {
      // Make the root focusable so the first Esc press can land there.
      if (!rootEl.hasAttribute('tabindex')) rootEl.setAttribute('tabindex', '-1');
      detachKeyboard = QuranPanelKeyboard.attach(rootEl, {
        rowSelector: '.quran-ext-panel-row',
        chipSelector: '.quran-ext-filter-chip',
        onAction: (kind, findingId) => {
          const finding = QuranPanelModel.get(findingId);
          if (!finding) return;
          // T023 — the single "fix" hotkey (f) routes to the correction action
          // that matches the focused finding's color/state: orange → ref rewrite;
          // yellow (safe) → text-replace; red with a near-match → accept; a
          // corrected successor → revert. Withheld where no correction applies.
          if (kind === 'correctInPlace') {
            if (finding.color === 'orange') kind = 'correctInPlace';
            else if (finding.color === 'yellow') { if (finding.unsafeToRewrite) return; kind = 'correctTextInPlace'; }
            else if (finding.color === 'red' && finding.nearMatch && finding.nearMatch.authenticText) {
              // A tie/near-tie must be chosen in the panel — never auto-accepted.
              if (Array.isArray(finding.nearMatch.rivalCandidates) && finding.nearMatch.rivalCandidates.length) return;
              kind = 'correctTextInPlace';
            }
            else if (finding.color === 'lightBlue') {
              // Accept the resolved reference; ambiguous → must choose in the panel.
              const sug = QuranPanelModel.suggestRefForLightBlue(finding.id);
              if (sug && !sug.ambiguous && sug.ref) { runAction('correctReferenceAttribution', finding, { ref: sug.ref }); }
              return;
            }
            else if (finding.color === 'lightGreen' && finding.priorFinding) kind = 'revertCorrection';
            else return;
          }
          runAction(kind, finding);
        },
        onEscape: () => {
          // Second Esc in the sidebar: blur back to the host page.
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
        },
      });
    }
  }

  // T154 — visibility tick + connected-set fingerprint, see comment in mount().
  let visibilityTimer = null;
  let lastVisibilityFingerprint = '';
  function computeVisibilityFingerprint() {
    const ids = [];
    for (const f of QuranPanelModel.all()) if (isPageConnected(f.id)) ids.push(f.id);
    ids.sort();
    return ids.join('|');
  }
  function startVisibilityTick() {
    stopVisibilityTick();
    lastVisibilityFingerprint = computeVisibilityFingerprint();
    visibilityTimer = setInterval(() => {
      if (!rootEl) return;
      const fp = computeVisibilityFingerprint();
      if (fp === lastVisibilityFingerprint) return;
      lastVisibilityFingerprint = fp;
      render();
    }, 1000);
  }
  function stopVisibilityTick() {
    if (visibilityTimer) { clearInterval(visibilityTimer); visibilityTimer = null; }
    lastVisibilityFingerprint = '';
  }

  function unmount() {
    stopVisibilityTick();
    if (detachKeyboard) { detachKeyboard(); detachKeyboard = null; }
    if (window.__quranSidebarHotkey) {
      document.removeEventListener('keydown', window.__quranSidebarHotkey);
      window.__quranSidebarHotkey = null;
    }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null;
    if (tabEl && tabEl.parentNode) tabEl.parentNode.removeChild(tabEl);
    tabEl = null;
    if (refTipEl && refTipEl.parentNode) refTipEl.parentNode.removeChild(refTipEl);
    refTipEl = null;
    document.documentElement.classList.remove('quran-ext-sidebar-mounted');
    document.documentElement.style.removeProperty('margin-right');
    document.documentElement.style.removeProperty('margin-left');
  }

  function focusFirstRow() {
    if (!rootEl) return;
    if (collapsed) expand(); // can't focus a row while collapsed
    const row = rootEl.querySelector('.quran-ext-panel-row');
    if (row) row.focus();
    else rootEl.focus();
  }

  // Called by content.js at fresh-full scan start so a new user-initiated scan
  // can re-open the sidebar even if it had been closed earlier this session.
  function clearUserClosed() { userClosed = false; }

  function upsert(finding) { QuranPanelModel.upsert(finding); if (rootEl) render(); }
  // T066 — ingest a correct-in-place successor (discards prior, pins successor).
  function ingest(finding, priorFindingId) { QuranPanelModel.ingestProgress(finding, priorFindingId || null); if (rootEl) render(); }
  // Revert a correction: drop the lightGreen successor row and put the original
  // (pre-correction) finding back in its place. Called by content.js after the
  // page span has already been rewritten back.
  function revertCorrection(successorId, original) {
    QuranPanelModel.remove(successorId);
    if (original) QuranPanelModel.upsert(original);
    if (rootEl) render();
  }
  function reset() { QuranPanelModel.reset(); if (rootEl) render(); }
  // Drop stale persisted badges after the options page clears the store, then
  // re-render so the open sidebar reflects the cleared state immediately.
  function clearPersistedBadges() {
    QuranPanelModel.all().forEach(f => { if (f.panelState) f.panelState.persistedBadge = null; });
    if (rootEl) render();
  }
  function tagPersisted(entries) { QuranPanelModel.tagPersisted(entries); if (rootEl) render(); }
  function isMounted() { return rootEl !== null && document.body.contains(rootEl); }

  // Page → panel: scroll the row for findingId into view and flash it. Called
  // by content.js when the user clicks a highlight on the page (the inverse of
  // the panel → page jump). Returns false if the row isn't currently shown
  // (e.g. its category is filtered out). Finding ids are [0-9a-z-] so the
  // attribute selector needs no escaping.
  function focusRow(findingId) {
    if (!rootEl || !findingId) return false;
    if (collapsed) expand(); // surface the panel so the row is visible
    const row = rootEl.querySelector(`.quran-ext-panel-row[data-finding-id="${findingId}"]`);
    if (!row) return false;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('quran-ext-panel-row-flash');
    setTimeout(() => row.classList.remove('quran-ext-panel-row-flash'), 1500);
    try { row.focus({ preventScroll: true }); } catch (_) {}
    return true;
  }

  // FR-020 — data-unavailable error surface. The findings panel needs the Quran
  // data to populate, so when the data fails to load we show a standalone,
  // self-contained error panel (themed via the shared .quran-ext-panel tokens)
  // with a Retry that re-attempts the load. Kept distinct from the "no citations"
  // empty state so a data error is never indistinguishable from a clean page.
  let errorEl = null;
  function showError(reason) {
    clearError();
    if (!document.body) return;
    // Drop any stale findings panel so the two surfaces don't overlap.
    if (rootEl) { try { unmount(); } catch (_) {} }
    const lang = (typeof QuranI18n !== 'undefined') ? QuranI18n.getLang() : 'ar';
    const dir = (typeof QuranI18n !== 'undefined') ? QuranI18n.dir() : 'rtl';
    const t = (k, v) => (typeof QuranI18n !== 'undefined') ? QuranI18n.t(k, v) : k;

    errorEl = document.createElement('div');
    errorEl.className = 'quran-ext-panel quran-ext-panel-error';
    errorEl.setAttribute('lang', lang);
    errorEl.setAttribute('dir', dir);
    errorEl.style.direction = dir === 'ltr' ? 'ltr' : 'rtl';
    errorEl.setAttribute('role', 'region');
    errorEl.setAttribute('aria-label', t('sidebar_title'));

    const header = document.createElement('div');
    header.className = 'quran-ext-panel-header';
    header.textContent = t('sidebar_title');

    const body = document.createElement('div');
    body.className = 'quran-ext-error-body';
    const msg = document.createElement('p');
    msg.className = 'quran-ext-error-msg';
    msg.setAttribute('role', 'alert');
    msg.textContent = t('data_error_panel');
    const retry = document.createElement('button');
    retry.className = 'quran-ext-error-retry';
    retry.textContent = t('retry_btn');
    retry.addEventListener('click', (e) => {
      // T098 — only act on real user clicks, not synthetic page events.
      if (!e.isTrusted) return;
      retry.disabled = true;
      QuranMsg.sendRequest('RETRY_DATA_LOAD', {})
        .catch(() => {})
        .finally(() => { retry.disabled = false; });
    });
    body.append(msg, retry);
    errorEl.append(header, body);
    document.body.appendChild(errorEl);
    document.documentElement.classList.add('quran-ext-sidebar-mounted');
  }
  function clearError() {
    if (errorEl && errorEl.parentNode) errorEl.parentNode.removeChild(errorEl);
    errorEl = null;
    if (!rootEl) document.documentElement.classList.remove('quran-ext-sidebar-mounted');
  }

  return { mount, unmount, upsert, ingest, revertCorrection, reset, tagPersisted, clearPersistedBadges, isMounted, clearUserClosed, focusRow, applyLang, setPosition, setFloatAnchor, applyHighlightPrefs, showError, clearError };
})();
