'use strict';
// One-off: read the official names from each bundled font's `name` table.
// Prints nameID 1 (Family), 4 (Full), 16 (Typographic Family) for every
// language record. Run: node tests/font_names.js
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'resources', 'fonts');

const NAME_IDS = { 1: 'Family', 2: 'Subfamily', 4: 'Full', 6: 'PostScript', 16: 'TypoFamily' };

function decodeName(buf, platformID, encodingID) {
  // Platform 3 (Windows) and platform 0 (Unicode) use UTF-16BE. Platform 1
  // (Mac Roman) is latin-ish; we only care about UTF-16BE records which carry
  // both English and Arabic.
  if (platformID === 3 || platformID === 0) return buf.toString('utf16le').length, swapUtf16(buf);
  return buf.toString('latin1');
}
function swapUtf16(buf) {
  const swapped = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) { swapped[i] = buf[i + 1]; swapped[i + 1] = buf[i]; }
  return swapped.toString('utf16le');
}

function parseNameTable(file) {
  const b = fs.readFileSync(file);
  const tag = b.readUInt32BE(0);
  if (tag === 0x774f4632 /* wOF2 */ || tag === 0x774f4646 /* wOFF */) return { skipped: 'woff/woff2 (compressed) — needs fonttools' };
  const numTables = b.readUInt16BE(4);
  let nameOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const t = b.toString('latin1', rec, rec + 4);
    if (t === 'name') { nameOff = b.readUInt32BE(rec + 8); break; }
  }
  if (nameOff < 0) return { error: 'no name table' };
  const count = b.readUInt16BE(nameOff + 2);
  const strOff = nameOff + b.readUInt16BE(nameOff + 4);
  const recs = [];
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    const platformID = b.readUInt16BE(r);
    const encodingID = b.readUInt16BE(r + 2);
    const langID = b.readUInt16BE(r + 4);
    const nameID = b.readUInt16BE(r + 6);
    const len = b.readUInt16BE(r + 8);
    const off = b.readUInt16BE(r + 10);
    if (!NAME_IDS[nameID]) continue;
    const slice = b.slice(strOff + off, strOff + off + len);
    const value = decodeName(slice, platformID, encodingID);
    recs.push({ nameID, label: NAME_IDS[nameID], platformID, langID, value });
  }
  return { recs };
}

for (const f of fs.readdirSync(dir).sort()) {
  if (!/\.(ttf|otf|woff2?)$/i.test(f)) continue;
  console.log('\n=== ' + f + ' ===');
  const res = parseNameTable(path.join(dir, f));
  if (res.skipped) { console.log('  ' + res.skipped); continue; }
  if (res.error) { console.log('  ' + res.error); continue; }
  // Show Family (1), TypoFamily (16), Full (4) — dedupe by value.
  const seen = new Set();
  for (const r of res.recs.filter(x => [1, 16, 4].includes(x.nameID))) {
    const key = r.label + '|' + r.value;
    if (seen.has(key)) continue; seen.add(key);
    const lang = r.langID === 0x0409 ? 'en' : r.langID === 0x0401 ? 'ar' : ('lang0x' + r.langID.toString(16));
    console.log(`  [${r.label}/${lang}] ${r.value}`);
  }
}
