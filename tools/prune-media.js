// Reclaim space in history-media.
//
// There is no garbage here to collect: the folder currently holds zero orphans
// and zero duplicates, so every byte is referenced by a real message. Anything
// this removes is a real attachment somebody sent.
//
// What deleting a file actually costs: the message itself is in the database
// and stays readable forever. Only the local copy of the attachment goes, and
// the UI falls back to whatever Beeper still has in its own cache. If Beeper
// has already evicted it, that attachment becomes unavailable here.
//
// Dry run by default. Nothing is deleted without --apply.
//
//   npm run media:prune                        audit only, changes nothing
//   npm run media:prune -- --orphans           delete only unreferenced files
//   npm run media:prune -- --cap 500MB         keep the newest 500MB, drop the rest
//   npm run media:prune -- --ext .zip,.mp4     limit which kinds may be evicted
//   npm run media:prune -- --apply             actually do it
//
// --ext is a floor on what a cap may touch: without it, a cap large enough
// will happily start deleting photographs, which is never what anyone means.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const apply = has('--apply');
const orphansOnly = has('--orphans');
const capArg = value('--cap');
const extArg = value('--ext');

const userData = process.env.APPDATA + '\\Better Beeper';
const mediaRoot = path.join(userData, 'history-media');

const MB = 1024 * 1024;
const parseSize = (s) => {
  const m = /^([\d.]+)\s*(b|kb|mb|gb)?$/i.exec(String(s).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n * ({ b: 1, kb: 1024, mb: MB, gb: MB * 1024 }[(m[2] || 'mb').toLowerCase()] ?? MB);
};
const cap = capArg ? parseSize(capArg) : null;
const allowedExts = extArg
  ? new Set(extArg.split(',').map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase()))
  : null;

if (!apply && !orphansOnly && !capArg) {
  // Audit mode: report only.
}

// --- Load the database ---------------------------------------------------
const db = new DatabaseSync(path.join(userData, 'history.db'), { readOnly: true });
// Chat ids are long and mostly identical, so show the tail that actually
// distinguishes them, and fall back to a short form rather than the whole id.
const shortChat = (id) => {
  const s = String(id || '');
  const host = s.split('.').pop();
  return s.length > 44 ? '...' + s.slice(-40) : s || '(unknown)';
};
const titles = new Map(
  db.prepare('SELECT chatID, title FROM chats').all().map((r) => [
    r.chatID,
    r.title ? String(r.title) + '  ' + shortChat(r.chatID) : shortChat(r.chatID),
  ]),
);
const rows = db.prepare('SELECT chatID, ts, payload FROM messages WHERE gone = 0').all();
db.close();

const refs = new Map(); // hash -> { names:Set, newest:number, chats:Set }
for (const row of rows) {
  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    continue;
  }
  for (const att of payload?.attachments || []) {
    const hash = att?.localMediaHash;
    if (!hash) continue;
    if (!refs.has(hash)) refs.set(hash, { names: new Set(), newest: 0, chats: new Set() });
    const r = refs.get(hash);
    if (att.fileName) r.names.add(String(att.fileName));
    if (row.ts > r.newest) r.newest = row.ts;
    if (row.chatID) r.chats.add(titles.get(row.chatID) || shortChat(row.chatID));
  }
}

// --- Walk the folder -----------------------------------------------------
const files = [];
let totalBytes = 0;
for (const shard of fs.readdirSync(mediaRoot, { withFileTypes: true })) {
  if (!shard.isDirectory()) continue;
  const dir = path.join(mediaRoot, shard.name);
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const bytes = fs.statSync(full).size;
    totalBytes += bytes;
    const hash = name.split('.')[0];
    files.push({ full, name, hash, bytes, ext: path.extname(name).toLowerCase() });
  }
}

// --- Decide what goes ----------------------------------------------------
const victims = [];

if (orphansOnly) {
  for (const f of files) {
    if (!refs.has(f.hash)) victims.push({ ...f, why: 'nothing references it' });
  }
} else if (cap) {
  // Largest first, oldest as the tie-break.
  //
  // Evicting purely oldest-first is the wrong instinct here: it drops a 3 MB
  // video from August before a 190 MB archive from last week, and frees almost
  // nothing doing it. Reclaiming space means taking the big items, and age
  // only decides between equals.
  const ranked = [...files]
    .filter((f) => !allowedExts || allowedExts.has(f.ext))
    .sort((a, b) => {
      const ra = refs.get(a.hash);
      const rb = refs.get(b.hash);
      if (a.bytes !== b.bytes) return b.bytes - a.bytes;
      return (ra?.newest || 0) - (rb?.newest || 0);
    });

  let running = totalBytes;
  for (const f of ranked) {
    if (running <= cap) break;
    const r = refs.get(f.hash);
    victims.push({
      ...f,
      why: r
        ? `largest still-referenced, last seen ${new Date(r.newest).toISOString().slice(0, 10)} in ${[...r.chats][0] || 'a chat'}`
        : 'not referenced by any message',
    });
    running -= f.bytes;
  }

  const skipped = files.filter((f) => !victims.includes(f) && allowedExts && !allowedExts.has(f.ext));
  if (skipped.length) {
    const skippedBytes = skipped.reduce((n, f) => n + f.bytes, 0);
    console.log(`protected by --ext : ${skipped.length} files, ${(skippedBytes / MB).toFixed(1)} MB (never eligible)`);
  }
} else {
  console.log('No --orphans and no --cap: this is an audit. Nothing was selected.');
}

// --- Report --------------------------------------------------------------
const freed = victims.reduce((n, v) => n + v.bytes, 0);
const mb = (n) => (n / MB).toFixed(1) + ' MB';

console.log('');
console.log(`folder now   : ${files.length} files, ${mb(totalBytes)}`);
console.log(`would delete : ${victims.length} files, ${mb(freed)}`);
console.log(`would remain : ${files.length - victims.length} files, ${mb(totalBytes - freed)}`);
console.log('');
for (const v of victims.slice(0, 40)) {
  const r = refs.get(v.hash);
  console.log(`  ${mb(v.bytes).padStart(9)}  ${(r && new Date(r.newest).toISOString().slice(0, 10)) || '  unreferenced'}  ${[...(r?.names || [])][0] || v.name}`);
  console.log(`      ${v.why}`);
}
if (victims.length > 40) console.log(`  ...and ${victims.length - 40} more`);

if (!apply) {
  console.log('');
  console.log(victims.length ? 'DRY RUN. Re-run with --apply to delete these.' : 'Nothing to do.');
  process.exit(0);
}

if (!victims.length) {
  console.log('');
  console.log('Nothing matched. No files were deleted.');
  process.exit(0);
}

// --- Delete --------------------------------------------------------------
// Recoverable only via the OS trash is not available here, so this is a real
// delete. That is why it is opt-in and why the dry run above exists.
let deleted = 0;
let failed = 0;
for (const v of victims) {
  try {
    fs.unlinkSync(v.full);
    deleted++;
  } catch (e) {
    failed++;
    console.log(`  FAILED ${v.name}: ${e.message}`);
  }
}

console.log('');
console.log(`deleted : ${deleted} of ${victims.length}  (${mb(freed)} freed)`);
if (failed) console.log(`failed  : ${failed}`);

// Prove what is left still resolves for every reference that survives.
const { openMediaStore } = require('../src/main/media-store.js');
const media = openMediaStore(userData);
let broken = 0;
for (const hash of refs.keys()) {
  if (!media.pathFor(hash)) broken++;
}
console.log(`references with no file after prune : ${broken} (expected: the ones just deleted)`);
console.log(`folder now : ${media.count()} files, ${mb(media.totalBytes())}`);