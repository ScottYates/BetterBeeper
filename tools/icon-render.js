/**
 * Rasterising the artwork, shared by the builder and the check.
 *
 * Why this is shared
 * ------------------
 * The build writes the icon files and the check proves they still match the
 * artwork. If the two drew the icon in their own way, the check would be
 * comparing two different things and would prove nothing. So both go through
 * here.
 *
 * Why it needs Electron
 * ---------------------
 * The artwork is a vector and the files are pixels. Electron is the renderer
 * this project already has, and it can capture a page at any size with the
 * curves still resolved - which is the whole point of drawing at 16 pixels
 * rather than shrinking a 512 pixel picture, which is what turns an icon into
 * a smudge in the taskbar.
 *
 * Everything here needs the app to be ready, because a window cannot be made
 * before then.
 */
const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The sizes Windows actually asks for. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Render the SVG at one size.
 *
 * The SVG is put into a page of exactly this size and the page is captured,
 * so the browser does the scaling.
 */
async function renderPng(win, svg, size) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
    svg{width:${size}px;height:${size}px;display:block}</style></head><body>${svg}</body></html>`;

  const tmp = path.join(os.tmpdir(), `bb-icon-render-${size}.html`);
  fs.writeFileSync(tmp, html, 'utf8');

  win.setContentSize(size, size);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await win.loadFile(tmp);
  await new Promise((resolve) => setTimeout(resolve, 350));

  const image = await win.webContents.capturePage();
  const got = image.getSize();
  if (got.width !== size || got.height !== size) {
    throw new Error(`rendered ${got.width}x${got.height}, wanted ${size}x${size}`);
  }
  fs.rmSync(tmp, { force: true });

  return { png: image.toPNG(), bitmap: image.toBitmap(), size };
}

/**
 * Render the artwork at every size.
 *
 * One window is used for all of them: making a window per size works, but it
 * is slower and it is the kind of thing that leaves stray processes behind
 * when something throws half way through.
 */
async function renderAll(svg, sizes = SIZES) {
  const win = new BrowserWindow({
    show: false,
    width: 256,
    height: 256,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    const images = [];
    for (const size of sizes) {
      images.push(await renderPng(win, svg, size));
    }
    return images;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { SIZES, renderPng, renderAll };
