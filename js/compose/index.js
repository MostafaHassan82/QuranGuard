'use strict';
/*
 * Writer-side autocomplete — orchestrator (feature 003, T007/T008/T014).
 *
 * Wires detect → match → dropdown → insert as the user types into editable
 * fields. Document-level (capture) input/keydown listeners delegate across all
 * editable surfaces; matching is debounced and gated by the minimum-word count;
 * IME composition is skipped until commit. Tab/Enter accept the selected
 * candidate; Arrow keys move selection. There is NO Esc dismissal — typing past
 * the citation or moving the caret away closes the dropdown instance (FR-011);
 * the only feature-level off switch is prefs.autocomplete.enabled (FR-019).
 *
 * Writes window.__quranCompose (contracts/window-globals.md) on every state
 * transition for the test gate; the acceptSelected/moveSelection helpers there
 * let the gate drive the UI deterministically.
 */
(() => {
  const DEBOUNCE_MS = 100;
  const LIMIT = 8;

  let settings = { enabled: true, liveRender: true, refFormat: 'arabicName', refPlacement: 'after', minWords: 2 };
  let composing = false;
  let inserting = false;
  let debounceTimer = null;
  let queryToken = 0;

  // Live state for the active citation/dropdown.
  const STATE = { el: null, ctx: null, det: null, candidates: [], selIndex: 0 };

  // ── Test/observability hook ────────────────────────────────────────────────
  const hook = {
    active: null,
    candidates: [],
    lastInsertion: null,
    lastClassification: null,
    // deterministic drivers for the gate:
    acceptSelected: () => accept(STATE.selIndex),
    moveSelection: (delta) => moveSelection(delta),
    _settings: () => settings,
  };
  window.__quranCompose = hook;

  function setActive(state) {
    hook.active = STATE.det
      ? { text: STATE.det.citationText, surface: STATE.ctx ? STATE.ctx.surface : null, wordCount: STATE.det.wordCount, isComposing: composing, state }
      : { text: '', surface: STATE.ctx ? STATE.ctx.surface : null, wordCount: 0, isComposing: composing, state };
  }

  function publishCandidates() {
    hook.candidates = STATE.candidates.map((c, i) => ({ ref: c.refLabel, tier: c.tier, rank: i }));
  }

  // ── Settings ────────────────────────────────────────────────────────────────
  async function loadSettings() {
    try {
      const resp = await QuranMsg.sendRequest('PREFS_READ', {});
      const prefs = resp && resp.payload && resp.payload.result;
      if (prefs && prefs.autocomplete) settings = prefs.autocomplete;
    } catch (_) {}
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PREFS_CHANGED' && msg.payload && msg.payload.prefs && msg.payload.prefs.autocomplete) {
      settings = msg.payload.prefs.autocomplete;
      if (!settings.enabled) closeInstance('classified');
    }
    // no response needed
  });

  // ── Core pipeline ─────────────────────────────────────────────────────────
  function closeInstance(state) {
    QuranComposeDropdown.hide();
    STATE.candidates = [];
    STATE.selIndex = 0;
    publishCandidates();
    setActive(state || 'idle');
  }

  async function process(el) {
    if (!settings.enabled) return;
    const ctx = QuranComposeEditable.getContext(el);
    if (!ctx) { STATE.det = null; STATE.ctx = null; closeInstance('idle'); return; }
    STATE.el = el;
    STATE.ctx = ctx;
    const det = QuranComposeDetect.detect(ctx.before);
    STATE.det = det;
    if (!det || det.wordCount < settings.minWords) { closeInstance('detecting'); return; }

    setActive('suggesting');
    const token = ++queryToken;
    const candidates = await QuranComposeMatch.query(det.citationText, LIMIT);
    if (token !== queryToken) return;                 // superseded by newer typing

    // Re-confirm the citation is still current before showing.
    const fresh = QuranComposeEditable.getContext(el);
    const freshDet = fresh ? QuranComposeDetect.detect(fresh.before) : null;
    if (!freshDet || freshDet.citationText !== det.citationText) return;
    STATE.ctx = fresh;
    STATE.det = freshDet;

    if (!candidates.length) {
      // Not recognized (FR-008). Full red rendering + fall-through is US3/US4;
      // for now just clear the dropdown.
      closeInstance('classified');
      hook.lastClassification = { ref: null, verdict: 'red', viaFallthrough: true };
      return;
    }
    STATE.candidates = candidates;
    STATE.selIndex = 0;
    publishCandidates();
    setActive('suggesting');
    QuranComposeDropdown.show(candidates, 0, QuranComposeEditable.caretRect(fresh), (idx) => accept(idx));
  }

  function moveSelection(delta) {
    const n = STATE.candidates.length;
    if (!n) return;
    STATE.selIndex = (STATE.selIndex + delta + n) % n;
    QuranComposeDropdown.setSelected(STATE.selIndex);
  }

  function accept(index) {
    const cand = STATE.candidates[index];
    if (!cand || !STATE.el) return;
    // Recompute the citation span against the live field (it may have shifted).
    const ctx = QuranComposeEditable.getContext(STATE.el);
    const det = ctx ? QuranComposeDetect.detect(ctx.before) : null;
    if (!ctx || !det) { closeInstance('idle'); return; }

    const scope = 'whole'; // US2 (T017) adds the scope menu
    const text = QuranComposeInsert.buildInsertText(cand, scope, settings);
    inserting = true;
    try {
      QuranComposeEditable.replaceRange(ctx, det.citeStart, ctx.caret, text);
    } finally {
      inserting = false;
    }
    hook.lastInsertion = {
      ref: cand.refLabel,
      scope,
      insertedText: text,
      reference: QuranComposeInsert.buildReference(cand, settings),
      surface: ctx.surface,
      persistedMarkup: false,        // US4 sets true for contenteditable styled markup
    };
    hook.lastClassification = { ref: cand.refLabel, verdict: cand.tier === 'exact' ? 'green' : (cand.tier === 'wordLevel' ? 'yellow' : 'red'), viaFallthrough: false };
    closeInstance('inserted');
    // Let host frameworks observe the programmatic edit.
    try { ctx.el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
  }

  // ── Event wiring ────────────────────────────────────────────────────────────
  function onInput(e) {
    if (inserting || composing) return;
    if (!QuranComposeEditable.surfaceOf(e.target)) return;
    clearTimeout(debounceTimer);
    const el = e.target;
    debounceTimer = setTimeout(() => { process(el); }, DEBOUNCE_MS);
  }

  function onKeyDown(e) {
    if (!QuranComposeDropdown.isVisible()) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(STATE.selIndex); }
    // No Esc handling by design (FR-011).
  }

  function onCompositionStart() { composing = true; }
  function onCompositionEnd(e) {
    composing = false;
    if (QuranComposeEditable.surfaceOf(e.target)) process(e.target);
  }
  function onFocusOut() {
    // Caret left the field → close the instance (not the feature).
    closeInstance('idle');
  }

  function attach() {
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    document.addEventListener('focusout', onFocusOut, true);
  }

  loadSettings();
  attach();
})();
