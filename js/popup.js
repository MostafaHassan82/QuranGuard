'use strict';
// popup.js — loaded after js/shared/messaging.js so QuranMsg is available.
// The popup is scan-only: scan trigger, scan/clear buttons, live status + stats,
// and the sidebar's initial state. The findings panel, filters, swap controls,
// and saved-corrections settings all live in the page-injected sidebar surface.

// ── State ─────────────────────────────────────────────────────────────────────
let activeScanId = null;

// Shared with sidebar-surface.js — the sidebar's persisted width/collapsed state.
const SIDEBAR_UI_KEY = 'quran.sidebar.ui';

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg) { document.getElementById('status').textContent = msg; }

function displayStats(perCategoryCount, totalCount) {
  const total = totalCount ?? Object.values(perCategoryCount || {}).reduce((a, b) => a + b, 0);
  document.getElementById('s-total').textContent     = total;
  document.getElementById('s-orange').textContent    = perCategoryCount?.orange     ?? 0;
  document.getElementById('s-green').textContent     = perCategoryCount?.green      ?? 0;
  document.getElementById('s-lightblue').textContent = perCategoryCount?.lightBlue  ?? 0;
  document.getElementById('s-yellow').textContent    = perCategoryCount?.yellow     ?? 0;
  document.getElementById('s-red').textContent       = perCategoryCount?.red        ?? 0;
  document.getElementById('stats').hidden = false;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function sendToContent(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// ── Prefs (T021) ──────────────────────────────────────────────────────────────

async function loadPrefs() {
  try {
    const resp = await QuranMsg.sendRequest('PREFS_READ', {});
    return resp?.payload?.result || {};
  } catch (_) { return {}; }
}

async function savePrefs(patch) {
  try { await QuranMsg.sendRequest('PREFS_WRITE', { patch }); } catch (_) {}
}

// The sidebar's collapsed state lives in chrome.storage.local (set by the
// sidebar when the user drags/collapses); the popup just seeds the initial value.
async function loadSidebarCollapsed() {
  try {
    const r = await chrome.storage.local.get(SIDEBAR_UI_KEY);
    return !!(r?.[SIDEBAR_UI_KEY]?.collapsed);
  } catch (_) { return false; }
}

async function saveSidebarCollapsed(collapsed) {
  try {
    const r = await chrome.storage.local.get(SIDEBAR_UI_KEY);
    const ui = r?.[SIDEBAR_UI_KEY] || {};
    ui.collapsed = collapsed;
    await chrome.storage.local.set({ [SIDEBAR_UI_KEY]: ui });
  } catch (_) {}
}

// Apply a UI language: switch the catalog, flip dir/lang on <html>, refill all
// [data-i18n] nodes. Dynamic strings (status) read QuranI18n.t() at call time.
function applyLang(lang) {
  QuranI18n.setLang(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = QuranI18n.dir(lang);
  QuranI18n.applyDom(document);
}

async function applyPrefsToUI(prefs) {
  applyLang(QuranI18n.detect(prefs.lang));
  const elLang = document.getElementById(QuranI18n.getLang() === 'en' ? 'lang-en' : 'lang-ar');
  if (elLang) elLang.checked = true;

  const trigger = prefs.scanTrigger || 'manual';
  (trigger === 'autoscan'
    ? document.getElementById('trigger-auto')
    : document.getElementById('trigger-manual')).checked = true;
  document.getElementById('btn-scan').hidden = false;

  const collapsed = await loadSidebarCollapsed();
  const elState = document.getElementById(collapsed ? 'state-collapsed' : 'state-expanded');
  if (elState) elState.checked = true;
}

// ── Scan trigger (T021) ───────────────────────────────────────────────────────

async function onScanClick(liftCap = false) {
  const btnScan = document.getElementById('btn-scan');
  const btnContinue = document.getElementById('btn-continue');
  btnScan.disabled = true;
  btnContinue.disabled = true;
  document.getElementById('progress').hidden = false;
  document.getElementById('progress-count').textContent = '0';
  setStatus(QuranI18n.t('status_scanning'));

  try {
    const tab = await getActiveTab();
    if (!tab) { setStatus(QuranI18n.t('status_no_tab')); return; }

    activeScanId = null;
    QuranMsg.sendRequest('SCAN_START', { tabId: tab.id, mode: liftCap ? 'rescanAll' : 'manual', liftCap })
      .then(resp => {
        if (resp?.payload?.ok === false) {
          setStatus(QuranI18n.t('status_error', { msg: resp.payload.error?.message || QuranI18n.t('status_start_error') }));
          btnScan.disabled = false;
          document.getElementById('progress').hidden = true;
          return;
        }
        if (resp?.payload?.result?.scanId) activeScanId = resp.payload.result.scanId;
      })
      .catch(() => {
        // Fallback: legacy direct-to-content path for older SW versions.
        sendToContent(tab.id, { type: 'scan' })
          .then(resp => {
            if (resp?.perCategoryCount) {
              displayStats(resp.perCategoryCount, resp.totalCount);
              setStatus(QuranI18n.t('status_done'));
            }
          })
          .catch(err => setStatus(QuranI18n.t('status_error', { msg: err.message })))
          .finally(() => {
            btnScan.disabled = false;
            document.getElementById('progress').hidden = true;
          });
      });
  } catch (e) {
    setStatus(QuranI18n.t('status_error', { msg: e.message }));
    btnScan.disabled = false;
    document.getElementById('progress').hidden = true;
  }
}

async function onClearClick() {
  setStatus(QuranI18n.t('status_clearing'));
  try {
    const tab = await getActiveTab();
    if (!tab) { setStatus(QuranI18n.t('status_no_tab')); return; }
    await sendToContent(tab.id, { type: 'clear' });
    document.getElementById('stats').hidden = true;
    document.getElementById('progress').hidden = true;
    document.getElementById('btn-continue').hidden = true;
    setStatus(QuranI18n.t('status_cleared'));
  } catch (e) {
    setStatus(QuranI18n.t('status_error', { msg: e.message }));
  }
}

// ── Progressive reveal via runtime messages (T029) ────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  const { type, payload = {} } = msg;

  if (type === 'SCAN_PROGRESS') {
    if (activeScanId && payload.scanId !== activeScanId) return;
    document.getElementById('progress-count').textContent = payload.runningCount ?? 0;
  }

  if (type === 'SCAN_CAP_HIT') {
    if (activeScanId && payload.scanId !== activeScanId) return;
    setStatus(QuranI18n.t('status_cap', { n: payload.cap }));
    document.getElementById('progress').hidden = true;
    document.getElementById('btn-continue').hidden = false;
    document.getElementById('btn-continue').disabled = false;
    displayStats(payload.perCategoryCount, payload.cap);
  }

  if (type === 'SCAN_COMPLETE') {
    if (activeScanId && payload.scanId !== activeScanId) return;
    document.getElementById('btn-scan').disabled = false;
    document.getElementById('btn-continue').disabled = false;
    document.getElementById('progress').hidden = true;

    if (payload.finalState === 'notArabic') {
      setStatus(QuranI18n.t('status_not_arabic'));
      document.getElementById('stats').hidden = true;
      return;
    }
    if (payload.finalState === 'empty') {
      setStatus(QuranI18n.t('status_empty'));
      document.getElementById('stats').hidden = true;
      return;
    }

    setStatus(QuranI18n.t('status_done'));
    displayStats(payload.perCategoryCount, payload.totalCount);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function hydrateFromActiveTab() {
  // Pull current scan state from the content script for cases the live
  // SCAN_COMPLETE listener can't cover (autoscan finished before the popup
  // opened, or the popup was reopened after a manual scan).
  try {
    const tab = await getActiveTab();
    if (!tab) return;
    const state = await sendToContent(tab.id, { type: 'getState' });
    if (!state) return;
    activeScanId = state.scanId || null;
    if (state.scanning) {
      setStatus(QuranI18n.t('status_scanning'));
      document.getElementById('progress').hidden = false;
      document.getElementById('progress-count').textContent = state.totalCount ?? 0;
      return;
    }
    if (state.scanComplete) {
      if (state.languageDetected && state.languageDetected !== 'ar') {
        setStatus(QuranI18n.t('status_not_arabic'));
        return;
      }
      if (state.totalCount === 0) {
        setStatus(QuranI18n.t('status_empty'));
        return;
      }
      setStatus(QuranI18n.t('status_done'));
      displayStats(state.perCategoryCount, state.totalCount);
      if (state.capHit) {
        document.getElementById('btn-continue').hidden = false;
        document.getElementById('btn-continue').disabled = false;
      }
    }
  } catch (_) {
    // Content script not present (e.g. chrome:// page) — leave UI in default state.
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const prefs = await loadPrefs();
  await applyPrefsToUI(prefs);

  document.getElementById('btn-scan').addEventListener('click', () => onScanClick(false));
  document.getElementById('btn-continue').addEventListener('click', () => onScanClick(true));
  document.getElementById('btn-clear').addEventListener('click', onClearClick);

  // Persist scanTrigger changes (T020)
  document.querySelectorAll('input[name="scanTrigger"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) savePrefs({ scanTrigger: radio.value });
    });
  });

  // Initial sidebar state (collapsed / expanded).
  document.querySelectorAll('input[name="panelInitialState"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) saveSidebarCollapsed(radio.value === 'collapsed');
    });
  });

  // UI language (ar/en). Persist via prefs.lang → PREFS_CHANGED re-localizes the
  // open sidebar; the popup re-localizes itself immediately.
  document.querySelectorAll('input[name="uiLang"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      applyLang(radio.value);
      savePrefs({ lang: radio.value });
    });
  });

  hydrateFromActiveTab();
});
