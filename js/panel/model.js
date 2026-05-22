'use strict';
// T044 — Panel model. In-memory store of Findings for the active scan plus
// per-Finding PanelState. Read by both panel surfaces (popup, sidebar).
// Lifetime: a single page session. Cleared when the next fresh-full scan starts.
// Section semantics follow data-model.md > Finding and FR-010 / FR-024 / FR-025.
const QuranPanelModel = (() => {
  const findings = new Map(); // id → Finding (merged with .panelState)
  // Insertion-order list of Finding ids — preserves the order in which the
  // scan emitted them, which is the order the panel renders rows in.
  const order = [];
  // urlKey → Set<compositeKey> for the "Previously dismissed" section. Populated
  // by tagPersisted() on SCAN_COMPLETE. Empty until then.
  const previouslyDismissedKeys = new Set();

  function defaultPanelState() {
    return {
      focused: false,
      scrollAnchor: null,
      inFlightAction: null,
      recentlyCorrected: false,
      dismissedThisSession: false,
      persistedBadge: null, // { kind: 'corrected' | 'dismissed', when: 'YYYY-MM-DD' }
    };
  }

  // Clears the entire model. Call on fresh-full SCAN_START.
  function reset() {
    findings.clear();
    order.length = 0;
    previouslyDismissedKeys.clear();
  }

  // Upsert a Finding from a SCAN_PROGRESS event. Preserves an existing
  // panelState if the composite id is unchanged (FR-021 invariant).
  function upsert(finding) {
    if (!finding || !finding.id) return;
    const existing = findings.get(finding.id);
    const panelState = existing?.panelState ?? defaultPanelState();
    findings.set(finding.id, { ...finding, panelState });
    if (!existing) order.push(finding.id);
  }

  // Tag the model with persistedBadge entries from `chrome.storage.local`.
  // `entries` is an array shaped like persisted.v1 records.
  function tagPersisted(entries) {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      // Stored entries use {kind: 'correction'|'dismissal', at: ISO8601} per
      // contracts/messaging.md (PERSIST_WRITE) + storage/persisted.js. Map to
      // the badge vocabulary the surfaces render ('corrected'/'dismissed') and
      // derive the YYYY-MM-DD shown in the badge from the ISO timestamp.
      const rawKind = e.kind || e.action || '';
      const isDismissal = rawKind === 'dismissal' || rawKind === 'dismiss';
      const badgeKind = isDismissal ? 'dismissed' : 'corrected';
      const when = (e.at || e.when || '').slice(0, 10);

      // Match the live finding by its id, or — when a correction was
      // auto-re-applied this load — by a successor whose priorFindingId points
      // back at the original (corrected) id.
      let finding = findings.get(e.compositeKey);
      if (!finding) {
        for (const f of findings.values()) {
          if (f.priorFindingId === e.compositeKey) { finding = f; break; }
        }
      }
      if (!finding) {
        // Carry forward dismissed-on-a-prior-visit entries so the
        // "Previously dismissed" section can render even without a live match.
        if (isDismissal) previouslyDismissedKeys.add(e.compositeKey);
        continue;
      }
      finding.panelState.persistedBadge = { kind: badgeKind, when };
    }
  }

  // FR-025: panel-level dismiss for the current session.
  function markDismissedThisSession(id) {
    const f = findings.get(id);
    if (f) f.panelState.dismissedThisSession = true;
  }

  // FR-025 restore: un-hide a dismissed finding and forget any prior-session
  // dismissal so it returns to the active filter view.
  function unmarkDismissed(id) {
    const f = findings.get(id);
    if (f) {
      f.panelState.dismissedThisSession = false;
      if (f.panelState.persistedBadge?.kind === 'dismissed') f.panelState.persistedBadge = null;
    }
    previouslyDismissedKeys.delete(id);
  }

  // FR-022: panel-level "recently corrected" pin.
  function markRecentlyCorrected(id) {
    const f = findings.get(id);
    if (f) f.panelState.recentlyCorrected = true;
  }

  function setInFlightAction(id, action) {
    const f = findings.get(id);
    if (f) f.panelState.inFlightAction = action;
  }

  // Remove a Finding entirely (used when a correct-in-place successor replaces
  // its prior, per FR-021 — the prior must not linger in any section).
  function remove(id) {
    if (findings.delete(id)) {
      const i = order.indexOf(id);
      if (i !== -1) order.splice(i, 1);
    }
  }

  // FR-021 + FR-022: ingest a SCAN_PROGRESS finding. When priorFindingId is set
  // (a correct-in-place successor), discard the prior Finding from every view
  // and pin the successor to the "Recently corrected" section.
  function ingestProgress(finding, priorFindingId) {
    if (priorFindingId && priorFindingId !== finding?.id) remove(priorFindingId);
    upsert(finding);
    if (priorFindingId) markRecentlyCorrected(finding.id);
  }

  function get(id) { return findings.get(id) ?? null; }
  function all() { return order.map(id => findings.get(id)).filter(Boolean); }
  function size() { return findings.size; }

  // ── Section selectors ────────────────────────────────────────────────────
  // The panel renders four sections (see data-model.md > Finding):
  //   1. Active filter view  — Findings whose color passes `filter` and which
  //      have NOT been recentlyCorrected or dismissedThisSession.
  //   2. Recently corrected  — set by FR-022; empty until US4 wires the writer.
  //   3. Dismissed (this session) — set by FR-025.
  //   4. Previously dismissed — composite keys persisted from earlier sessions.

  function activeView(filter) {
    return all().filter(f =>
      filter?.[f.color] === true &&
      !f.panelState.recentlyCorrected &&
      !f.panelState.dismissedThisSession
    );
  }
  function recentlyCorrected() { return all().filter(f => f.panelState.recentlyCorrected); }
  function dismissedThisSession() { return all().filter(f => f.panelState.dismissedThisSession); }
  function previouslyDismissed() {
    // Live findings whose composite key was dismissed in a prior session AND
    // that haven't already moved into another section this session.
    return all().filter(f =>
      previouslyDismissedKeys.has(f.id) &&
      !f.panelState.dismissedThisSession &&
      !f.panelState.recentlyCorrected
    );
  }

  return {
    reset, upsert, ingestProgress, remove, tagPersisted,
    markDismissedThisSession, unmarkDismissed, markRecentlyCorrected, setInFlightAction,
    get, all, size,
    activeView, recentlyCorrected, dismissedThisSession, previouslyDismissed,
  };
})();
