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
  const DEFAULT_LIMIT = 8;
  // Dropdown row budget. Read live from settings.maxCandidates so an options
  // change reaches the next query without a reload. 0 = unlimited (let the
  // background return every match across all tiers, up to its hard cap).
  function activeLimit() {
    const n = parseInt(settings.maxCandidates, 10);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_LIMIT;
    return n;  // 0 propagates as "unlimited"
  }
  // Pre-existing-on-focus render (FR-018a) is scheduled this long after focus and
  // CANCELED the moment the author starts typing — a field they immediately type
  // into is a newly-typed citation (dropdown territory), not pre-existing content.
  const FOCUS_RENDER_MS = 60;

  let settings = { enabled: true, liveRender: true, refFormat: 'arabicName', refPlacement: 'after', minWords: 2, maxCandidates: DEFAULT_LIMIT, multiAyahsWordCap: 200 };
  // The global Quran-font choice (prefs.font, NOT under prefs.autocomplete) used
  // when rendering matched text in-editor (FR-018).
  let fontKey = 'uthmaniHafs';
  let composing = false;
  let inserting = false;
  let debounceTimer = null;
  let focusRenderTimer = null;     // pending pre-existing-on-focus render (FR-018a)
  let queryToken = 0;

  // Live state for the active citation/dropdown.
  //   mode: 'candidates' | 'scope' | 'endword' | 'ayahcount'
  //   pending: the accepted candidate + frozen citation span, awaiting a scope choice.
  const STATE = { el: null, ctx: null, det: null, candidates: [], selIndex: 0, mode: 'candidates', pending: null };

  // Insertion scopes for the second menu (FR-015). Labels are localized at show
  // time so a language change between loads is reflected. multiAyahs prompts
  // for the number of ayahs at insertion time; surahEnd inserts through the
  // surah's last ayah. Both are gated by settings.multiAyahsWordCap.
  const SCOPES = [
    { key: 'whole', i18n: 'ac_scope_whole' },
    { key: 'typedPortion', i18n: 'ac_scope_typed' },
    { key: 'startToEndWord', i18n: 'ac_scope_endword' },
    { key: 'multiAyahs', i18n: 'ac_scope_multi_ayahs' },
    { key: 'surahEnd', i18n: 'ac_scope_surah_end' },
  ];
  function tt(key, params) {
    if (typeof QuranI18n === 'undefined') return key;
    const s = QuranI18n.t(key);
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
  }

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
    submitAyahCount: (raw) => submitAyahCount(raw),// US2: multi-ayah count prompt
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
      if (prefs && prefs.font) fontKey = prefs.font;
    } catch (_) {}
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PREFS_CHANGED' && msg.payload && msg.payload.prefs) {
      const prefs = msg.payload.prefs;
      if (prefs.autocomplete) settings = prefs.autocomplete;
      if (prefs.font) fontKey = prefs.font;
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
    const candidates = await QuranComposeMatch.query(det.citationText, activeLimit());
    if (token !== queryToken) return;                 // superseded by newer typing

    // Re-confirm the citation is still current before showing.
    const fresh = QuranComposeEditable.getContext(el);
    const freshDet = fresh ? QuranComposeDetect.detect(fresh.before) : null;
    if (!freshDet || freshDet.citationText !== det.citationText) return;
    STATE.ctx = fresh;
    STATE.det = freshDet;

    qc('match', `${candidates.length} candidate(s) for "${qcPreview(det.citationText)}"`);
    if (!candidates.length) {
      // No exact/wordLevel/fuzzy match. NEVER touch the field — show a non-
      // destructive "no matching ayah" note in the dropdown and record the fall-
      // through verdict (FR-008/011a). US4's render-editable.js owns any in-editor
      // verdict styling; it must likewise never delete the user's text.
      STATE.candidates = [];
      STATE.mode = 'candidates';
      STATE.pending = null;
      publishCandidates();
      hook.lastClassification = { ref: null, verdict: 'red', viaFallthrough: true };
      // FR-008/011a: a recognized-but-unmatched citation falls through to the
      // verdict classifier — mark it red. Additive markup only (never deletes the
      // user's text); a no-op in plain inputs and when liveRender is off.
      if (settings.liveRender) {
        QuranComposeRenderEditable.mark(fresh, freshDet.citeStart, fresh.caret, 'red', {});
      }
      setActive('classified');
      QuranComposeDropdown.showNote(tt('ac_no_matches'), QuranComposeEditable.caretRect(fresh));
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
  // startToEndWord opens the end-word prompt; multiAyahs/surahEnd fetch the
  // extra ayahs from the worker, then insert (or show the cap-exceeded note).
  async function chooseScope(key) {
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
    if (key === 'multiAyahs') {
      STATE.mode = 'ayahcount';
      setActive('scopeMenu');
      QuranComposeDropdown.showAyahCountInput(
        STATE.pending.rect,
        (raw) => submitAyahCount(raw),
        tt('ac_multi_ayahs_prompt'));
      return;
    }
    if (key === 'surahEnd') {
      await insertMultiAyahs('surahEnd', 0);
      return;
    }
    doInsert(key, null);
  }

  function submitAyahCount(raw) {
    if (!STATE.pending) return;
    const n = parseInt(String(raw || '').trim(), 10);
    if (!Number.isFinite(n) || n < 2) {
      // Re-prompt with a hint; don't tear down.
      STATE.mode = 'ayahcount';
      QuranComposeDropdown.showAyahCountInput(
        STATE.pending.rect,
        (r) => submitAyahCount(r),
        tt('ac_multi_ayahs_prompt'),
        tt('ac_multi_ayahs_min'));
      return;
    }
    insertMultiAyahs('multiAyahs', n);
  }

  // Fetch the (N-1) ayahs after the candidate (or to the surah's end) and
  // delegate to doInsert with them attached. The word-cap refusal is enforced
  // inside QuranComposeInsert.buildBody; the caller surfaces it as a note.
  async function insertMultiAyahs(key, n) {
    const p = STATE.pending;
    if (!p) return;
    const cand = p.cand;
    const startAyah = cand.ref.ayah;
    const toAyah = (key === 'multiAyahs') ? startAyah + (n - 1) : -1;
    let extras = [];
    let endAyah = startAyah;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'getAyahRange', surahNum: cand.ref.surah, fromAyah: startAyah, toAyah,
      });
      const texts = (resp && Array.isArray(resp.texts)) ? resp.texts : [];
      extras = texts.slice(1);
      endAyah = startAyah + Math.max(0, texts.length - 1);
      if (key === 'surahEnd' && resp && Number.isFinite(resp.surahLastAyah)) {
        endAyah = Math.min(resp.surahLastAyah, endAyah);
      }
    } catch (_) {}
    const err = doInsert(key, null, { extraAyahs: extras, endAyah, wordCap: settings.multiAyahsWordCap });
    if (err === 'capExceeded') {
      const cap = settings.multiAyahsWordCap;
      QuranComposeDropdown.showNote(tt('ac_cap_exceeded', { cap }), p.rect);
    }
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
  // ('endWordNotFound' | 'endWordMissing' | 'capExceeded') when the insert could
  // not be made; returns null on success. `extra` carries multi-ayah context
  // (extraAyahs, endAyah, wordCap) when present.
  function doInsert(scope, endWord, extra) {
    const p = STATE.pending;
    if (!p) return null;
    const built = QuranComposeInsert.buildInsertText(p.cand, scope, settings, Object.assign({
      typedText: p.typedText, endWord, openBracket: p.openBracket, closeBracket: p.closeBracket,
    }, extra || {}));
    if (built.error) return built.error;

    inserting = true;
    try {
      QuranComposeEditable.replaceRange(p.ctx, p.start, p.end, built.text);
    } finally {
      inserting = false;
    }
    const cand = p.cand;
    const verdict = QuranComposeRenderEditable.verdictForTier(cand.tier);
    // FR-018/018b: in contenteditable, render the just-inserted authentic ayah by
    // its verdict color + Quran font as PERSISTENT markup. Additive only — wraps
    // the inserted run, never re-splices the user's surrounding text. Skipped in
    // plain inputs (cannot hold markup) and when liveRender is off.
    let persistedMarkup = false;
    if (settings.liveRender && p.ctx.surface === 'contenteditable') {
      persistedMarkup = QuranComposeRenderEditable.mark(
        p.ctx, p.start, p.start + built.text.length, verdict,
        { fontFamily: QuranComposeRenderEditable.fontFamily(fontKey) });
    }
    hook.lastInsertion = {
      ref: cand.refLabel,
      scope,
      insertedText: built.text,
      reference: QuranComposeInsert.buildReference(cand, settings, extra),
      surface: p.ctx.surface,
      persistedMarkup,
    };
    hook.lastClassification = { ref: cand.refLabel, verdict, viaFallthrough: false };
    const targetEl = p.ctx.el;
    closeInstance('inserted');
    // Let host frameworks observe the programmatic edit.
    try { targetEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    return null;
  }

  // ── Fall-through classification (FR-011a) ─────────────────────────────────
  // A recognized citation the author did NOT resolve via the dropdown (caret
  // moved away / typed past with candidates still showing) is recorded with the
  // top candidate's verdict (Principle V — reuse the matcher's decision). We do
  // NOT splice the DOM here: framework editors (Lexical/Draft/ProseMirror —
  // WhatsApp, Slack, etc.) reconcile a foreign span mutation against their own
  // model and drop the surrounding text, which would erase the author's typed
  // citation on blur. Constitution non-negotiable #1 (never alter the ayah)
  // outranks the cosmetic verdict color. The no-candidate case is already
  // handled inline in process(); pre-existing-on-focus rendering (renderOnFocus)
  // still applies markup once, before the editor has decided we're foreign.
  function dismissFallthrough() {
    if (STATE.mode !== 'candidates') return;        // scope/end-word menus aren't dismissals
    const top = STATE.candidates[0];
    if (!top || !STATE.det || !STATE.ctx) return;
    const verdict = QuranComposeRenderEditable.verdictForTier(top.tier);
    hook.lastClassification = { ref: top.refLabel, verdict, viaFallthrough: true };
  }

  // ── Pre-existing-on-focus rendering (FR-018a) ─────────────────────────────
  // Render (but never rewrite) a citation already present in a contenteditable
  // when it gains focus. Plain inputs can't hold markup → skipped. Idempotent so
  // refocus doesn't double-wrap. The dropdown/insertion path is reserved for
  // newly-typed citations, so this only ever ADDS verdict/Quran-font markup.
  async function renderOnFocus(el) {
    if (!settings.enabled || !settings.liveRender) return;
    if (QuranComposeEditable.surfaceOf(el) !== 'contenteditable') return;
    if (QuranComposeRenderEditable.isMarked(el)) return;
    const det = QuranComposeDetect.detect(el.textContent || '');
    if (!det || det.wordCount < settings.minWords) return;
    const candidates = await QuranComposeMatch.query(det.citationText, activeLimit());
    if (QuranComposeRenderEditable.isMarked(el)) return;             // raced with a live render
    const ctx = { surface: 'contenteditable', el, node: el };
    const end = det.citeStart + det.citationText.length;
    if (candidates && candidates.length) {
      const top = candidates[0];
      const verdict = QuranComposeRenderEditable.verdictForTier(top.tier);
      const ok = QuranComposeRenderEditable.mark(ctx, det.citeStart, end, verdict,
        { fontFamily: QuranComposeRenderEditable.fontFamily(fontKey) });
      if (ok) hook.lastClassification = { ref: top.refLabel, verdict, viaFallthrough: true };
    } else {
      const ok = QuranComposeRenderEditable.mark(ctx, det.citeStart, end, 'red', {});
      if (ok) hook.lastClassification = { ref: null, verdict: 'red', viaFallthrough: true };
    }
  }

  // ── Event wiring ────────────────────────────────────────────────────────────
  function onInput(e) {
    if (inserting || composing) { qc('input', `ignored (inserting=${inserting} composing=${composing})`); return; }
    // The author started typing → this is a newly-typed citation, not pre-existing
    // content; cancel any pending focus render (FR-018a) so the dropdown owns it.
    clearTimeout(focusRenderTimer);
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
    // Backspace/Delete inside an editable: framework editors (Lexical/Draft/
    // ProseMirror — WhatsApp, Slack, etc.) often don't emit a synthetic `input`
    // event for deletions, so the dropdown would otherwise keep showing the
    // pre-deletion candidate list. Re-run the pipeline after the host processed
    // the key. Runs regardless of dropdown visibility so a backspace that drops
    // word-count below minWords also closes a still-showing menu.
    if ((e.key === 'Backspace' || e.key === 'Delete') && !composing && !inserting) {
      const el = e.target;
      if (QuranComposeEditable.surfaceOf(el) && !QuranComposeDropdown.contains(el)) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { process(el); }, DEBOUNCE_MS);
      }
    }
    if (!QuranComposeDropdown.isVisible()) return;
    // In end-word / ayah-count modes the prompt input owns the keyboard.
    if (STATE.mode === 'endword' || STATE.mode === 'ayahcount') return;
    // Keys we act on must be FULLY consumed: preventDefault stops the host's
    // default (newline / form submit), and stopImmediatePropagation stops the
    // host's own keydown handlers (e.g. WhatsApp "send on Enter") from ever
    // seeing the key. Enter therefore behaves exactly like a mouse click on the
    // selected row — accept/choose, and nothing reaches the page.
    // Only consume keys when there's something to act on. When the dropdown only
    // shows a "no matching ayah" note (no candidates, no scope menu), let Enter/
    // Tab/Arrows pass through to the page — the user is still just typing.
    const actionable = STATE.mode === 'scope' || STATE.candidates.length > 0;
    if (!actionable) return;
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

  // Warm up the service worker when the user focuses an editable, so the verse
  // index is already built by the time they finish the lead-in + first words —
  // otherwise the first match waits on an MV3 cold start (the "dropdown takes too
  // long" symptom). Throttled so refocus churn doesn't spam the worker.
  let lastWarm = 0;
  function onFocusIn(e) {
    const el = e.target;
    if (!QuranComposeEditable.surfaceOf(el)) return;
    // Pre-existing-on-focus render (FR-018a), canceled by onInput if the author
    // immediately starts typing into the field.
    clearTimeout(focusRenderTimer);
    focusRenderTimer = setTimeout(() => { renderOnFocus(el); }, FOCUS_RENDER_MS);
    // Warm the service worker so the index is built before the first match.
    const now = Date.now();
    if (now - lastWarm < 15000) return;
    lastWarm = now;
    try { chrome.runtime.sendMessage({ type: 'ping' }); } catch (_) {}
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
    if (STATE.mode === 'scope' || STATE.mode === 'endword' || STATE.mode === 'ayahcount') return;
    // Caret left the field with a recognized citation still unresolved → hand it
    // to the verdict classifier (FR-011a) before closing the instance.
    dismissFallthrough();
    // Caret left the field → close the instance (not the feature).
    closeInstance('idle');
  }

  function attach() {
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    document.addEventListener('focusout', onFocusOut, true);
  }

  loadSettings();
  attach();
})();
