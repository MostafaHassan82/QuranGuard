'use strict';

// Optional fault-injection coverage driver. Runs inside the Playwright page only
// when run_tests_node.js is invoked with --coverage-faults.
module.exports = async function coverageFaultDriver() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const step = async (fn) => { try { await fn(); } catch (_) {} };
  const rawSend = (message, timeoutMs = 1500) => new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    setTimeout(() => finish(null), timeoutMs);
    try { chrome.runtime.sendMessage(message, finish); } catch (_) { finish(null); }
  });

  // Clipboard/manual-paste fallback: remove the editable ref marker and run a
  // non-silent correction so the fallback copy path is exercised.
  await step(async () => {
    if (typeof correctInPlace !== 'function') return;
    const orange = (window.__quranMatches || []).find(f => f.color === 'orange');
    if (!orange) return;
    const marker = document.querySelector(`[data-quran-ref-for="${CSS.escape(orange.id)}"]`);
    const clone = marker ? marker.cloneNode(true) : null;
    if (marker) marker.remove();
    const oldClipboard = navigator.clipboard;
    const oldCopy = (typeof QuranActions !== 'undefined') ? QuranActions.copy : null;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => {} },
      });
      if (typeof QuranActions !== 'undefined') QuranActions.copy = async () => true;
      await correctInPlace(orange.id, { persist: false, silent: false });
    } finally {
      if (typeof QuranActions !== 'undefined' && oldCopy) QuranActions.copy = oldCopy;
      try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: oldClipboard }); } catch (_) {}
      if (clone) document.body.appendChild(clone);
    }
  });

  // Direct content-script failure edges that do not need fixture text.
  await step(async () => {
    if (typeof correctInPlace === 'function') await correctInPlace('coverage-missing-id', { persist: false, silent: true });
    if (typeof isOrangeAutoCorrectable === 'function') {
      isOrangeAutoCorrectable(null);
      isOrangeAutoCorrectable({ matchedRefs: ['a', 'b'] });
      isOrangeAutoCorrectable({ matchedRefs: ['a'] });
    }
    if (typeof getMutatedSubtreeText === 'function') getMutatedSubtreeText(document.createElement('div'));
  });

  // Background load failures: RETRY_DATA_LOAD re-enters loadAndIndex, whose fetch
  // is resolved at call time, so a temporary fetch mock covers unreadable and
  // schema-failure paths. Restore the real fetch and retry once so later probes
  // are not left with dataState='unavailable'.
  await step(async () => {
    const realFetch = window.fetch;
    const retry = () => rawSend({ type: 'RETRY_DATA_LOAD', requestId: 'cov-fault-retry', payload: {} }, 2500);
    try {
      window.fetch = async (url, opts) => {
        if (String(url).includes('quran-uthmani_min-v2.json')) {
          return { ok: false, status: 503, text: async () => '' };
        }
        return realFetch(url, opts);
      };
      await retry();

      window.fetch = async (url, opts) => {
        if (String(url).includes('quran-uthmani_min-v2.json')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ suras: [], meta: {} }) };
        }
        return realFetch(url, opts);
      };
      await retry();
    } finally {
      window.fetch = realFetch;
    }
    await retry();
  });

  // Storage/prefs failure and pruning edges, isolated after the restore retry.
  await step(async () => {
    if (typeof QuranPrefs !== 'undefined') {
      await QuranPrefs.write({
        perColor: { red: true },
        font: 'invalid-font',
        scanTrigger: 'bad-trigger',
        lang: 'bad-lang',
        panelFilter: {},
      });
      await QuranPrefs.read();
    }
    if (typeof QuranPersisted !== 'undefined') {
      const key = QuranPersisted.urlKey(location.href + '#frag?z=2&a=1');
      await QuranPersisted.write({ urlKey: key, compositeKey: 'old', kind: 'dismissal', at: '2000-01-01T00:00:00.000Z' });
      await QuranPersisted.write({ urlKey: key, compositeKey: 'live', kind: 'correction', at: new Date().toISOString() });
      await QuranPersisted.read(key);
      await QuranPersisted.remove({ urlKey: key, compositeKey: 'live', kind: 'correction' });
      await QuranPersisted.clearAll();
    }
  });

  // Legacy/unknown message fallthrough after data has been restored.
  await step(() => rawSend({ type: 'unknownCoverageMessage' }));
  await sleep(20);
};
