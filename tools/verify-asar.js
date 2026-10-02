// Dev helper: confirm the packaged app.asar is byte-identical to the working tree's src/.
// Any mismatch means the installer predates the current source.
const asar = require('@electron/asar');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
// Default to the unpacked build; pass a path to verify an installed copy instead.
const asarPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');

// asar normalises internal paths to backslashes on Windows.
const inArchive = (rel) => rel.split('/').join(path.sep);

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const listed = new Set(
  asar
    .listPackage(asarPath)
    .filter((p) => !p.endsWith('\\') && !p.startsWith('\\node_modules'))
    .map((p) => p.replace(/^\\/, '').split(path.sep).join('/'))
);

const files = walk(path.join(root, 'src'), 'src');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let ok = 0;
const problems = [];

for (const rel of files) {
  if (!listed.has(rel)) {
    problems.push(`MISSING from asar: ${rel}`);
    continue;
  }
  const a = sha(asar.extractFile(asarPath, inArchive(rel)));
  const b = sha(fs.readFileSync(path.join(root, rel)));
  if (a === b) ok++;
  else problems.push(`DIFFERS: ${rel}`);
}

console.log(`src files compared: ${files.length}`);
console.log(`identical:           ${ok}`);
console.log(`problems:            ${problems.length}`);
for (const p of problems) console.log('  ' + p);

process.exit(problems.length === 0 ? 0 : 1);
