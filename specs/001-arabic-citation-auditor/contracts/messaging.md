# Contract: `chrome.runtime.onMessage` envelope

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md) | **Model**: [../data-model.md](../data-model.md)

All cross-context communication (content script ↔ background service worker ↔ popup ↔ sidebar surface) uses a single typed envelope. Every `onMessage` handler MUST `return true` (per constitution Tech Constraints) so the channel stays open for the async response.

## Envelope

```js
{
  type: string,        // One of the message types below
  requestId: string,   // crypto.randomUUID(); echoed by the responder
  payload: object      // Per-type shape; see below
}
```

Responses share the same envelope with `type` suffixed `_RESPONSE` and an extra `payload.ok: boolean` plus either `payload.result` or `payload.error: {code, message}`.

## Message types

### Scan lifecycle

#### `SCAN_START`
- **Direction**: popup → background → content
- **Payload**: `{tabId, mode: "manual" | "autoscan" | "rescanAll", liftCap: boolean}`
- **Triggers**: FR-026 (Manual click or Autoscan); FR-019 ("Re-scan all"); FR-031 ("Continue scanning" sets `liftCap: true`).
- **Response**: `{ok, result: {scanId}}` — caller uses `scanId` to disambiguate streaming progress messages.

#### `SCAN_PROGRESS`
- **Direction**: content → popup + sidebar
- **Payload**: `{scanId, finding: <Finding>, runningCount: int, perCategoryCount: {green, lightBlue, lightGreen, yellow, orange, red}}` (`lightGreen` = corrected, a provenance color)
- **Triggers**: FR-023 — emitted once per verified finding, in order; consumers paint highlights and append panel rows live.

#### `SCAN_CAP_HIT`
- **Direction**: content → popup
- **Payload**: `{scanId, cap: 500, perCategoryCount}`
- **Triggers**: FR-031 — popup replaces "Scanning…" with "Stopped at 500 findings — large page detected" and offers "Continue scanning".

#### `SCAN_COMPLETE`
- **Direction**: content → popup + sidebar + background (for badge update)
- **Payload**: `{scanId, totalCount, perCategoryCount, durationMs, languageDetected: "ar" | other, finalState: "clean" | "defects" | "notArabic" | "empty"}`
- **Triggers**: end of scan; drives FR-027 (empty/clean ⇒ suppress panel) and FR-028 (badge final state) and FR-029 (non-Arabic UX).

### Incremental re-scan (FR-019)

#### `MUTATION_RESCAN`
- **Direction**: content → content (internal); not crossing contexts. Listed here as a documented intra-context event for traceability.
- **Payload**: `{mutatedSubtreeRoot: domRef, debounceWindowMs: 500}`
- **Notes**: emits `SCAN_PROGRESS` / `SCAN_COMPLETE` for the subtree only; retained Findings (FR-021) emit no progress.

### Per-finding actions

#### `CORRECT_IN_PLACE`
- **Direction**: panel (popup or sidebar) → content
- **Payload**: `{findingId}`
- **Behavior**: FR-012 + FR-022 — content mutates DOM, emits successor Finding via `SCAN_PROGRESS` with `priorFindingId === findingId`, writes a persisted correction entry via `PERSIST_WRITE`.
- **Response**: `{ok, result: {successorFindingId, fellBackToClipboard: boolean}}` (FR-012 clipboard fallback).

#### `DISMISS_FINDING`
- **Direction**: panel → content
- **Payload**: `{findingId}`
- **Behavior**: FR-025 — hides from active filter, moves to "Dismissed (this session)", writes a persisted dismissal via `PERSIST_WRITE`.

#### `RESTORE_DISMISSED`
- **Direction**: panel → content
- **Payload**: `{findingId}`
- **Behavior**: FR-025 — removes persisted dismissal for the current URL; un-hides the row.

### Persistence

#### `PERSIST_WRITE`
- **Direction**: content → background
- **Payload**: `{urlKey, compositeKey, kind: "correction" | "dismissal", at: ISO8601}`
- **Behavior**: FR-024 — appends to `persisted.v1.byUrl.<urlKey>`; prunes any entries already past 30 days during the same write.

#### `PERSIST_READ`
- **Direction**: content → background
- **Payload**: `{urlKey}`
- **Response**: `{ok, result: {entries: [<persisted entry>], prunedCount}}` — content uses entries to badge re-encountered Findings per FR-024.

#### `CLEAR_PERSISTED`
- **Direction**: popup or sidebar → background
- **Payload**: `{}`
- **Behavior**: FR-024 "Clear remembered corrections and dismissals" — wipes `persisted.v1.byUrl.*` and `persisted.v1.index`.

#### `PERSIST_REMOVE`
- **Direction**: panel (sidebar) → background
- **Payload**: `{urlKey, compositeKey, kind: "correction" | "dismissal"}`
- **Behavior**: removes a SINGLE persisted entry — used by the per-row "Restore" affordance (FR-025) to drop a dismissal/correction without clearing the whole store. Added 2026-05; complements `RESTORE_DISMISSED` (which restores the in-session row) by removing the durable entry so the badge doesn't reappear on revisit.

### Preferences

#### `PREFS_READ`
- **Direction**: any context → background
- **Response**: `{ok, result: <prefs.v1 object>}` — see [storage.md](./storage.md).

#### `PREFS_WRITE`
- **Direction**: popup → background → broadcast to content scripts
- **Payload**: `{patch: <partial prefs.v1>}`
- **Behavior**: shallow-merge into `prefs.v1`; broadcast `PREFS_CHANGED` to all live content scripts so the active page reflects the new state without reload where possible (constitution: notify content on settings change).

#### `PREFS_CHANGED`
- **Direction**: background → content scripts (broadcast)
- **Payload**: `{prefs: <full prefs.v1>}`
- **Behavior**: content script re-renders affected UI (per-color swap, font, panel filter visibility, badge tooltip text).

### Failure mode

#### `DATA_UNAVAILABLE`
- **Direction**: background → popup + content (broadcast)
- **Payload**: `{reason: "missing" | "unreadable" | "schemaFailure", detail: string}`
- **Behavior**: FR-020 — content scripts do not attach (or, if attached, refuse to scan); popup shows the explicit error state with Retry; badge cleared with FR-020 tooltip. Triggered at service worker startup if `quran-uthmani_desc-v2.json` fails to load or validate, and at any later runtime detection of corruption.

#### `RETRY_DATA_LOAD`
- **Direction**: popup → background
- **Payload**: `{}`
- **Response**: `{ok}` if data file now loads cleanly (background then sends `DATA_AVAILABLE`); `{ok: false, error}` otherwise.

#### `DATA_AVAILABLE`
- **Direction**: background → popup + content (broadcast)
- **Payload**: `{}`
- **Behavior**: clears the FR-020 error state across surfaces; content scripts attach.

## Internal (non-envelope) messages

**Implementation note (2026-05-21):** alongside the typed envelope above, two
groups of messages use a **bare `{type, ...fields}` shape** (no `requestId`/
`payload` wrapper). They are intentionally kept simple and are NOT part of the
cross-context envelope contract; they are documented here so the contract
matches the running protocol (review finding #6). Migrating them to the envelope
is tracked separately and is not required for V1.

### Verifier RPC — content → background

The hot path: content extracts a candidate and asks background to classify it.
Background's listener (`js/background.js`) handles these in a `switch` and
responds with the raw verification result (or `null`).

- `verifyFragment` — `{type, text, candidateConfidence}` → `VerificationResult | null`
- `verifyFragmentByRef` — `{type, text, ref, candidateConfidence, debug?}` → `VerificationResult | null` (with `_trace` when `debug`)
- `resolveReference` — `{type, ref}` → `{surahNum, surahName, ayahNums, ayahTexts, displayLabel} | null`
- `getAyahText` — `{type, surahNum, ayahNum}` → `{text, ref} | null`
- `ping` — `{type}` → `{ok, indexReady}` (readiness probe before scanning)
- `logFindings` — `{type, findings}` → console dump (debug aid; no response needed)

### Content control — popup/test → content

The popup (and the `window.__quran*` test bridge) drive a scan with bare
messages handled in `js/content.js`:

- `scan` — `{type, liftCap?}` → runs/streams a scan
- `clear` — `{type}` → removes all highlights
- `stats` / `getFindings` / `getState` — `{type}` → current scan snapshot

(Cross-context, enveloped actions — `CORRECT_IN_PLACE`, `JUMP_TO_FINDING`,
`PERSIST_*`, `PREFS_*`, etc. — use the typed envelope above.)

## Async discipline

Every `chrome.runtime.onMessage.addListener` registered by `js/background.js`, `js/content.js`, and any panel surface MUST:

1. `return true` at the end of its synchronous body to keep the channel open.
2. Invoke `sendResponse` exactly once per request (success path or error path).
3. Tag errors with a stable code: `DATA_UNAVAILABLE`, `INVALID_REQUEST`, `NOT_FOUND`, `INTERNAL`. Callers branch on `code`, not free-text `message`.

## Idempotency

- `SCAN_START` is idempotent per `tabId`: a second start while one is in flight cancels the in-flight scan and supersedes it (popup may rapidly click Scan).
- `PERSIST_WRITE` is idempotent per `(urlKey, compositeKey, kind)`: re-writing refreshes `at` (effectively extending the TTL).
- `CLEAR_PERSISTED` is idempotent: re-running on an empty store succeeds with `prunedCount: 0`.
