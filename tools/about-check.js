/**
 * Dev check: the About row in settings shows the version and points at the
 * newest release.
 *
 * The version number is the one thing in the app that is never right unless it
 * is read from the main process at the moment the window opens, and the link
 * is the one thing that must not be pinned to a version: a fixed tag URL stops
 * being "the most recent release" the moment a newer one ships.
 *
 * Run with `npm run check:about`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const modalsURL = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'modals.js')).href;
const PKG = path.join(__dirname, '..', 'package.json');

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-about-check-profile'));

  // String.raw is load-bearing, not decoration. This harness is a template
  // literal, and a plain one eats backslashes: "\/" would collapse to "/" and
  // leave "//releases/latest/?$/" in the page, which JavaScript reads as a line
  // comment. The assertion would then quietly return undefined instead of
  // testing the URL, and the check would pass (or fail) for no reason at all.
  // check:syntax parses the raw text, so the two agree only with String.raw.
  const harness = String.raw`
    (async () => {
      const M = await import(${JSON.stringify(modalsURL)});
      const cases = [];
      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      add('the About row shows the running version', () => {
        const out = M.versionLabel('1.2.3');
        return out.includes('1.2.3') || ('got ' + JSON.stringify(out));
      });

      add('the version is named, not just numbered', () => {
        const out = M.versionLabel('1.2.3');
        return /better beeper/i.test(out) || ('got ' + JSON.stringify(out));
      });

      add('a missing version says so rather than inventing one', () => {
        // Falling back to a plausible-looking 1.0.0 is how a settings panel
        // ends up confidently wrong about what it is running.
        const out = M.versionLabel('');
        return /unknown/i.test(out) && !/\d/.test(out) || ('got ' + JSON.stringify(out));
      });

      add('the link resolves to the latest release, not a pinned tag', () => {
        // Single backslashes on purpose: the harness is String.raw, and
        // check:syntax parses that same raw text, so the two must agree.
        const url = String(M.RELEASES_URL);
        return /\/releases\/latest\/?$/.test(url) || ('got ' + url);
      });

      add('the link is https and points at this project', () => {
        const url = String(M.RELEASES_URL);
        return url.startsWith('https://github.com/ScottYates/BetterBeeper/')
          || ('got ' + url);
      });

      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:about' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(path.join(__dirname, 'about-harness.html'));
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);

  const cases = JSON.parse(result);
  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }

  // The version the app is built from has to be the one package.json names, or
  // the About row is showing the wrong number from the day it ships.
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const versionKnown = Boolean(pkg.version);
  if (!versionKnown) failed++;
  console.log(`${versionKnown ? 'PASS' : 'FAIL'}  package.json carries the version the About row shows  [${pkg.version || 'missing'}]`);

  console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
