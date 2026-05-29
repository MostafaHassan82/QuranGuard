'use strict';
/*
 * V1.2 correction prefs migration gate (T201 P3).
 * ---------------------------------------------------------------------------
 * Pure-Node test of QuranPrefs.applyDefaults — the migration from the legacy
 * `autoCorrectOrange` boolean to the generalized `autoCorrect` object
 * {orange, lightBlue, yellow} (red never auto, ratified Q-D), and the back-compat
 * mirror that keeps autoCorrectOrange === autoCorrect.orange.
 *
 * Run: node tests/correction_prefs_check.js
 */
const path = require('path');
const Prefs = require(path.join('..', 'js', 'storage', 'prefs.js'));

const results = [];
const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });

// (1) Fresh defaults: all autocorrect off; red absent from the object.
{
  const p = Prefs.applyDefaults({});
  T('defaults: autoCorrect present, all off', p.autoCorrect && p.autoCorrect.orange === false && p.autoCorrect.lightBlue === false && p.autoCorrect.yellow === false, JSON.stringify(p.autoCorrect));
  T('defaults: red is never an autoCorrect key', !('red' in p.autoCorrect), JSON.stringify(p.autoCorrect));
  T('defaults: legacy mirror matches autoCorrect.orange', p.autoCorrectOrange === p.autoCorrect.orange, JSON.stringify({ m: p.autoCorrectOrange }));
}

// (2) Legacy autoCorrectOrange:true migrates to autoCorrect.orange:true.
{
  const p = Prefs.applyDefaults({ autoCorrectOrange: true });
  T('legacy true → autoCorrect.orange true', p.autoCorrect.orange === true, JSON.stringify(p.autoCorrect));
  T('legacy migration leaves lightBlue/yellow off', p.autoCorrect.lightBlue === false && p.autoCorrect.yellow === false, JSON.stringify(p.autoCorrect));
  T('legacy migration keeps the mirror in sync', p.autoCorrectOrange === true, String(p.autoCorrectOrange));
}

// (3) New object wins; mirror follows orange.
{
  const p = Prefs.applyDefaults({ autoCorrect: { orange: false, yellow: true } });
  T('new object preserved (yellow true)', p.autoCorrect.yellow === true, JSON.stringify(p.autoCorrect));
  T('new object default-fills missing lightBlue', p.autoCorrect.lightBlue === false, JSON.stringify(p.autoCorrect));
  T('mirror follows the new object orange (false)', p.autoCorrectOrange === false, String(p.autoCorrectOrange));
}

// (4) New object takes precedence over a conflicting legacy flag.
{
  const p = Prefs.applyDefaults({ autoCorrectOrange: true, autoCorrect: { orange: false } });
  T('explicit autoCorrect.orange overrides legacy flag', p.autoCorrect.orange === false && p.autoCorrectOrange === false, JSON.stringify({ ac: p.autoCorrect, m: p.autoCorrectOrange }));
}

// (5) Garbage values fall back to defaults.
{
  const p = Prefs.applyDefaults({ autoCorrect: 'nope' });
  T('non-object autoCorrect resets to defaults', p.autoCorrect && p.autoCorrect.orange === false && p.autoCorrect.yellow === false, JSON.stringify(p.autoCorrect));
}

const failed = results.filter(r => !r.pass);
for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`\ncorrection_prefs: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
