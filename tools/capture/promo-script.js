'use strict';
/**
 * QuranGuard promo video — the SHOT LIST.
 *
 * This file is the only thing to edit to change the promo video: reorder
 * scenes, retime holds, add or drop cases, change caption copy. The engine
 * that executes it lives in promo.js (run with
 * `node tools/capture/promo.js --lang ar|en`); the verbs are documented there.
 *
 * Shape:  module.exports = ({ lang }) => [ { scene: 'name', steps: [step…] } ]
 *
 * A step is { do: '<verb>', …options }, plus optionally:
 *   when: 'popupShown'  — skip the step unless that runtime flag is set
 *                         (openPopup sets it)
 *
 * { do: 'cut', steps: […] } runs its steps inside a "load interval" that is
 * removed from the final video in post — page loads and rescans go here so
 * the viewer never sees them. The camera zoom MUST be back at 1 before every
 * cut (zoompan would jump otherwise; promo.js validates this).
 *
 * Caption cues ({ do: 'cue', text: 'key' }) reference PROMO_COPY below; a cue
 * stays on screen until the next cue starts. Cue strings may carry inline
 * HTML (<span class="g">/<span class="r">) — pills are rendered by a real
 * browser, not libass, because ffmpeg-static's libass cannot shape Arabic.
 *
 * Targets (spotlight / rippleClick / zoom / saveBox accept these):
 *   '.css-selector'                          first match on the page
 *   '@wrongRefMarker'                        named resolver in promo.js
 *   { resolver: 'nearestLightGreen', arg: 'orangeBox' }
 *                                            resolver with a saved-box argument
 *   { row: '.row-selector', label: /re/i }   first <button> in the panel row
 *                                            whose label matches (works in
 *                                            both UI languages)
 *   [a, b, …]                                fallback list; first that resolves
 */

// Screen-coordinate constants (CSS px; Chrome window pinned at (0,0), outer
// size 1280×800). Tab row y≈0–35, toolbar y≈35–75 (center y≈55); with only
// our extension loaded the action icon sits just left of the profile button.
const EXT_ICON = { x: 1205, y: 55 };

module.exports = function buildPromoScript({ lang }) {
  // The popup's primary "Scan page" button mirrors with UI direction:
  // right side in RTL (Arabic), left side in LTR (English).
  const SCAN_BTN = lang === 'ar' ? { x: 1017, y: 191 } : { x: 899, y: 191 };

  return [

    // ── Scene 1 (~4.5s): hook over the real article, slow push-in ───────────
    { scene: 'hook', steps: [
      { do: 'cue',  text: 'hook' },
      { do: 'zoom', z: 1.06, cx: 0.5, cy: 0.45, dur: 4.0 }, // subtle cinematic drift
      { do: 'mouse', x: 640, y: 320 },
      { do: 'scrollBy', top: 500 },
      { do: 'wait', ms: 4300 },
    ] },

    // ── Scene 2 (~7s): popup opens, camera punches in, real Scan click ──────
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
        { do: 'setScanTrigger', value: 'autoscan' },
        { do: 'goto', url: 'colors', waitUntil: 'domcontentloaded', timeout: 45000, dismissOverlays: true },
        { do: 'waitFor', sel: '.quran-green, .quran-lightblue, .quran-yellow', timeout: 40000 },
        { do: 'waitForPanel' },
        { do: 'scrollTop', top: 600 },
        { do: 'wait', ms: 600 }, // settle inside the cut — also absorbs anchor error
      ] },
    ] },

    // ── Scene 3 (~6s): results panel spotlight, then scroll the highlights ──
    { scene: 'panel', steps: [
      { do: 'cue', text: 'scan' },
      { do: 'spotlight', target: '.quran-ext-panel', pad: 6, holdMs: 2700 },
      { do: 'scrollBy', top: 240 },
      { do: 'wait', ms: 2300 },
    ] },

    // ── Scene 4 (~5s): color verdicts, spotlight a non-green finding ────────
    { scene: 'colors', steps: [
      { do: 'cue', text: 'colors' },
      { do: 'spotlight', target: '.quran-yellow', pad: 8, scrollIntoView: true, settleMs: 400, holdMs: 2900 },
      { do: 'wait', ms: 500 },
    ] },

    // ── Scene 5 (~14s): RED — show the error, fix it, show the result ───────
    { scene: 'red', steps: [
      { do: 'cut', steps: [
        { do: 'goto', url: 'errors', waitUntil: 'domcontentloaded', timeout: 45000, dismissOverlays: true },
        { do: 'waitFor', sel: '.quran-red, .quran-orange', timeout: 40000 },
        { do: 'waitForPanel' },
        { do: 'scrollToEl', sel: '.quran-red' },
        { do: 'wait', ms: 600 },
      ] },
      { do: 'cue', text: 'red' },
      { do: 'spotlight', target: '.quran-red', pad: 8, holdMs: 2500 },
      { do: 'rippleClick', target: '.quran-red' }, // opens the panel detail card
      { do: 'wait', ms: 600 },
      { do: 'cue', text: 'tap' },
      { do: 'zoom', z: 1.28, cx: 0.16, cy: 0.55, dur: 0.7 }, // punch in on the panel detail card
      { do: 'wait', ms: 2600 },
      // Accept the red suggestion while still zoomed on the panel.
      { do: 'rippleClick', name: 'red: accepted suggestion', scrollIntoView: true, preMs: 350,
        target: { row: '.quran-ext-panel-row-red', label: /اعتماد|قبول|تصحيح|accept|correct|fix/i } },
      { do: 'wait', ms: 900 },
      { do: 'zoom', z: 1.0, cx: 0.5, cy: 0.5, dur: 0.6 },
      { do: 'wait', ms: 700 },
      { do: 'cue', text: 'redFixed' },
      { do: 'spotlight', target: '.quran-lightgreen', pad: 8, scrollIntoView: true, settleMs: 400, holdMs: 2600 },
    ] },

    // ── Scene 6 (~11s): ORANGE — jump from the panel, see it, fix it ────────
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

    // ── Scene 7 (~10s): writer demo — type, zoom on dropdown, Tab-insert ────
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
      { do: 'wait', ms: 2400 },
      { do: 'zoom', z: 1.0, cx: 0.5, cy: 0.5, dur: 0.6 },
      { do: 'wait', ms: 700 },
    ] },

    // ── Scene 8 (~8s): live theme switching, zoomed on the picker ───────────
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

    // ── Scene 9 (~7s): options tour — much more to configure ────────────────
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
};

// ── Copy ──────────────────────────────────────────────────────────────────────
// Caption + card copy, per language. Cue keys above reference these. Inline
// HTML allowed: <span class="g"> = brand green, <span class="r"> = alert red.

module.exports.PROMO_COPY = {
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
