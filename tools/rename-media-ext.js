// Give the already-stored media files the extension they should have had.
//
// Files were written as bare hashes because safeExt() used to test the whole
// tail of a filename against an extension, so "clip.mp4" never matched. The
// fix is in place, but files stored before it stay extension-less.
//
// Safe to rename: nothing resolves media by path. The only reader is
// urlFor(hash) -> pathFor(hash), which finds a file by its hash whatever it is
// named. localMediaPath is written but never read back.
//
// Dry run by default. Pass --apply to actually rename.

const fs = require('node:fs');
const path = require('node:path');

const userDataDir = path.join(process.env.APPDATA, 'Better Beeper');
const dbPath = path.join(userDataDir, 'history.db');
const mediaRoot = path.join(userDataDir, 'history-media');

// The app's own rule, so this cannot disagree with what it writes later.
const { safeExt } = require('../src/main/media-store.js');
const { DatabaseSync } = require('node:sqlite');

const apply = process.argv.includes('--apply');
const BARE = /^[0-9a-f]{64}$/;

// --- What each stored hash was called -------------------------------------
// Read-only, and straight from the table: the names live inside each message's
// payload JSON, and there is no store method that hands back every row.
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT payload FROM messages WHERE gone = 0').all();

const namesFor = new Map(); // hash -> Set of fileNames
let attachments = 0;

for (const row of rows) {
  let payload;
  try {
    payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  } catch {
    continue;
  }
  for (const att of payload?.attachments || []) {
    const hash = att?.localMediaHash;
    if (!BARE.test(String(hash || ''))) continue;
    attachments++;
    if (!namesFor.has(hash)) namesFor.set(hash, new Set());
    if (att.fileName) namesFor.get(hash).add(String(att.fileName));
  }
}
db.close();

// A name is only useful if it yields an extension. When several messages
// share one hash under different names, take the same choice every run.
function extensionFor(hash) {
  const names = [...(namesFor.get(hash) || [])].sort();
  for (const n of names) {
    const ext = safeExt(n);
    if (ext) return { ext, name: n };
  }
  return null;
}

// --- What is actually on disk --------------------------------------------
const rename = [];
const skipNoName = [];
const alreadyNamed = [];
const collisions = [];
const unknown = [];

for (const shard of fs.readdirSync(mediaRoot, { withFileTypes: true })) {
  if (!shard.isDirectory()) continue;
  const dir = path.join(mediaRoot, shard.name);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);

    if (!BARE.test(entry.name)) {
      alreadyNamed.push(entry.name);
      continue;
    }

    const found = extensionFor(entry.name);
    if (!found) {
      // Nothing in the database names this one, so there is no extension to
      // invent. Leaving it bare is correct, not a failure.
      skipNoName.push(entry.name);
      continue;
    }

    const target = path.join(dir, entry.name + found.ext);
    if (fs.existsSync(target)) {
      collisions.push({ from: full, to: target });
      continue;
    }
    rename.push({ from: full, to: target, ext: found.ext, name: found.name });
  }
}

const bytes = rename.reduce((n, r) => n + fs.statSync(r.from).size, 0);

console.log(`messages scanned : ${rows.length}`);
console.log(`attachments      : ${attachments}`);
console.log(`distinct hashes  : ${namesFor.size}`);
console.log('');
console.log(`already named    : ${alreadyNamed.length}`);
console.log(`no name in db    : ${skipNoName.length}`);
console.log(`collisions       : ${collisions.length}`);
console.log(`to rename        : ${rename.length}`);
console.log('');

const byExt = new Map();
for (const r of rename) byExt.set(r.ext, (byExt.get(r.ext) || 0) + 1);
console.log('extensions found :');
for (const [ext, n] of [...byExt].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ext.padEnd(7)} ${n}`);
}
console.log('');

if (collisions.length) {
  console.log('collisions (target already exists, not touching):');
  for (const c of collisions.slice(0, 10)) {
    console.log(`  ${path.basename(c.from)} -> ${path.basename(c.to)}`);
  }
  if (collisions.length > 10) console.log(`  ...and ${collisions.length - 10} more`);
  console.log('');
}

if (skipNoName.length) {
  console.log(`sample of the ${skipNoName.length} with no name in the database:`);
  for (const n of skipNoName.slice(0, 3)) console.log(`  ${n}`);
  console.log('');
}

if (!apply) {
  console.log('DRY RUN. Nothing was changed. Re-run with --apply to rename.');
  process.exit(0);
}

// --- Do it ---------------------------------------------------------------
let done = 0;
const failed = [];
for (const r of rename) {
  try {
    fs.renameSync(r.from, r.to);
    done++;
  } catch (e) {
    failed.push({ file: r.from, error: e.message });
  }
}

console.log(`renamed : ${done} of ${rename.length}`);
if (failed.length) {
  console.log(`FAILED  : ${failed.length}`);
  for (const f of failed.slice(0, 10)) console.log(`  ${path.basename(f.file)}: ${f.error}`);
}

// Nothing should be left bare that we could have named.
const stillBare = fs
  .readdirSync(mediaRoot, { withFileTypes: true })
  .filter((s) => s.isDirectory())
  .flatMap((s) => fs.readdirSync(path.join(mediaRoot, s.name)))
  .filter((n) => BARE.test(n));

console.log('');
console.log(`still extension-less: ${stillBare.length} (of which ${skipNoName.length} have no name in the database)`);
process.exit(failed.length ? 1 : 0);
