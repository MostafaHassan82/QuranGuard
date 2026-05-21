'use strict';
// T087 — Tiny i18n layer (Arabic + English). Shared by the popup and the
// page-injected sidebar so a language switch takes effect in both without a
// reload. We roll our own catalog (rather than chrome.i18n/_locales) because
// the sidebar lives in the content world and needs a runtime language switch
// driven by prefs.lang + PREFS_CHANGED, not a per-load static lookup.
//
// API:
//   QuranI18n.setLang('en' | 'ar')   — set the active language (clamps to ar).
//   QuranI18n.getLang()              — current language code.
//   QuranI18n.t(key, vars?)          — translate; {name} placeholders ← vars.
//   QuranI18n.dir(lang?)             — 'rtl' for ar, 'ltr' for en.
//   QuranI18n.applyDom(root?)        — fill [data-i18n] (textContent),
//        [data-i18n-title] (title), [data-i18n-aria] (aria-label) under root.
//   QuranI18n.detect(prefLang?)      — resolve a starting language from a pref
//        or the browser UI language; falls back to 'ar'.
//
// Category *meanings* are fixed (constitution Principle II) — only the display
// strings localize.
const QuranI18n = (() => {
  const CATALOGS = {
    ar: {
      // categories
      cat_green: 'مطابق للقرآن مع المرجع',
      cat_lightBlue: 'مطابق للقرآن — لم يُذكر المرجع',
      cat_yellow: 'اختلاف لفظي',
      cat_orange: 'مرجع غير مطابق',
      cat_red: 'لم يُعثر عليه في القرآن',
      // popup
      popup_title: 'تدقيق آيات القرآن',
      scan_mode: 'وضع الفحص:',
      manual: 'يدوي',
      auto: 'تلقائي',
      scan_page: 'فحص الصفحة',
      continue_scan: 'متابعة الفحص',
      clear_highlights: 'مسح التمييز',
      stat_total: 'إجمالي النتائج',
      stat_orange: '⚠ مرجع خاطئ',
      stat_green: '✓ تطابق تام',
      stat_lightblue: '✓ تطابق بدون مرجع',
      stat_yellow: '~ اختلاف لفظي',
      stat_red: '✗ لم يُتحقَّق',
      panel_start: 'لوحة النتائج تبدأ:',
      expanded: 'مفتوحة',
      collapsed: 'مطوية',
      lang_label: 'اللغة:',
      // popup status
      status_scanning: 'جارٍ الفحص…',
      status_done: 'اكتمل الفحص',
      status_clearing: 'جارٍ المسح…',
      status_cleared: 'تم مسح التمييز',
      status_no_tab: 'لم يتم العثور على صفحة نشطة',
      status_not_arabic: 'الصفحة ليست بالعربية — لم يُعثر على آيات قرآنية',
      status_empty: 'لم يُعثر على آيات قرآنية في هذه الصفحة',
      status_cap: 'توقّف عند {n} نتيجة — الصفحة كبيرة',
      status_error: 'خطأ: {msg}',
      status_start_error: 'تعذّر بدء الفحص',
      progress_suffix: 'نتيجة حتى الآن…',
      // sidebar
      sidebar_title: 'نتائج التحقق',
      collapse: 'طيّ',
      collapse_aria: 'طيّ اللوحة',
      resize_aria: 'تغيير العرض',
      panel_region_aria: 'نتائج التحقق من الاقتباسات',
      hint: 'Alt+Shift+Q ← اللوحة',
      hint_title: 'اضغط Alt+Shift+Q من أي مكان في الصفحة للعودة إلى اللوحة',
      tab_text: 'النتائج ⟨',
      tab_open_aria: 'فتح اللوحة',
      chip_orange: '⚠ مرجع خاطئ',
      chip_green: '✓ تطابق تام',
      chip_lightBlue: '✓ بدون مرجع',
      chip_yellow: '~ اختلاف لفظي',
      chip_red: '✗ لم يُتحقَّق',
      swap_summary: 'عرض النص القرآني الأصلي',
      swap_master: 'تفعيل (رئيسي)',
      swap_green: 'تطابق تام',
      swap_lightBlue: 'تطابق بدون مرجع',
      swap_yellow: 'اختلاف لفظي',
      swap_orange: 'مرجع غير مطابق',
      swap_red: 'لم يُتحقَّق — دائمًا معطّل',
      swap_red_title: 'الأحمر دائمًا معطّل',
      font_label: 'الخط:',
      font_uthmani: 'عثماني — حفص',
      font_qpcHafs: 'QPC حفص (عثماني رسمي)',
      font_qpcV2: 'QPC إصدار 2',
      font_qpcV4Tajweed: 'QPC إصدار 4 — تجويد',
      font_digitalKhattIndopak: 'Digital Khatt — هندي/باكستاني',
      font_digitalKhattV1: 'Digital Khatt إصدار 1',
      font_digitalKhattV2: 'Digital Khatt إصدار 2',
      font_indopakNastaleeq: 'هندي/باكستاني — نستعليق',
      font_kfgqpcNastaleeq: 'KFGQPC نستعليق',
      persist_summary: 'التصحيحات والتجاهلات المحفوظة',
      clear_persisted: 'مسح التصحيحات والتجاهلات المحفوظة',
      persist_cleared: 'تم المسح — لا توجد عناصر محفوظة (أُزيلت {n}).',
      persist_clear_failed: 'تعذّر المسح. حاول مرة أخرى.',
      section_results: 'النتائج',
      section_recent: 'صُحِّحت مؤخرًا',
      section_dismissed: 'مرفوضة (هذه الجلسة)',
      section_prior_dismissed: 'مرفوضة سابقًا',
      empty_no_results: 'لا توجد نتائج بعد',
      empty_no_match_filter: 'لا توجد نتائج تطابق المرشّحات الحالية',
      act_correct: 'تصحيح',
      act_copy: 'نسخ',
      act_share: 'مشاركة',
      act_report: 'تقرير',
      act_json: 'JSON',
      act_dismiss: 'تجاهل',
      act_restore: 'استرجاع',
      badge_corrected: 'صُحِّح سابقًا',
      badge_dismissed: 'مرفوض سابقًا',
      // tooltips (content highlights)
      tip_match: '(تطابق)',
      tip_also_in: 'يُوجد أيضاً في: {refs}',
      tip_partial_in: '(جزئي في: {refs})',
      tip_no_ref: '(لم يُذكر المرجع في الصفحة)',
      tip_word_level: '(اختلاف لفظي)',
      tip_word_level_and_ref: 'مذكور كـ: {cited}\n(اختلاف لفظي + مرجع غير مطابق)',
      tip_orange: 'مذكور كـ: {cited}\nالصواب: {matched}',
      tip_red: 'لم يُعثر على هذا النص في القرآن',
      tip_red_with_ref: 'لم يُعثر على هذا النص في القرآن\nالمرجع المذكور: {ref}',
      // share (reader-facing prose)
      share_orange: 'تنسب هذه الصفحة «{snippet}» إلى {cited}، لكنها في الحقيقة من {matched} في القرآن الكريم.',
      share_green: '«{snippet}» — {matched} (مطابقة موثّقة للقرآن).',
      share_lightBlue: '«{snippet}» — وردت في {matched} (لم يُذكر المرجع في الصفحة).',
      share_yellow: '«{snippet}» — قريبة من {matched} مع اختلاف لفظي يستحق المراجعة.',
      share_red: '«{snippet}» — لم يُعثر على هذا النص في القرآن الكريم.',
      share_page: 'الصفحة: {url}',
      share_via: '— عبر مُدقّق آيات القرآن',
    },
    en: {
      cat_green: 'Verified with reference',
      cat_lightBlue: 'Verified — no reference cited',
      cat_yellow: 'Word-level mismatch',
      cat_orange: 'Reference mismatch',
      cat_red: 'Not found in the Quran',
      popup_title: 'Quran Citation Verifier',
      scan_mode: 'Scan mode:',
      manual: 'Manual',
      auto: 'Automatic',
      scan_page: 'Scan page',
      continue_scan: 'Continue scanning',
      clear_highlights: 'Clear highlights',
      stat_total: 'Total findings',
      stat_orange: '⚠ Wrong reference',
      stat_green: '✓ Exact match',
      stat_lightblue: '✓ Match (no reference)',
      stat_yellow: '~ Word-level mismatch',
      stat_red: '✗ Unverified',
      panel_start: 'Results panel starts:',
      expanded: 'Open',
      collapsed: 'Collapsed',
      lang_label: 'Language:',
      status_scanning: 'Scanning…',
      status_done: 'Scan complete',
      status_clearing: 'Clearing…',
      status_cleared: 'Highlights cleared',
      status_no_tab: 'No active page found',
      status_not_arabic: 'This page is not in Arabic — no Quran verses found',
      status_empty: 'No Quran verses found on this page',
      status_cap: 'Stopped at {n} findings — large page',
      status_error: 'Error: {msg}',
      status_start_error: 'Could not start the scan',
      progress_suffix: 'findings so far…',
      sidebar_title: 'Verification results',
      collapse: 'Collapse',
      collapse_aria: 'Collapse panel',
      resize_aria: 'Resize',
      panel_region_aria: 'Quran citation verification results',
      hint: 'Alt+Shift+Q → panel',
      hint_title: 'Press Alt+Shift+Q anywhere on the page to jump back to the panel',
      tab_text: '⟩ Results',
      tab_open_aria: 'Open panel',
      chip_orange: '⚠ Wrong reference',
      chip_green: '✓ Exact match',
      chip_lightBlue: '✓ No reference',
      chip_yellow: '~ Word-level mismatch',
      chip_red: '✗ Unverified',
      swap_summary: 'Show the original Quran text',
      swap_master: 'Enable (master)',
      swap_green: 'Exact match',
      swap_lightBlue: 'Match without reference',
      swap_yellow: 'Word-level mismatch',
      swap_orange: 'Reference mismatch',
      swap_red: 'Unverified — always off',
      swap_red_title: 'Red is always off',
      font_label: 'Font:',
      font_uthmani: 'Uthmani — Hafs',
      font_qpcHafs: 'QPC Hafs (official Uthmani)',
      font_qpcV2: 'QPC V2',
      font_qpcV4Tajweed: 'QPC V4 — Tajweed',
      font_digitalKhattIndopak: 'Digital Khatt — Indo-Pak',
      font_digitalKhattV1: 'Digital Khatt V1',
      font_digitalKhattV2: 'Digital Khatt V2',
      font_indopakNastaleeq: 'Indo-Pak — Nastaleeq',
      font_kfgqpcNastaleeq: 'KFGQPC Nastaleeq',
      persist_summary: 'Saved corrections and dismissals',
      clear_persisted: 'Clear saved corrections and dismissals',
      persist_cleared: 'Cleared — no saved items ({n} removed).',
      persist_clear_failed: "Couldn't clear. Try again.",
      section_results: 'Results',
      section_recent: 'Recently corrected',
      section_dismissed: 'Dismissed (this session)',
      section_prior_dismissed: 'Previously dismissed',
      empty_no_results: 'No results yet',
      empty_no_match_filter: 'No results match the current filters',
      act_correct: 'Correct',
      act_copy: 'Copy',
      act_share: 'Share',
      act_report: 'Report',
      act_json: 'JSON',
      act_dismiss: 'Dismiss',
      act_restore: 'Restore',
      badge_corrected: 'Corrected previously',
      badge_dismissed: 'Dismissed previously',
      tip_match: '(match)',
      tip_also_in: 'Also appears in: {refs}',
      tip_partial_in: '(partial in: {refs})',
      tip_no_ref: '(no reference cited on the page)',
      tip_word_level: '(word-level mismatch)',
      tip_word_level_and_ref: 'Cited as: {cited}\n(word-level mismatch + reference mismatch)',
      tip_orange: 'Cited as: {cited}\nActually: {matched}',
      tip_red: 'This text was not found in the Quran',
      tip_red_with_ref: 'This text was not found in the Quran\nCited reference: {ref}',
      share_orange: 'This page attributes “{snippet}” to {cited}, but it actually appears at {matched} in the Quran.',
      share_green: '“{snippet}” — {matched} (verified against the Quran).',
      share_lightBlue: '“{snippet}” — appears at {matched} (no reference was cited on the page).',
      share_yellow: '“{snippet}” — close to {matched}, with a word-level difference worth reviewing.',
      share_red: '“{snippet}” — this text was not found in the Quran.',
      share_page: 'Page: {url}',
      share_via: '— via Quran Citation Verifier',
    },
  };

  let lang = 'ar';
  function setLang(l) { lang = (l === 'en' || l === 'ar') ? l : 'ar'; }
  function getLang() { return lang; }
  function dir(l) { return (l || lang) === 'en' ? 'ltr' : 'rtl'; }

  function t(key, vars) {
    let s = (CATALOGS[lang] && CATALOGS[lang][key]);
    if (s == null) s = CATALOGS.ar[key];   // fall back to Arabic, then the key
    if (s == null) return key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }

  function detect(prefLang) {
    if (prefLang === 'en' || prefLang === 'ar') return prefLang;
    const ui = (typeof navigator !== 'undefined' && (navigator.language || '')).slice(0, 2).toLowerCase();
    return ui === 'en' ? 'en' : 'ar';
  }

  function applyDom(root) {
    const r = root || (typeof document !== 'undefined' ? document : null);
    if (!r) return;
    r.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    r.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    r.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  }

  return { t, dir, setLang, getLang, detect, applyDom, CATALOGS };
})();

// CommonJS export so the Node parity test (i18n key coverage) can require it.
if (typeof module !== 'undefined' && module.exports) module.exports = QuranI18n;
