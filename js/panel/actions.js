'use strict';
// T051 — Per-finding actions. Pure builders + clipboard + jump-to-highlight.
// Loadable in both popup (extension page) and content (host page) worlds.
// FR-011: copy/share/report use a plain-text record with every field labeled in
// Arabic + English (one field per line); "Copy as JSON" emits the same fields
// as a single canonical JSON object.
const QuranActions = (() => {
  // FR-005 / FR-007 — category name in words. Mirrors the labels used in the
  // tooltip and the panel surfaces so a copied record reads the same way.
  const CATEGORY_LABEL_AR = {
    green:     'مطابق للقرآن مع المرجع',
    lightBlue: 'مطابق للقرآن — لم يُذكر المرجع',
    yellow:    'اختلاف لفظي',
    orange:    'مرجع غير مطابق',
    red:       'لم يُعثر عليه في القرآن',
  };
  const CATEGORY_LABEL_EN = {
    green:     'Verified with reference',
    lightBlue: 'Verified — no reference cited',
    yellow:    'Word-level mismatch',
    orange:    'Reference mismatch',
    red:       'Not found in the Quran',
  };

  // The exact field set per FR-011. Stable shape across plain-text and JSON.
  function buildRecord(finding, { pageUrl } = {}) {
    return {
      citation:        finding.text || finding.rawText || '',
      citedReference:  finding.claimedRef || finding.citedReference || '',
      trueReference:   finding.matchedRef || '',
      pageUrl:         pageUrl || (typeof location !== 'undefined' ? location.href : ''),
      category:        finding.color || finding.category || '',
      categoryAr:      CATEGORY_LABEL_AR[finding.color || finding.category] || '',
      categoryEn:      CATEGORY_LABEL_EN[finding.color || finding.category] || '',
      timestamp:       new Date().toISOString(),
    };
  }

  const T = (k, v) => (typeof QuranI18n !== 'undefined') ? QuranI18n.t(k, v) : k;

  // T091 — reader-facing share/copy text (localized prose, not a field dump).
  // The machine-readable record stays behind "Copy as JSON" (toJson below).
  function friendlyText(finding, { pageUrl } = {}) {
    const color = finding.color || finding.category || '';
    const snippet = (finding.text || finding.rawText || '').trim();
    const cited = finding.claimedRef || finding.citedReference || '—';
    const matched = finding.matchedRef || finding.matchedReference || '—';
    const sentence = T('share_' + color, { snippet, cited, matched });
    const url = pageUrl || (typeof location !== 'undefined' ? location.href : '');
    return `${sentence}\n\n${T('share_page', { url })}\n${T('share_via')}`;
  }

  function toJson(record) { return JSON.stringify(record, null, 2); }

  function encodeFragment(s) {
    const t = (s || '').trim();
    return encodeURIComponent(t.length > 300 ? t.slice(0, 300) : t);
  }

  // T092 — build the share URL with Chrome text fragments. Highlight BOTH the
  // ayah AND the cited reference (multiple directives joined by `&`), so an
  // orange finding's wrong reference is highlighted alongside the verse — that
  // mismatch is usually the reason for sharing. Falls back to ayah-only (or the
  // bare URL) when a piece is missing or the URL can't be parsed.
  function buildShareUrl(finding, opts = {}) {
    const base = opts.pageUrl || (typeof location !== 'undefined' ? location.href : '');
    if (!base) return base;
    const directives = [];
    const ayah = (finding.text || finding.rawText || '').trim();
    if (ayah) directives.push('text=' + encodeFragment(ayah));
    const ref = (finding.refText || finding.claimedRef || finding.citedReference || '').trim();
    // Only add the ref directive when it isn't already part of the ayah snippet.
    if (ref && !ayah.includes(ref)) directives.push('text=' + encodeFragment(ref));
    if (!directives.length) return base;
    try {
      const u = new URL(base);
      u.hash = ':~:' + directives.join('&');
      return u.toString();
    } catch (_) { return base; }
  }

  // FR-011c — reader-facing share text whose embedded link carries the text
  // fragment, so the recipient lands on the highlighted ayah.
  function buildShareArtifact(finding, opts = {}) {
    return friendlyText(finding, { pageUrl: buildShareUrl(finding, opts) });
  }

  async function copy(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through to legacy path */ }
    // Legacy fallback for pages that block the async Clipboard API.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  // Convenience: build + copy in one call. Returns the text written. Copy and
  // Report use the friendly prose; only JSON emits the machine record (T091).
  async function copyRecord(finding, opts)     { const t = friendlyText(finding, opts);          await copy(t); return t; }
  async function copyRecordJson(finding, opts) { const t = toJson(buildRecord(finding, opts));    await copy(t); return t; }
  async function copyShareArtifact(finding, opts) { const t = buildShareArtifact(finding, opts);  await copy(t); return t; }
  // FR-011d — report uses the same plain-text body (Assumptions: no separate
  // wire format; the report destination is the user's clipboard).
  async function copyReport(finding, opts) { return copyRecord(finding, opts); }

  // FR-011a — jump-to-highlight. Caller in the CONTENT world (sidebar) can
  // call this directly. In the POPUP world, see jumpFromPopup(tabId, id) below.
  // Does NOT move focus to the highlight: keyboard users who press Enter on a
  // panel row need focus to stay on the row so they can keep navigating with
  // ↑/↓ without having to refocus the panel after every jump.
  function jumpInContent(findingId) {
    if (typeof document === 'undefined' || !findingId) return false;
    const el = document.querySelector(`[data-finding-id="${cssEscape(findingId)}"]`);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('quran-jump-flash');
    setTimeout(() => el.classList.remove('quran-jump-flash'), 1500);
    return true;
  }

  function cssEscape(s) {
    // CSS.escape isn't available in every context (old test browsers) — fall
    // back to a minimal escaper for the characters that appear in our ids.
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // FR-011a from the popup surface: ask the active tab's content script to do
  // the actual scroll. Content.js handles `JUMP_TO_FINDING` (added in T052).
  async function jumpFromPopup(tabId, findingId) {
    if (!tabId || !findingId) return false;
    return new Promise(resolve => {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'JUMP_TO_FINDING', findingId }, resp => {
          if (chrome.runtime.lastError) resolve(false);
          else resolve(resp?.ok === true);
        });
      } catch (_) { resolve(false); }
    });
  }

  // FR-012 correct-in-place from the CONTENT world (sidebar). content.js defines
  // a top-level correctInPlace() in the shared content-script scope.
  async function correctInContent(findingId) {
    if (!findingId || typeof correctInPlace !== 'function') return { ok: false };
    try { return await correctInPlace(findingId); } catch (_) { return { ok: false }; }
  }

  // FR-012 from the POPUP world: ask the active tab's content script to perform
  // the correction. Resolves with the response payload {ok, result}.
  async function correctFromPopup(tabId, findingId) {
    if (!tabId || !findingId) return { ok: false };
    return new Promise(resolve => {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'CORRECT_IN_PLACE', findingId }, resp => {
          if (chrome.runtime.lastError) resolve({ ok: false });
          else resolve(resp?.payload || resp || { ok: false });
        });
      } catch (_) { resolve({ ok: false }); }
    });
  }

  // Canonical URL key (mirrors QuranPersisted.urlKey): drop hash, sort query.
  // Both surfaces use this so dismiss/restore persistence matches what
  // content.js writes via pageUrlKey() and what the popup reads (FR-024/025).
  function urlKey(rawUrl) {
    try {
      const u = new URL(rawUrl);
      u.hash = '';
      const params = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b));
      u.search = new URLSearchParams(params).toString();
      return u.toString();
    } catch (_) { return rawUrl || ''; }
  }

  // FR-025 dismiss: persist a dismissal keyed by the finding's composite id.
  async function dismiss(finding, { pageUrl } = {}) {
    if (!finding?.id) return false;
    try {
      await QuranMsg.sendRequest('PERSIST_WRITE', { urlKey: urlKey(pageUrl || (typeof location !== 'undefined' ? location.href : '')), compositeKey: finding.id, kind: 'dismissal', at: new Date().toISOString() });
      return true;
    } catch (_) { return false; }
  }

  // FR-025 restore: remove the persisted dismissal for this finding.
  async function restore(finding, { pageUrl } = {}) {
    if (!finding?.id) return false;
    try {
      await QuranMsg.sendRequest('PERSIST_REMOVE', { urlKey: urlKey(pageUrl || (typeof location !== 'undefined' ? location.href : '')), compositeKey: finding.id, kind: 'dismissal' });
      return true;
    } catch (_) { return false; }
  }

  return {
    buildRecord, friendlyText, toJson, buildShareUrl, buildShareArtifact,
    copy, copyRecord, copyRecordJson, copyShareArtifact, copyReport,
    jumpInContent, jumpFromPopup, correctInContent, correctFromPopup,
    urlKey, dismiss, restore,
  };
})();
