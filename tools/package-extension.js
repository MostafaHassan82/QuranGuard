'use strict';
/*
 * QuranGuard — Chrome Web Store packaging tool.
 *
 * Reads manifest.json, collects the files Chrome actually needs at runtime
 * (per the manifest's content_scripts / background / web_accessible_resources
 * plus icons + html + css), and writes a deflate-compressed .zip to
 * dist/quranguard-<version>.zip. Also writes <zip>.sha256.
 *
 * Pure Node (no npm deps): minimal PKZIP writer over Node's built-in
 * zlib.deflateRawSync. Store the central directory, compute one EOCD, done.
 * Chrome and the Web Store both accept method-8 (deflate) zips.
 *
 * Run: node tools/package-extension.js
 *      node tools/package-extension.js --list   # just print what would be zipped
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// What goes IN the zip. Allowlist of top-level dirs/files Chrome needs.
// Everything else (specs, tests, .git, .github, .claude, .specify, fresh_start,
// tools, node_modules, README, LICENSE, package*.json, *.md, dist) is excluded
// — none of it is referenced by manifest.json or runtime code.
const INCLUDE_FILES = ['manifest.json'];
const INCLUDE_DIRS  = ['js', 'css', 'html', 'icons', 'resources', '_locales'];

// Hard excludes inside the included dirs (defensive: log files, OS junk,
// editor backups). The included tree is hand-curated, but a stray .log in
// resources/ shouldn't ride along into the store package.
//
// resources/QuranAyas{,2}/ are excluded here because they ship ~150 MB of
// per-ayah PNGs for a render-as-image mode that no runtime code uses today.
// Keeping them in the repo (vs. deleting) preserves the option to add an
// image-render feature later; the moment one ships, drop these entries and
// re-list the dirs in manifest.json's web_accessible_resources.
const EXCLUDE_PATTERNS = [
  /\.log$/i,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/i,
  /~$/,
  /\.bak$/i,
  /\.swp$/i,
  /^resources\/QuranAyas2?\//,
];

// ── File walk ────────────────────────────────────────────────────────────────

function walk(absDir, relBase) {
  const out = [];
  if (!fs.existsSync(absDir)) return out;
  const stack = [{ abs: absDir, rel: relBase }];
  while (stack.length) {
    const { abs, rel } = stack.pop();
    for (const name of fs.readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? rel + '/' + name : name;
      const st = fs.statSync(childAbs);
      if (st.isDirectory()) { stack.push({ abs: childAbs, rel: childRel }); continue; }
      if (!st.isFile()) continue;
      if (EXCLUDE_PATTERNS.some(re => re.test(childRel))) continue;
      out.push({ abs: childAbs, rel: childRel, size: st.size });
    }
  }
  return out;
}

function collect() {
  const entries = [];
  for (const f of INCLUDE_FILES) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) {
      console.error(`[package] missing required file: ${f}`);
      process.exit(1);
    }
    entries.push({ abs, rel: f, size: fs.statSync(abs).size });
  }
  for (const d of INCLUDE_DIRS) entries.push(...walk(path.join(ROOT, d), d));
  // Stable order — sort by zip path so successive builds are byte-comparable
  // (modulo timestamps, which we also pin below).
  entries.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  return entries;
}

// ── PKZIP writer (method 8, deflate) ─────────────────────────────────────────

// Precomputed CRC-32 table (poly 0xEDB88320). Used for each entry's checksum.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Fixed (deterministic) DOS time/date — 2024-01-01 00:00:00.  Keeping these
// constant makes the output zip byte-stable across builds when contents match.
const DOS_TIME = 0;                                  // 00:00:00
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1; // 2024-01-01

function buildZip(entries) {
  const chunks = [];
  const cdEntries = [];
  let offset = 0;

  for (const e of entries) {
    const raw = fs.readFileSync(e.abs);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const nameBuf = Buffer.from(e.rel, 'utf8');
    const crc = crc32(raw);

    // Local File Header (30 bytes + filename)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);  // signature
    lfh.writeUInt16LE(20, 4);          // version needed
    lfh.writeUInt16LE(0x0800, 6);      // flags: bit 11 = filename is UTF-8
    lfh.writeUInt16LE(8, 8);           // method: deflate
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);          // no extra field

    chunks.push(lfh, nameBuf, compressed);

    cdEntries.push({
      name: nameBuf, crc, compSize: compressed.length, rawSize: raw.length, lfhOffset: offset,
    });
    offset += lfh.length + nameBuf.length + compressed.length;
  }

  // Central Directory
  const cdStart = offset;
  for (const c of cdEntries) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);          // version made by
    cdh.writeUInt16LE(20, 6);          // version needed
    cdh.writeUInt16LE(0x0800, 8);      // flags: UTF-8 filenames
    cdh.writeUInt16LE(8, 10);          // method: deflate
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(c.crc, 16);
    cdh.writeUInt32LE(c.compSize, 20);
    cdh.writeUInt32LE(c.rawSize, 24);
    cdh.writeUInt16LE(c.name.length, 28);
    cdh.writeUInt16LE(0, 30);          // extra length
    cdh.writeUInt16LE(0, 32);          // comment length
    cdh.writeUInt16LE(0, 34);          // disk number start
    cdh.writeUInt16LE(0, 36);          // internal attrs
    cdh.writeUInt32LE(0, 38);          // external attrs
    cdh.writeUInt32LE(c.lfhOffset, 42);
    chunks.push(cdh, c.name);
    offset += cdh.length + c.name.length;
  }
  const cdSize = offset - cdStart;

  // End Of Central Directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                       // disk number
  eocd.writeUInt16LE(0, 6);                       // disk with CD
  eocd.writeUInt16LE(cdEntries.length, 8);        // entries this disk
  eocd.writeUInt16LE(cdEntries.length, 10);       // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);                      // zip comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const version = manifest.version || '0.0.0';
  const entries = collect();

  if (process.argv.includes('--list')) {
    let total = 0;
    for (const e of entries) { console.log(`${e.rel}  (${e.size} bytes)`); total += e.size; }
    console.log(`\n${entries.length} files, ${total} bytes uncompressed.`);
    return;
  }

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const zipName = `quranguard-${version}.zip`;
  const zipPath = path.join(DIST, zipName);
  const zipBuf  = buildZip(entries);
  fs.writeFileSync(zipPath, zipBuf);

  const crypto = require('crypto');
  const sha = crypto.createHash('sha256').update(zipBuf).digest('hex');
  fs.writeFileSync(zipPath + '.sha256', `${sha}  ${zipName}\n`);

  console.log(`wrote ${path.relative(ROOT, zipPath)} (${zipBuf.length} bytes, ${entries.length} files)`);
  console.log(`sha256: ${sha}`);
}

main();
