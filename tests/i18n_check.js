'use strict';
// T090 — i18n key-parity check. Fails if any key is missing from either catalog
// (so the shipped UI never falls back to a missing translation).
// Run: node tests/i18n_check.js
const i18n = require('../js/shared/i18n.js');
const ar = Object.keys(i18n.CATALOGS.ar);
const en = Object.keys(i18n.CATALOGS.en);
const missingInEn = ar.filter(k => !(k in i18n.CATALOGS.en));
const missingInAr = en.filter(k => !(k in i18n.CATALOGS.ar));
const emptyAr = ar.filter(k => !String(i18n.CATALOGS.ar[k]).trim());
const emptyEn = en.filter(k => !String(i18n.CATALOGS.en[k]).trim());

const problems = [];
if (missingInEn.length) problems.push('missing in en: ' + missingInEn.join(', '));
if (missingInAr.length) problems.push('missing in ar: ' + missingInAr.join(', '));
if (emptyAr.length) problems.push('empty ar: ' + emptyAr.join(', '));
if (emptyEn.length) problems.push('empty en: ' + emptyEn.join(', '));

if (problems.length) {
  console.error('i18n FAIL:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`i18n OK — ${ar.length} keys, ar/en in parity.`);
