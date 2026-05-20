'use strict';
// T050 — Page-injected sidebar surface. Runs in the content-script world and
// is the ONLY panel surface (the popup is scan-only). Mounts whenever a scan
// produces findings; the user can collapse it to a tab but not close it. Hosts
// the findings list, filters, swap controls, and saved-corrections settings
// (FR-010, FR-027, FR-029).
const QuranPanelSidebar = (() => {
  const CATEGORY_LABEL_AR = {
    green:     'مطابق للقرآن مع المرجع',
    lightBlue: 'مطابق للقرآن — لم يُذكر المرجع',
    yellow:    'اختلاف لفظي',
    orange:    'مرجع غير مطابق',
    red:       'لم يُعثر عليه في القرآن',
  };
  const CATEGORY_GLYPH = { green: '✓', lightBlue: '✓', yellow: '~', orange: '⚠', red: '✗' };

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

  // Reflect collapsed/width state into the DOM (panel, host margin, tab).
  function applyLayout() {
    if (!rootEl) return;
    if (collapsed) {
      rootEl.style.display = 'none';
      ensureTab().style.display = 'flex';
      setHostMargin(TAB_W);
    } else {
      rootEl.style.display = 'flex';
      rootEl.style.width = panelWidth + 'px';
      if (tabEl) tabEl.style.display = 'none';
      setHostMargin(panelWidth);
    }
  }

  function ensureTab() {
    if (tabEl && document.body.contains(tabEl)) return tabEl;
    tabEl = document.createElement('div');
    tabEl.className = 'quran-ext-panel-tab';
    tabEl.setAttribute('role', 'button');
    tabEl.setAttribute('tabindex', '0');
    tabEl.setAttribute('aria-label', 'فتح اللوحة');
    tabEl.title = 'فتح لوحة النتائج';
    tabEl.textContent = 'النتائج ⟨';
    const open = () => expand();
    tabEl.addEventListener('click', open);
    tabEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
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
    label.textContent = CATEGORY_LABEL_AR[finding.color] || finding.color;
    head.append(glyph, swatch, label);

    const snippet = document.createElement('div');
    snippet.className = 'quran-ext-panel-snippet';
    snippet.textContent = finding.text || '';

    const refs = document.createElement('div');
    refs.className = 'quran-ext-panel-refs';
    const cited = finding.claimedRef || finding.citedReference || '';
    const matched = finding.matchedRef || '';
    if (cited && matched && cited !== matched) refs.textContent = `${cited} → ${matched}`;
    else refs.textContent = matched || cited || '';

    row.setAttribute('aria-label',
      `${CATEGORY_LABEL_AR[finding.color] || finding.color}. ${finding.text || ''}${refs.textContent ? '. ' + refs.textContent : ''}`);

    row.append(head, snippet);
    if (refs.textContent) row.append(refs);

    // Action buttons (T052). Primary action is row click = jump (FR-011a).
    const actions = document.createElement('div');
    actions.className = 'quran-ext-panel-actions';
    if (finding.color === 'orange') {
      actions.append(makeActionBtn('تصحيح', () => runAction('correctInPlace', finding)));
    }
    actions.append(
      makeActionBtn('نسخ',    () => runAction('copy',   finding)),
      makeActionBtn('مشاركة', () => runAction('share',  finding)),
      makeActionBtn('تقرير',  () => runAction('report', finding)),
      makeActionBtn('JSON',   () => runAction('json',   finding)),
    );
    const isDismissed = finding.panelState?.dismissedThisSession === true ||
                        finding.panelState?.persistedBadge?.kind === 'dismissed';
    actions.append(isDismissed
      ? makeActionBtn('استرجاع', () => runAction('restore', finding))
      : makeActionBtn('تجاهل',   () => runAction('dismiss', finding)));
    row.append(actions);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.quran-ext-panel-action-btn')) return;
      runAction('jump', finding);
    });

    const persist = finding.panelState?.persistedBadge;
    if (persist) {
      const badge = document.createElement('span');
      badge.className = `quran-ext-panel-persisted quran-ext-panel-persisted-${persist.kind}`;
      badge.textContent = (persist.kind === 'corrected' ? 'صُحِّح سابقًا' : 'مرفوض سابقًا') +
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

  function render() {
    if (!rootEl) return;
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
        ? 'لا توجد نتائج بعد'
        : 'لا توجد نتائج تطابق المرشّحات الحالية';
      container.append(empty);
      return;
    }
    // FR-022 — "Recently corrected" pinned at the top, regardless of filter.
    if (recent.length)    container.append(makeSection('صُحِّحت مؤخرًا', recent));
    if (active.length)    container.append(makeSection('النتائج', active));
    if (dismissed.length) container.append(makeSection('مرفوضة (هذه الجلسة)', dismissed));
    if (prior.length)     container.append(makeSection('مرفوضة سابقًا', prior));
  }

  function syncChips() {
    if (!rootEl) return;
    rootEl.querySelectorAll('.quran-ext-filter-chip input[type=checkbox]').forEach(cb => {
      cb.checked = activeFilter?.[cb.dataset.color] === true;
    });
  }

  function wireEvents() {
    const collapseBtn = rootEl.querySelector('.quran-ext-panel-collapse');
    if (collapseBtn) collapseBtn.addEventListener('click', () => collapse());
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

  // Reflect saved prefs into the swap controls (moved here from the popup).
  function syncSwapControls(prefs) {
    const master = rootEl.querySelector('.quran-ext-swap-master');
    if (master) master.checked = prefs?.master?.authenticTextReplacement !== false;
    const perColor = prefs?.perColor || {};
    rootEl.querySelectorAll('[data-swap-color]').forEach(cb => {
      const c = cb.dataset.swapColor;
      if (c === 'red') { cb.checked = false; cb.disabled = true; return; } // FR-015
      cb.checked = perColor[c] !== false;
    });
    const fontSel = rootEl.querySelector('.quran-ext-font-select');
    if (fontSel) fontSel.value = prefs?.font || 'uthmaniHafs';
  }

  // Wire the swap controls + the "clear saved corrections" button. PREFS_WRITE
  // broadcasts PREFS_CHANGED, which content.js uses to reconcile the on-page
  // swaps — so no extra plumbing is needed here.
  function wireSwapAndPersist() {
    const master = rootEl.querySelector('.quran-ext-swap-master');
    if (master) master.addEventListener('change', () => {
      QuranMsg.sendRequest('PREFS_WRITE', { patch: { master: { authenticTextReplacement: master.checked } } }).catch(() => {});
    });
    rootEl.querySelectorAll('[data-swap-color]').forEach(cb => {
      if (cb.dataset.swapColor === 'red') return; // FR-015 — locked off
      cb.addEventListener('change', () => {
        QuranMsg.sendRequest('PREFS_WRITE', { patch: { perColor: { [cb.dataset.swapColor]: cb.checked } } }).catch(() => {});
      });
    });
    const fontSel = rootEl.querySelector('.quran-ext-font-select');
    if (fontSel) fontSel.addEventListener('change', () => {
      QuranMsg.sendRequest('PREFS_WRITE', { patch: { font: fontSel.value } }).catch(() => {});
    });

    const clearBtn = rootEl.querySelector('.quran-ext-clear-persisted');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      const status = rootEl.querySelector('.quran-ext-persist-status');
      clearBtn.disabled = true;
      try {
        const resp = await QuranMsg.sendRequest('CLEAR_PERSISTED', {});
        const pruned = resp?.payload?.result?.prunedCount ?? 0;
        if (status) status.textContent = `تم المسح — لا توجد عناصر محفوظة (أُزيلت ${pruned}).`;
        QuranPanelModel.all().forEach(f => { if (f.panelState) f.panelState.persistedBadge = null; });
        render();
      } catch (_) {
        if (status) status.textContent = 'تعذّر المسح. حاول مرة أخرى.';
      } finally {
        clearBtn.disabled = false;
      }
    });
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

    syncChips();
    wireEvents();
    syncSwapControls(prefs);
    render();
    applyLayout(); // restore saved width / collapsed state

    // Page-level shortcut: Alt+Shift+Q from anywhere on the host page pulls
    // focus into the sidebar's first row. Lets keyboard users hop back to the
    // panel after a jump-to-highlight or any other page interaction without
    // having to Tab through every focusable element on the host page.
    if (!window.__quranSidebarHotkey) {
      window.__quranSidebarHotkey = (e) => {
        if (e.altKey && e.shiftKey && (e.key === 'Q' || e.key === 'q')) {
          e.preventDefault();
          focusFirstRow();
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

  return { mount, unmount, upsert, ingest, reset, tagPersisted, isMounted, clearUserClosed, focusRow };
})();
