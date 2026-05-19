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

  // FR-011 plain-text: one field per line, Arabic label / English label: value.
  function toPlainText(record) {
    const lines = [
      `الاقتباس / Citation: ${record.citation}`,
      `المرجع المذكور / Cited Reference: ${record.citedReference || '—'}`,
      `المرجع الصحيح / True Reference: ${record.trueReference || '—'}`,
      `الفئة / Category: ${record.categoryAr || record.category}${record.categoryEn ? ` (${record.categoryEn})` : ''}`,
      `رابط الصفحة / Page URL: ${record.pageUrl}`,
      `الوقت / Timestamp: ${record.timestamp}`,
    ];
    return lines.join('\n');
  }

  function toJson(record) { return JSON.stringify(record, null, 2); }

  // FR-011c — page URL + #:~:text=<encoded snippet> (Chrome text fragment),
  // then a blank line, then the plain-text record body. On non-supporting
  // browsers the recipient still gets a usable URL (the fragment is ignored).
  function buildShareArtifact(finding, opts = {}) {
    const record = buildRecord(finding, opts);
    const snippet = (record.citation || '').trim();
    let url = record.pageUrl;
    if (snippet && url) {
      // Trim to a reasonable length so the URL stays under common limits.
      const truncated = snippet.length > 300 ? snippet.slice(0, 300) : snippet;
      try {
        const u = new URL(url);
        u.hash = `:~:text=${encodeURIComponent(truncated)}`;
        url = u.toString();
      } catch (_) { /* leave url as-is on parse failure */ }
    }
    return `${url}\n\n${toPlainText(record)}`;
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

  // Convenience: build + copy in one call. Returns the text written.
  async function copyRecord(finding, opts)     { const t = toPlainText(buildRecord(finding, opts)); await copy(t); return t; }
  async function copyRecordJson(finding, opts) { const t = toJson(buildRecord(finding, opts));       await copy(t); return t; }
  async function copyShareArtifact(finding, opts) { const t = buildShareArtifact(finding, opts);     await copy(t); return t; }
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

  return {
    buildRecord, toPlainText, toJson, buildShareArtifact,
    copy, copyRecord, copyRecordJson, copyShareArtifact, copyReport,
    jumpInContent, jumpFromPopup,
  };
})();
