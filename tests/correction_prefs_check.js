'use strict';
/*
 * Correction prefs migration gate.
 * ---------------------------------------------------------------------------
 * Pure-Node test of QuranPrefs.applyDefaults — the one-way migration from the
 * legacy `autoCorrectOrange` boolean to the generalized `autoCorrect` object
 * {orange, lightBlue, yellow, red}:
 *   - lightBlue defaults ON (it never edits page text — safe to auto-surface).
 *   - orange / yellow / red default OFF (opt-in; all edit page text).
 *   - The legacy `autoCorrectOrange` key is migrated then DELETED (no mirror).
 *
 * Run: node tests/correction_prefs_check.js
 */
const path = require('path');
const Prefs = require(path.join('..', 'js', 'storage', 'prefs.js'));

const results = [];
const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : (detail || '') });

// (1) Fresh install: only lightBlue ON; orange/yellow/red OFF; no legacy key.
{
  const p = Prefs.applyDefaults({});
  T('fresh: orange off', p.autoCorrect && p.autoCorrect.orange === false, JSON.stringify(p.autoCorrect));
  T('fresh: lightBlue ON', p.autoCorrect.lightBlue === true, JSON.stringify(p.autoCorrect));
  T('fresh: yellow off', p.autoCorrect.yellow === false, JSON.stringify(p.autoCorrect));
  T('fresh: red off', p.autoCorrect.red === false, JSON.stringify(p.autoCorrect));
  T('fresh: legacy autoCorrectOrange deleted', !('autoCorrectOrange' in p), JSON.stringify(Object.keys(p)));
}

// (2) Legacy autoCorrectOrange:true migrates to orange:true, lightBlue ON, deletes legacy.
{
  const p = Prefs.applyDefaults({ autoCorrectOrange: true });
  T('legacy true → autoCorrect.orange true', p.autoCorrect.orange === true, JSON.stringify(p.autoCorrect));
  T('legacy migration sets lightBlue ON', p.autoCorrect.lightBlue === true, JSON.stringify(p.autoCorrect));
  T('legacy key removed after migrate', !('autoCorrectOrange' in p), JSON.stringify(Object.keys(p)));
}

// (3) Existing new object preserved; missing keys default-fill (lightBlue ON, rest OFF).
{
  const p = Prefs.applyDefaults({ autoCorrect: { orange: true, yellow: true } });
  T('explicit orange preserved (true)', p.autoCorrect.orange === true, JSON.stringify(p.autoCorrect));
  T('missing lightBlue default-fills ON', p.autoCorrect.lightBlue === true, JSON.stringify(p.autoCorrect));
  T('explicit yellow preserved (true)', p.autoCorrect.yellow === true, JSON.stringify(p.autoCorrect));
  T('missing red default-fills OFF', p.autoCorrect.red === false, JSON.stringify(p.autoCorrect));
}

// (4) Explicit lightBlue:false is honored (user opted out — not overwritten).
{
  const p = Prefs.applyDefaults({ autoCorrect: { orange: false, lightBlue: false } });
  T('explicit lightBlue:false honored', p.autoCorrect.lightBlue === false, JSON.stringify(p.autoCorrect));
}

// (5) New object takes precedence over a conflicting legacy flag, legacy still deleted.
{
  const p = Prefs.applyDefaults({ autoCorrectOrange: true, autoCorrect: { orange: false } });
  T('explicit autoCorrect.orange overrides legacy', p.autoCorrect.orange === false, JSON.stringify(p.autoCorrect));
  T('legacy deleted even when new object wins', !('autoCorrectOrange' in p), JSON.stringify(Object.keys(p)));
}

// (6) Garbage value falls back to fresh defaults (only lightBlue on).
{
  const p = Prefs.applyDefaults({ autoCorrect: 'nope' });
  T('non-object autoCorrect resets',
    p.autoCorrect && p.autoCorrect.orange === false && p.autoCorrect.lightBlue === true
      && p.autoCorrect.yellow === false && p.autoCorrect.red === false,
    JSON.stringify(p.autoCorrect));
}

const failed = results.filter(r => !r.pass);
for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`\ncorrection_prefs: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
