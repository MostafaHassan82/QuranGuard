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
      const finding = findings.get(e.compositeKey);
      if (!finding) {
        // Carry forward dismissed-on-a-prior-visit entries so the
        // "Previously dismissed" section can render even without a live match.
        if (e.action === 'dismiss') previouslyDismissedKeys.add(e.compositeKey);
        continue;
      }
      finding.panelState.persistedBadge = { kind: e.action, when: e.when };
    }
  }

  // FR-025: panel-level dismiss for the current session.
  function markDismissedThisSession(id) {
    const f = findings.get(id);
    if (f) f.panelState.dismissedThisSession = true;
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
    reset, upsert, tagPersisted,
    markDismissedThisSession, markRecentlyCorrected, setInFlightAction,
    get, all, size,
    activeView, recentlyCorrected, dismissedThisSession, previouslyDismissed,
  };
})();
