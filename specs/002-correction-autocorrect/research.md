# Research — Correction & Autocorrect (V1.2)

**Feature**: 002-correction-autocorrect
**Date**: 2026-05-29
**Status**: Phase 0 of `/speckit-plan`. No NEEDS CLARIFICATION items remain — the spec's 2026-05-24 clarification session resolved every functional ambiguity.

## 1. What feature 001 already provides

The orange correct-in-place pipeline (FR-012, FR-022, FR-024 in feature 001) is the substrate this feature generalizes. The relevant inventory:

**Decision**: Reuse `VerificationResult` and the existing `correctInPlace` action as the substrate. Add the minimum new fields/edit kinds the spec requires.

**Rationale**: A `VerificationResult` emitted by `js/background.js` already carries `matchedRef`, `matchedRefs[]`, `authenticText`, `authenticExcerpt`, `deviation`, and `matchType`. So:

- **lightBlue** (FR-007 → FR-010) — the verifier already knows the resolved reference(s). The feature only needs UI to surface them in the tooltip + panel row, plus the context-disambiguation adjacency check (FR-009).
- **yellow** (FR-011 → FR-014) — the verifier already knows the matched ayah and a diff *count* via `wordLevelCompareSingleAyah`. The one net-new verifier output is the **aligned** diff (which words missing / extra / substituted), surfaced as `Finding.alignedDiff: DiffSegment[]`.
- **red** (FR-015 → FR-017) — the rebuild already has the fuzzy helpers (`wordLevelMatchGlobal`, soft-subsequence) used inside classify. The feature adds a focused **near-match probe** that runs during scan and emits `Finding.nearMatchSuggestion` when a candidate within threshold exists.
- **autocorrect generalization** (FR-018 → FR-020) — the existing `prefs.v1.autoCorrectOrange: boolean` is migrated to `prefs.v1.autoCorrect: { orange, lightBlue }` (lightBlue default ON, orange carried forward). Yellow + red have no preference; they are manual by rule.
- **persistence + revert** (FR-006, FR-021) — feature 001's `persisted.v1.byUrl.<urlKey>[]` already supports per-URL correction entries with 30-day TTL. The feature adds a `kind` discriminator so Revert can clear precisely the right entry.

**Alternatives considered**:
- A separate "corrections" subsystem with its own storage area. Rejected: doubles the surface area for no integrity gain; the existing `persisted.v1` is shape-correct, only needing one new field.
- Computing the aligned diff in the panel renderer instead of the verifier. Rejected: SC-002 measures verifier accuracy and SC-007 measures layout safety of the inline overlay — both want the diff to be a stable verifier output cached on the Finding, not a render-time computation that varies by surface.

## 2. Relationship to `specs/001-arabic-citation-auditor/v1.2-correction-design.md` (T201)

That document is a **design predecessor** drafted on 2026-05-24 and ratified the same day (commit `6a31133`). It captures the engineer's first-pass shape. The spec's clarification session (also 2026-05-24, committed `e208cee`) **diverged** from the design in three places:

**Decision**: The spec is authoritative on all three divergences. The design doc is retained only for historical context.

**Rationale**:

| Topic | Design predecessor (T201) | Spec (this feature) | Authoritative resolution |
|---|---|---|---|
| lightBlue correction | "Insert a ref marker into the page body" (`ref-insert` edit kind) | FR-007: surface in **tooltip and panel row only**, never insert into page body | Spec wins. lightBlue correction is `reference-attribution` (recolor + tooltip), not `ref-insert`. |
| yellow diff visibility | "Surface in the panel row; optionally inline via tooltip" | FR-012: **always inline** as a visual overlay on every yellow finding, automatically | Spec wins. Inline overlay is always-on; not a per-finding opt-in. |
| Autocorrect scope | "yellow + red are always manual; lightBlue context-autocorrect; orange autocorrect retains prior default" | FR-018: same manual rule for yellow/red, **lightBlue autocorrect defaults ON** on fresh install (orange retains prior default) | Spec wins. lightBlue default is ON because it never edits page text. |

**Alternatives considered**: None — the spec's clarifications are explicit owner ratification post-design, not aspirational. The design doc's Recommended Phasing (P1 yellow diff → P2 lightBlue → P3 yellow/red text-replace) is still useful as a sequencing hint and is broadly mirrored in the spec's user-story priorities (P1 yellow → P2 lightBlue → P3 red), with the note that yellow's inline diff and yellow's text-replace are spec'd as one user story (US1) rather than split across phases.

## 3. Implementation already landed on `003-ayah-autocomplete`

A working implementation of P1–P3 landed on the `003-ayah-autocomplete` branch — NOT on this `002-correction-autocorrect` branch — across these commits:

- `9ba93fe` feat(002): P1 verifier outputs — yellow aligned diff + red near-match
- `b8c264a` feat(002): P1 panel display — yellow diff + red "did you mean" suggestion
- `89601d6` feat(002): P2 lightBlue missing-reference suggestion (suggestion-only)
- `3eacd2c` feat(002): P3 text-replace correction + generalized autocorrect
- `1b014f1` docs(002): mark T201 done (P1-P3 implemented) + design status

**Decision**: Phase 2 task generation MUST reconcile what landed against the spec (this document), not against the v1.2 design predecessor that those commits were originally written against.

**Rationale**: The commit titles match the design predecessor's recommended phasing, which means the diff between "what landed" and "what the spec requires" is the diff between the design predecessor and the spec — captured in §2 above:

- **Keepers** (consistent with spec): aligned word-level diff as a verifier output; red near-match probe; panel surfacing of "Did you mean …?"; the generalized `autoCorrect` prefs shape.
- **Needs verification against spec**: lightBlue presentation. The commit message says "suggestion-only" which is consistent with the spec's FR-007 (tooltip-only, no page-body insertion). Task generation must confirm no `ref-insert` code path landed; if any did, it must be removed.
- **Likely missing**: Revert that **clears the persisted correction entry** per FR-006 (the design predecessor did not call this out as a hard requirement; the spec's clarification session ratified it). Also: confirmation that lightBlue autocorrect defaults ON on fresh install per FR-018.
- **Branch hygiene**: this plan was generated on the `002-correction-autocorrect` branch where only the spec exists; the implementation diverged onto `003-ayah-autocomplete` because feature 003 (writer-side autocomplete) became the active branch before 002 was formally tasked. The Phase 2 task list will need to address the merge/port path explicitly (cherry-pick into 002, or formally fold 002's plan into the 003 branch's history).

**Alternatives considered**:
- Treating the landed commits as authoritative and back-writing the spec to match. Rejected: integrity (Principle I) — the spec's lightBlue tooltip-only rule and the spec's mandatory Revert-clears-persistence rule are owner ratifications that the design predecessor did not yet have. We do not weaken the spec to match earlier code.

## 4. Open questions

None at plan time. All four clarifications from the 2026-05-24 session are recorded in `spec.md` §Clarifications and are reflected in the FRs cited above.
