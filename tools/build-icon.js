/**
 * Draw the app icon and write the two files the app needs.
 *
 * Why this runs under Electron
 * ----------------------------
 * The artwork is a vector, and the files that need it are pixels. Electron is
 * the renderer that is already in this project, and it can take an SVG and
 * capture it at any size with the curves still resolved, which is the whole
 * point: an icon that was made by shrinking a 512 pixel picture looks like a
 * smudge at 16 pixels, and one that was drawn at 16 pixels does not.
 *
 * Why there is a script for it at all
 * ----------------------------------
 * Three places show the icon - the executable, the shortcut and the window -
 * and each of them wants a different file. A hand-made .ico and a hand-made
 * PNG drift apart the first time the artwork changes, and nobody notices
 * until the taskbar and the installer disagree. Here the artwork is one SVG
 * and everything else is generated, so they cannot.
 *
 * Usage: npm run icon
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { buildIco } = require('./icon-format');
const { SIZES, renderAll } = require('./icon-render');

const ROOT = path.join(__dirname, '..');

/** The artwork. The one file that is edited by hand. */
const SVG_FILE = path.join(ROOT, 'build', 'icon.svg');

/** The files that are generated from it. */
const ICO_FILE = path.join(ROOT, 'build', 'icon.ico');
const PNG_FILE = path.join(ROOT, 'src', 'assets', 'icon.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  if (!fs.existsSync(SVG_FILE)) {
    console.error(`no artwork at ${SVG_FILE}`);
    app.exit(2);
    return;
  }
  const svg = fs.readFileSync(SVG_FILE, 'utf8');
  fs.mkdirSync(path.dirname(PNG_FILE), { recursive: true });

  try {
    const images = await renderAll(svg, SIZES);

    // The PNG the window uses, and the largest image inside the .ico.
    const big = images.find((image) => image.size === 256);
    fs.writeFileSync(PNG_FILE, big.png);
    console.log(`  ${path.relative(ROOT, PNG_FILE)}  ${big.png.length} bytes`);

    // The .ico electron-builder copies into the exe and the shortcut.
    const ico = buildIco(images);
    fs.writeFileSync(ICO_FILE, ico);
    console.log(`  ${path.relative(ROOT, ICO_FILE)}  ${ico.length} bytes`);

    for (const image of images) {
      console.log(`    ${String(image.size).padStart(3)}px rendered`);
    }
    console.log('done');
  } catch (err) {
    console.error(`FAILED: ${err && (err.stack || err.message)}`);
    app.exit(1);
    return;
  }
  app.exit(0);
});
