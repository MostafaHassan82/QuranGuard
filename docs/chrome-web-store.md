# Publishing QuranGuard to the Chrome Web Store

End-to-end playbook for taking the `dist/quranguard-<version>.zip` produced by `npm run package` and getting it live in the Chrome Web Store (CWS). Written 2026-06-04 against the current CWS dashboard; the dashboard UI shifts occasionally, but the required *content* below is stable.

---

## Package size

Current package: **~2.6 MB, 63 files** — well within the norm for browser extensions and a fast review/install profile.

The `resources/QuranAyas/` and `resources/QuranAyas2/` PNG sets (~150 MB combined) are deliberately **excluded** from the package and from `manifest.json` → `web_accessible_resources`. They're staged in the repo for a possible future "render ayahs as images" mode, but no runtime code references them today. If a future feature needs them, drop the `resources/QuranAyas2?/` line from `EXCLUDE_PATTERNS` in `tools/package-extension.js` and add them back to `web_accessible_resources`.

---

## One-time setup

### Developer account
1. Go to https://chrome.google.com/webstore/devconsole
2. Sign in with the Google account that will own the listing.
3. Pay the **one-time $5 developer registration fee**. This unlocks the dashboard for up to 20 listings.
4. Set the account type (Individual vs. Organization). For an org, you'll later need to verify a domain.

### Privacy & contact
- Add a **public contact email** (CWS requires this — it appears on the listing).
- If your privacy policy needs to live somewhere public, the simplest option is a `PRIVACY.md` in this repo and link to the rendered GitHub URL.

---

## Per-release workflow

```
1. Bump manifest.json "version" (e.g., 1.0.0 → 1.0.1)
2. npm test                          ← regression gate (must be green)
3. npm run package                   ← writes dist/quranguard-<version>.zip + sha256
4. Open the CWS dashboard
5. New version → upload the zip → save → submit for review
```

The version string in `manifest.json` is the *only* knob CWS reads. Every upload must have a higher version than the previous; CWS rejects duplicates.

---

## Store listing fields

### Item name
**QuranGuard (صون القرآن)**

### Summary (≤ 132 chars)
> Verifies Quran citations on the web and helps you insert correct ayahs as you type. صون القرآن.

### Description (long)
Use a structured block; CWS supports plain text + line breaks (no markdown).

> **QuranGuard** keeps Quran citations on the web honest.
>
> Reader-side: as you browse, QuranGuard scans the page for Quran citations, compares each one against the authentic mushaf, and shows a verdict color directly on the text:
> • green — verified exact (text + reference agree)
> • light blue — verified exact, no reference written
> • yellow — word-level deviation from the authentic wording
> • orange — reference mismatch (real Quran, wrong ref)
> • red — citation signal but text not in the Quran
>
> When you want to fix something, one click rewrites the page text (or the reference) to match the mushaf, marked light green so you can see what was corrected.
>
> Writer-side: in any web editor or input, QuranGuard offers inline autocomplete for Quran citations drawn from the authentic mushaf. Single ayah, multi-ayah ranges, or "to end of surah." Mistakes are prevented at the source.
>
> Privacy: QuranGuard reads page text locally and stores your settings and per-page corrections in chrome.storage.local. No data is sent to a server.
>
> Open source: github.com/MostafaHassan82/QuranGuard

### Category
**Productivity** (closest fit; "Accessibility" is a defensible alternative).

### Language
Add at least **Arabic** and **English**. CWS lets you ship the same listing copy for both unless you write localized strings.

### Single-purpose statement (required by CWS policy)
> QuranGuard has a single purpose: to verify Quran citations on web pages and to assist authors in inserting correct citations while typing. Every permission and content script exists to serve that purpose.

---

## Permission justifications

CWS asks for a one-paragraph justification per permission. Copy these into the dashboard. Each is tailored to QuranGuard's actual usage.

### `storage`
> Stores user preferences (verdict color filter, autocomplete settings, panel position) and per-page state (which findings were corrected or dismissed, so a revisit does not flag them again). All data is kept in `chrome.storage.local`; nothing is transmitted off the device.

### `activeTab`
> The toolbar popup operates on the page currently in view — opening the findings panel, triggering a manual rescan. `activeTab` is the minimal permission that grants this on-demand access only after the user clicks the QuranGuard action.

### `scripting`
> Used to inject the verification helpers into pages on user demand and to apply corrections within page text. Required for Manifest V3 programmatic injection; no remote code is ever loaded.

### Host permission `<all_urls>` (content scripts)
> Quran citations appear on websites of every kind — news sites, blogs, forums, educational pages, social platforms — and the extension cannot know in advance which page will contain one. The content script needs to run wherever the user might encounter a citation, so the host match must be `<all_urls>`. The script reads page text locally; it does not exfiltrate it.

---

## Privacy practices

CWS now requires an explicit data-handling declaration. QuranGuard's answers:

| Question | Answer |
|---|---|
| Does this extension collect or use… personally identifiable information? | **No** |
| …health information? | No |
| …financial / payment info? | No |
| …authentication info? | No |
| …personal communications? | No |
| …location? | No |
| …web history? | **No** (page text is read locally; never stored or sent) |
| …user activity? | No |
| …website content? | **Yes, locally only** (page text is scanned for citations; results stay in `chrome.storage.local`) |

**Disclosures to certify:**
- ☑ I do not sell or transfer user data to third parties outside of approved use cases.
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:**
You need a publicly reachable URL. Simplest options:
1. Add `PRIVACY.md` to this repo, link to the GitHub blob URL.
2. A one-page GitHub Pages site if you want a prettier render.

A minimal policy: "QuranGuard reads page text locally for the sole purpose of detecting and verifying Quran citations. Settings and per-page correction/dismissal records are stored in chrome.storage.local on your device. No data is collected, transmitted, or shared with any third party."

---

## Required assets

| Asset | Size | Required? | Notes |
|---|---|---|---|
| Store icon | 128×128 PNG | **Yes** | Already in repo: `icons/icon-128.png` |
| Screenshots | 1280×800 or 640×400 PNG | **Yes — at least 1, up to 5** | Capture the panel showing the five verdicts on a real page; the autocomplete dropdown mid-typing; the corrected-in-place state |
| Small promo tile | 440×280 PNG | Optional but recommended | Used in store browsing rows |
| Marquee promo | 1400×560 PNG | Optional | Only matters if you'd aspire to be featured |

**Screenshot suggestions (capture in this order):**
1. A news page with several citations highlighted in green / yellow / orange / red — shows the core value.
2. The findings panel open on the right, listing the findings with verdict chips.
3. The autocomplete dropdown showing Quran candidates as the user types.
4. The "corrected" state — same page, yellow now light-green after click-to-correct.
5. The options page showing per-color settings.

Use clean fixture pages (e.g., a fixture from `tests/fixtures/` opened locally) so screenshots show varied colors without identifying any specific external site.

---

## Submission flow (first time)

1. Dashboard → **New item** → upload `dist/quranguard-<version>.zip`.
2. Wait for the zip to be parsed (a few minutes for a 130 MB upload; faster after a size reduction).
3. **Store listing tab:** paste the name, summary, description, category, language. Upload icon + screenshots.
4. **Privacy tab:** answer the data-use questions, paste the single-purpose statement, paste each permission justification, paste the privacy policy URL.
5. **Distribution tab:** choose Public, Unlisted, or Private. For a first launch, **Unlisted** is the safest — it lets you share the install link with a few trusted reviewers before publicizing. Regions: default to all regions unless you have a reason to exclude any.
6. **Save draft.** Re-read everything; the most common rejection cause is a mismatch between the description and the actual permissions.
7. **Submit for review.**

Review typically takes **a few hours to several days**. First submissions and any submission that uses `<all_urls>` are reviewed by a human; expect 1–3 days. You'll get an email either way.

If rejected, the email cites the policy violated. Fix and resubmit (no charge).

---

## After it's live

- The listing URL looks like `https://chromewebstore.google.com/detail/quranguard/<itemId>`.
- Updates: same flow — bump version → `npm run package` → upload → submit. Reviews for updates are usually faster than the first one.
- Crash reports and uninstall stats appear on the dashboard after ~24h.
- User reviews can be replied to once.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Package contains a file with an invalid path" | A file outside the manifest's tree, or a path with backslashes | The packager uses forward slashes; check that `INCLUDE_DIRS` doesn't catch a symlink |
| "Version must be higher than previous" | Forgot to bump `manifest.json` | Increment `version` (semver), re-`npm run package`, re-upload |
| "Description violates policy" | Often: making efficacy claims, or sounding like a separate product | Tone down marketing language; describe what it does, not what it promises |
| Long review | `<all_urls>` + large size trigger extra scrutiny | Trim the package; the justification text above already preempts the obvious concern |
| "Privacy practices incomplete" | Missing one of the certifications, or the privacy policy URL is unreachable | Make sure the URL returns 200; certifications must all be checked |

---

## Open source / repo cross-link

Once live, link both ways:
- Add the CWS listing URL to the README's install section.
- Add the GitHub repo link in the CWS description (already in the template above).

This builds trust ("I can read the code") and helps with the inevitable user who wants to verify what the extension actually does.
