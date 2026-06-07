'use strict';
// T034 — Node unit check for js/themes/registry.js (feature 004).
// Pure Node, no browser. Run: node tests/theme_registry_check.js
//
// Verifies the QuranThemes contract from contracts/theme-registry.md:
//   - list is a non-empty ordered array
//   - exactly one descriptor carries defaultFor: 'fresh-install'
//   - every id matches ^[a-z][a-z0-9-]{1,31}$
//   - defaultId() returns the fresh-install id
//   - isValidId(id) recognizes shipped ids and rejects unknowns
//   - get(id) returns the descriptor or null

const QuranThemes = require('../js/themes/registry.js');

const problems = [];
function check(name, cond, detail) {
  if (!cond) problems.push(`${name}${detail ? ' — ' + detail : ''}`);
}

check('list-shape', Array.isArray(QuranThemes.list) && QuranThemes.list.length > 0,
  'list must be a non-empty array');

const freshDefaults = QuranThemes.list.filter(t => t.defaultFor === 'fresh-install');
check('one-default', freshDefaults.length === 1,
  `expected exactly one defaultFor:'fresh-install', got ${freshDefaults.length}`);

const idRe = /^[a-z][a-z0-9-]{1,31}$/;
for (const t of QuranThemes.list) {
  check(`id-shape:${t.id}`, idRe.test(t.id), `id "${t.id}" does not match ${idRe}`);
  check(`displayName:${t.id}`, typeof t.displayName === 'string' && t.displayName.length > 0);
  check(`displayNameAr:${t.id}`, typeof t.displayNameAr === 'string' && t.displayNameAr.length > 0);
}

check('defaultId', QuranThemes.defaultId() === freshDefaults[0]?.id,
  `defaultId() returned "${QuranThemes.defaultId()}", expected "${freshDefaults[0]?.id}"`);

check('isValidId:default', QuranThemes.isValidId('default') === true);
check('isValidId:mihrab',  QuranThemes.isValidId('mihrab')  === true);
check('isValidId:bogus',   QuranThemes.isValidId('not-a-theme') === false);
check('isValidId:undef',   QuranThemes.isValidId(undefined) === false);
check('isValidId:number',  QuranThemes.isValidId(42) === false);

check('get:default', QuranThemes.get('default') && QuranThemes.get('default').id === 'default');
check('get:bogus',   QuranThemes.get('not-a-theme') === null);

if (problems.length) {
  console.error('FAIL', problems.length, 'problem(s):');
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}
console.log('OK theme registry —', QuranThemes.list.length, 'theme(s):',
  QuranThemes.list.map(t => t.id).join(', '));
