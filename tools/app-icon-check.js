/**
 * check:appicon - the icon files and the wiring that uses them agree.
 *
 * What this is for
 * ----------------
 * The icon exists in three places: the artwork, the .ico that goes into the
 * executable and the shortcut, and the PNG the windows carry. They are
 * generated from each other, and generated things go stale silently: the
 * artwork gets edited, the .ico does not, and the app keeps shipping the old
 * picture with no complaint from anything.
 *
 * So the check does not look at the files and ask whether they look right. It
 * draws the artwork again, builds the .ico from that fresh drawing, and
 * compares the result with the file that is in the repository, byte for
 * byte. If the artwork changed and the files were not regenerated, this goes
 * red and says which one is stale.
 *
 * It also checks the wiring, because an icon that is generated perfectly and
 * then never handed to anything is still no icon at all.
 *
 * Usage: electron tools/run-check.js tools/app-icon-check.js
 *
 * The files can be pointed somewhere else with --root=<dir>, which is how the
 * red proof runs the check against a copy of the tree that has been broken on
 * purpose. The tools themselves always come from this repository, so the copy
 * is being checked by exactly the same code.
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { buildIco, parseIco, pngSize } = require('./icon-format');
const { SIZES, renderAll } = require('./icon-render');

const ROOT_ARG = process.argv.find((a) => a.startsWith('--root='));
const ROOT = ROOT_ARG ? path.resolve(ROOT_ARG.slice('--root='.length)) : path.join(__dirname, '..');
const SVG_FILE = path.join(ROOT, 'build', 'icon.svg');
const ICO_FILE = path.join(ROOT, 'build', 'icon.ico');
const PNG_FILE = path.join(ROOT, 'src', 'assets', 'icon.png');
const BUILDER_FILE = path.join(ROOT, 'electron-builder.yml');
const MAIN_FILE = path.join(ROOT, 'src', 'main', 'main.js');
const AUTH_FILE = path.join(ROOT, 'src', 'main', 'auth.js');

let fails = 0;

/**
 * The house rule for a check: compare against true, and keep the reason it
 * failed as a separate argument. A helper that coerces its own result cannot
 * tell a pass from a failure reason, because every non-empty string is
 * truthy - so a case written as add(name, cond ? true : 'why') passes even
 * when the condition is false.
 *
 * The reason is only printed when the case failed. A detail that explains a
 * failure sitting next to a PASS is worse than no detail at all, because it
 * reads like a description of the passing state.
 */
const ok = (name, cond, detail = '') => {
  const passed = cond === true;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${!passed && detail ? ' — ' + detail : ''}`);
  if (!passed) fails += 1;
};

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/** The first place two buffers differ, or -1 when they are the same. */
function firstDifference(a, b) {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : length;
}

async function main() {
  // The same setting the builder uses, so the drawing here matches the
  // drawing there. Without it the two runs can differ in the last bits.
  app.disableHardwareAcceleration();
  await app.whenReady();

  // ---- the artwork ----
  const artworkExists = fs.existsSync(SVG_FILE);
  ok('the artwork exists', artworkExists, SVG_FILE.replace(ROOT, '.'));
  if (!artworkExists) return;

  const svg = read(SVG_FILE);
  ok('the artwork is not empty', svg.length > 200, `${svg.length} bytes`);
  ok(
    'the artwork is ASCII',
    !/[^\x00-\x7F]/.test(svg),
    'a non-ASCII character in the artwork'
  );
  ok(
    'the artwork is drawn on a 512 square',
    svg.includes('viewBox="0 0 512 512"'),
    'the viewBox decides every size that is rendered from it'
  );

  // ---- the ico ----
  const icoExists = fs.existsSync(ICO_FILE);
  ok('the .ico exists', icoExists, ICO_FILE.replace(ROOT, '.'));
  if (!icoExists) return;

  const icoBytes = fs.readFileSync(ICO_FILE);
  const ico = parseIco(icoBytes);
  ok('the .ico parses as an icon', ico.ok === true, ico.ok ? '' : ico.reason);

  if (ico.ok) {
    const sizes = ico.entries.map((entry) => entry.width);
    const missing = SIZES.filter((size) => !sizes.includes(size));
    ok(
      'the .ico holds every size Windows asks for',
      missing.length === 0,
      missing.length ? `missing ${missing.join(', ')}` : `${sizes.length} sizes`
    );
    ok(
      'every image in the .ico is inside the file',
      ico.entries.every((entry) => entry.inside === true),
      ico.entries
        .filter((entry) => entry.inside !== true)
        .map((entry) => `${entry.width}px`)
        .join(', ')
    );

    // The 256 pixel one is a PNG, because Windows has understood PNGs inside
    // an .ico since Vista and the same picture as a DIB is four times the
    // size. The smaller ones are DIBs, because the older readers that still
    // draw icons in the shell want them that way.
    const big = ico.entries.find((entry) => entry.width === 256);
    ok('the 256 pixel image is a PNG', big ? big.isPng === true : false);
    const smallsAreDib = ico.entries
      .filter((entry) => entry.width !== 256)
      .every((entry) => entry.isPng === false);
    ok('the smaller images are DIBs', smallsAreDib === true);
  }

  // ---- the png the windows carry ----
  const pngExists = fs.existsSync(PNG_FILE);
  ok('the window png exists', pngExists, PNG_FILE.replace(ROOT, '.'));
  if (!pngExists) return;

  const pngBytes = fs.readFileSync(PNG_FILE);
  const size = pngSize(pngBytes);
  ok('the window png is a png', size !== null);
  ok(
    'the window png is 256 by 256',
    size !== null && size.width === 256 && size.height === 256,
    size ? `${size.width}x${size.height}` : 'not a png'
  );

  // ---- the two files are the same picture ----
  //
  // The 256 pixel image inside the .ico is the very png the window uses, so
  // the two must be the same bytes. If they are not, one of them was
  // regenerated and the other was not.
  const inside = ico.ok ? ico.entries.find((entry) => entry.width === 256) : null;
  ok(
    'the 256 pixel image in the .ico is the window png',
    inside ? Buffer.compare(inside.data, pngBytes) === 0 : false
  );

  // ---- the files match the artwork, right now ----
  //
  // This is the part that catches the artwork being edited without the files
  // being regenerated. The artwork is drawn again here and put through the
  // same builder, and the result is compared with what is in the repository.
  const fresh = await renderAll(svg, SIZES);
  const freshIco = buildIco(fresh);
  const at = firstDifference(freshIco, icoBytes);
  ok(
    'the .ico is what the artwork produces today',
    at === -1,
    at === -1
      ? `${icoBytes.length} bytes`
      : `first difference at byte ${at}; run "npm run icon"`
  );

  const freshBig = fresh.find((image) => image.size === 256);
  const pngAt = firstDifference(freshBig.png, pngBytes);
  ok(
    'the window png is what the artwork produces today',
    pngAt === -1,
    pngAt === -1
      ? `${pngBytes.length} bytes`
      : `first difference at byte ${pngAt}; run "npm run icon"`
  );

  // ---- the wiring ----
  const builder = read(BUILDER_FILE);
  ok(
    'the builder is told which icon to use',
    /^\s*icon:\s*build\/icon\.ico\s*$/m.test(builder),
    'electron-builder.yml wants "icon: build/icon.ico" under win'
  );

  const main = read(MAIN_FILE);
  ok(
    'the main window is given the icon',
    /icon:\s*APP_ICON/.test(main),
    'src/main/main.js wants "icon: APP_ICON" in the window options'
  );

  const auth = read(AUTH_FILE);
  ok(
    'the approval window is given the icon',
    /icon:\s*path\.join\(__dirname, '\.\.', 'assets', 'icon\.png'\)/.test(auth),
    'src/main/auth.js wants the icon path in the window options'
  );
}

main()
  .then(() => {
    console.log(`\n${fails ? 'FAILED' : 'OK'}  ${fails ? fails + ' failed' : 'all checks passed'}`);
    app.exit(fails ? 1 : 0);
  })
  .catch((err) => {
    console.error('failed:', err && (err.stack || err.message));
    app.exit(1);
  });
