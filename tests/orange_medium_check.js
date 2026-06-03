'use strict';
// Regression gate for review finding #2: an explicit-reference citation whose
// text EXACTLY matches a verse elsewhere must surface as ORANGE even when the
// extractor only graded it MEDIUM confidence (a bare run / short fragment).
// Before the fix, orange.js hard-rejected anything not `high`, so these real
// wrong-reference citations silently fell through to yellow/red.
//
// Drives the verifier directly via the harness's --verify-ref probe (bypasses
// candidate extraction) and reuses the machine-derived orange ground truth so
// no verse/ref is hand-typed. Run: node tests/orange_medium_check.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GROUND = path.join(ROOT, 'tests', 'fixtures', 'synthetic', 'orange_cases.expected.json');
if (!fs.existsSync(GROUND)) { console.error('Missing fixture — run node tests/gen_orange_cases.js first.'); process.exit(1); }
const ground = JSON.parse(fs.readFileSync(GROUND, 'utf8'));

function probe(text, ref, conf) {
  const out = execFileSync('node', [path.join('tests', 'run_tests_node.js'), '--verify-ref', text, ref, conf], { cwd: ROOT, encoding: 'utf8' });
  return JSON.parse(out.slice(out.indexOf('{')));
}

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); failures++; } else console.log('ok: ' + msg); };

// Take the first two orange ground-truth cases; cited ref is the WRONG ref, the
// matchedRef is the true verse. Probe at MEDIUM confidence.
const samples = ground.matches.filter(m => m.color === 'orange').slice(0, 2);
for (const s of samples) {
  const cited = s.claimedRef.replace(/[()]/g, '');
  const r = probe(s.text, cited, 'medium');
  assert(r.color === 'orange', `medium "${s.text.slice(0, 24)}…" cited ${cited} → orange (got ${r.color})`);
  assert(r.matchedRef === s.matchedRef, `  resolves to true ref ${s.matchedRef} (got ${r.matchedRef})`);
}

if (failures) { console.error(`\norange_medium_check: ${failures} failure(s)`); process.exit(1); }
console.log('\norange_medium_check OK — medium-confidence exact-match citations surface as orange (finding #2).');
