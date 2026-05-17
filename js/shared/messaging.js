'use strict';
// Typed message envelope per contracts/messaging.md.
// Every onMessage handler MUST return true to keep the channel open (MV3 async discipline).
const QuranMsg = (() => {
  function sendRequest(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      try {
        chrome.runtime.sendMessage({ type, requestId, payload }, response => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      } catch (e) { reject(e); }
    });
  }

  // Only available in service-worker context where chrome.tabs exists.
  function sendTabRequest(tabId, type, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      try {
        chrome.tabs.sendMessage(tabId, { type, requestId, payload }, response => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      } catch (e) { reject(e); }
    });
  }

  // Fire-and-forget broadcast — content → background/popup (no response expected).
  function emit(type, payload = {}) {
    const requestId = crypto.randomUUID();
    try { chrome.runtime.sendMessage({ type, requestId, payload }); } catch (_) {}
  }

  function okResponse(requestId, result) {
    return { requestId, payload: { ok: true, result } };
  }

  function errResponse(requestId, code, message) {
    return { requestId, payload: { ok: false, error: { code, message } } };
  }

  return { sendRequest, sendTabRequest, emit, okResponse, errResponse };
})();
