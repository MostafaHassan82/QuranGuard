'use strict';
// popup.js — loaded after js/shared/messaging.js so QuranMsg is available.

// ── State ─────────────────────────────────────────────────────────────────────
let activeScanId = null;
let activePrefs = null; // cached so the panel can re-render on SCAN_PROGRESS without an extra RTT

function urlKeyForTab(tab) {
  // Mirror QuranPersisted.urlKey() semantics (origin + path, no query/hash)
  // so PERSIST_READ returns this URL's records. Defined inline because storage
  // modules aren't loaded in the popup; keeping the duplication tiny is fine.
  try {
    const u = new URL(tab.url);
    return u.origin + u.pathname;
  } catch (_) { return tab?.url || ''; }
}

function renderPanel() {
  QuranPanelSurface.render({ filter: activePrefs?.panelFilter });
}

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

  // T047 — sync filter chips and surface picker with prefs
  const filter = prefs.panelFilter || {};
  document.querySelectorAll('#filter-chips input[type=checkbox]').forEach(cb => {
    cb.checked = filter[cb.dataset.color] === true;
  });
  const surface = prefs.panelSurface || 'popup';
  const sPop = document.getElementById('surface-popup');
  const sSide = document.getElementById('surface-sidebar');
  if (sPop && sSide) (surface === 'sidebar' ? sSide : sPop).checked = true;

  // T061 — sync authentic-text swap controls (FR-009)
  const master = document.getElementById('swap-master');
  if (master) master.checked = prefs?.master?.authenticTextReplacement !== false;
  const perColor = prefs?.perColor || {};
  document.querySelectorAll('[data-swap-color]').forEach(cb => {
    const c = cb.dataset.swapColor;
    if (c === 'red') { cb.checked = false; cb.disabled = true; return; } // FR-015
    cb.checked = perColor[c] !== false;
  });
  const fontSel = document.getElementById('font-select');
  if (fontSel) fontSel.value = prefs?.font || 'uthmaniHafs';
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
  // Fresh full scans clear the panel model so prior-scan findings don't bleed
  // into the new view. `liftCap` continuations keep what we already have.
  if (!liftCap) {
    QuranPanelModel.reset();
    renderPanel();
  }

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
    // T045 — feed the panel model live as findings arrive
    if (payload.finding) {
      QuranPanelModel.upsert(payload.finding);
      renderPanel();
    }
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

    // T045 — tag panel findings with persistedBadge for this URL (FR-024).
    getActiveTab().then(tab => {
      if (!tab) return;
      return QuranMsg.sendRequest('PERSIST_READ', { urlKey: urlKeyForTab(tab) });
    }).then(resp => {
      const entries = resp?.payload?.result?.entries;
      if (entries) {
        QuranPanelModel.tagPersisted(entries);
        renderPanel();
      }
    }).catch(() => {});
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
      // Pull the existing Findings into the panel model. SCAN_PROGRESS events
      // for this scan already fired before the popup opened, so the model is
      // otherwise empty.
      try {
        const fr = await sendToContent(tab.id, { type: 'getFindings' });
        if (fr?.findings) {
          QuranPanelModel.reset();
          for (const f of fr.findings) QuranPanelModel.upsert(f);
          const persist = await QuranMsg.sendRequest('PERSIST_READ', { urlKey: urlKeyForTab(tab) }).catch(() => null);
          const entries = persist?.payload?.result?.entries;
          if (entries) QuranPanelModel.tagPersisted(entries);
          renderPanel();
        }
      } catch (_) {}
    }
  } catch (_) {
    // Content script not present (e.g. chrome:// page) — leave UI in default state.
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const prefs = await loadPrefs();
  activePrefs = prefs;
  applyPrefsToUI(prefs);
  // Pass active tab info to the surface so per-row jump + record builders work.
  try {
    const tab = await getActiveTab();
    if (tab) QuranPanelSurface.setContext({ tabId: tab.id, pageUrl: tab.url || '' });
  } catch (_) {}
  renderPanel();
  QuranPanelSurface.attachKeyboard();

  document.getElementById('btn-scan').addEventListener('click', () => onScanClick(false));
  document.getElementById('btn-continue').addEventListener('click', () => onScanClick(true));
  document.getElementById('btn-clear').addEventListener('click', onClearClick);

  // Persist scanTrigger changes (T020)
  document.querySelectorAll('input[name="scanTrigger"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) savePrefs({ scanTrigger: radio.value });
    });
  });

  // T047 — filter chip toggles
  document.querySelectorAll('#filter-chips input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', async () => {
      activePrefs = activePrefs || {};
      activePrefs.panelFilter = { ...(activePrefs.panelFilter || {}), [cb.dataset.color]: cb.checked };
      renderPanel();
      await savePrefs({ panelFilter: activePrefs.panelFilter });
    });
  });

  // T047 — surface picker
  document.querySelectorAll('input[name="panelSurface"]').forEach(radio => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      activePrefs = activePrefs || {};
      activePrefs.panelSurface = radio.value;
      await savePrefs({ panelSurface: radio.value });
    });
  });

  // T061 — authentic-text swap controls (FR-009)
  const master = document.getElementById('swap-master');
  if (master) {
    master.addEventListener('change', async () => {
      activePrefs = activePrefs || {};
      activePrefs.master = { ...(activePrefs.master || {}), authenticTextReplacement: master.checked };
      await savePrefs({ master: { authenticTextReplacement: master.checked } });
    });
  }
  document.querySelectorAll('[data-swap-color]').forEach(cb => {
    if (cb.dataset.swapColor === 'red') return; // FR-015 — red is locked off
    cb.addEventListener('change', async () => {
      const patch = { perColor: { [cb.dataset.swapColor]: cb.checked } };
      activePrefs = activePrefs || {};
      activePrefs.perColor = { ...(activePrefs.perColor || {}), [cb.dataset.swapColor]: cb.checked };
      await savePrefs(patch);
    });
  });
  const fontSel = document.getElementById('font-select');
  if (fontSel) {
    fontSel.addEventListener('change', async () => {
      activePrefs = activePrefs || {};
      activePrefs.font = fontSel.value;
      await savePrefs({ font: fontSel.value });
    });
  }

  // Show stats from a prior scan (autoscan or earlier manual run).
  hydrateFromActiveTab();
});
