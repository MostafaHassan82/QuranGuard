'use strict';
// popup.js — loaded after js/shared/messaging.js so QuranMsg is available.

// ── State ─────────────────────────────────────────────────────────────────────
let activeScanId = null;

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
  try {
    await QuranMsg.sendRequest('PREFS_WRITE', { patch });
  } catch (_) {}
}

function applyPrefsToUI(prefs) {
  const trigger = prefs.scanTrigger || 'manual';
  const manual = document.getElementById('trigger-manual');
  const auto = document.getElementById('trigger-auto');
  if (trigger === 'autoscan') {
    auto.checked = true;
  } else {
    manual.checked = true;
  }
  // Gate scan button: always visible in manual; in autoscan, still allow manual trigger
  document.getElementById('btn-scan').hidden = false;
}

// ── Scan trigger (T021) ───────────────────────────────────────────────────────

async function onScanClick(liftCap = false) {
  const btnScan = document.getElementById('btn-scan');
  const btnContinue = document.getElementById('btn-continue');
  btnScan.disabled = true;
  btnContinue.disabled = true;
  document.getElementById('progress').hidden = false;
  document.getElementById('progress-count').textContent = '0';
  setStatus('جارٍ الفحص…');

  try {
    const tab = await getActiveTab();
    if (!tab) { setStatus('لم يتم العثور على صفحة نشطة'); return; }

    // Send via new envelope route: popup → background → content
    activeScanId = null;
    QuranMsg.sendRequest('SCAN_START', { tabId: tab.id, mode: liftCap ? 'rescanAll' : 'manual', liftCap })
      .then(resp => {
        if (resp?.payload?.ok === false) {
          // Background returned an error (e.g. content script not present on this page).
          setStatus('خطأ: ' + (resp.payload.error?.message || 'تعذّر بدء الفحص'));
          btnScan.disabled = false;
          document.getElementById('progress').hidden = true;
          return;
        }
        if (resp?.payload?.result?.scanId) activeScanId = resp.payload.result.scanId;
      })
      .catch(() => {
        // Fallback: send directly to content (legacy path, for older SW versions).
        sendToContent(tab.id, { type: 'scan' })
          .then(resp => {
            if (resp?.perCategoryCount) {
              displayStats(resp.perCategoryCount, resp.totalCount);
              setStatus('اكتمل الفحص');
            }
          })
          .catch(err => setStatus('خطأ: ' + err.message))
          .finally(() => {
            btnScan.disabled = false;
            document.getElementById('progress').hidden = true;
          });
      });
  } catch (e) {
    setStatus('خطأ: ' + e.message);
    btnScan.disabled = false;
    document.getElementById('progress').hidden = true;
  }
}

async function onClearClick() {
  setStatus('جارٍ المسح…');
  try {
    const tab = await getActiveTab();
    if (!tab) { setStatus('لم يتم العثور على صفحة نشطة'); return; }
    await sendToContent(tab.id, { type: 'clear' });
    document.getElementById('stats').hidden = true;
    document.getElementById('progress').hidden = true;
    document.getElementById('btn-continue').hidden = true;
    setStatus('تم مسح التمييز');
  } catch (e) {
    setStatus('خطأ: ' + e.message);
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
    setStatus(`توقّف عند ${payload.cap} نتيجة — الصفحة كبيرة`);
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
      setStatus('الصفحة ليست بالعربية — لم يُعثر على آيات قرآنية');
      document.getElementById('stats').hidden = true;
      return;
    }
    if (payload.finalState === 'empty') {
      setStatus('لم يُعثر على آيات قرآنية في هذه الصفحة');
      document.getElementById('stats').hidden = true;
      return;
    }

    setStatus('اكتمل الفحص');
    displayStats(payload.perCategoryCount, payload.totalCount);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function hydrateFromActiveTab() {
  // Pull the current scan state from the content script. Covers two cases the
  // live SCAN_COMPLETE listener can't: (a) autoscan finished before the popup
  // opened, (b) user closed the popup after a manual scan and reopened it.
  try {
    const tab = await getActiveTab();
    if (!tab) return;
    const state = await sendToContent(tab.id, { type: 'getState' });
    if (!state) return;
    activeScanId = state.scanId || null;
    if (state.scanning) {
      setStatus('جارٍ الفحص…');
      document.getElementById('progress').hidden = false;
      document.getElementById('progress-count').textContent = state.totalCount ?? 0;
      return;
    }
    if (state.scanComplete) {
      if (state.languageDetected && state.languageDetected !== 'ar') {
        setStatus('الصفحة ليست بالعربية — لم يُعثر على آيات قرآنية');
        return;
      }
      if (state.totalCount === 0) {
        setStatus('لم يُعثر على آيات قرآنية في هذه الصفحة');
        return;
      }
      setStatus('اكتمل الفحص');
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
  applyPrefsToUI(prefs);

  document.getElementById('btn-scan').addEventListener('click', () => onScanClick(false));
  document.getElementById('btn-continue').addEventListener('click', () => onScanClick(true));
  document.getElementById('btn-clear').addEventListener('click', onClearClick);

  // Persist scanTrigger changes (T020)
  document.querySelectorAll('input[name="scanTrigger"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) savePrefs({ scanTrigger: radio.value });
    });
  });

  // Show stats from a prior scan (autoscan or earlier manual run).
  hydrateFromActiveTab();
});
