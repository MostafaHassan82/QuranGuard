'use strict';
// Typed message envelope per contracts/messaging.md.
// Every onMessage handler MUST return true to keep the channel open (MV3 async discipline).
const QuranMsg = (() => {
  // crypto.randomUUID() requires a secure context. Content scripts on plain http:// pages
  // (including Playwright fixtures) don't have it, so fall back to getRandomValues.
  function randomId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      try { return crypto.randomUUID(); } catch (_) {}
    }
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  function sendRequest(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = randomId();
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
      const requestId = randomId();
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
    const requestId = randomId();
    try { chrome.runtime.sendMessage({ type, requestId, payload }); } catch (_) {}
  }

  function okResponse(requestId, result) {
    return { requestId, payload: { ok: true, result } };
  }

  function errResponse(requestId, code, message) {
    return { requestId, payload: { ok: false, error: { code, message } } };
  }

  return { sendRequest, sendTabRequest, emit, okResponse, errResponse, randomId };
})();
