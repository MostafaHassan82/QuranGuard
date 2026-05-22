# Handoff to Sonnet (or any successor)

**Last updated:** 2026-05-15
**Status:** Milestone A implementation complete, awaiting fixture validation.

---

## What this project is

A Chrome extension that audits Quran citations on Arabic web pages. The mission is integrity: catch citations that are wrong — especially the case where the cited text is real Quran but is attributed to the wrong reference (the "orange" finding). Reader-side audit is the primary V1 user; writer-side assist is secondary.

**Do not lose sight of the mission.** When in doubt, the question to ask is: *does this protect Quran integrity on the web?* Render-mode polish, code prettification, autocomplete — these are downstream. The verifier producing trustworthy green/orange/red is the only thing that matters in V1.

---

## Read these first (in order)

1. `fresh_start/00-V1-PRD.md` — V1 product spec. Source of truth for scope, requirements, success metrics.
2. `fresh_start/06-verifier-design.md` — verifier API contract, color decision tree, normalization tiers.
3. `MEMORY.md` (and the linked files) at `C:\Users\mosta\AppData\Roaming\Claude\local-agent-mode-sessions\a0f5965b-f592-4a60-9dbb-8369f862eef4\dc5af955-976a-4c73-b799-c57c106f4e9f\spaces\ae962498-c489-45a0-a99d-18a57d0f9be7\memory\` — durable user/project context. Particularly: `mission.md`, `color_semantics.md`, `v1_scope.md`, `porting_discipline.md`, `advanced_copy_reference.md`.
4. `js/background.js` and `js/content.js` — the current V1 implementation.

The supporting docs in `fresh_start/01-05*.md` are the original rebuild plan. They're useful background but `00-V1-PRD.md` supersedes them where they disagree.

---

## What's been done

- Milestone A: V1 background.js verifier (~580 lines) with full five-color output including the orange pipeline. Tier-1 normalization handles Uthmani-vs-modern spelling drift (alif/hamza/ya/ta-marbuta + adjacent same-letter collapse + Uthmani decomposed `ءا → ا`).
- Milestone A: V1 content.js (~640 lines) with four extraction strategies (lead-in-braced, range-construct, explicit-ref-backward, short-fragment-with-ref), five-color highlight application, findings payload emission.
- Five-color CSS (`css/content.css`) and popup updated for five-color stats display.
- Comprehensive debug logging in background.js (`DEBUG = true` at top, `dlog()` everywhere). Each verify call prints a structured trace; each finding gets a copyable block on `logFindings`.

## What's pending

| # | Task | Notes |
|---|---|---|
| 6 | Port 11 fixtures with intended-output JSON | Hand-curation work. See "Fixture porting" below. |
| 7 | Run fixture suite; iterate to all-pass | Debug-driven. Expect 1-2 normalization fixes from real fixtures. |
| - | Milestone B: orange precision/recall tuning | After 6/7 pass. Build 20-case scoring set, tune thresholds. |
| - | Milestone C: authentic-text swap engine | **Escalate to Opus for design.** Real layout/architecture decisions. |
| - | Milestone D: findings panel + edit-in-place | **Escalate to Opus for design.** Two surfaces, edit-in-place is tricky. |
| - | Milestone E: test infra polish, release prep | Mostly execution; you can take this. |

---

## Fixture porting (Task 6) — concrete instructions

The mature reference implementation is at `C:\Users\mosta\PycharmProjects\QuranChromePlugin` (MV2, ~1300/1883-line background/content scripts). **You may READ it for reference but NEVER edit it.** See `porting_discipline.md` memory.

For Task 6:

1. Copy fixture HTML files only from `QuranChromePlugin/tests/fixtures/*.html` to `QuranAuditPlugin/tests/fixtures/`. Fixtures to port: `120981, 174389, 202459, 228475, 228994, 238996, 239356, 241627, 246487, 246814, 41337` (11 total).
2. **Do NOT copy `.expected.json` files verbatim** — those are frozen outputs from the MV2 advanced copy, not intended-correct output. You need to rewrite each one.
3. To rewrite an expected.json: read the fixture HTML, identify the citations and their correct refs (use the QuranChromePlugin's expected.json as a *hint* about which citations exist, but verify each against Quran data). Then construct the expected stats and matches in the V1 five-color format.
4. **Curate at least 5 orange fixtures.** These need to be cases where the page-stated ref disagrees with what the global search finds. Two sources: (a) find real Islamweb articles with miscitations; (b) construct synthetic fixtures by editing existing fixture HTML to introduce a wrong ref. Note your sources in a comment at the top of each expected.json.
5. The V1 expected.json shape should look roughly like:

```json
{
  "fixture": "174389.html",
  "expectedStats": {
    "greenMatches": <n>,
    "lightBlueMatches": <n>,
    "yellowMatches": <n>,
    "orangeMatches": <n>,
    "redMatches": <n>,
    "totalFindings": <sum>
  },
  "expectedFindings": [
    {
      "text": "<candidate text>",
      "color": "green",
      "matchedRef": "البقرة:106",
      "claimedRef": "(البقرة:106)",
      "deviation": "spellingDrift"
    },
    ...
  ]
}
```

You will likely need to update `tests/run_tests.py` to compare the new shape. The current runner expects the older `yellowMatches/redMatches/refsSeen/...` shape — that's the MV2 stats vocabulary. Update it.

---

## Iteration (Task 7)

After fixtures are in place:

```bash
python tests/run_tests.py --all --timeout 120
```

Expect ~1-3 fixtures to fail on first run. Common failure modes:

- **Uthmani decomposition I haven't handled yet.** Look at `dlog()` output for `tier1` of candidate vs `tier1` of claimed ayah. If they differ by a single character, that's almost certainly a missing normalization rule (similar to the `ءا → ا` fix that just shipped). Add it to `tier1Normalize()` in background.js with a comment explaining the Uthmani-vs-modern convention being unified.
- **Candidate extraction grabbing wrong span.** The four strategies in `content.js` have priority order: lead-in-braced (s1) → range-construct (s3) → explicit-ref-backward (s2) → short-fragment-with-ref (s4). If a fixture produces wrong text, find which strategy fired (`strategy` field in finding) and check that strategy's boundary detection.
- **Word-level threshold too tight/loose.** Currently `Math.max(1, Math.floor(candidate.length / 8))` in `wordLevelCompareSingleAyah`. If yellow firing where green should, threshold may be too generous. If green missing where it should fire — that's a normalization issue, not a threshold issue.

**Do NOT add fixture-specific carve-outs.** If a fixture requires a special case to pass, the fix is wrong. Document the case as a Milestone A risk and find the principled normalization or extraction rule instead.

---

## Pitfalls to avoid

1. **Don't port `QuranChromePlugin` code verbatim.** It has accumulated patches (e.g., the `يبنم` carve-out for Surah Taha at line 737 of its content.js, mojibake bracket characters at lines 1387/1433/1438, 20-pass `scanUntilStable` retry loop). Harvest principles, not lines.
2. **Don't confuse green with yellow.** Tashkeel difference, ا vs آ, ى vs ي, ة vs ه, Uthmani decomposed `ءا` vs modern `آ`, adjacent same-letter collapse (`بالليل` vs `بِٱلَّيْلِ`) — ALL of these are green, not yellow. Yellow is for *word-level* deviation (a word missing, added, or substituted).
3. **Don't ship a verifier that produces wrong greens.** A single wrong-green destroys trust in all greens. Better to drop a candidate than mislabel it.
4. **Don't make orange optional.** It's a required V1 finding (the reference-mismatch case a reader can't catch unaided), even though it's the least severe problem case (severity runs red > yellow > orange). If a fix removes orange firing, that's a regression.
5. **Don't add features outside the V1 scope.** Image render, typing autocomplete, English citations, autoInteractive scan — all explicitly out of V1 per the PRD. If you find yourself adding one, stop and check the PRD.

---

## Where to find things

- **Service worker console** (where `dlog()` output goes): `chrome://extensions` → "Quran Citation Verifier" → click **"service worker"** link.
- **Content script console**: regular page DevTools console (F12) on whichever page you're scanning.
- **Test bridge**: `__quranBridgeScan` / `__quranBridgeDone` custom events, used by `tests/run_tests.py`.
- **Debug helpers in browser console**: `window.__quranStats()`, `window.__quranFindings()`, `window.__quranScan()`, `window.__quranClear()`.

---

## When to escalate back to Opus

Hand back if you hit any of these:

- A normalization or extraction question that requires a *product judgment* (e.g., "should orange fire for partial-text matches at a different ref?"). The PRD has the framework; if you can't answer from it, ask.
- A failing fixture that doesn't fit any of the principled patterns — meaning the right fix would be a carve-out. **Don't add the carve-out. Escalate.**
- You're starting **Milestone C** (authentic-text swap engine). Architecture: where the swap engine slots in, how layout stability is preserved, font fallback, swap-on-hover vs always, undo semantics. Worth a focused Opus session.
- You're starting **Milestone D** (findings panel + edit-in-place). Two surfaces (popup-attached + page-injected), data flow, edit-in-place DOM mutation strategy for non-contenteditable articles, reversibility/undo. Worth a focused Opus session.
- You're starting **Milestone B** scoring set design — methodology question (what counts as a false orange, how to grade ambiguous cases). One Opus session, then iterate in Sonnet.

For everything else — regex fixes, fixture curation, threshold tuning, bug-fix-from-clear-log — just do it.

---

## Task list state

Use `TaskList` / `TaskGet` / `TaskUpdate` to see / progress current tasks. Tasks 1-5 and 8 are completed. Tasks 6 and 7 are pending and ready to start.

---

## Communication norms (from Mostafa)

- Mostafa values terse, opinionated responses over hedging.
- When proposing changes, take a position and explain *why*, not just *what*.
- Don't summarize what you just did at the end of every response — Mostafa reads diffs.
- Save anything *durable* about user preferences or project structure to memory (see "auto memory" section in your system context). Don't save ephemeral debugging detail.
- When unsure between two paths, ask — but propose a recommendation rather than presenting menus.

Good luck.
