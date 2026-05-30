# Messaging Contract (Δ) — Correction & Autocorrect

**Feature**: 002-correction-autocorrect
**Status**: Phase 1 of `/speckit-plan`. Delta against `specs/001-arabic-citation-auditor/contracts/messaging.md`.

All envelopes follow the feature 001 base shape:

```text
{ type: string, requestId: string, payload: object }
```

All `chrome.runtime.onMessage` handlers MUST `return true` to keep the message channel open for async responses (constitution Tech Constraints).

## Modified messages

### `CORRECT_IN_PLACE` (extended)

The existing orange correct-in-place action grows a `kind` discriminator so the same envelope handles all three correction kinds.

**Payload**:
```text
{
  compositeKey: string,                       // identifies the original Finding
  kind: 'ref-edit' | 'text-replace' | 'reference-attribution',
  resolvedRef?: string,                       // ref-edit, reference-attribution
  authenticExcerpt?: string,                  // text-replace
  originalCitedText?: string                  // text-replace — captured here so Revert can restore it
}
```

**Behavior**:
- `kind: 'ref-edit'` — existing orange behavior (FR-012 of feature 001), unchanged.
- `kind: 'text-replace'` — yellow Fix-in-place (FR-013) and accepted-red (FR-016). Replaces the cited span with the authentic excerpt, rendered with `<del>` (removed wording) and `<ins>` (inserted/corrected wording) per the diff (FR-013). Subject to the swap-engine eligibility gate (FR-014): unsafe-to-rewrite matches are refused with an explanatory response and no DOM mutation.
- `kind: 'reference-attribution'` — lightBlue (FR-007/FR-008). Recolors the finding to a lightGreen successor and surfaces `resolvedRef` in the tooltip and panel row. **MUST NOT modify the page body** (this is the spec's FR-007; the v1.2 design predecessor's `ref-insert` is rejected — see research.md §2).

**Response**:
```text
{
  ok: boolean,
  successorFindingId?: string,                // back-references the original via priorFindingId in the data model
  reason?: 'unsafe-rewrite' | 'locked-dom' | 'span-missing' | 'ambiguous' | 'unverified-payload'
}
```

`unverified-payload` is the defensive-guard rejection (tasks.md T008a): the payload's correction text/reference is not traceable to a known `VerificationResult` field (`matchedRef`, `matchedRefs[]`, `authenticText`, `authenticExcerpt`, `nearMatchSuggestion.candidateText`, `nearMatchSuggestion.candidateRef`). Hardens NON-NEGOTIABLE Principle I + FR-004.

When the target span cannot be edited (`locked-dom`, FR-005), the system falls back to copying the corrected citation to the clipboard with a user-visible explanation; the response carries `ok: true, reason: 'locked-dom'` so the panel UI can present the fallback message.

### `DISMISS_FINDING` (unchanged)

Inherited from feature 001. Not affected by this feature.

## New messages

### `REVERT_CORRECTION` (FR-006)

**Payload**:
```text
{ compositeKey: string }
```

**Behavior**:
1. Restore the reader-supplied original page content where the target span still exists. If the span is gone (SC-005 partial case), respond `ok: false, reason: 'span-missing'` and leave the persisted entry in place so the user can retry on next visit.
2. Return the finding to its pre-correction verdict.
3. **Clear the matching `persisted.v1.byUrl.<urlKey>` entry** (`compositeKey` + correction `kind`) so the revert sticks across reloads and autocorrect treats the finding as normal on the next scan (FR-006).

**Response**:
```text
{ ok: boolean, reason?: 'span-missing' | 'no-entry' }
```

### `ACCEPT_NEAR_MATCH` (FR-016)

User-facing entry point for the red "Did you mean …?" suggestion. Internally the handler converts this into a `CORRECT_IN_PLACE` with `kind: 'text-replace'`.

**Payload**:
```text
{ compositeKey: string, candidateRef: string }
```

**Response**: Same shape as `CORRECT_IN_PLACE`'s response.

## Migration notes

- Existing call sites that send `CORRECT_IN_PLACE` without a `kind` field are treated as `kind: 'ref-edit'` for backward compatibility. This is symmetric with the storage migration (legacy persisted entries without `kind` are read as `kind: 'ref-edit'`).
- No message type is renamed or removed.
- All new envelopes are sent from the panel (popup-surface and sidebar-surface) and handled in the background service worker, matching the routing established in feature 001.
