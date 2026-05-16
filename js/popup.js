'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function displayStats(stats) {
  document.getElementById('s-total').textContent     = stats.totalFindings     ?? 0;
  document.getElementById('s-orange').textContent    = stats.orangeMatches     ?? 0;
  document.getElementById('s-green').textContent     = stats.greenMatches      ?? 0;
  document.getElementById('s-lightblue').textContent = stats.lightBlueMatches  ?? 0;
  document.getElementById('s-yellow').textContent    = stats.yellowMatches     ?? 0;
  document.getElementById('s-red').textContent       = stats.redMatches        ?? 0;
  document.getElementById('stats').hidden = false;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function sendToContent(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function fetchStats(tabId) {
  try {
    const resp = await sendToContent(tabId, { type: 'stats' });
    if (resp?.stats) displayStats(resp.stats);
  } catch (_) {
    // content script may not be ready
  }
}

// ── Button handlers ──────────────────────────────────────────────────────────

async function onScanClick() {
  const btnScan = document.getElementById('btn-scan');
  btnScan.disabled = true;
  setStatus('جارٍ الفحص…');

  try {
    const tab = await getActiveTab();
    if (!tab) {
      setStatus('لم يتم العثور على صفحة نشطة');
      return;
    }

    sendToContent(tab.id, { type: 'scan' })
      .then(resp => {
        if (resp?.stats) displayStats(resp.stats);
        setStatus('اكتمل الفحص');
      })
      .catch(err => setStatus('خطأ: ' + err.message));

    setTimeout(() => fetchStats(tab.id), 1500);
    setTimeout(() => fetchStats(tab.id), 3000);
    setTimeout(() => fetchStats(tab.id), 5000);
    setStatus('الفحص جارٍ…');
  } catch (e) {
    setStatus('خطأ: ' + e.message);
  } finally {
    btnScan.disabled = false;
  }
}

async function onClearClick() {
  setStatus('جارٍ المسح…');
  try {
    const tab = await getActiveTab();
    if (!tab) {
      setStatus('لم يتم العثور على صفحة نشطة');
      return;
    }
    await sendToContent(tab.id, { type: 'clear' });
    document.getElementById('stats').hidden = true;
    setStatus('تم مسح التمييز');
  } catch (e) {
    setStatus('خطأ: ' + e.message);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-scan').addEventListener('click', onScanClick);
  document.getElementById('btn-clear').addEventListener('click', onClearClick);
});
