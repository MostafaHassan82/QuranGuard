'use strict';
// T050 — Page-injected sidebar surface. Runs in the content-script world,
// uses its own QuranPanelModel instance (separate from the popup's). Mounts
// only when prefs.panelSurface === 'sidebar' AND the scan produced findings
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
    actions.append(
      makeActionBtn('نسخ',    () => runAction('copy',   finding)),
      makeActionBtn('مشاركة', () => runAction('share',  finding)),
      makeActionBtn('تقرير',  () => runAction('report', finding)),
      makeActionBtn('JSON',   () => runAction('json',   finding)),
    );
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
    if (active.length)    container.append(makeSection('النتائج', active));
    if (recent.length)    container.append(makeSection('صُحِّحت مؤخرًا', recent));
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
    rootEl.querySelector('.quran-ext-panel-close').addEventListener('click', () => {
      userClosed = true;
      unmount();
    });
    rootEl.querySelectorAll('.quran-ext-filter-chip input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        activeFilter = { ...(activeFilter || {}), [cb.dataset.color]: cb.checked };
        render();
        QuranMsg.sendRequest('PREFS_WRITE', { patch: { panelFilter: activeFilter } }).catch(() => {});
      });
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

    try {
      const resp = await QuranMsg.sendRequest('PREFS_READ', {});
      activeFilter = resp?.payload?.result?.panelFilter || { orange: true };
    } catch (_) { activeFilter = { orange: true }; }

    syncChips();
    wireEvents();
    render();

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
    document.documentElement.classList.remove('quran-ext-sidebar-mounted');
  }

  function focusFirstRow() {
    if (!rootEl) return;
    const row = rootEl.querySelector('.quran-ext-panel-row');
    if (row) row.focus();
    else rootEl.focus();
  }

  // Called by content.js at fresh-full scan start so a new user-initiated scan
  // can re-open the sidebar even if it had been closed earlier this session.
  function clearUserClosed() { userClosed = false; }

  function upsert(finding) { QuranPanelModel.upsert(finding); if (rootEl) render(); }
  function reset() { QuranPanelModel.reset(); if (rootEl) render(); }
  function tagPersisted(entries) { QuranPanelModel.tagPersisted(entries); if (rootEl) render(); }
  function isMounted() { return rootEl !== null && document.body.contains(rootEl); }

  return { mount, unmount, upsert, reset, tagPersisted, isMounted, clearUserClosed };
})();
