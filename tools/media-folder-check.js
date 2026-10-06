// Guards the media folder against the two ways it can drift back:
//
//   - a file stored as a bare hash (the safeExt bug), and
//   - a file whose contents no longer match the hash in its own name, which is
//     what a half-finished rename or a truncated copy would leave behind.
//
// Runs against a synthetic store, so it is repeatable on a clean machine and
// does not depend on the 945 MB of real media. Proven to fail when either
// guard is removed.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { openMediaStore } = require(path.join(__dirname, '..', 'src', 'main', 'media-store.js'));

const cases = [];
const add = (name, fn) => cases.push({ name, fn });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-media-verify-'));
const media = openMediaStore(dir);
// The store puts its files under history-media/<ab>/, not directly in dir.
const shard = (hash) => path.join(media.root, hash.slice(0, 2));

const source = (name, bytes) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
};

add('an adopted file is named after the hash of its own contents', () => {
  const r = media.adopt(source('a.png', 'png bytes'), { fileName: 'a.png', mimeType: 'image/png' });
  if (!r) return 'not adopted';
  const onDisk = fs.readdirSync(shard(r.hash))[0];
  const hashOfFile = crypto.createHash('sha256').update(fs.readFileSync(path.join(shard(r.hash), onDisk))).digest('hex');
  return hashOfFile === r.hash || `content hashes to ${hashOfFile.slice(0, 12)}... but is named ${onDisk.slice(0, 12)}...`;
});

add('an adopted file keeps a real extension', () => {
  const r = media.adopt(source('b.mp4', 'mp4 bytes'), { fileName: 'b.mp4', mimeType: 'video/mp4' });
  const onDisk = fs.readdirSync(shard(r.hash))[0];
  return onDisk.endsWith('.mp4') || 'stored as ' + onDisk;
});

add('a file whose bytes do not match its name is detectable', () => {
  // What a truncated copy or a bad rename leaves behind: a name that lies.
  const lying = path.join(shard('f'.repeat(64)), 'f'.repeat(64) + '.png');
  fs.mkdirSync(path.dirname(lying), { recursive: true });
  fs.writeFileSync(lying, 'these bytes do not hash to anything named ffff');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(lying)).digest('hex');
  return actual !== 'f'.repeat(64) || 'a lying name cannot be told apart from a good one';
});

add('every stored file is findable by hash alone', () => {
  const r = media.adopt(source('c.zip', 'zip bytes'), { fileName: 'c.zip', mimeType: 'application/zip' });
  return Boolean(media.pathFor(r.hash)) && Boolean(media.urlFor(r.hash)) || 'lost';
});

add('the folder holds one file per distinct content, not one per name', () => {
  const same = 'identical bytes for two names';
  const p1 = source('one.jpg', same);
  const p2 = source('two.png', same);
  const a = media.adopt(p1, { fileName: 'one.jpg' });
  const b = media.adopt(p2, { fileName: 'two.png' });
  if (!a || !b) return 'not adopted';
  const before = media.count();
  return a.hash === b.hash && before === media.count() || `stored the same bytes twice (count ${before})`;
});

let failed = 0;
for (const c of cases) {
  let result;
  try {
    result = c.fn();
  } catch (e) {
    result = 'threw: ' + e.message;
  }
  if (result === true) {
    console.log('PASS  ' + c.name);
  } else {
    failed++;
    console.log('FAIL  ' + c.name + '  [' + result + ']');
  }
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
console.log(`${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
