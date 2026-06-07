# Privacy Policy — QuranGuard (صون القرآن)

**Last updated:** 2026-06-07

QuranGuard is a Chrome extension that verifies Quran citations on web pages and helps authors insert correct citations while typing. This policy describes, in full, what it does and does not do with your data.

## Summary (the whole policy in three lines)

- QuranGuard reads page text **locally, in your browser**, only to detect and verify Quran citations.
- Your settings and a record of which findings you've corrected or dismissed are stored in `chrome.storage.local` **on your device**.
- **Nothing** is sent to any server, collected, sold, shared, or used for advertising.

## What QuranGuard accesses

| Access | Purpose | Where it stays |
| --- | --- | --- |
| The text content of web pages you visit | Detect Quran citations, compare them against the authentic mushaf | Read in memory only; never stored, never transmitted |
| Your extension settings (verdict colors, autocomplete prefs, panel position, font choice, appearance theme) | Apply your preferences across pages and sessions | `chrome.storage.local` on your device |
| Per-page correction & dismissal records (which findings on a URL you corrected or dismissed) | Re-apply your decisions on revisit so QuranGuard does not re-prompt you | `chrome.storage.local` on your device |

## What QuranGuard does NOT do

- It does **not** transmit page text, citations, references, or any other data over the network.
- It does **not** contact any server (no analytics, no telemetry, no crash reporting, no remote configuration).
- It does **not** load or execute any code from outside the extension package. All JavaScript and the bundled mushaf data ship inside the extension.
- It does **not** create accounts, require login, or use cookies.
- It does **not** track you across sites. It does **not** build a profile of your reading or writing.
- It does **not** sell or share your data with any third party (because it has none to share).

## Permissions, explained

- **`storage`** — to save your settings and per-page records in `chrome.storage.local`.
- **`activeTab`** — so the toolbar action can act on the page currently in view (open the panel, trigger a rescan).
- **`scripting`** — required by Manifest V3 to apply corrections within page text. No remote code is ever loaded.
- **Host access `<all_urls>`** — because Quran citations can appear on any website. The extension reads page text locally; it does not exfiltrate it.

## Your data, your device

Everything QuranGuard stores lives in `chrome.storage.local`, which is sandboxed per extension by Chrome. You can clear it at any time by:

- Removing the extension (`chrome://extensions` → Remove), or
- `chrome://extensions` → QuranGuard → "Site access" / details → clear extension data.

## Children's privacy

QuranGuard does not collect any data, and is not directed at any specific age group. No special handling is required because no data leaves your device.

## Changes to this policy

If this policy ever changes (for example, if a future version of the extension adds optional sync or cloud features), the change will be reflected in this file with a new "Last updated" date, and called out in the release notes.

## Contact

- Issues and questions: https://github.com/MostafaHassan82/QuranGuard/issues
- Source code (you can read exactly what the extension does): https://github.com/MostafaHassan82/QuranGuard

## Closing note

QuranGuard exists to protect the integrity of Quran citations. It would be strange to do that while undermining the integrity of your privacy. The extension is built to be a tool you can trust without having to read the source — but the source is also public, so you can.
