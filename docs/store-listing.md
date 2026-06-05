# Chrome Web Store — Listing Copy (paste-ready)

Each section below maps to a field in the CWS dashboard's **Store listing** tab. Copy the blocks as-is, or tweak before pasting.

---

## 1. Description

> The CWS "Detailed description" field accepts plain text + line breaks (no markdown is rendered). The block below is ~3,700 characters, well under the 16,000 limit, and structured so the first ~200 chars (visible before "Read more") sell the value.

```
Allah's words are noble. Their wording must be preserved — whether an alteration is a careless typo or a deliberate change. QuranGuard (صون القرآن) was built to protect Quran citations on the web from drifting away from the authentic mushaf.

It pursues that goal in two directions, on the same page, at the same time:

  • Reader side — when a citation is already on the page, QuranGuard verifies it against the authentic mushaf and shows you exactly what is right, what is off, and what is missing. Where the wording or the reference has drifted, one click corrects it in place.

  • Writer side — when you are the one writing, QuranGuard offers inline autocomplete for Quran citations drawn from the authentic mushaf, so the citation never leaves your keyboard wrong in the first place.

This is the entire purpose of the extension. Everything below is how it delivers on it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
READER SIDE — see at a glance whether a citation is right
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

As you browse, QuranGuard scans the page for Quran citations, compares each one to the authentic mushaf, and marks it with one of five verdict colors directly on the text:

  • Green        — verified exact: text and reference agree (tashkeel and spelling variants tolerated)
  • Light blue   — verified exact, but no reference written on the page
  • Yellow       — word-level deviation from the authentic wording
  • Orange       — reference mismatch: the text is real Quran, but at a different ayah than cited
  • Red          — the text is presented as Quran but is not found in the Quran

A sixth shade, light green, marks text that QuranGuard has corrected for you back to the authentic wording — so a glance at the page shows what was changed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ONE-CLICK CORRECTION — fix yellow / orange / red in place
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For deviations, QuranGuard offers to rewrite the page text to match the authentic mushaf, or to fix a wrong reference. Each correction is recorded; the next time you visit the same page, the fix is reapplied automatically. You can revert any correction with one click.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WRITER SIDE — autocomplete authentic ayahs while you type
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

In any web editor or input — social posts, blog drafts, comments, emails on web — start typing a citation and QuranGuard offers inline suggestions drawn from the authentic mushaf:

  • Insert a single ayah
  • Insert a range of ayahs (you choose how many)
  • Insert from where you typed "to end of surah"
  • Insert "up to" a phrase you specify

Reference formatting (Arabic name vs. number, before/after the text) is configurable. Mistakes are prevented at the source rather than caught after publication.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DESIGNED FOR ARABIC AND BILINGUAL PAGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  • The findings panel is bilingual (Arabic / English); the rest of the UI adapts to your browser language.
  • Right-to-left rendering throughout.
  • Multiple Quran fonts to choose from (Uthmani Hafs, QPC Hafs, IndoPak Nastaleeq, Digital Khatt, KFGQPC Nastaleeq, and others).
  • Citation diacritics, ornate brackets ﴿ ﴾, BiDi controls, and surah-name variants are all recognised.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIVACY — your reading stays on your device
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  • Page text is scanned locally, in your browser. Nothing is sent to a server.
  • Your settings and the record of which findings you've corrected or dismissed are stored in chrome.storage.local. No accounts, no telemetry, no tracking.
  • The complete authentic Quran data is bundled with the extension; no network round-trip is needed to verify.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPEN SOURCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Full source code, specs, and test fixtures are public on GitHub. Issues and suggestions welcome.

  https://github.com/MostafaHassan82/QuranGuard

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

QuranGuard exists for one reason: the Quran is noble; no citation should be altered, intentionally or not. صون القرآن.
```

---

## 2. Category

**Selected:** `Tools` (under the Productivity domain).

Note on terminology: in the current CWS dashboard, **Productivity** is a top-level *domain*, not a selectable category — the picker forces a leaf category underneath. `Tools` is the best functional match for a utility that improves the accuracy of what you read and write on the web; CWS reviewers see grammar checkers, citation assistants, and similar text utilities under this leaf, so the framing is familiar to them.

Alternatives considered:

  • `Education` (Productivity domain) — defensible; many users are students, teachers, researchers, da'wah writers. Slightly narrower discoverability than Tools.
  • `Religion & spirituality` (Lifestyle domain) — most thematically precise, but the wrong audience: browsers of that category expect devotional apps (prayer times, dhikr counters), not a text-verification tool. Worse discoverability for the people who'd actually use it.

---

## 3. Language

The "Language" field in CWS controls which translated listing copy is shown to which user — it does NOT control which countries the extension is available in (that's the **Distribution** tab).

**Primary language:** `English (United States)` (en-US) — covers the global English audience.

**Add a second listing for Arabic:** `Arabic` (ar). If you don't want to translate the description block above into Arabic right now, you can ship with just English-US for v1 and add an Arabic listing later from the dashboard (it's a per-language form, doesn't require re-submitting the package).

> Short Arabic version you can use later for the Arabic listing's description, if you want to do that pass at the same time — drop into the Arabic listing's Description field:

```
كلام الله تعالى مُنزَّه عن التحريف، ولا يجوز أن يتبدّل لفظه — سواء أكان ذلك عن سهوٍ أم عن قصد. ومن هنا جاءت إضافة "صون القرآن" (QuranGuard) لحفظ الاقتباسات القرآنية على صفحات الويب من الانحراف عن المصحف الشريف.

تعمل الإضافة في اتجاهين، على الصفحة ذاتها، في الوقت نفسه:

  • القارئ — حين يوجد الاقتباس في الصفحة، تتحقق الإضافة من مطابقته للمصحف، وتُظهر بوضوح ما الصحيح وما المُختلف وما الناقص، وتعرض تصحيحه في مكانه بنقرة واحدة عند انحراف اللفظ أو المرجع.

  • الكاتب — حين تكون أنت من يكتب، تقترح الإضافة الآيات الصحيحة من المصحف فور البدء في كتابة الاقتباس، فلا يخرج الاقتباس من لوحة المفاتيح مُحرَّفًا أصلًا.

هذا هو هدف الإضافة كاملًا. كل ما يلي تفصيل لكيفية تحقيقه.

عند التصفح، تقوم الإضافة بفحص نص الصفحة، ومطابقة كل آية مع المصحف الشريف، وتمييز كل اقتباس بأحد ألوان التحقق الخمسة:
  • أخضر — تحقق تام، النص والمرجع متطابقان
  • أزرق فاتح — تحقق تام، دون مرجع مكتوب
  • أصفر — انحراف في الألفاظ عن النص الأصلي
  • برتقالي — النص قرآني صحيح، لكن المرجع المذكور خاطئ
  • أحمر — يُقدَّم النص على أنه قرآن، لكنه غير موجود في المصحف

عند الكتابة في أي محرر ويب، تعرض الإضافة اقتراحات لإدراج الآية الصحيحة من المصحف فور البدء في كتابة الاقتباس: آية واحدة، أو عدة آيات، أو حتى نهاية السورة، أو حتى كلمة محددة.

الخصوصية: النص يُفحص محليًا في متصفحك. لا يُرسل شيء إلى أي خادم. تُحفظ الإعدادات والتعديلات في chrome.storage.local على جهازك فقط.

المصدر مفتوح:
https://github.com/MostafaHassan82/QuranGuard

الهدف واحد: القرآن مُنزَّه، لا ينبغي أن يُحرَّف لفظُه ولو سهوًا. صون القرآن.
```

---

## 4. Graphic assets

| Asset | Spec | Required? | Source / Status |
|---|---|---|---|
| **Store icon** | 128×128 PNG, opaque | Required | `icons/icon-128.png` — already in repo |
| **Screenshot 1** | 1280×800 or 640×400 PNG | At least 1 required, up to 5 | Capture: a news page with several citations highlighted in different verdict colors — shows the core value at a glance |
| **Screenshot 2** | same | optional | Capture: the findings sidebar open, listing the findings with verdict chips |
| **Screenshot 3** | same | optional | Capture: the autocomplete dropdown mid-typing (showing 2-3 ayah candidates) |
| **Screenshot 4** | same | optional | Capture: the "corrected" state — same page with yellow now light-green after one-click correct |
| **Screenshot 5** | same | optional | Capture: the options page, showing per-color filter / autocomplete settings |
| **Small promo tile** | 440×280 PNG | Optional | Recommended — used in store browsing rows. Simple gold-on-green tile with the shield mark + "QuranGuard" works fine |
| **Marquee promo tile** | 1400×560 PNG | Optional | Only matters if you'd aspire to a featured slot — skip for v1 |

**Tips for the screenshots:**

- Use **fixture pages** from `tests/fixtures/` opened locally, not real third-party sites — avoids naming/identifying any specific website in your listing.
- Aim for 1280×800 (not 640×400). Larger looks better in the carousel.
- Keep the browser chrome simple — no extra extensions in the toolbar, no bookmarks bar with personal links visible.
- Annotate sparingly. CWS reviewers are picky about screenshots that look like banner ads (heavy text overlays, marketing copy). A single small caption per screenshot is fine; full-screen text is not.
- All five screenshots should be in the same Chrome window at the same zoom level so the carousel feels coherent.

**Quick promo-tile spec sheet** (if you want to design one):

```
Small promo (440×280):
  background: linear-gradient #08482e → #063626 (the manifest's deep green)
  centerpiece: the QuranGuard shield silhouette (from icons/icon.svg), gold stroked
  text right of mark: "QuranGuard" (white, 36pt), "صون القرآن" (gold, 24pt, RTL aligned)
  no marketing claims — CWS rejects "Best Quran tool ever" etc.
```

---

## 5. Additional fields

The "Additional fields" section under Store listing usually contains:

### Official URL
> Skip — only matters if you have a verified canonical domain for the product. The GitHub URL goes under "Homepage URL" instead.

### Homepage URL
```
https://github.com/MostafaHassan82/QuranGuard
```

### Support URL
```
https://github.com/MostafaHassan82/QuranGuard/issues
```

> Tip: this is the URL users see when they click "Support" on your listing. The Issues tab is the cleanest no-extra-setup option since you already wired bug-report templates.

### Mature content
> **No** — QuranGuard does not contain mature content.

### Single purpose
> See the "Single-purpose statement" section in `docs/chrome-web-store.md`. Paste verbatim:
>
> "QuranGuard has a single purpose: to verify Quran citations on web pages and to assist authors in inserting correct citations while typing. Every permission and content script exists to serve that purpose."

### YouTube video URL (optional)
> Skip for v1 — only worth doing if you record a 30-90s demo screencast. Has measurable effect on conversion on the listing page, but not blocking.

---

## Quick-paste reference (one-line each)

| Field | Value |
|---|---|
| Item name | `QuranGuard (صون القرآن)` |
| Summary | `Verifies Quran citations on the web and helps you insert correct ayahs as you type. صون القرآن.` |
| Category | `Tools` (under the Productivity domain) |
| Language (primary) | `English (United States)` |
| Mature content | `No` |
| Homepage URL | `https://github.com/MostafaHassan82/QuranGuard` |
| Support URL | `https://github.com/MostafaHassan82/QuranGuard/issues` |
| Privacy policy URL | (add when ready — see `docs/chrome-web-store.md`) |
| Official URL | (leave blank) |
| YouTube URL | (leave blank for v1) |
