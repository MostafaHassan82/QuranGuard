'use strict';
// Unit check for the panel-placement prefs added to prefs.v1: `panelPosition`
// (auto | left | right | float) and `floatAnchor` (auto | left | right).
// Verifies defaults, clamp-on-read of bad values, that every valid value
// round-trips, and that patch() merges without dropping other fields.
// Pure Node — no browser. Run: node tests/prefs_position_check.js

// Minimal in-memory chrome.storage.local mock (the only chrome API prefs.js
// touches). Must exist before requiring the module under test.
const store = {};
global.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
    },
  },
};

const QuranPrefs = require('../js/storage/prefs.js');

const problems = [];
function check(name, cond, detail) {
  if (!cond) problems.push(`${name}${detail ? ' — ' + detail : ''}`);
}
function resetStore() { for (const k of Object.keys(store)) delete store[k]; }

(async () => {
  // 1) Defaults when nothing is stored.
  resetStore();
  let p = await QuranPrefs.read();
  check('default panelPosition is auto', p.panelPosition === 'auto', `got ${p.panelPosition}`);
  check('default floatAnchor is auto', p.floatAnchor === 'auto', `got ${p.floatAnchor}`);
  check('DEFAULTS exposes panelPosition', QuranPrefs.DEFAULTS.panelPosition === 'auto');
  check('DEFAULTS exposes floatAnchor', QuranPrefs.DEFAULTS.floatAnchor === 'auto');

  // 2) Every valid panelPosition round-trips through write→read.
  for (const pos of ['auto', 'left', 'right', 'float']) {
    resetStore();
    await QuranPrefs.write({ panelPosition: pos });
    p = await QuranPrefs.read();
    check(`panelPosition '${pos}' round-trips`, p.panelPosition === pos, `got ${p.panelPosition}`);
  }

  // 3) Every valid floatAnchor round-trips.
  for (const a of ['auto', 'left', 'right']) {
    resetStore();
    await QuranPrefs.write({ floatAnchor: a });
    p = await QuranPrefs.read();
    check(`floatAnchor '${a}' round-trips`, p.floatAnchor === a, `got ${p.floatAnchor}`);
  }

  // 4) Invalid values clamp to the defaults on read.
  resetStore();
  await QuranPrefs.write({ panelPosition: 'sideways', floatAnchor: 'middle' });
  p = await QuranPrefs.read();
  check('invalid panelPosition clamps to auto', p.panelPosition === 'auto', `got ${p.panelPosition}`);
  check('invalid floatAnchor clamps to auto', p.floatAnchor === 'auto', `got ${p.floatAnchor}`);

  // 5) 'float' is NOT a valid floatAnchor (anchor is left/right/auto only).
  resetStore();
  await QuranPrefs.write({ floatAnchor: 'float' });
  p = await QuranPrefs.read();
  check("floatAnchor rejects 'float'", p.floatAnchor === 'auto', `got ${p.floatAnchor}`);

  // 6) patch() merges the new fields without disturbing unrelated prefs.
  resetStore();
  await QuranPrefs.write({ panelPosition: 'right', floatAnchor: 'right', refLinks: false });
  const merged = await QuranPrefs.patch({ panelPosition: 'float' });
  check('patch updates panelPosition', merged.panelPosition === 'float', `got ${merged.panelPosition}`);
  check('patch preserves floatAnchor', merged.floatAnchor === 'right', `got ${merged.floatAnchor}`);
  check('patch preserves unrelated pref (refLinks)', merged.refLinks === false, `got ${merged.refLinks}`);

  if (problems.length) {
    console.error(`prefs_position FAIL:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('prefs_position OK — panelPosition + floatAnchor defaults, validation, and patch verified.');
})().catch((e) => { console.error(e); process.exit(1); });
