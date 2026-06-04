'use strict';
// T044 — Panel model. In-memory store of Findings for the active scan plus
// per-Finding PanelState. Read by both panel surfaces (popup, sidebar).
// Lifetime: a single page session. Cleared when the next fresh-full scan starts.
// Section semantics follow data-model.md > Finding and FR-010 / FR-024 / FR-025.
//
// ── T004 — V1.2 correction data shapes (data-model.md) ──────────────────────
// Vanilla JS has no static types; these JSDoc typedefs are the single source of
// truth for the correction-related Finding fields introduced by feature 002.
//
// CorrectionKind discriminates how a correction was applied (and keys the
// persisted entry + the panel's Revert routing):
//   @typedef {'ref-edit'|'text-replace'|'reference-attribution'} CorrectionKind
//     - 'ref-edit'              : orange — rewrite the on-page reference (feature 001 FR-012). Edits DOM.
//     - 'text-replace'          : yellow Fix-in-place (FR-013) + accepted red near-match (FR-016). Edits DOM.
//     - 'reference-attribution' : lightBlue (FR-007/FR-008). Recolor + tooltip ref only. NO DOM text edit.
//
// DiffSegment — one word-level position in a yellow aligned diff (FR-011):
//   @typedef {{op:'keep'|'missing'|'extra'|'sub', cited?:string, authentic?:string}} DiffSegment
//     keep/sub require both cited+authentic; missing forbids cited; extra forbids authentic.
//
// NearMatchSuggestion — fuzzy probe result for a red finding (FR-015):
//   @typedef {{candidateRef:string, candidateText:string, distance:number,
//              withinThreshold:boolean, rivalCandidates?:NearMatchSuggestion[]}} NearMatchSuggestion
//
// New optional Finding fields (all absent unless the verdict/lifecycle applies):
//   finding.alignedDiff            : DiffSegment[]?            yellow, FR-011
//   finding.nearMatchSuggestion    : NearMatchSuggestion|null  red, FR-015
//   finding.resolvedLightBlueRef   : string?                   lightBlue, FR-008/FR-009
//   finding.candidateLightBlueRefs : string[]?                 lightBlue ambiguous, FR-010
//   finding.correctionKind         : CorrectionKind?           corrected successors only, FR-002
//   finding.priorFindingId         : string? (feature 001)     corrected successors only, FR-002
//
// Landed-name aliases (research.md §2 reconciliation, T002): the partial impl on
// 003-ayah-autocomplete named these `finding.diff` and `finding.nearMatch`.
// Those landed names are CANONICAL on the wire; the data-model.md names
// `alignedDiff`/`nearMatchSuggestion` are accepted as aliases. Readers below and
// in the surfaces tolerate either, so no call-site rename is forced.
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
      // 'reference-attribution' is a reading aid, not a correction (lightBlue
      // stays lightBlue); persisted entries of that kind get the ref re-stamped
      // in content.js but must NOT carry the "Previously corrected" badge.
      if (rawKind === 'reference-attribution') continue;
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
      // FR-024/025: a live finding that the user dismissed in a prior session
      // belongs in the "Previously dismissed" section, NOT in the active
      // results — the prior verdict still stands. Mark its id so activeView
      // can exclude it and previouslyDismissed() will pick it up.
      if (isDismissal) previouslyDismissedKeys.add(finding.id);
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

  // ── T201 P2 — lightBlue reference suggestion (suggestion-only, no page edit) ──
  // lightBlue = authentic text, no reference on the page. We SUGGEST the missing
  // reference in the panel (the user can copy it); we never inject it into the
  // host page (ratified Q-A). Disambiguation when the text occurs at several refs
  // (design §1): adopt an adjacent green/lightGreen/orange-corrected finding's
  // surah when it's among the candidates (the author cited the ayah once then
  // discussed its parts), else use the unique ref, else mark ambiguous (manual).
  function surahOfRef(ref) {
    if (!ref || typeof ref !== 'string') return null;
    const i = ref.lastIndexOf(':');
    return i < 0 ? ref.trim() : ref.slice(0, i).trim();
  }
  function suggestRefForLightBlue(id) {
    const f = findings.get(id);
    if (!f || f.color !== 'lightBlue') return null;
    const candidates = (Array.isArray(f.matchedRefs) && f.matchedRefs.length)
      ? f.matchedRefs.slice() : (f.matchedRef ? [f.matchedRef] : []);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return { ref: candidates[0], candidates, ambiguous: false, viaContext: false };

    // Multiple candidate refs → try context from the immediate neighbors.
    const candSurahs = new Set(candidates.map(surahOfRef));
    const idx = order.indexOf(id);
    const neighborRef = (j) => {
      const nf = j >= 0 && j < order.length ? findings.get(order[j]) : null;
      if (!nf) return null;
      const resolved = nf.color === 'green' || nf.color === 'lightGreen' || nf.panelState?.persistedBadge?.kind === 'corrected';
      if (!resolved) return null;
      return nf.matchedRef || nf.claimedRef || null;
    };
    for (const j of [idx - 1, idx + 1]) {
      const nref = neighborRef(j);
      const ns = surahOfRef(nref);
      if (ns && candSurahs.has(ns)) {
        const picked = candidates.find(c => surahOfRef(c) === ns);
        if (picked) return { ref: picked, candidates, ambiguous: false, viaContext: true };
      }
    }
    return { ref: null, candidates, ambiguous: true, viaContext: false };
  }

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
      !f.panelState.dismissedThisSession &&
      !previouslyDismissedKeys.has(f.id)
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
    get, all, size, suggestRefForLightBlue,
    activeView, recentlyCorrected, dismissedThisSession, previouslyDismissed,
  };
})();

// CommonJS export so the Node correction-model test can require it (mirrors
// js/storage/prefs.js + js/shared/i18n.js). Harmless in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = QuranPanelModel;
