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
  let tabEl = null;
  const MIN_PANEL_W = 240;
  const TAB_W = 26;
  const UI_KEY = 'quran.sidebar.ui';

  // Set the host root's right gutter (inline + important so it beats any host
  // stylesheet) to match the visible sidebar width — or the tab when collapsed.
  function setHostMargin(px) {
    document.documentElement.style.setProperty('margin-right', px + 'px', 'important');
  }

  function clampWidth(w) {
    const max = Math.round(window.innerWidth * 0.9);
    return Math.max(MIN_PANEL_W, Math.min(max, w));
  }

  // Chevron icons for the persistent edge toggle. Left = expand (pull the panel
  // out); right = collapse (push it to the edge).
  const CHEVRON_LEFT  = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Reflect collapsed/width state into the DOM (panel, host margin, tab). The
  // edge tab stays mounted in BOTH states: when collapsed it's the only handle;
  // when expanded it rides the panel's left edge as a persistent collapse
  // toggle.
  function applyLayout() {
    if (!rootEl) return;
    const tab = ensureTab();
    tab.style.display = 'flex';
    if (collapsed) {
      rootEl.style.display = 'none';
      tab.style.right = '0px';
      tab.innerHTML = CHEVRON_LEFT;
      tab.setAttribute('aria-label', T('tab_open_aria'));
      tab.title = T('tab_open_aria');
      setHostMargin(TAB_W);
    } else {
      rootEl.style.display = 'flex';
      rootEl.style.width = panelWidth + 'px';
      tab.style.right = panelWidth + 'px';
      tab.innerHTML = CHEVRON_RIGHT;
      tab.setAttribute('aria-label', T('collapse_aria'));
      tab.title = T('collapse');
      setHostMargin(panelWidth);
    }
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
    try { chrome.storage.local.set({ [UI_KEY]: { width: panelWidth, collapsed } }); } catch (_) {}
  }

  async function loadUi() {
    try {
      const r = await chrome.storage.local.get(UI_KEY);
      const ui = r?.[UI_KEY] || {};
      if (typeof ui.width === 'number') panelWidth = clampWidth(ui.width);
      collapsed = !!ui.collapsed;
    } catch (_) {}
  }

  function collapse() { collapsed = true; applyLayout(); persistUi(); }
  function expand() { collapsed = false; applyLayout(); persistUi(); focusFirstRow(); }

  // Drag the left edge to resize. Panel is pinned right, so width tracks the
  // distance from the cursor to the right viewport edge.
  function wireResize() {
    const handle = rootEl.querySelector('.quran-ext-panel-resize');
    if (!handle) return;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const onMove = (ev) => {
        panelWidth = clampWidth(window.innerWidth - ev.clientX);
        rootEl.style.width = panelWidth + 'px';
        setHostMargin(panelWidth);
        if (tabEl) tabEl.style.right = panelWidth + 'px';
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
    if (finding.color === 'lightGreen' && finding.correctedFromRef) {
      // Corrected: show what was wrong (the bad ref) → the true ref.
      refs.textContent = `${finding.correctedFromRef} ✎→ ${matched || cited}`;
    } else if (cited && matched && cited !== matched) {
      refs.textContent = `${cited} → ${matched}`;
    } else {
      refs.textContent = matched || cited || '';
    }

    row.setAttribute('aria-label',
      `${catLabel(finding.color)}. ${finding.text || ''}${refs.textContent ? '. ' + refs.textContent : ''}`);

    row.append(head, snippet);
    if (refs.textContent) row.append(refs);

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

  function wireEvents() {
    wireResize();
    rootEl.querySelectorAll('.quran-ext-filter-chip input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
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
    if (master) master.addEventListener('change', () => {
      QuranMsg.sendRequest('PREFS_WRITE', { patch: { master: { authenticTextReplacement: master.checked } } }).catch(() => {});
    });
  }

  // Localize the static markup + set dir/lang on the panel root (T088/T089).
  function setLangDom(lang) {
    if (typeof QuranI18n === 'undefined' || !rootEl) return;
    QuranI18n.setLang(QuranI18n.detect(lang));
    rootEl.setAttribute('lang', QuranI18n.getLang());
    rootEl.setAttribute('dir', QuranI18n.dir());
    QuranI18n.applyDom(rootEl);
  }

  // Called by content.js on PREFS_CHANGED so a language switch re-localizes the
  // open sidebar (static markup + dynamic rows) without a reload.
  function applyLang(lang) {
    if (!rootEl) return;
    setLangDom(lang);
    render();
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
    } catch (_) { activeFilter = { orange: true }; }

    setLangDom(prefs.lang); // localize static markup + set dir/lang on the panel
    syncChips();
    wireEvents();
    syncSwapControls(prefs);
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
    document.documentElement.classList.remove('quran-ext-sidebar-mounted');
    document.documentElement.style.removeProperty('margin-right');
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

  return { mount, unmount, upsert, ingest, reset, tagPersisted, clearPersistedBadges, isMounted, clearUserClosed, focusRow, applyLang };
})();
