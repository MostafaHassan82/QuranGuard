'use strict';
/**
 * QuranGuard marketing promo — the VIDEO SCRIPT.
 *
 * Everything specific to THIS video lives here: source URLs, extension prefs,
 * scene choreography, caption/card copy, card design, caption pill style,
 * timings, and the output name. The generic recording engine (record.js)
 * executes it:
 *
 *   node tools/capture/record.js promo-script.js --lang ar|en
 *   node tools/capture/record.js promo-script.js --validate
 *
 * (promo-script.js is the engine's default script, so the path can be omitted.)
 *
 * ── Script interface (what record.js expects this module to export) ─────────
 *   name        output base name → output/video/<name>-<lang>.mp4
 *   languages   supported langs; first one is the default
 *   urls        ({ srv, popupUrl, optionsUrl, extensionId }) → { key: url } map
 *               used by goto steps and startUrl
 *   startUrl    urls key loaded fully BEFORE capture starts (frame 1 is clean)
 *   prefs       (lang) → object merged into chrome.storage.local 'prefs.v1'
 *               before any extension surface renders
 *   cleanupPrefs  merged into prefs.v1 after recording (restore state)
 *   timing      { introDur, outroDur, xf } — card durations + crossfade (s)
 *   narration   { enabled, voices: {lang: edgeVoice}, rate?, pitch?, volume?,
 *               maxTempo? } — optional narrator: each cue's text (HTML
 *               stripped) is spoken by an Edge neural voice, mixed in at the
 *               cue's start. Clips that outlast their cue window are sped up
 *               (≤ maxTempo, default 1.15, pitch-preserved) and never overlap
 *               (needs network; --narrate / --no-narrate override enabled)
 *   copy        per-language strings; cue steps reference these by key
 *   scenes      ({ lang }) → [ { scene: 'name', steps: [step…] } ]
 *   cards       (lang) → { introHtml, outroHtml, viewport } rendered headless
 *               to PNG, never visible to the screen recording
 *   captionHtml (text, lang) → HTML page whose FIRST <body> element is
 *               screenshotted (transparent) as the caption pill
 *
 * ── Steps ───────────────────────────────────────────────────────────────────
 * A step is { do: '<verb>', …options } (verb reference in record.js), plus
 * optionally `when: 'popupShown'` — skip unless that runtime flag is set
 * (openPopup sets it).
 *
 * { do: 'cut', steps: […] } runs its steps inside a "load interval" that is
 * removed from the final video in post — page loads and rescans go here so
 * the viewer never sees them. The camera zoom MUST be back at 1 before every
 * cut (zoompan would jump otherwise; --validate checks this).
 *
 * A cue stays on screen until the next cue starts. Cue strings may carry
 * inline HTML (<span class="g">/<span class="r">, styled by captionHtml) —
 * pills are rendered by a real browser, not libass, because ffmpeg-static's
 * libass cannot shape Arabic.
 *
 * ── Targets (spotlight / rippleClick / zoom / saveBox) ──────────────────────
 *   '.css-selector'                          first match on the page
 *   '@wrongRefMarker'                        named resolver in record.js
 *   { resolver: 'nearestLightGreen', arg: 'orangeBox' }
 *                                            resolver with a saved-box argument
 *   { row: '.row-selector', label: /re/i }   first <button> in the panel row
 *                                            whose label matches (works in
 *                                            both UI languages)
 *   [a, b, …]                                fallback list; first that resolves
 */

const fs   = require('fs');
const path = require('path');

// ── Copy ──────────────────────────────────────────────────────────────────────
// Caption + card copy, per language. Cue keys in the scenes reference these.
// Inline HTML allowed: <span class="g"> = brand green, <span class="r"> = alert red.

const COPY = {
  en: {
    hook:       'Quran citations are everywhere — but are they accurate?',
    meet:       'Meet <span class="g">QuranGuard</span> — a one-click audit for any page',
    scan:       'Auto-scan verifies every citation against the mushaf',
    colors:     'Color-coded verdicts — issues at a glance',
    red:        '<span class="r">Red</span> — this text isn\'t in the Quran',
    tap:        'Tap a highlight to see the authentic wording',
    redFixed:   'One click — the authentic ayah, fixed in place',
    orangeJump: 'Wrong reference? Jump straight to it',
    orangeFix:  '…and correct it in place',
    writer:     'It even completes the ayah as you type',
    tab:        'Press Tab — the verified ayah is inserted',
    themes:     'Six hand-crafted themes',
    more:       '…and much more to fine-tune',
    cardKicker: 'QuranGuard',
    cardTag:    'Every ayah. Letter-perfect.',
    outroKicker:'QuranGuard · صون القرآن',
    outroTag:   'Guard every ayah you publish.',
    outroPill:  'Available on the Chrome Web Store',
  },
  ar: {
    hook:       'آيات القرآن تُقتبس في كل مكان — فهل هي دقيقة؟',
    meet:       'تعرَّف على <span class="g">صَوْن القرآن</span> — فحص أي صفحة بنقرة واحدة',
    scan:       'الفحص التلقائي يدقّق كل اقتباس على المصحف',
    colors:     'ألوان تكشف الحالة — والمشاكل تظهر بلمحة',
    red:        '<span class="r">الأحمر</span> — نصٌ لا وجود له في القرآن',
    tap:        'اضغط على أي تمييز لترى النص الصحيح من المصحف',
    redFixed:   'بنقرة واحدة — يُستبدل بالنص القرآني الصحيح',
    orangeJump: 'مرجع خاطئ؟ انتقل إليه مباشرةً من اللوحة',
    orangeFix:  '…وصحِّحه في مكانه',
    writer:     'بل ويُكمل الآية أثناء الكتابة',
    tab:        'اضغط Tab — وتُدرَج الآية الموثَّقة',
    themes:     'ستة مظاهر مصمَّمة بعناية',
    more:       '…والمزيد من الخيارات للتخصيص',
    cardKicker: 'QuranGuard',
    cardTag:    'كلُّ آية، بحرفها.',
    outroKicker:'QuranGuard · صون القرآن',
    outroTag:   'احرس كلَّ آية تنشرها.',
    outroPill:  'متوفر في متجر Chrome الإلكتروني',
  },
};

// ── Screen coordinates (CSS px; window pinned at (0,0), outer 1280×800) ──────
// Tab row y≈0–35, toolbar y≈35–75 (center y≈55); with only our extension
// loaded the action icon sits just left of the profile button.

const EXT_ICON = { x: 1205, y: 55 };

module.exports = {
  name: 'promo-screen',
  languages: ['en', 'ar'],

  // Real source URLs — navigated directly so the extension runs on the live
  // site exactly as end users experience it.
  urls: ({ srv, optionsUrl }) => ({
    colors: 'https://www.islamweb.net/ar/article/241627/%D8%AD%D8%B0%D9%81-%D8%A7%D9%84%D8%AA%D9%86%D9%88%D9%8A%D9%86-%D8%AA%D8%AE%D9%81%D9%8A%D9%81%D8%A7%D9%8B',
    errors: 'https://www.islamweb.net/ar/article/220324/%D8%AC%D9%85%D9%88%D8%B9-%D8%A7%D9%84%D8%AA%D9%83%D8%B3%D9%8A%D8%B1-%D9%81%D9%8A-%D8%A7%D9%84%D9%82%D8%B1%D8%A2%D9%86-%D8%A7%D9%84%D9%83%D8%B1%D9%8A%D9%85-%D8%AC%D9%85%D9%88%D8%B9-%D8%A7%D9%84%D9%83%D8%AB%D8%B1%D8%A9-8',
    writerDemo: `${srv.base}/writer-demo`,
    options: optionsUrl,
  }),
  startUrl: 'colors',

  // Applied to prefs.v1 before any extension surface renders: UI language,
  // manual scan (scene 2 clicks the popup button), all panel categories
  // visible, panel floating on the left so it doesn't squeeze the page text.
  prefs: (lang) => ({
    lang,
    scanTrigger: 'manual',
    panelFilter: { orange: true, green: true, lightBlue: true, lightGreen: true, yellow: true, red: true },
    panelPosition: 'float',
    floatAnchor: 'left',
  }),
  cleanupPrefs: { scanTrigger: 'manual' },

  // Final-timeline card durations and crossfade, seconds.
  timing: { introDur: 2.8, outroDur: 3.6, xf: 0.5 },

  // Narrator: each cue line is spoken at its on-screen start. Edge neural
  // voices (other options: en-US-GuyNeural, ar-SA-HamedNeural, ar-EG-SalmaNeural).
  narration: {
    enabled: true,
    voices: { en: 'en-US-AndrewNeural', ar: 'ar-EG-ShakirNeural' },
  },

  copy: COPY,

  // ── Scenes ──────────────────────────────────────────────────────────────────
  scenes: ({ lang }) => {
    // The popup's primary "Scan page" button mirrors with UI direction:
    // right side in RTL (Arabic), left side in LTR (English).
    const SCAN_BTN = lang === 'ar' ? { x: 1017, y: 191 } : { x: 899, y: 191 };

    // Arabic narration speaks ~15% slower than English over the same copy —
    // P(base, arExtra) widens specific holds so each spoken line fits its cue
    // window (record.js warns per clip when pacing gets tight again).
    const P = (base, arExtra) => lang === 'ar' ? base + arExtra : base;

    return [

      // ── Scene 1 (~4.5s): hook over the real article, slow push-in ─────────
      { scene: 'hook', steps: [
        { do: 'cue',  text: 'hook' },
        { do: 'zoom', z: 1.06, cx: 0.5, cy: 0.45, dur: 4.0 }, // subtle cinematic drift
        { do: 'mouse', x: 640, y: 320 },
        { do: 'scrollBy', top: 500 },
        { do: 'wait', ms: P(4300, 1200) },
      ] },

      // ── Scene 2 (~7s): popup opens, camera punches in, real Scan click ────
      { scene: 'popup', steps: [
        { do: 'cue', text: 'meet' },
        // Cursor glides into the toolbar extension-icon area — visual cue for click.
        { do: 'nativeGlide', points: [
          [EXT_ICON.x - 120, EXT_ICON.y + 40],
          [EXT_ICON.x - 40,  EXT_ICON.y + 10],
          [EXT_ICON.x,       EXT_ICON.y],
        ] },
        { do: 'openPopup' }, // sets popupShown; falls back to popup-as-tab
        { do: 'zoom', z: 1.6, cx: 0.75, cy: 0.24, dur: 0.8 }, // strong punch-in on the popup
        { do: 'wait', ms: 1500 },
        // Really click the popup's "Scan page" button — the popup is a native
        // window outside CDP's reach, so this is an OS-level click.
        { do: 'nativeGlide', when: 'popupShown', click: true, points: [
          [SCAN_BTN.x - 60, SCAN_BTN.y + 30],
          [SCAN_BTN.x,      SCAN_BTN.y],
        ], log: 'clicked popup scan button' },
        { do: 'wait', ms: 2400 }, // scan runs; highlights appear behind the popup
        { do: 'zoom', z: 1.0, cx: 0.5, cy: 0.5, dur: 0.7 },
        { do: 'wait', ms: 800 },
        // Dismiss the popup and rescan — the whole load interval is cut in post.
        // Playwright clicks/keys never dismiss the native popup; a real OS-level
        // Escape + a focus click on the empty tab strip do.
        { do: 'cut', steps: [
          { do: 'nativeKey',   when: 'popupShown', vk: 0x1B },
          { do: 'nativeClick', when: 'popupShown', x: 640, y: 15 },
          { do: 'setPref', key: 'scanTrigger', value: 'autoscan' },
          { do: 'goto', url: 'colors', waitUntil: 'domcontentloaded', timeout: 45000, dismissOverlays: true },
          { do: 'waitFor', sel: '.quran-green, .quran-lightblue, .quran-yellow', timeout: 40000 },
          { do: 'waitForPanel' },
          { do: 'scrollTop', top: 600 },
          { do: 'wait', ms: 600 }, // settle inside the cut — also absorbs anchor error
        ] },
      ] },

      // ── Scene 3 (~6s): results panel spotlight, then scroll the highlights ─
      { scene: 'panel', steps: [
        { do: 'cue', text: 'scan' },
        { do: 'spotlight', target: '.quran-ext-panel', pad: 6, holdMs: 2700 },
        { do: 'scrollBy', top: 240 },
        { do: 'wait', ms: 2300 },
      ] },

      // ── Scene 4 (~5s): color verdicts, spotlight a non-green finding ──────
      { scene: 'colors', steps: [
        { do: 'cue', text: 'colors' },
        { do: 'spotlight', target: '.quran-yellow', pad: 8, scrollIntoView: true, settleMs: 400, holdMs: P(2900, 600) },
        { do: 'wait', ms: 500 },
      ] },

      // ── Scene 5 (~14s): RED — show the error, fix it, show the result ─────
      { scene: 'red', steps: [
        { do: 'cut', steps: [
          { do: 'goto', url: 'errors', waitUntil: 'domcontentloaded', timeout: 45000, dismissOverlays: true },
          { do: 'waitFor', sel: '.quran-red, .quran-orange', timeout: 40000 },
          { do: 'waitForPanel' },
          { do: 'scrollToEl', sel: '.quran-red' },
          { do: 'wait', ms: 600 },
        ] },
        { do: 'cue', text: 'red' },
        { do: 'spotlight', target: '.quran-red', pad: 8, holdMs: P(2500, 900) },
        { do: 'rippleClick', target: '.quran-red' }, // opens the panel detail card
        { do: 'wait', ms: 600 },
        { do: 'cue', text: 'tap' },
        { do: 'zoom', z: 1.28, cx: 0.16, cy: 0.55, dur: 0.7 }, // punch in on the panel detail card
        { do: 'wait', ms: P(2600, 400) },
        // Accept the red suggestion while still zoomed on the panel.
        { do: 'rippleClick', name: 'red: accepted suggestion', scrollIntoView: true, preMs: 350,
          target: { row: '.quran-ext-panel-row-red', label: /اعتماد|قبول|تصحيح|accept|correct|fix/i } },
        { do: 'wait', ms: 900 },
        { do: 'zoom', z: 1.0, cx: 0.5, cy: 0.5, dur: 0.6 },
        { do: 'wait', ms: 700 },
        { do: 'cue', text: 'redFixed' },
        { do: 'spotlight', target: '.quran-lightgreen', pad: 8, scrollIntoView: true, settleMs: 400, holdMs: P(2600, 2000) },
      ] },

      // ── Scene 6 (~11s): ORANGE — jump from the panel, see it, fix it ──────
      { scene: 'orange', steps: [
        { do: 'cue', text: 'orangeJump' },
        // Row click (not on the action button) = jump to the highlight.
        { do: 'rippleClick', target: '.quran-ext-panel-row-orange .quran-ext-panel-head',
          scrollIntoView: true, settleMs: 300 },
        { do: 'wait', ms: 1600 }, // page scrolls to the orange mistake
        // Remember where the orange highlight was BEFORE the fix — used below to
        // pick the nearest light-green among multiple corrections on the page.
        { do: 'saveBox', target: '.quran-orange', as: 'orangeBox' },
        // The orange mistake is the REFERENCE, not the ayah — spotlight the wrong
        // ref marker next to the highlight (fallback: the highlight itself).
        { do: 'spotlight', target: ['@wrongRefMarker', '.quran-orange'], pad: 8, holdMs: 2400 },
        { do: 'cue', text: 'orangeFix' },
        { do: 'rippleClick', name: 'orange: corrected in place', scrollIntoView: true, preMs: 400,
          target: { row: '.quran-ext-panel-row-orange', label: /تصحيح|correct/i } },
        { do: 'wait', ms: 900 },
        // What changed is the reference text — spotlight the corrected ref marker
        // (correctInPlace tags it quran-ref-corrected), not the ayah.
        { do: 'spotlight', pad: 8, holdMs: 2400,
          target: ['.quran-ref-corrected', { resolver: 'nearestLightGreen', arg: 'orangeBox' }] },
      ] },

      // ── Scene 7 (~10s): writer demo — type, zoom on dropdown, Tab-insert ──
      { scene: 'writer', steps: [
        { do: 'cut', steps: [
          { do: 'goto', url: 'writerDemo', waitUntil: 'load' },
          // Uthmani font for the dropdown candidates (same treatment as screenshots).
          { do: 'injectCss', css: `
            @font-face { font-family:'UthmaniHafs'; src:url('chrome-extension://{EXT_ID}/resources/fonts/uthmani-hafs.ttf') format('truetype'); }
            .quran-ac-ayah { font-family:'UthmaniHafs','Traditional Arabic',serif !important; font-size:18px !important; }
          ` },
          { do: 'click', sel: '#article-body' },
          { do: 'press', key: 'Control+End' },
          { do: 'wait', ms: 600 },
        ] },
        { do: 'cue', text: 'writer' },
        { do: 'type', text: 'فإذا قرأت', perCharMs: 140 },
        { do: 'waitFor', sel: '.quran-ac-menu', timeout: 8000, optional: true },
        { do: 'zoom', target: '.quran-ac-menu', z: 1.3, dur: 0.8 },
        { do: 'wait', ms: 2300 },  // dropdown clearly visible
        { do: 'press', key: 'Tab' },
        { do: 'wait', ms: 1500 },  // scope menu clearly visible
        { do: 'cue', text: 'tab' },
        { do: 'press', key: 'Tab' },
        { do: 'wait', ms: P(2400, 1200) },
        { do: 'zoom', z: 1.0, cx: 0.5, cy: 0.5, dur: 0.6 },
        { do: 'wait', ms: 700 },
      ] },

      // ── Scene 8 (~8s): live theme switching, zoomed on the picker ─────────
      { scene: 'themes', steps: [
        { do: 'cut', steps: [
          { do: 'goto', url: 'options', waitUntil: 'domcontentloaded' },
          { do: 'waitFor', sel: '#appearance-picker .theme-card', timeout: 10000, optional: true },
          { do: 'scrollToEl', sel: '#sec-appearance' },
          { do: 'wait', ms: 600 },
        ] },
        { do: 'cue', text: 'themes' },
        { do: 'zoom', target: '#appearance-picker', z: 1.22, dur: 0.8 },
        { do: 'rippleClick', target: '.theme-card[data-theme-id="mihrab"]' },
        { do: 'wait', ms: 1900 },
        { do: 'rippleClick', target: '.theme-card[data-theme-id="diwan"]' },
        { do: 'wait', ms: 1900 },
        { do: 'rippleClick', target: '.theme-card[data-theme-id="tahrir"]' },
        { do: 'wait', ms: 1900 },
        { do: 'zoom', z: 1.0, cx: 0.5, cy: 0.5, dur: 0.7 },
        { do: 'wait', ms: 900 },
      ] },

      // ── Scene 9 (~7s): options tour — much more to configure ──────────────
      { scene: 'more', steps: [
        { do: 'cue', text: 'more' },
        { do: 'scrollToEl', sel: '#sec-highlight', smooth: true },
        { do: 'wait', ms: 2200 },
        { do: 'scrollToEl', sel: '#sec-autocomplete', smooth: true },
        { do: 'wait', ms: 2200 },
        { do: 'scrollToEl', sel: '#sec-panel', smooth: true },
        { do: 'wait', ms: 2200 },
        { do: 'wait', ms: 500 },
      ] },

    ];
  },

  // ── Intro/outro cards (1600×1000, rendered headless, scaled in post) ────────
  cards: (lang) => {
    const iconB64 = fs.readFileSync(
      path.resolve(__dirname, '../..', 'icons', 'icon-128.png')).toString('base64');
    const star = encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>" +
      "<g fill='none' stroke='#ffffff' stroke-width='1'>" +
      "<path d='M60 6l14 40 40 14-40 14-14 40-14-40-40-14 40-14z'/><circle cx='60' cy='60' r='4'/></g></svg>");
    const card = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{width:1600px;height:1000px;display:flex;align-items:center;justify-content:center;
        font-family:'Segoe UI',system-ui,sans-serif;color:#f3faf5;overflow:hidden;
        background:radial-gradient(1200px 800px at 50% 38%,#11402a 0%,#0a2719 52%,#051710 100%)}
      .pattern{position:fixed;inset:0;opacity:.06;background-image:url("data:image/svg+xml,${star}")}
      .wrap{position:relative;text-align:center}
      .kicker{font-size:30px;letter-spacing:.38em;color:#7fd6a4;text-transform:uppercase;font-weight:600}
      .ar{font-size:96px;font-weight:700;font-family:'Traditional Arabic','Amiri',serif;margin-top:6px}
      .tag{font-size:34px;color:#cfe9da;font-weight:300;margin-top:16px}
      .rule{width:120px;height:2px;background:linear-gradient(90deg,transparent,#34c759,transparent);margin:26px auto 0}
      .pill{display:inline-block;margin-top:34px;padding:16px 44px;border-radius:999px;background:#f3faf5;
        color:#0a2719;font-size:28px;font-weight:600}
      img.logo{width:118px;height:118px;filter:drop-shadow(0 12px 32px rgba(0,0,0,.5))}
    </style></head><body><div class="pattern"></div><div class="wrap">${body}</div></body></html>`;

    const c = COPY[lang];
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    return {
      viewport: { width: 1600, height: 1000 },
      introHtml: card(`
        <img class="logo" src="data:image/png;base64,${iconB64}">
        <div class="kicker" style="margin-top:34px">${c.cardKicker}</div>
        <div class="ar">صَوْنُ القُرْآن</div>
        <div class="rule"></div>
        <div class="tag" dir="${dir}">${c.cardTag}</div>`),
      outroHtml: card(`
        <img class="logo" src="data:image/png;base64,${iconB64}">
        <div class="kicker" style="margin-top:34px">${c.outroKicker}</div>
        <div class="tag" dir="${dir}" style="margin-top:22px">${c.outroTag}</div>
        <div class="pill" dir="${dir}">${c.outroPill}</div>`),
    };
  },

  // ── Caption pill (first <body> element is screenshotted, transparent) ───────
  // Rendered at 2× by the engine and downscaled in FFmpeg for crisp text.
  captionHtml: (text, lang) => {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    return `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;display:flex;align-items:flex-start;justify-content:center;background:transparent}
      .pill{display:inline-block;max-width:1100px;margin-top:8px;padding:14px 30px;border-radius:14px;
        background:rgba(7,18,11,.88);box-shadow:0 6px 22px rgba(0,0,0,.35);
        font:600 28px 'Segoe UI',system-ui,sans-serif;color:#fff;text-align:center;
        direction:${dir};line-height:1.45}
      .pill .g{color:#34c759;font-weight:700}
      .pill .r{color:#ff6b5e;font-weight:700}
    </style><body><div class="pill">${text}</div>`;
  },
};
