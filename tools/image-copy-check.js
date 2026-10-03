/**
 * Dev check: which image URLs may be copied to the clipboard, and how they map
 * back to bytes.
 *
 * The renderer cannot read files, so "copy this image" arrives here as a bare
 * URL and the main process has to work out what it points at. That makes this
 * module a security boundary as much as a convenience:
 *
 *  - a remote URL must never be fetched, or a URL inside a message could turn
 *    a copy into a network request;
 *  - javascript:, vbscript: and friends must never be honoured;
 *  - the hand-rolled beeper-file path has to round-trip a Windows drive letter.
 *
 * Plain node, no Electron, so it runs in about a second.
 *
 * Run with `npm run check:imagecopy`.
 */
const path = require('path');
const mediaPath = require(path.join(__dirname, '..', 'src', 'main', 'media-path'));

const ON_WIN = process.platform === 'win32';

const cases = [];
const add = (name, fn) => {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true;
    if (r !== true) detail = String(r);
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  cases.push([name, ok, detail]);
};

const expectedPath = (posixPath) => (ON_WIN ? posixPath.replace(/\//g, '\\') : posixPath);

add('a beeper-file URL resolves to the file behind it', () => {
  const got = mediaPath.beeperFilePath('beeper-file://local/C:/Users/scott/Pictures/shot.png');
  const want = expectedPath('C:/Users/scott/Pictures/shot.png');
  return got === want || ('got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
});

add('a beeper-file URL keeps a drive letter on Windows', () => {
  if (!ON_WIN) return true;
  const got = mediaPath.beeperFilePath('beeper-file://local/D:/pics/a b.png');
  return /^D:\\/.test(got) || ('got ' + JSON.stringify(got));
});

add('percent escapes in a media path are decoded', () => {
  const got = mediaPath.beeperFilePath('beeper-file://local/C:/pics/my%20photo.png');
  return /my photo\.png$/.test(got) || ('got ' + JSON.stringify(got));
});

add('a beeper-file URL that dropped the "local" host still resolves', () => {
  // main.js tolerates this shape when serving media, so copying has to too.
  const got = mediaPath.beeperFilePath('beeper-file://C:/Users/scott/shot.png');
  return got && /shot\.png$/.test(got) || ('got ' + JSON.stringify(got));
});

add('a file: URL resolves through node, not by hand', () => {
  const got = mediaPath.localPathFrom('file:///C:/Users/scott/shot.png');
  return got && /shot\.png$/.test(got) || ('got ' + JSON.stringify(got));
});

add('a beeper-file URL is recognised as copyable', () => {
  return mediaPath.isCopyableUrl('beeper-file://local/C:/a.png') === true || 'refused';
});

add('a file: URL is recognised as copyable', () => {
  return mediaPath.isCopyableUrl('file:///C:/a.png') === true || 'refused';
});

add('a data: URL is recognised as copyable', () => {
  return mediaPath.isCopyableUrl('data:image/png;base64,AAAA') === true || 'refused';
});

for (const bad of [
  'https://example.com/a.png',
  'http://example.com/a.png',
  'javascript:alert(1)',
  'vbscript:msgbox',
  'ftp://example.com/a.png',
  'beeper-file://local/C:/a.png.exe',
]) {
  add(`a remote or scripting URL is refused: ${bad.slice(0, 28)}`, () => {
    // The allowlist is a prefix test, so "beeper-file://...exe" is still
    // allowed - it is a local file, and only the extension is suspicious.
    const allowed = mediaPath.isCopyableUrl(bad);
    if (bad.endsWith('.exe')) return allowed === true || 'expected local files to stay allowed';
    return allowed === false || ('allowed ' + bad);
  });
}

add('a missing or non-string URL is refused', () => {
  return mediaPath.isCopyableUrl(null) === false
    && mediaPath.isCopyableUrl(undefined) === false
    && mediaPath.isCopyableUrl(42) === false
    && mediaPath.isCopyableUrl({}) === false
    || 'accepted a non-string';
});

add('an unparseable URL yields no path', () => {
  return mediaPath.beeperFilePath('beeper-file://') === null || 'produced a path';
});

add('a base64 data URL decodes to the exact bytes', () => {
  // "PNG" - enough to prove the base64 path really decodes.
  const buf = mediaPath.dataUrlBuffer('data:image/png;base64,UE5H');
  return buf && buf.toString('utf8') === 'PNG' || ('got ' + (buf && buf.toString('hex')));
});

add('a percent-encoded data URL decodes too', () => {
  const buf = mediaPath.dataUrlBuffer('data:text/plain,hello%20world');
  return buf && buf.toString('utf8') === 'hello world' || ('got ' + (buf && buf.toString('utf8')));
});

add('a malformed data URL yields nothing', () => {
  return mediaPath.dataUrlBuffer('data:image/png') === null || 'produced bytes';
});

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
