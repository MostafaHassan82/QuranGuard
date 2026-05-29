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
  //   mode: 'candidates' (US1 list) | 'scope' (US2 scope menu) | 'endword' (US2 prompt)
  //   pending: the accepted candidate + frozen citation span, awaiting a scope choice.
  const STATE = { el: null, ctx: null, det: null, candidates: [], selIndex: 0, mode: 'candidates', pending: null };

  // Insertion scopes for the second menu (FR-015). Labels are localized at show
  // time so a language change between loads is reflected.
  const SCOPES = [
    { key: 'whole', i18n: 'ac_scope_whole' },
    { key: 'typedPortion', i18n: 'ac_scope_typed' },
    { key: 'startToEndWord', i18n: 'ac_scope_endword' },
  ];
  function tt(key) { return (typeof QuranI18n !== 'undefined') ? QuranI18n.t(key) : key; }

  // ── Opt-in trace ─────────────────────────────────────────────────────────────
  // Toggle from the page console:  __quranDebug(true)  then type in the field.
  // Shares the scanner's debug bridge (debug-bridge.js → __quranDebugSet event).
  // All lines start with [QC:] so a bug report can be grepped/copied as a block.
  let QC_TRACE = false;
  document.addEventListener('__quranDebugSet', (e) => {
    QC_TRACE = !!(e && e.detail && e.detail.on);
    console.log(`[QC] compose trace ${QC_TRACE ? 'ON' : 'OFF'} — type in the field to capture`);
  });
  function qc(stage, msg) { if (QC_TRACE) console.log(`[QC:${stage}] ${msg}`); }
  function qcPreview(s, max = 80) {
    if (!s) return '∅';
    const flat = String(s).replace(/[\x00\n\r]/g, '·').replace(/\s+/g, ' ');
    return flat.length <= max ? flat : '…' + flat.slice(flat.length - max);
  }

  // ── Test/observability hook ────────────────────────────────────────────────
  const hook = {
    active: null,
    candidates: [],
    lastInsertion: null,
    lastClassification: null,
    // deterministic drivers for the gate:
    acceptSelected: () => accept(STATE.selIndex),
    moveSelection: (delta) => moveSelection(delta),
    chooseScope: (key) => chooseScope(key),       // US2: pick an insertion scope
    submitEndWord: (word) => submitEndWord(word),  // US2: start-to-end-word scope
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
    STATE.mode = 'candidates';
    STATE.pending = null;
    publishCandidates();
    setActive(state || 'idle');
  }

  async function process(el) {
    if (!settings.enabled) { qc('process', 'feature disabled (prefs.autocomplete.enabled=false)'); return; }
    const ctx = QuranComposeEditable.getContext(el);
    if (!ctx) {
      qc('process', `getContext → null (surface=${QuranComposeEditable.surfaceOf(el) || 'none'}; ` +
        `selection not a collapsed caret inside the field?)`);
      STATE.det = null; STATE.ctx = null; closeInstance('idle'); return;
    }
    qc('process', `surface=${ctx.surface} before="${qcPreview(ctx.before)}"`);
    STATE.el = el;
    STATE.ctx = ctx;
    const det = QuranComposeDetect.detect(ctx.before);
    STATE.det = det;
    qc('detect', det ? `cite="${qcPreview(det.citationText)}" words=${det.wordCount} (minWords=${settings.minWords})`
                     : 'null — no lead-in / open-brace marker found before the caret');
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

    qc('match', `${candidates.length} candidate(s) for "${qcPreview(det.citationText)}"`);
    if (!candidates.length) {
      // No exact/wordLevel/fuzzy match → recognized-but-not-Quran (FR-008): mark
      // the citation red where the surface supports styling, and record the
      // fall-through verdict (FR-011a). US4's render-editable.js owns the full
      // verdict/Quran-font rendering; this is the minimal red flag.
      markNotRecognized(freshDet);
      closeInstance('classified');
      return;
    }
    STATE.candidates = candidates;
    STATE.selIndex = 0;
    STATE.mode = 'candidates';      // fresh detection abandons any prior scope/end-word menu
    STATE.pending = null;
    publishCandidates();
    setActive('suggesting');
    QuranComposeDropdown.show(candidates, 0, QuranComposeEditable.caretRect(fresh), (idx) => accept(idx));
  }

  // Cycle the selection over whichever menu is showing (candidates or scopes).
  function menuCount() {
    return STATE.mode === 'scope' ? SCOPES.length : STATE.candidates.length;
  }
  function moveSelection(delta) {
    const n = menuCount();
    if (!n) return;
    STATE.selIndex = (STATE.selIndex + delta + n) % n;
    QuranComposeDropdown.setSelected(STATE.selIndex);
  }

  // Accept a candidate (FR-012/012a): do NOT insert yet — freeze the citation
  // span and open the second scope menu.
  function accept(index) {
    const cand = STATE.candidates[index];
    if (!cand || !STATE.el) return;
    // Recompute the citation span against the live field (it may have shifted).
    const ctx = QuranComposeEditable.getContext(STATE.el);
    const det = ctx ? QuranComposeDetect.detect(ctx.before) : null;
    if (!ctx || !det) { closeInstance('idle'); return; }

    // Freeze everything the insert needs — focus is about to move to the scope
    // menu (and possibly the end-word input), so we can't rely on a live caret.
    STATE.pending = {
      cand, ctx,
      // Replace FROM the opening bracket (if any) so it isn't left dangling; the
      // inserter re-emits a balanced pair.
      start: det.openBracket ? det.citeBraceStart : det.citeStart,
      end: ctx.caret,
      typedText: det.citationText,
      openBracket: det.openBracket || null,
      closeBracket: det.closeBracket || null,
      rect: QuranComposeEditable.caretRect(ctx),
    };
    openScopeMenu();
  }

  function openScopeMenu() {
    STATE.mode = 'scope';
    STATE.selIndex = 0;
    STATE.candidates = [];          // candidate list is replaced by the scope menu
    publishCandidates();
    const scopes = SCOPES.map(s => ({ key: s.key, label: tt(s.i18n) }));
    setActive('scopeMenu');
    QuranComposeDropdown.showScope(scopes, 0, STATE.pending.rect, (idx) => chooseScope(SCOPES[idx].key));
  }

  // The user picked an insertion scope. whole/typedPortion insert immediately;
  // startToEndWord opens the end-word prompt instead (FR-015c).
  function chooseScope(key) {
    if (!STATE.pending) return;
    if (key === 'startToEndWord') {
      STATE.mode = 'endword';
      setActive('scopeMenu');
      QuranComposeDropdown.showEndWord(
        STATE.pending.rect,
        (word) => submitEndWord(word),
        tt('ac_endword_prompt'));
      return;
    }
    doInsert(key, null);
  }

  function submitEndWord(word) {
    if (!STATE.pending) return;
    const err = doInsert('startToEndWord', word);
    if (err === 'endWordNotFound') {
      // FR-016: don't truncate — keep the prompt open with the localized message.
      STATE.mode = 'endword';
      QuranComposeDropdown.showEndWord(
        STATE.pending.rect,
        (w) => submitEndWord(w),
        tt('ac_endword_prompt'),
        tt('ac_endword_not_found'));
    }
  }

  // Perform the actual replacement for a resolved scope. Returns an error code
  // ('endWordNotFound' | 'endWordMissing') when the insert could not be made, so
  // the caller can keep the prompt open; returns null on success.
  function doInsert(scope, endWord) {
    const p = STATE.pending;
    if (!p) return null;
    const built = QuranComposeInsert.buildInsertText(p.cand, scope, settings, {
      typedText: p.typedText, endWord, openBracket: p.openBracket, closeBracket: p.closeBracket,
    });
    if (built.error) return built.error;

    inserting = true;
    try {
      QuranComposeEditable.replaceRange(p.ctx, p.start, p.end, built.text);
    } finally {
      inserting = false;
    }
    const cand = p.cand;
    hook.lastInsertion = {
      ref: cand.refLabel,
      scope,
      insertedText: built.text,
      reference: QuranComposeInsert.buildReference(cand, settings),
      surface: p.ctx.surface,
      persistedMarkup: false,        // US4 sets true for contenteditable styled markup
    };
    hook.lastClassification = { ref: cand.refLabel, verdict: cand.tier === 'exact' ? 'green' : (cand.tier === 'wordLevel' ? 'yellow' : 'red'), viaFallthrough: false };
    const targetEl = p.ctx.el;
    closeInstance('inserted');
    // Let host frameworks observe the programmatic edit.
    try { targetEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    return null;
  }

  // Flag a recognized-but-unmatched citation as not-recognized red (FR-008).
  // Records the fall-through verdict on the hook for every surface; applies a
  // minimal red span in contenteditable (plain inputs carry no markup, FR-018b).
  // Full verdict/Quran-font rendering is US4 (render-editable.js).
  function markNotRecognized(det) {
    hook.lastClassification = { ref: null, verdict: 'red', viaFallthrough: true };
    const ctx = STATE.ctx;
    if (!ctx || !det) return;
    const end = det.citeStart + det.citationText.length;
    inserting = true;
    try {
      QuranComposeEditable.markRange(ctx, det.citeStart, end, 'quran-ac-cite quran-red');
    } finally {
      inserting = false;
    }
  }

  // ── Event wiring ────────────────────────────────────────────────────────────
  function onInput(e) {
    if (inserting || composing) { qc('input', `ignored (inserting=${inserting} composing=${composing})`); return; }
    // Events from our OWN menu UI (e.g. typing/pasting into the end-word prompt,
    // which is itself an <input>) must not be treated as host-field typing — that
    // would tear down the very instance the prompt belongs to.
    if (QuranComposeDropdown.contains(e.target)) { qc('input', 'ignored (inside our menu)'); return; }
    const surface = QuranComposeEditable.surfaceOf(e.target);
    if (!surface) {
      // Only note misses for plausibly-editable targets, to avoid console spam.
      if (QC_TRACE && e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.target.tagName || ''))) {
        qc('input', `surfaceOf → null for <${(e.target.tagName || '?').toLowerCase()}> (type not free-text?)`);
      }
      return;
    }
    qc('input', `fired on <${(e.target.tagName || '?').toLowerCase()}> surface=${surface}`);
    clearTimeout(debounceTimer);
    const el = e.target;
    debounceTimer = setTimeout(() => { process(el); }, DEBOUNCE_MS);
  }

  function onKeyDown(e) {
    if (!QuranComposeDropdown.isVisible()) return;
    // In end-word mode the prompt input owns the keyboard — let it through.
    if (STATE.mode === 'endword') return;
    // Keys we act on must be FULLY consumed: preventDefault stops the host's
    // default (newline / form submit), and stopImmediatePropagation stops the
    // host's own keydown handlers (e.g. WhatsApp "send on Enter") from ever
    // seeing the key. Enter therefore behaves exactly like a mouse click on the
    // selected row — accept/choose, and nothing reaches the page.
    const consume = () => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { consume(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { consume(); moveSelection(-1); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      consume();
      if (STATE.mode === 'scope') chooseScope(SCOPES[STATE.selIndex].key);
      else accept(STATE.selIndex);
    }
    // No Esc handling by design (FR-011).
  }

  function onCompositionStart() { composing = true; }
  function onCompositionEnd(e) {
    composing = false;
    if (QuranComposeDropdown.contains(e.target)) return;   // IME inside our own end-word prompt
    if (QuranComposeEditable.surfaceOf(e.target)) process(e.target);
  }
  function onFocusOut(e) {
    // Focus moving INTO our own menu (e.g. the end-word input) is not the user
    // leaving the citation — keep the instance alive.
    if (e && e.relatedTarget && QuranComposeDropdown.contains(e.relatedTarget)) return;
    // While the scope/end-word menu is open the field has already yielded focus
    // by design; don't tear down the pending insertion.
    if (STATE.mode === 'scope' || STATE.mode === 'endword') return;
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
