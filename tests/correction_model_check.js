'use strict';
/*
 * V1.2 correction model unit gate (T201 P2).
 * ---------------------------------------------------------------------------
 * Pure-Node test of QuranPanelModel.suggestRefForLightBlue — the lightBlue
 * missing-reference suggestion + context disambiguation (design §1, ratified
 * Q-A: suggestion-only). No browser needed; the model is dependency-free.
 *
 * Run: node tests/correction_model_check.js
 */
const path = require('path');
const Model = require(path.join('..', 'js', 'panel', 'model.js'));

const results = [];
const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });

function lb(id, matchedRefs) {
  return { id, color: 'lightBlue', text: 'x', matchedRef: matchedRefs[0], matchedRefs };
}

// (1) Unique ref → suggested directly, not ambiguous.
Model.reset();
Model.upsert(lb('f1', ['البقرة:255']));
{
  const s = Model.suggestRefForLightBlue('f1');
  T('unique matchedRef → suggested, not ambiguous',
    s && s.ref === 'البقرة:255' && s.ambiguous === false && s.viaContext === false, JSON.stringify(s));
}

// (2) Multiple refs, no resolved neighbor → ambiguous (manual).
Model.reset();
Model.upsert(lb('f1', ['البقرة:255', 'آل عمران:2', 'طه:8']));
{
  const s = Model.suggestRefForLightBlue('f1');
  T('multiple refs, no context → ambiguous with candidates',
    s && s.ambiguous === true && s.ref === null && s.candidates.length === 3, JSON.stringify(s));
}

// (3) Multiple refs, a PRECEDING green neighbor in the same surah → context pick.
Model.reset();
Model.upsert({ id: 'g0', color: 'green', text: 'y', matchedRef: 'البقرة:255', claimedRef: 'البقرة:255' });
Model.upsert(lb('f1', ['آل عمران:2', 'البقرة:255', 'طه:8']));
{
  const s = Model.suggestRefForLightBlue('f1');
  T('preceding green neighbor disambiguates by surah (context)',
    s && s.ambiguous === false && s.ref === 'البقرة:255' && s.viaContext === true, JSON.stringify(s));
}

// (4) Multiple refs, a FOLLOWING lightGreen (corrected) neighbor → context pick.
Model.reset();
Model.upsert(lb('f1', ['آل عمران:2', 'طه:8', 'يس:9']));
Model.upsert({ id: 'c1', color: 'lightGreen', text: 'z', matchedRef: 'طه:8' });
{
  const s = Model.suggestRefForLightBlue('f1');
  T('following lightGreen neighbor disambiguates by surah (context)',
    s && s.ambiguous === false && s.ref === 'طه:8' && s.viaContext === true, JSON.stringify(s));
}

// (5) Neighbor exists but is NOT resolved (red/yellow) → stays ambiguous.
Model.reset();
Model.upsert({ id: 'r0', color: 'red', text: 'y', matchedRef: 'البقرة:255' });
Model.upsert(lb('f1', ['البقرة:255', 'آل عمران:2']));
{
  const s = Model.suggestRefForLightBlue('f1');
  T('unresolved (red) neighbor does NOT disambiguate → ambiguous',
    s && s.ambiguous === true, JSON.stringify(s));
}

// (6) Non-lightBlue finding → null (no suggestion).
Model.reset();
Model.upsert({ id: 'y1', color: 'yellow', text: 'y', matchedRef: 'البقرة:255', matchedRefs: ['البقرة:255'] });
{
  const s = Model.suggestRefForLightBlue('y1');
  T('non-lightBlue finding yields no suggestion', s === null, JSON.stringify(s));
}

const failed = results.filter(r => !r.pass);
for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`\ncorrection_model: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
