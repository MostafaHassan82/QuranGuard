'use strict';
// T093 — share builder checks. Loads the real QuranActions (with QuranI18n
// injected) and asserts the orange share link highlights BOTH the ayah and the
// cited reference, and that the body uses the localized friendly templates.
// Run: node tests/share_check.js
const path = require('path');
const src = require('fs').readFileSync(path.join(__dirname, '..', 'js', 'panel', 'actions.js'), 'utf8').replace(/'use strict';/, '');
const i18n = require('../js/shared/i18n.js');
const QuranActions = new Function('QuranI18n', src + '; return QuranActions;')(i18n);

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); failures++; } };

const orange = {
  text: 'ما ننسخ من آية', color: 'orange',
  claimedRef: 'البقرة:105', refText: '(البقرة:105)', matchedRef: 'البقرة:106',
};
const green = { text: 'وقليل من عبادي الشكور', color: 'green', claimedRef: 'سبأ:13', matchedRef: 'سبأ:13' };
const PAGE = 'https://example.test/page?id=7';

// --- URL: both directives for orange ---
const url = QuranActions.buildShareUrl(orange, { pageUrl: PAGE });
const directives = (url.split('#:~:')[1] || '').split('&').filter(d => d.startsWith('text='));
assert(directives.length === 2, `orange share URL should have 2 text= directives, got ${directives.length} (${url})`);
assert(decodeURIComponent(directives[0]).includes('ما ننسخ'), 'first directive should be the ayah');
assert(decodeURIComponent(directives[1]).includes('البقرة:105'), 'second directive should be the cited reference');

// --- Body: localized friendly templates ---
i18n.setLang('en');
const enBody = QuranActions.buildShareArtifact(orange, { pageUrl: PAGE });
assert(/attributes/.test(enBody) && enBody.includes('البقرة:105') && enBody.includes('البقرة:106'),
  'en orange body should name both refs in friendly prose:\n' + enBody);
assert(!/Cited Reference:/.test(enBody), 'body must not be the old developer record');

i18n.setLang('ar');
const arBody = QuranActions.buildShareArtifact(orange, { pageUrl: PAGE });
assert(arBody.includes('تنسب هذه الصفحة') && arBody.includes('البقرة:106'), 'ar orange body should use the ar template');

// --- Green: single directive (ref is inside the ayah snippet check / distinct) ---
const gUrl = QuranActions.buildShareUrl(green, { pageUrl: PAGE });
assert(gUrl.includes('#:~:text='), 'green share URL should still carry a text fragment');

if (failures) { console.error(`\nshare_check: ${failures} failure(s)`); process.exit(1); }
console.log('share_check OK — dual text fragment + localized friendly body verified.');
