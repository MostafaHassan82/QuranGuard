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

  function ensureTab() {
    if (tabEl && document.body.contains(tabEl)) return tabEl;
    tabEl = document.createElement('div');
    tabEl.className = 'quran-ext-panel-tab';
    tabEl.setAttribute('role', 'button');
    tabEl.setAttribute('tabindex', '0');
    tabEl.innerHTML = CHEVRON_LEFT;
    const toggle = () => { if (collapsed) expand(); else collapse(); };
    tabEl.addEventListener('click', toggle);
    tabEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    document.body.appendChild(tabEl);
    return tabEl;
  }

  function persistUi() {
    try {
      chrome.storage.local.set({ [UI_KEY]: {
        width: panelWidth, collapsed, summaryCollapsed,
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
    snippet.textContent = finding.text || '';

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

    // Action buttons (T052). Primary action is row click = jump (FR-011a).
    const actions = document.createElement('div');
    actions.className = 'quran-ext-panel-actions';
    if (finding.color === 'orange') {
      actions.append(makeActionBtn(T('act_correct'), () => runAction('correctInPlace', finding)));
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

  function makeActionBtn(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quran-ext-panel-action-btn';
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  async function runAction(kind, finding) {
    if (typeof QuranActions === 'undefined') return;
    const opts = { pageUrl: location.href };
    try {
      switch (kind) {
        case 'jump':   QuranActions.jumpInContent(finding.id); break;
        case 'copy':   await QuranActions.copyRecord(finding, opts); break;
        case 'share':  await QuranActions.copyShareArtifact(finding, opts); break;
        case 'report': await QuranActions.copyReport(finding, opts); break;
        case 'json':   await QuranActions.copyRecordJson(finding, opts); break;
        // T067 — correct-in-place runs directly in this content context; the
        // sidebar model is updated by content.js via QuranPanelSidebar.ingest.
        case 'correctInPlace': await QuranActions.correctInContent(finding.id); break;
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

  // Results summary table (moved from the popup; T094). Counts derive from the
  // panel model so the sidebar owns perCategoryCount without extra messaging.
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
      cell.className = key === 'total'
        ? 'quran-ext-summary-cell quran-ext-summary-total'
        : `quran-ext-summary-cell quran-ext-summary-${key}`;
      const label = document.createElement('span');
      label.className = 'quran-ext-summary-label';
      label.textContent = T(key === 'total' ? 'stat_total'
        : key === 'lightBlue' ? 'stat_lightblue' : 'stat_' + key);
      const value = document.createElement('span');
      value.className = 'quran-ext-summary-value';
      value.textContent = n;
      cell.append(label, value);
      grid.append(cell);
    }
  }

  function render() {
    if (!rootEl) return;
    renderSummary();
    const container = rootEl.querySelector('.quran-ext-panel-container');
    container.replaceChildren();

    const filter = activeFilter || {};
    const active = QuranPanelModel.activeView(filter);
    const recent = QuranPanelModel.recentlyCorrected();
    const dismissed = QuranPanelModel.dismissedThisSession();
    const prior = QuranPanelModel.previouslyDismissed();

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

  function wireEvents() {
    wireResize();
    wireHeaderDrag();
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
    if (master) master.checked = prefs?.master?.authenticTextReplacement !== false;
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
    if (master) master.addEventListener('change', (e) => {
      // T098 — reject synthetic events from page-world scripts.
      if (!e.isTrusted) return;
      QuranMsg.sendRequest('PREFS_WRITE', { patch: { master: { authenticTextReplacement: master.checked } } }).catch(() => {});
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

  // Mount the sidebar into the host page if not already present. Reads filter
  // from PREFS_READ so chips render in the saved state.
  async function mount() {
    if (userClosed) return;
    if (rootEl && document.body.contains(rootEl)) { render(); return; }
    if (!document.body) return;

    const html = await fetchTemplate();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    rootEl = wrapper.firstElementChild;
    document.body.appendChild(rootEl);
    // Reserve gutter space on <html> so the sidebar doesn't overlap content.
    document.documentElement.classList.add('quran-ext-sidebar-mounted');

    await loadUi();

    let prefs = {};
    try {
      const resp = await QuranMsg.sendRequest('PREFS_READ', {});
      prefs = resp?.payload?.result || {};
      activeFilter = prefs.panelFilter || { orange: true };
      refLinksEnabled = prefs.refLinks !== false;
      uiLang = prefs.lang === 'en' ? 'en' : 'ar';
      uiFont = prefs.font || 'uthmaniHafs';
      panelPosition = prefs.panelPosition || 'auto';
      floatAnchor = prefs.floatAnchor || 'auto';
    } catch (_) { activeFilter = { orange: true }; }

    setLangDom(prefs.lang); // localize static markup + set dir/lang on the panel
    syncChips();
    wireEvents();
    syncSwapControls(prefs);
    applySummaryCollapsed(); // restore saved summary collapsed state + chevron
    render();
    applyLayout(); // restore saved width / collapsed state

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
          if (finding) runAction(kind, finding);
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

  function unmount() {
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

  return { mount, unmount, upsert, ingest, reset, tagPersisted, clearPersistedBadges, isMounted, clearUserClosed, focusRow, applyLang, setPosition, setFloatAnchor };
})();
