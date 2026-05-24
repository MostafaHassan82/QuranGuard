'use strict';

// Runs inside the Playwright page during coverage mode only.
// Keep interaction-only probes here instead of embedding them in run_tests_node.js.
module.exports = async function coverageDriverInteractions(options = {}) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const step = async (fn) => { try { await fn(); } catch (_) {} };
  const extended = options && options.extended === true;

  // These are content-script lexical globals in the page, not window properties.
  const Actions = (typeof QuranActions !== 'undefined') ? QuranActions : null;
  const Model = (typeof QuranPanelModel !== 'undefined') ? QuranPanelModel : null;
  const Sidebar = (typeof QuranPanelSidebar !== 'undefined') ? QuranPanelSidebar : null;
  const Msg = (typeof QuranMsg !== 'undefined') ? QuranMsg : null;
  const Badge = (typeof QuranBadge !== 'undefined') ? QuranBadge : null;
  const correct = (typeof correctInPlace !== 'undefined') ? correctInPlace : null;
  const setupObserver = (typeof setupMutationObserver !== 'undefined') ? setupMutationObserver : null;
  const scan = (typeof scanPage !== 'undefined') ? scanPage : null;
  const send = (type, payload) => Msg ? Msg.sendRequest(type, payload || {}) : Promise.resolve();
  const rawSend = (message) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(message, resolve); } catch (_) { resolve(null); }
  });
  const dispatchAs = (type, payload, sender) => {
    if (!chrome?.runtime?.__dispatchWithSender) return Promise.resolve();
    return chrome.runtime.__dispatchWithSender({ type, requestId: (Msg && Msg.randomId ? Msg.randomId() : 'cov'), payload: payload || {} }, sender || { id: 'mock' });
  };

  await step(async () => { if (Sidebar && !Sidebar.isMounted()) await Sidebar.mount(); });
  await step(() => { const b = document.querySelector('.quran-ext-panel-collapse'); if (b) b.click(); });
  await step(() => { const t = document.querySelector('.quran-ext-panel-tab'); if (t) t.click(); });

  const findings = (window.__quranMatches || []).slice();
  const orange = findings.find(f => f.color === 'orange');
  const fallbackOrange = findings.find(f => f.color === 'orange' && f.id !== (orange && orange.id)) || orange;
  const any = findings[0];
  const heavyExtended = extended && findings.length < 100;

  if (any && Actions) {
    await step(() => Actions.copyRecord(any, {}));
    await step(() => Actions.copyShareArtifact(any, {}));
    await step(() => Actions.copyReport(any, {}));
    await step(() => Actions.copyRecordJson(any, {}));
    await step(() => Actions.jumpInContent(any.id));
    await step(() => Actions.buildShareArtifact(any, { pageUrl: location.href }));
  }

  // Correction fallback: remove the marker briefly so correctInPlace has to take
  // its no-marker path, then reattach the clone for later UI probes.
  if (fallbackOrange && correct) {
    await step(async () => {
      const marker = document.querySelector(`[data-quran-ref-for="${CSS.escape(fallbackOrange.id)}"]`);
      const clone = marker ? marker.cloneNode(true) : null;
      if (marker) marker.remove();
      await correct(fallbackOrange.id, { silent: true });
      if (clone) document.body.appendChild(clone);
    });
  }

  if (orange && correct) {
    await step(() => correct(orange.id));
    await sleep(60);
  }

  if (any && Model) {
    await step(() => Model.markDismissedThisSession(any.id));
    await step(() => Actions && Actions.dismiss(any, {}));
    await step(() => Model.unmarkDismissed(any.id));
    await step(() => Actions && Actions.restore(any, {}));
  }

  await step(async () => {
    const row = document.querySelector('.quran-ext-panel-row');
    if (!row) return;
    row.focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'c', 's', 'r', 'j', 'd', ' ', 'Escape', 'Escape']) {
      row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await sleep(2);
    }
  });

  await step(async () => {
    const panel = document.querySelector('.quran-ext-panel');
    if (!panel) return;
    panel.dispatchEvent(new Event('scroll', { bubbles: true }));

    const resize = panel.querySelector('.quran-ext-panel-resize');
    if (resize) {
      resize.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: Math.max(0, window.innerWidth - 420) }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.max(0, window.innerWidth - 360) }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Q', altKey: true, shiftKey: true, bubbles: true }));
    await sleep(5);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Q', altKey: true, shiftKey: true, bubbles: true }));
  });

  await step(() => { document.querySelectorAll('.quran-ext-filter-chip input').forEach(cb => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }); });
  await step(() => { const m = document.querySelector('.quran-ext-swap-master'); if (m) { m.checked = false; m.dispatchEvent(new Event('change', { bubbles: true })); } });
  await step(() => { const m = document.querySelector('.quran-ext-swap-master'); if (m) { m.checked = true; m.dispatchEvent(new Event('change', { bubbles: true })); } });
  await step(() => { document.querySelectorAll('[data-swap-color]').forEach(cb => { if (cb.dataset.swapColor !== 'red') { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); } }); });
  await step(() => { const f = document.querySelector('.quran-ext-font-select'); if (f) { f.value = 'indoPak'; f.dispatchEvent(new Event('change', { bubbles: true })); } });
  await step(() => { const c = document.querySelector('.quran-ext-clear-persisted'); if (c) c.click(); });

  await step(() => send('PREFS_READ'));
  await step(() => send('PREFS_WRITE', { patch: { scanTrigger: 'autoscan' } }));
  await step(() => send('PREFS_WRITE', { patch: { refLinks: false } }));
  await step(() => send('PREFS_WRITE', { patch: { refLinks: true } }));
  await step(() => send('PERSIST_WRITE', { urlKey: location.href, compositeKey: 'cov-key', kind: 'dismissal', at: new Date().toISOString() }));
  await step(() => send('PERSIST_READ', { urlKey: location.href }));
  await step(() => send('PERSIST_REMOVE', { urlKey: location.href, compositeKey: 'cov-key', kind: 'dismissal' }));
  await step(() => send('CLEAR_PERSISTED'));

  // Tooltip open/close, long-press, scroll dismissal, and ref-marker click.
  await step(async () => {
    const marker = document.querySelector('.quran-ref-marker');
    const highlight = document.querySelector('[data-finding-id]');
    for (const el of [marker, highlight]) {
      if (!el) continue;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await sleep(5);
      el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
    window.dispatchEvent(new Event('scroll'));
    // Long-press (touch hold) carries a ~520ms wait; it only adds coverage on the
    // few extended fixtures, so keep it off the per-fixture base path.
    if (extended && highlight) {
      highlight.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
      await sleep(520);
      highlight.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
      highlight.classList.add('quran-pressed');
      if (!highlight.hasAttribute('tabindex')) highlight.setAttribute('tabindex', '0');
      highlight.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    if (marker) {
      const open = window.open;
      window.open = () => null;
      try { marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
      finally { window.open = open; }
    }
  });

  await step(() => { const h = document.querySelector('.quran-green,[data-finding-id]'); if (h) h.click(); });
  await sleep(20);

  await step(async () => {
    const buttons = Array.from(document.querySelectorAll('.quran-ext-panel-action-btn'));
    for (const b of buttons.slice(0, 6)) { b.click(); await sleep(5); }
    const row = document.querySelector('.quran-ext-panel-row');
    if (row) { row.click(); await sleep(5); }
  });

  await step(() => send('getState'));
  await step(() => send('stats'));
  await step(() => send('getFindings'));

  if (extended) {
    if (heavyExtended) {
      await step(() => { if (typeof QuranLog !== 'undefined') QuranLog.setLevel('debug'); });
      await step(() => { if (typeof window.__quranDebug === 'function') window.__quranDebug(true); });
      await step(() => document.dispatchEvent(new CustomEvent('__quranDebugSet', { detail: { on: true } })));
    }

    await step(() => send('DATA_UNAVAILABLE', { reason: 'coverage' }));
    await step(() => send('DATA_AVAILABLE'));

    await step(async () => {
      if (!Sidebar || !any) return;
      Sidebar.tagPersisted([
        { compositeKey: any.id, kind: 'correction', at: new Date().toISOString() },
        { compositeKey: 'coverage-prior-dismissed', kind: 'dismissal', at: new Date().toISOString() },
      ]);
      const panelRef = document.querySelector('.quran-ext-panel-ref');
      if (panelRef) {
        panelRef.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        await sleep(25);
        panelRef.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        panelRef.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        await sleep(25);
        panelRef.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        const open = window.open;
        window.open = () => null;
        try {
          panelRef.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          panelRef.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
          panelRef.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        } finally {
          window.open = open;
        }
      }
    });

    await step(() => dispatchAs('SCAN_START', {}, { id: 'content', tab: { id: 1 } }));
    await step(() => dispatchAs('SCAN_START', {}, { id: 'popup' }));
    await step(() => dispatchAs('SCAN_PROGRESS', { perCategoryCount: { green: 1 }, runningCount: 1 }, { id: 'content', tab: { id: 1 } }));
    await step(() => dispatchAs('SCAN_COMPLETE', { finalState: 'clean', perCategoryCount: { green: 1 }, totalCount: 1 }, { id: 'content', tab: { id: 1 } }));
    await step(() => dispatchAs('SCAN_CAP_HIT', { perCategoryCount: { green: 500 } }, { id: 'content', tab: { id: 1 } }));
    await step(() => dispatchAs('DATA_UNAVAILABLE', { reason: 'coverage' }, { id: 'content', tab: { id: 1 } }));
    await step(() => dispatchAs('DATA_AVAILABLE', {}, { id: 'content', tab: { id: 1 } }));
    await step(() => dispatchAs('CORRECT_IN_PLACE', {}, { id: 'popup' }));
    await step(() => dispatchAs('DISMISS_FINDING', {}, { id: 'popup' }));
    await step(() => dispatchAs('RESTORE_DISMISSED', {}, { id: 'popup' }));

    if (heavyExtended && any) {
      await step(() => rawSend({
        type: 'verifyFragmentBatch',
        debug: true,
        items: [
          { type: 'verifyFragment', text: any.text, candidateConfidence: any.confidence || 'medium', debug: true },
          { type: 'verifyFragmentByRef', text: any.text, ref: any.matchedRef || any.claimedRef, candidateConfidence: 'high', debug: true },
        ],
      }));
      await step(() => rawSend({ type: 'resolveReference', ref: any.matchedRef || any.claimedRef }));
      await step(() => rawSend({ type: 'getAyahText', surahNum: 1, ayahNum: 1 }));
      await step(() => rawSend({ type: 'alternateRefs', text: any.text }));
      await step(() => rawSend({ type: 'logFindings', findings: window.__quranMatches || [], url: location.href }));
    }

    // Hidden/progressive/continue scan paths: liftCap uses the single-pass
    // visible flow, which emits SCAN_PROGRESS rather than hidden fresh-scan UI.
    await step(() => scan && scan({ liftCap: true }));
    await sleep(60);

    if (heavyExtended) {
      await step(async () => {
        const done = new Promise(resolve => {
          document.addEventListener('__quranBridgeDone', resolve, { once: true });
          setTimeout(resolve, 3000);
        });
        document.dispatchEvent(new Event('__quranBridgeScan'));
        await done;
      });
    }

    // Mutation observer / incremental rescan path. Use inert text so content
    // cases still belong to fixtures, while the runtime observer branch runs.
    if (setupObserver) {
      await step(async () => {
        setupObserver();
        const host = document.createElement('section');
        host.setAttribute('data-coverage-driver', 'mutation');
        document.body.appendChild(host);
        const child = document.createElement('p');
        child.textContent = 'coverage driver mutation node';
        host.appendChild(child);
        await sleep(650);
        host.remove();
        await sleep(20);
        const second = document.createElement('section');
        second.setAttribute('data-coverage-driver', 'mutation-again');
        document.body.appendChild(second);
        second.appendChild(document.createTextNode('coverage driver mutation node again'));
        await sleep(650);
        second.remove();
        await sleep(20);
      });
    }

    if (heavyExtended) {
      await step(() => send('clear'));
      await sleep(30);
      await step(() => { if (typeof window.__quranDebug === 'function') window.__quranDebug(false); });
    }
  }

  await step(() => {
    if (!Sidebar || !Sidebar.isMounted()) return;
    Sidebar.unmount();
  });

  await step(() => {
    const B = Badge; if (!B) return;
    const pcc = { green: 3, lightBlue: 1, yellow: 1, orange: 1, red: 1 };
    B.onScanStart(1);
    B.onScanProgress(1, pcc, 6);
    B.onScanComplete(1, 'defects', pcc, 7);
    B.onScanComplete(1, 'clean', { green: 5 }, 5);
    B.onScanComplete(1, 'empty', {}, 0);
    B.onScanComplete(1, 'notArabic', {}, 0);
    B.onCapHit(1, pcc);
    B.onDataUnavailable(1, 'missing');
    B.onDataAvailable(1);
  });
};
