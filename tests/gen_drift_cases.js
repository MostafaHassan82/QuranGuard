'use strict';
// T041 generator — build the drift-as-green fixture from the SHIPPED Quran JSON
// so every case is machine-derived (constitution Principle I: no hand-typed
// verses/refs). Each case is a REAL verse cited at its CORRECT reference, but
// rendered in a "modern web author" spelling that drifts from the Uthmani
// orthography along exactly ONE FR-003 normalization rule. All must classify
// GREEN (the drift is forgiven), never yellow/orange.
//
// FR-003 drift classes exercised (one verse each, distinct suras):
//   tashkeelOnly       — marks stripped only; letters identical to Uthmani
//   alefVariant        — آ / ٱ / dagger-alef → ا
//   alefMaqsuraToYa    — ى → ي
//   taMarbutaToHa      — ة → ه
//   sameLetterCollapse — a doubled letter (web typo) the collapse rule forgives
//
// Each cited form is gated so that tier1(cited) === the verse's indexed key
// (→ exact match → green) and the verse's key is globally unique (→ unambiguous
// matchedRef). The doubled-letter case is a deterministic synthetic exerciser
// of the collapse rule, clearly labeled in the fixture comment.
//
// Output: tests/fixtures/synthetic/drift_cases.html + .expected.json
// Run: node tests/gen_drift_cases.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const normSrc = fs.readFileSync(path.join(ROOT, 'js', 'verifier', 'normalize.js'), 'utf8').replace(/'use strict';/, '');
const { tier1 } = new Function(normSrc + '; return QuranNormalize;')();

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'quran-uthmani_desc-v2.json'), 'utf8'));

const verses = [];
for (const sura of data.suras) {
  const surahNum = parseInt(sura.index, 10);
  for (const aya of sura.ayas) {
    verses.push({ surahNum, surahName: sura.name, ayahNum: parseInt(aya.index, 10), ref: `${sura.name}:${aya.index}`, text: aya.text });
  }
}

// Mirror indexes.js's vocative split, then the same web-rendering / key helpers
// as gen_orange_cases.js so the eligibility gate matches the verifier exactly.
function splitVocative(t) {
  return t.split(' ').map(tok => tok.replace(/^ي[َُِ]*ٰ/, 'يَا ')).join(' ');
}
// Strip combining marks / annotation signs ONLY, keeping every base letter AND
// the dagger alef U+0670 (it's a nonspacing mark but represents a hidden alef
// that tier1 turns into ا, so removing it would change the skeleton). Uses
// Unicode property classes rather than a hand-built range to avoid accidentally
// swallowing base letters.
// Quranic annotation signs that are modifier LETTERS (\p{Lm}), not marks, so the
// property filter below misses them: small high waw/yeh/etc. (U+06D6–U+06ED,
// U+06E5–U+06E6). tier1 strips these too, so dropping them keeps the case green
// while producing the clean wording a real web author would actually type.
const QURANIC_SIGNS = /[ۖ-ۭۥۦ]/g;
function markStripText(t) {
  const s = [...splitVocative(t).replace(QURANIC_SIGNS, '')]
    .filter(ch => ch === 'ٰ' || ch === ' ' || !/[\p{Mn}\p{Me}\p{Cf}ـ]/u.test(ch))
    .join('');
  return s.replace(/\s+/g, ' ').trim();
}
// Full modern web rendering: marks stripped + Quran-only alef forms → ا.
function webText(t) {
  return markStripText(t).replace(/ٰ/g, 'ا').replace(/[آٱ]/g, 'ا').replace(/\s+/g, ' ').trim();
}
function indexedKey(t) { return tier1(splitVocative(t)); }

const keyCount = new Map();
for (const v of verses) {
  const k = indexedKey(v.text);
  keyCount.set(k, (keyCount.get(k) || 0) + 1);
}
function wordCount(s) { return s.split(' ').filter(Boolean).length; }
function eligible(v) {
  return keyCount.get(indexedKey(v.text)) === 1 && wordCount(webText(v.text)) >= 4 && wordCount(webText(v.text)) <= 9;
}

// Per-class cited-text builders. Each returns the drifted rendering, or null if
// this verse can't exercise the class. The result is accepted only when it
// (a) differs from the authentic modern wording in the intended way and
// (b) still normalizes (tier1) to the verse's indexed key.
const CLASSES = [
  {
    id: 'tashkeelOnly',
    desc: 'harakat stripped, consonantal letters kept verbatim (marks-only drift)',
    build(v) {
      // Pure tashkeel drift: keep the letters exactly (incl. any ٱ/آ/dagger the
      // author copied from a vocalized source), strip only the harakat/marks.
      // Differs from the raw Uthmani by marks alone → classifyDeviation reports
      // tashkeelOnly; tier1 still folds it onto the verse key → green.
      const ms = markStripText(v.text);
      if (ms === splitVocative(v.text)) return null; // verse had no marks to drop
      return ms;
    },
  },
  {
    id: 'alefVariant',
    desc: 'آ / ٱ / dagger-alef → ا',
    build(v) {
      if (!/[آٱٰ]/.test(splitVocative(v.text))) return null;
      return webText(v.text); // converts the special alefs to bare ا
    },
  },
  {
    id: 'alefMaqsuraToYa',
    desc: 'ى → ي',
    build(v) {
      const web = webText(v.text);
      if (!web.includes('ى')) return null;
      return web.replace(/ى/g, 'ي');
    },
  },
  {
    id: 'taMarbutaToHa',
    desc: 'ة → ه',
    build(v) {
      const web = webText(v.text);
      if (!web.includes('ة')) return null;
      return web.replace(/ة/g, 'ه');
    },
  },
  {
    id: 'sameLetterCollapse',
    desc: 'a doubled letter (synthetic web typo) the same-letter-collapse rule forgives',
    build(v) {
      const web = webText(v.text);
      const words = web.split(' ');
      // Double the first base letter of the 2nd word to create an adjacent
      // duplicate run; the collapse rule should fold it back to the verse key.
      if (words.length < 2) return null;
      const w = words[1];
      const m = w.match(/[ء-ي]/);
      if (!m) return null;
      words[1] = w[0] + w[0] + w.slice(1);
      return words.join(' ');
    },
  },
];

const sorted = verses.filter(eligible).sort((a, b) => a.surahNum - b.surahNum || a.ayahNum - b.ayahNum);

const picked = [];
const usedSura = new Set();
for (const cls of CLASSES) {
  let chosen = null;
  for (const v of sorted) {
    if (usedSura.has(v.surahNum)) continue;
    const cited = cls.build(v);
    if (!cited) continue;
    if (cited === webText(v.text) && cls.id !== 'alefVariant' && cls.id !== 'tashkeelOnly') continue; // must actually drift
    if (tier1(cited) !== indexedKey(v.text)) continue; // must still normalize equal → green
    chosen = { cls, v, cited };
    break;
  }
  if (!chosen) { console.error(`FAIL: no eligible verse for drift class ${cls.id}`); process.exit(1); }
  usedSura.add(chosen.v.surahNum);
  picked.push(chosen);
}

const para = p => `<p>\n  <!-- GREEN drift[${p.cls.id}]: ${p.cls.desc} — ${p.v.ref} -->\n  قال تعالى: {${p.cited}} (${p.v.ref}).\n</p>`;
const html = `<!DOCTYPE html>
<!--
  T041 — Drift-as-green fixture. GENERATED by tests/gen_drift_cases.js from
  resources/quran-uthmani_desc-v2.json. Do not hand-edit; re-run the generator.
  ${picked.length} real verses cited at their CORRECT reference but in a modern
  spelling that drifts along one FR-003 normalization rule each. All must be
  GREEN (SC-004 = 100%). Ground truth is machine-derived (Principle I).
-->
<html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>اختبار انحراف الإملاء</title></head>
<body>
<article class="article-content">
<h1>مجموعة اختبار انحراف الإملاء</h1>
${picked.map(para).join('\n\n')}
</article>
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, 'tests', 'fixtures', 'synthetic', 'drift_cases.html'), html, 'utf8');

const stats = {
  greenMatches: picked.length, lightBlueMatches: 0, yellowMatches: 0,
  orangeMatches: 0, redMatches: 0, totalFindings: picked.length,
};
const matches = picked.map(p => ({ text: p.cited, color: 'green', matchedRef: p.v.ref, claimedRef: `(${p.v.ref})` }));
fs.writeFileSync(path.join(ROOT, 'tests', 'fixtures', 'synthetic', 'drift_cases.expected.json'), JSON.stringify({ stats, matches }, null, 2), 'utf8');

console.log(`Generated ${picked.length} drift-as-green cases:`);
for (const p of picked) console.log(`  ${p.cls.id.padEnd(20)} ${p.v.ref}  "${p.cited.slice(0, 40)}…"`);
