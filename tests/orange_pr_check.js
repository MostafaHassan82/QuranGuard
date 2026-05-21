'use strict';
// T040 — orange precision/recall gate (SC-009 ≥ 95% precision, SC-010 ≥ 90%
// recall). Runs the generated orange_cases fixture through the real scan
// pipeline (via the Node harness's --write-observed), then scores the orange
// verdicts against the machine-derived ground truth.
//
//   precision = TP / (TP + FP)   — of findings flagged orange, how many are
//                                   genuine reference mismatches (and resolve
//                                   to the correct true reference)
//   recall    = TP / (TP + FN)   — of the known orange cases, how many were
//                                   caught (with the correct true reference)
//
// A control green/lightBlue case flagged orange counts as a false positive.
// Run: node tests/orange_pr_check.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GROUND = path.join(ROOT, 'tests', 'fixtures', 'orange_cases.expected.json');
const OBSERVED = path.join(ROOT, 'tests', 'fixtures', 'orange_cases.observed.json');

if (!fs.existsSync(GROUND)) { console.error('Missing fixture — run node tests/gen_orange_cases.js first.'); process.exit(1); }

// Drive the scan through the existing harness so we score the SAME pipeline CI
// runs (no second, divergent scan path).
execFileSync('node', [path.join('tests', 'run_tests_node.js'), path.join('tests', 'fixtures', 'orange_cases.html'), '--write-observed'],
  { cwd: ROOT, stdio: 'ignore' });

const ground = JSON.parse(fs.readFileSync(GROUND, 'utf8'));
const observed = JSON.parse(fs.readFileSync(OBSERVED, 'utf8'));
const obsByText = new Map((observed.matches || []).map(m => [m.text, m]));

const trueOranges = ground.matches.filter(m => m.color === 'orange');
const controls = ground.matches.filter(m => m.color !== 'orange');

let tp = 0, fn = 0;
for (const g of trueOranges) {
  const o = obsByText.get(g.text);
  // A true positive must be flagged orange AND resolve to the correct true ref
  // (a wrong matchedRef is not a real catch — it would mislead the reader).
  if (o && o.color === 'orange' && o.matchedRef === g.matchedRef) tp++;
  else fn++;
}
// False positives: any non-orange control the pipeline flagged orange.
let fp = 0;
for (const c of controls) {
  const o = obsByText.get(c.text);
  if (o && o.color === 'orange') fp++;
}

const precision = (tp + fp) === 0 ? 1 : tp / (tp + fp);
const recall = (tp + fn) === 0 ? 1 : tp / (tp + fn);
const PREC_MIN = 0.95, REC_MIN = 0.90;

console.log(`orange cases: ${trueOranges.length} oranges + ${controls.length} controls`);
console.log(`TP=${tp} FP=${fp} FN=${fn}`);
console.log(`precision = ${(precision * 100).toFixed(1)}%  (SC-009 floor ${PREC_MIN * 100}%)`);
console.log(`recall    = ${(recall * 100).toFixed(1)}%  (SC-010 floor ${REC_MIN * 100}%)`);

const failed = [];
if (precision < PREC_MIN) failed.push(`precision ${(precision * 100).toFixed(1)}% < ${PREC_MIN * 100}%`);
if (recall < REC_MIN) failed.push(`recall ${(recall * 100).toFixed(1)}% < ${REC_MIN * 100}%`);
if (failed.length) { console.error('FAIL: ' + failed.join('; ')); process.exit(1); }
console.log('orange_pr_check OK — SC-009 + SC-010 satisfied.');
