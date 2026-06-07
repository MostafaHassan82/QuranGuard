'use strict';
/*
 * Writer-side autocomplete — insertion builder (feature 003, T013 + T017/T018).
 *
 * Builds the text that replaces the user's typed citation: the AUTHENTIC ayah
 * wording (never the user's drifted text — FR-017) plus a reference formatted
 * per prefs (FR-014).
 *
 * Insertion scope (FR-015) is honored here:
 *   - 'whole'          → the complete authentic verse.
 *   - 'typedPortion'   → only the authentic words the typed fragment aligns to.
 *   - 'startToEndWord' → from the typed start through the authentic word matching
 *                        a user-supplied end word; if that end word is absent from
 *                        the verse after the start, NO truncated insert is made —
 *                        the caller is told instead (FR-016).
 *
 * Alignment is done by Tier-1-normalizing both the typed fragment and the verse
 * words (reusing js/verifier/normalize.js) and locating the contiguous run of
 * verse words the typed words map onto. The ORIGINAL (vocalized) verse words are
 * what gets inserted — normalization is only the comparison key, so the inserted
 * text is always authentic mushaf wording, never the user's typing.
 *
 * Exposed as the QuranComposeInsert global.
 */
const QuranComposeInsert = (() => {

  function norm(s) {
    return (typeof QuranNormalize !== 'undefined') ? QuranNormalize.tier1(String(s || '')) : String(s || '').trim();
  }
  // Invisible bidi / formatting marks the user can pick up via keyboard layouts
  // or RTL inputs (LRM/RLM, ZWJ/ZWNJ, ALM, BOM, LRE/RLE/PDF/LRO/RLO/LRI/RLI/PDI/FSI).
  // tier1Normalize doesn't strip these (it only handles tashkeel + base-letter
  // drift), so the user's "كلمة كلمتان" can carry a U+200F between words and
  // appear as a single token to a plain split(' ').
  const INVISIBLE_RE = /[؜​-‏‪-‮⁦-⁩﻿]/g;
  function normWords(s) {
    const stripped = String(s || '').replace(INVISIBLE_RE, '');
    const n = norm(stripped);
    return n ? n.split(/\s+/).filter(Boolean) : [];
  }

  // Drift-tolerant word equality — a faithful copy of the verifier's
  // softEqualWord (js/background.js). Tolerates up to two alef/waw/ya/hamza
  // insertions/deletions (or one such substitution at equal length), so the
  // Uthmani spelling (e.g. تُتْلَىٰ → "تليا") still equals the user's plainer
  // typing (تتلى → "تلي"). Alignment MUST use the same tolerance the matcher
  // used to offer the candidate (Principle V), or a soft-tier match aligns short.
  function softEqualWord(a, b) {
    if (a === b) return true;
    const diff = Math.abs(a.length - b.length);
    if (diff > 2) return false;
    const isDrift = c => c === 'ا' || c === 'و' || c === 'ي' || c === 'ء';
    if (diff === 0) {
      let mismatchPos = -1;
      for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        if (mismatchPos !== -1) return false;
        if (!isDrift(a[i]) || !isDrift(b[i])) return false;
        mismatchPos = i;
      }
      return mismatchPos !== -1;
    }
    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
    if (diff === 1) {
      for (let i = 0; i < longer.length; i++) {
        if (!isDrift(longer[i])) continue;
        if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return true;
      }
      return false;
    }
    for (let i = 0; i < longer.length; i++) {
      if (!isDrift(longer[i])) continue;
      const after1 = longer.slice(0, i) + longer.slice(i + 1);
      for (let j = 0; j < after1.length; j++) {
        if (!isDrift(after1[j])) continue;
        if (after1.slice(0, j) + after1.slice(j + 1) === shorter) return true;
      }
    }
    return false;
  }

  // When opts.endAyah is set and differs from candidate.ref.ayah, format the
  // reference as a range ("البقرة:255-257"). Used by the multi-ayah / surah-end
  // insertion scopes.
  function buildReference(candidate, settings, opts) {
    const start = candidate.ref.ayah;
    const end = (opts && Number.isFinite(opts.endAyah) && opts.endAyah > start) ? opts.endAyah : start;
    const ayahPart = (end === start) ? String(start) : `${start}-${end}`;
    const inner = (settings && settings.refFormat === 'number')
      ? `${candidate.ref.surah}:${ayahPart}`
      : `${candidate.surahName}:${ayahPart}`;
    return `(${inner})`;
  }

  // Find the contiguous run of verse words (by index) that the typed fragment
  // aligns to. Returns { start, end } inclusive into `verseWords`, or null when
  // no leading word matches. Greedy: anchors on the first typed word, then walks
  // forward word-for-word while the normalized forms agree.
  function alignSpan(typedText, verseNorm) {
    const typed = normWords(typedText);
    if (!typed.length || !verseNorm.length) return null;
    let best = null;
    for (let s = 0; s < verseNorm.length; s++) {
      let v = s, t = 0;
      while (t < typed.length && v < verseNorm.length && softEqualWord(verseNorm[v], typed[t])) { v++; t++; }
      if (t > 0 && (!best || t > best.matched)) {
        best = { start: s, end: v - 1, matched: t };
        if (t === typed.length) break;           // full alignment, can't do better
      }
    }
    return best;
  }

  // The user can type a single word OR a contiguous phrase (multiple words) as
  // the end marker. Returns the verse index of the LAST word in the matching
  // run, or -1 if no run is found.
  //
  // Single-word path keeps the original two-pass behavior: exact-normalized
  // match first (so a short end word like لا doesn't bind to an earlier
  // near-twin via soft equality), then a drift-tolerant fallback. Multi-word
  // phrases match contiguously: each verse position N is tried as the run
  // start, and we walk forward word-for-word using the same soft equality.
  function findEndWord(endWord, verseNorm, fromStart) {
    const tokens = normWords(endWord);
    if (!tokens.length) return -1;
    if (tokens.length === 1) {
      const target = tokens[0];
      for (let i = fromStart; i < verseNorm.length; i++) if (verseNorm[i] === target) return i;
      for (let i = fromStart; i < verseNorm.length; i++) if (softEqualWord(verseNorm[i], target)) return i;
      return -1;
    }
    // Phrase: walk every possible start, accept the first contiguous run that
    // matches all tokens (drift-tolerant per word). Stops at the first hit so a
    // later, looser run can't override an earlier exact one.
    const last = verseNorm.length - tokens.length;
    for (let s = fromStart; s <= last; s++) {
      let ok = true;
      for (let t = 0; t < tokens.length; t++) {
        if (!softEqualWord(verseNorm[s + t], tokens[t])) { ok = false; break; }
      }
      if (ok) return s + tokens.length - 1;
    }
    return -1;
  }

  // Returns { body } with the authentic wording for the chosen scope, or
  // { error } when the scope cannot be satisfied (e.g. end word not found, or
  // the body would exceed opts.wordCap for the multi-ayah / surah-end scopes).
  // opts: { typedText, endWord, extraAyahs, wordCap }
  //   extraAyahs — authentic texts for the ayahs FOLLOWING candidate (caller
  //                fetches them via the getAyahRange RPC).
  //   wordCap    — refuse with { error: 'capExceeded', wordCount } when the
  //                resulting body's word count would exceed this. Only applies
  //                to 'multiAyahs' / 'surahEnd' scopes.
  function buildBody(candidate, scope, opts) {
    opts = opts || {};
    const verse = candidate.authenticText;
    if (scope === 'whole' || (!opts.typedText && scope !== 'multiAyahs' && scope !== 'surahEnd')) {
      return { body: verse };
    }

    const verseWords = verse.split(/\s+/).filter(Boolean);
    const verseNorm = verseWords.map(norm);

    if (scope === 'multiAyahs' || scope === 'surahEnd') {
      // Span across the matched ayah + the fetched extras. The matched ayah is
      // emitted whole — alignment within it isn't meaningful when we're going
      // to cross verse boundaries anyway. Authentic-only (FR-017): we never
      // mix in the user's typed wording.
      const extras = Array.isArray(opts.extraAyahs) ? opts.extraAyahs : [];
      const parts = [verse, ...extras];
      const wordCount = parts.reduce((n, t) => n + String(t).split(/\s+/).filter(Boolean).length, 0);
      if (typeof opts.wordCap === 'number' && wordCount > opts.wordCap) {
        return { error: 'capExceeded', wordCount };
      }
      return { body: parts.join(' ') };
    }

    const span = alignSpan(opts.typedText, verseNorm);
    // No alignment → fall back to the whole authentic verse (still authentic +
    // complete; we never insert the user's drifted text — FR-017).
    if (!span) return { body: verse };

    if (scope === 'typedPortion') {
      return { body: verseWords.slice(span.start, span.end + 1).join(' ') };
    }
    if (scope === 'startToEndWord') {
      if (!opts.endWord) return { error: 'endWordMissing' };
      // Search the matched ayah first; if the ending word/phrase isn't there,
      // walk into the following ayahs (extraAyahs[0] = candidate+1, etc.) so
      // a user typing "إلى قوله: …" across a verse boundary still works.
      // When the ending lives in a later ayah, the body becomes:
      //   matched-ayah[span.start..end] + whole(extras[0..k-1]) + extras[k][0..endIdx]
      // and the reference becomes a range (candidate.ayah .. candidate.ayah+k).
      const cap = (typeof opts.wordCap === 'number') ? opts.wordCap : Infinity;
      const trailing = verseWords.slice(span.start);
      let endIdx = findEndWord(opts.endWord, verseNorm, span.start);
      if (endIdx >= 0) {
        const body = verseWords.slice(span.start, endIdx + 1).join(' ');
        const wc = body.split(/\s+/).filter(Boolean).length;
        if (wc > cap) return { error: 'capExceeded', wordCount: wc };
        return { body };
      }
      const extras = Array.isArray(opts.extraAyahs) ? opts.extraAyahs : [];
      const parts = [trailing.join(' ')];
      let runningWC = trailing.length;
      for (let i = 0; i < extras.length; i++) {
        const aw = String(extras[i]).split(/\s+/).filter(Boolean);
        const aNorm = aw.map(norm);
        const hit = findEndWord(opts.endWord, aNorm, 0);
        if (hit >= 0) {
          const tail = aw.slice(0, hit + 1).join(' ');
          parts.push(tail);
          runningWC += hit + 1;
          if (runningWC > cap) return { error: 'capExceeded', wordCount: runningWC };
          return { body: parts.join(' '), endAyah: candidate.ref.ayah + (i + 1) };
        }
        // Ending not yet found in this ayah — append the whole ayah and keep walking.
        parts.push(aw.join(' '));
        runningWC += aw.length;
        if (runningWC > cap) return { error: 'capExceeded', wordCount: runningWC };
      }
      return { error: 'endWordNotFound' };
    }
    return { body: verse };
  }

  // Fallback opener→closer map, used only if the caller didn't pass closeBracket
  // (detect.js is the source of truth and normally supplies it). Symmetric quotes
  // map to themselves; ornate ﴿ → ﴾.
  const CLOSERS = {
    '{': '}', '(': ')', '[': ']', '«': '»', '﴿': '﴾',
    '"': '"', "'": "'", '“': '”', '‘': '’',
  };

  // Returns { text } ready to insert, or { error } (e.g. 'endWordNotFound',
  // 'capExceeded'). When the citation was opened with a quote/bracket, the body
  // is wrapped in the matching pair so the opener isn't left dangling
  // (FR-014); the reference is placed OUTSIDE the brackets. For multi-ayah /
  // surah-end scopes, opts.endAyah lets buildReference emit a range.
  function buildInsertText(candidate, scope, settings, opts) {
    const r = buildBody(candidate, scope, opts);
    if (r.error) return { error: r.error, wordCount: r.wordCount };
    // buildBody can discover an endAyah dynamically (e.g. startToEndWord that
    // walks into the next ayah); it takes precedence over any value the caller
    // pre-set on opts.
    const refOpts = (r.endAyah != null) ? Object.assign({}, opts, { endAyah: r.endAyah }) : opts;
    const ref = buildReference(candidate, settings, refOpts);
    const ob = opts && opts.openBracket;
    const cb = (opts && opts.closeBracket) || (ob ? CLOSERS[ob] : null);
    const body = (ob && cb) ? `${ob}${r.body}${cb}` : r.body;
    // Track where the ayah body and reference sit inside `text` so the
    // writer-side renderer can wrap them in separate decorations (verdict
    // span over the body, .quran-ref-marker over the reference). Offsets
    // are relative to the start of `text`; callers shift by the insertion
    // point in the editable to get root-relative offsets.
    let text, ayahStart, refStart;
    if (settings && settings.refPlacement === 'before') {
      text = `${ref} ${body}`;
      refStart = 0;
      ayahStart = ref.length + 1;
    } else {
      text = `${body} ${ref}`;
      ayahStart = 0;
      refStart = body.length + 1;
    }
    return {
      text,
      ayahStart, ayahEnd: ayahStart + body.length,
      refStart,  refEnd:  refStart  + ref.length,
    };
  }

  return { buildInsertText, buildReference, buildBody };
})();
