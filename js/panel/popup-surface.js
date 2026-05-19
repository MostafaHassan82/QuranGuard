'use strict';
// T046 — Popup-attached panel surface. Renders Findings from QuranPanelModel
// into #panel-container inside html/popup.html. Per-row layout follows FR-010:
// category glyph + category-name in words + color swatch + citation snippet
// + (cited ref / true ref). Each row is role="button" + tabindex="0" (FR-030).
//
// Action wiring (jump / copy / share / report / copy-as-JSON) ships with T051;
// rows currently emit no events. The surface is render-only here.
const QuranPanelSurface = (() => {
  // Owned by popup.js — surface needs the active tab to dispatch jumps + page
  // URL for the record builders. Set via setContext({tabId, pageUrl}).
  let _ctx = { tabId: null, pageUrl: '' };
  function setContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

  // FR-005 category-name-in-words. Mirrors content.js CATEGORY_LABEL_AR; kept
  // in sync by hand (the popup loads no content scripts so we can't import it).
  const CATEGORY_LABEL_AR = {
    green:     'مطابق للقرآن مع المرجع',
    lightBlue: 'مطابق للقرآن — لم يُذكر المرجع',
    yellow:    'اختلاف لفظي',
    orange:    'مرجع غير مطابق',
    red:       'لم يُعثر عليه في القرآن',
  };
  // Same glyph vocabulary the badge + tooltip use. Stable across surfaces.
  const CATEGORY_GLYPH = {
    green:     '✓',
    lightBlue: '✓',
    yellow:    '~',
    orange:    '⚠',
    red:       '✗',
  };

  function $(id) { return document.getElementById(id); }

  function makeRow(finding) {
    const row = document.createElement('div');
    row.className = `panel-row panel-row-${finding.color}`;
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.findingId = finding.id;
    row.dataset.color = finding.color;

    const glyph = document.createElement('span');
    glyph.className = 'panel-glyph';
    glyph.textContent = CATEGORY_GLYPH[finding.color] || '•';
    glyph.setAttribute('aria-hidden', 'true');

    const swatch = document.createElement('span');
    swatch.className = `panel-swatch panel-swatch-${finding.color}`;
    swatch.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'panel-category';
    label.textContent = CATEGORY_LABEL_AR[finding.color] || finding.color;

    const snippet = document.createElement('div');
    snippet.className = 'panel-snippet';
    snippet.textContent = finding.text || '';

    const refs = document.createElement('div');
    refs.className = 'panel-refs';
    const cited = finding.claimedRef || finding.citedReference || '';
    const matched = finding.matchedRef || '';
    if (cited && matched && cited !== matched) {
      refs.textContent = `${cited} → ${matched}`;
    } else {
      refs.textContent = matched || cited || '';
    }

    row.setAttribute(
      'aria-label',
      `${CATEGORY_LABEL_AR[finding.color] || finding.color}. ${finding.text || ''}${refs.textContent ? '. ' + refs.textContent : ''}`
    );

    const persist = finding.panelState?.persistedBadge;
    if (persist) {
      const badge = document.createElement('span');
      badge.className = `panel-persisted panel-persisted-${persist.kind}`;
      badge.textContent = (persist.kind === 'corrected' ? 'صُحِّح سابقًا' : 'مرفوض سابقًا') +
                          (persist.when ? ` — ${persist.when}` : '');
      row.appendChild(badge);
    }

    const head = document.createElement('div');
    head.className = 'panel-head';
    head.append(glyph, swatch, label);
    row.append(head, snippet);
    if (refs.textContent) row.append(refs);

    // Action buttons (T052). F + D ship with US4 — omit until then.
    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    actions.append(
      makeActionBtn('نسخ',     'copy',    () => doAction('copy', finding)),
      makeActionBtn('مشاركة',  'share',   () => doAction('share', finding)),
      makeActionBtn('تقرير',   'report',  () => doAction('report', finding)),
      makeActionBtn('JSON',    'json',    () => doAction('json', finding)),
    );
    row.append(actions);

    // Primary action: click on row body = jump-to-highlight (FR-011a).
    row.addEventListener('click', (e) => {
      // Avoid double-firing when the click landed on an action button.
      if (e.target.closest('.panel-action-btn')) return;
      doAction('jump', finding);
    });

    return row;
  }

  function makeActionBtn(label, kind, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `panel-action-btn panel-action-${kind}`;
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  async function doAction(kind, finding) {
    if (typeof QuranActions === 'undefined') return;
    const opts = { pageUrl: _ctx.pageUrl };
    try {
      switch (kind) {
        case 'jump':   await QuranActions.jumpFromPopup(_ctx.tabId, finding.id); break;
        case 'copy':   await QuranActions.copyRecord(finding, opts); break;
        case 'share':  await QuranActions.copyShareArtifact(finding, opts); break;
        case 'report': await QuranActions.copyReport(finding, opts); break;
        case 'json':   await QuranActions.copyRecordJson(finding, opts); break;
      }
    } catch (_) { /* clipboard or messaging errors are non-fatal */ }
  }

  function makeSection(title, findings) {
    const section = document.createElement('section');
    section.className = 'panel-section';
    const h = document.createElement('h3');
    h.className = 'panel-section-title';
    h.textContent = `${title} (${findings.length})`;
    section.append(h);
    for (const f of findings) section.append(makeRow(f));
    return section;
  }

  // Render the four sections per data-model.md. The caller owns the filter
  // (read from prefs.panelFilter). Empty sections are omitted so the popup
  // stays compact.
  function render({ filter } = {}) {
    const root = $('panel-container');
    if (!root) return;
    root.replaceChildren();

    const active = QuranPanelModel.activeView(filter || {});
    const recent = QuranPanelModel.recentlyCorrected();
    const dismissed = QuranPanelModel.dismissedThisSession();
    const prior = QuranPanelModel.previouslyDismissed();

    if (active.length === 0 && recent.length === 0 && dismissed.length === 0 && prior.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = QuranPanelModel.size() === 0
        ? 'لا توجد نتائج بعد'
        : 'لا توجد نتائج تطابق المرشّحات الحالية';
      root.append(empty);
      return;
    }

    if (active.length > 0)    root.append(makeSection('النتائج', active));
    if (recent.length > 0)    root.append(makeSection('صُحِّحت مؤخرًا', recent));
    if (dismissed.length > 0) root.append(makeSection('مرفوضة (هذه الجلسة)', dismissed));
    if (prior.length > 0)     root.append(makeSection('مرفوضة سابقًا', prior));
  }

  // T054 — keyboard wiring for the popup surface (FR-030).
  function attachKeyboard() {
    if (typeof QuranPanelKeyboard === 'undefined') return () => {};
    const root = $('panel-container');
    if (!root) return () => {};
    return QuranPanelKeyboard.attach(root, {
      rowSelector: '.panel-row',
      chipSelector: '.filter-chip',
      onAction: (kind, findingId) => {
        const finding = QuranPanelModel.get(findingId);
        if (!finding) return;
        doAction(kind, finding);
      },
      onEscape: () => {
        // Second Esc in the popup: return focus to the popup root (body).
        if (document.body && typeof document.body.focus === 'function') {
          document.body.setAttribute('tabindex', '-1');
          document.body.focus();
        }
      },
    });
  }

  return { render, setContext, attachKeyboard };
})();
