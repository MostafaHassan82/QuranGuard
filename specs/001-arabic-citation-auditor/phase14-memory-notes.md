# Phase 14 — memory hygiene notes (T145, T148)

Companion to `tasks.md` Phase 14. Records the audit conclusions for the two
"measure-before-optimize" tasks alongside the code changes shipped for
T141–T144 and T146–T147.

## T145 — Per-tab retained state, as of Phase 14 close

The four heavy per-tab retained objects in the content script:

| Item                          | Source                                | Bounded? |
| ----------------------------- | ------------------------------------- | -------- |
| `STATE.findings`              | scan → push per finding               | **Yes, post-T147** — subtree rescans now GC findings whose span left the DOM (`scanPage` tail). Full scans still clear-and-rebuild. |
| `STATE.highlightedSpans`      | scan → push per wrapped span          | **Yes, post-T147** — same GC pass drops disconnected spans (`!s.isConnected`). |
| `STATE.mutationObserver`      | `setupMutationObserver()`             | **Yes, post-T146** — disconnected on `visibilitychange → hidden`; re-armed on `visible`. |
| keep-warm `chrome.runtime` port | `keepWorkerWarm` IIFE              | **Yes** (pre-existing) — `disconnect()` on hidden, single-flight `connect()` on visible. Audited under T148 below. |

Field report #5 (memory growth with many highlighted tabs) is addressed
without taking a numeric baseline first. Reason: the three biggest growth
vectors all turned out to be tractable from code reading
(unbounded-append in subtree rescans, observer pinned on hidden tabs,
detached spans pinned via the spans array). Measuring before fixing those
would have produced a baseline against code that's already changing. A
numeric profile is queued only if a future report shows growth that the
above guards don't account for.

Heuristic ceiling under the new code, for an SPA running for hours and
churning ~50 ayahs in/out of the DOM per minute:

- `STATE.findings.length` and `STATE.highlightedSpans.length` track the
  count of ayahs **currently in the page**, not lifetime count.
- Detached spans become GC-eligible the moment the page drops them, since
  T147 removes the last extension-side reference.
- One MutationObserver per visible tab; zero on hidden tabs (T146).

## T148 — Keep-warm port lifecycle audit

Code reviewed: the `keepWorkerWarm` IIFE in `js/content.js` and the
`handleRouteChange` path.

**Findings:**

1. **No double-connect.** `connect()` is guarded by `if (port || ...) return`
   — re-entering while a port is alive is a no-op.
2. **Reconnect path doesn't leak.** `onDisconnect` nulls `port` *before*
   scheduling the 1 s retry; the retry re-enters `connect()` which is now
   guard-clean. A storm of disconnects produces at most one in-flight retry
   at a time.
3. **Hidden-tab discipline.** `visibilitychange → hidden` calls
   `disconnect()` which nulls the port. Hidden tabs hold no port.
4. **SPA route changes don't touch the port.** `handleRouteChange` resets
   page-level state (findings, spans, sidebar) but leaves the worker port
   intact across `pushState`/`replaceState` swaps — correct, since the
   worker is shared per-process and the next scan on the new route benefits
   from a warm worker. No port-per-route accumulation.
5. **Single listener.** The `visibilitychange` listener is attached inside
   the IIFE that runs once per content-script injection. Standard MV3
   injection model — one listener per page load.

**Conclusion:** no leak. The port lifecycle is tight; the only failure
mode (a connect race against a still-disconnecting port) is prevented by
the null-then-schedule order in `onDisconnect`. No code change needed for
T148.
