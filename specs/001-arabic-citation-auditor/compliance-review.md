# Constitution Compliance Review — V1 (T081)

Reviewed against `.specify/memory/constitution.md` v1.0.0. Date: 2026-05-20.

This is the post-implementation review the constitution's "Compliance review"
section requires. Each item is a code-level finding; the runtime success-criteria
(SC-001…SC-013) verification is gated on the fixture suite (see T082 status).

## (a) No carve-outs in production code — Workflow item 4 · PASS

Grepped all of `js/**/*.js` for per-page/per-fixture branches
(`if (url === …)`, `location.href ===`, literal fixture ids like `174389`,
`HACK`/`XXX`). The only match is a benign comment in `js/shared/messaging.js`
explaining the `crypto.randomUUID` secure-context fallback. No URL-keyed or
fixture-keyed conditional exists in the matching, extraction, classification, or
render paths. Verdict: **no carve-outs**.

## (b) No fixture forced a one-off branch — Principle VI · PASS

The extraction strategies (`extractLeadInBraced`, `extractSecondaryLeadInBraced`,
`extractExplicitRefBackward`, `extractRangeConstruct`, `extractShortFragmentWithRef`,
`extractBracedOnly`) are general patterns gated by structural signals (lead-in
phrases, brace style, reference proximity), not by page identity. The
verification verdicts in `verifyFragmentByRef` branch on match quality
(tier1 / ellipsis / word-level / orange / global), never on a specific verse or
page. The known reference-mismatch case (`ما ننسخ من آية` → orange at البقرة:106)
is resolved by the general orange pipeline, not a special case. Verdict: **clean**.

## (c) Advanced-copy reuse was case-harvesting only — Principle V · PASS

The rebuild's module shapes are independently designed and small/focused:
`verifier/normalize.js`, `verifier/indexes.js`, `verifier/references.js`,
`verifier/orange.js`, `verifier/classify.js`, `background.js` (verifier glue),
`content.js` (extraction + DOM), `panel/*`, `render/*`. What was harvested from
the advanced copy is **cases**, not implementation: the surah-name variant map,
the tashkeel/spelling-drift normalization rules, and the Uthmani-orthography
quirks (e.g. the `يَا`-prefix split, standalone waqf-mark tokens). No 1300-line
`background.js` / 1883-line `content.js` was ported; logic is expressed as
principled passes (normalize → index → extract → verify → classify → render).
Verdict: **disciplined**.

## (d) Five-color taxonomy intact — Principle II · PASS

`verifier/classify.js` freezes the taxonomy:
`CATEGORIES = Object.freeze(['green','lightBlue','yellow','orange','red'])`, and
`makeResult` runs every verdict through `assertCategory` (throws on anything
outside the set) and `assertGreenAllowed` (green only for none/tashkeelOnly/
spellingDrift deviations, per FR-017). The CSS/render layer uses exactly the five
classes `quran-green/lightblue/yellow/orange/red` (plus an invisible
`quran-pending` scaffold used only during convergence — not a sixth category).
No test-only color class was introduced (the harness reads the production
classes, per T085). Verdict: **not collapsed, not extended**.

## Principle IV (authentic-text replacement default) · PASS

Swap is on by default (master + per-color all default on except red), applies to
every non-red color, and red is hard-skipped (`isEligible` returns false for red,
FR-015). The user controls it via the master toggle + per-color overrides (now in
the sidebar). Reversal is lossless (original text stashed in data attributes and
restored on revert / re-scan). Verdict: **matches the constitution's default**.

## Principle I / III (integrity + severity-ordered coverage) · PASS (design-level)

The five-color verdicts all serve the "make false citations visible" test, with
severity red > yellow > orange. Orange (the reference-mismatch case a reader
can't catch unaided) has a well-developed pipeline (single-word + multi-word
elsewhere search, soft-equality to absorb Uthmani drift so wrong-ref cases aren't
masked), its own correct-in-place action, and a dedicated panel section + page
glyph — but it is not treated as the sole headline. Final quantitative
confirmation (SC-009 precision ≥95%, SC-010 recall ≥90%) is gated on the orange
fixture set (T040), which is part of the postponed test work.

## Open / gated items

- **SC-001…SC-013 quantitative verification** is gated on the Playwright fixture
  suite. The fixtures (T038–T043, T055–T057, T063–T064, T073–T076) were postponed
  pending the JS test-harness modernization (T084–T086). Until those run, this
  review attests to **structural** compliance only; the numeric bars (≥17 verified
  / 0 red on 174389, orange precision/recall, layout-safety delta) remain to be
  measured.
- No constitution amendments were required by the implementation.

## Verdict

No constitution violations found at the code level. The five-color taxonomy,
no-carve-out rule, porting discipline, and authentic-render default all hold. The
remaining work is quantitative fixture verification, not compliance remediation.

---

## Appendix A — Performance review (T077, code-level)

SC-012 (< 5 s end-to-end on a ~5,000-word page) requires a browser profile to
confirm; that run is gated on the fixture suite. Code-level observations:

- The scan is a convergence loop (`SCAN_SAFETY_MAX = 10` passes) that **stops as
  soon as the finding count is stable between passes**, so typical pages settle
  in 1–3 passes, not 10.
- Per-candidate verification is awaited sequentially
  (`await sendToBackground(...)` inside the loop). Each call is an in-process
  message to the SW; latency is dominated by the verifier, not IPC. The clearest
  future win if SC-012 is missed: **memoize verdicts by `(tier1Text|ref)`** so
  repeated candidates across passes skip re-verification. Deferred until a
  profile shows it's needed (avoid speculative change without measurement).
- Hidden-pass rendering (`quran-pending`) + a single `materializeHighlights()`
  avoids per-finding reflows during convergence.
- The FR-031 cap (500 findings) bounds worst-case work on pathological pages.

No performance regression introduced by the Phase 6/UI work. Action item: profile
on fixture 174389 once the harness runs; only then consider the memo cache.

## Appendix B — Multi-story verification (T078, code-level trace)

- **SC-005** (orange list in ≤ 2 interactions): the sidebar mounts automatically
  on a scan that finds anything (1 interaction = Scan). The orange filter chip is
  on by default, so orange findings are visible immediately — within the budget.
- **SC-006** (master toggle off/on round-trip): `QuranSwap.applySwap` stashes
  original text/font/size in data-attrs; `revertSwap` (and `clearHighlights`)
  restore them verbatim. Toggling the master pref fires `PREFS_CHANGED` →
  `QuranSwap.reconcile`, which applies/reverts per finding. Highlights persist
  across the toggle (only text/font swap). Round-trip is lossless by construction.
- **SC-007** (copy + persist prefs + correct-in-place without leaving the page):
  copy/share/JSON run in-page via the clipboard; prefs persist through
  `chrome.storage.local` (`prefs.v1`); correct-in-place mutates the DOM in place
  and persists via `PERSIST_WRITE`. None navigate away.

These traces are structural confirmation; the numeric SC bars still need the
fixture run (T082).
