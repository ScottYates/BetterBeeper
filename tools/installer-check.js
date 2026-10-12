/**
 * Dev check: the install step must compare the installed copy against the build
 * its own installer came from.
 *
 * This exists because of a real false failure. Building into a scratch
 * `release-v<version>/` is how this project gets around a locked `release/`, but
 * the install step hardcoded `release/` for *both* the installer lookup and the
 * asar it verifies against. So a successful install was reported as
 *
 *     x The installed copy does not match this build - nothing was replaced.
 *
 * having actually replaced everything, because it compared the new install with
 * the previous release's build. A release that looked broken was not broken,
 * which is the worst kind of tooling lie: it sends you looking for a problem
 * that does not exist.
 *
 * The second bug is quieter. The registry lookup took the *first* uninstall key
 * matching any known product name, so the stale "Beeper Desktop Chat 1.0.0"
 * entry sorted ahead of the real one and the whole lookup was thrown away - the
 * script reported "installed: none found" for an app that was plainly installed,
 * then had no evidence left to verify against.
 *
 * Run with `npm run check:installer`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { buildDirs, findInstaller, buildAsarFor, compareInstall } = require('./install-update');

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!cond) failed++;
};

// A throwaway tree shaped like the repo: a locked-looking default `release/`
// with a stale build in it, and a fresh scratch build beside it.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-installer-check-'));
const writeAsar = (dir, tag) => {
  fs.mkdirSync(path.join(dir, 'win-unpacked', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'win-unpacked', 'resources', 'app.asar'), tag);
};
const writeInstaller = (dir, name, when) => {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, name);
  fs.utimesSync(full, when, when);
};

const staleRelease = path.join(stage, 'release');
const scratch = path.join(stage, 'release-v9.9.9');
writeAsar(staleRelease, 'STALE BUILD');
writeInstaller(staleRelease, 'Better Beeper-1.3.1-x64-setup.exe', new Date('2026-01-01T00:00:00Z'));
writeAsar(scratch, 'FRESH BUILD');
writeInstaller(scratch, 'Better Beeper-9.9.9-x64-setup.exe', new Date('2026-10-05T00:00:00Z'));

try {
  // --- finding the installer -------------------------------------------------
  check('build dirs include the scratch output', buildDirs(stage).includes(scratch), buildDirs(stage).join(', '));
  check('build dirs include the default output', buildDirs(stage).includes(staleRelease));

  const found = findInstaller(stage);
  check('the newest installer wins across build dirs', found && path.basename(found.full).includes('9.9.9'),
    found ? path.basename(found.full) : 'none found');
  check('the installer reports the directory it came from', found && found.dir === scratch,
    found ? found.dir : '');

  // The bug, stated as one assertion: the asar must come from the installer's
  // own directory, never a fixed one.
  check('the asar to verify against is beside the installer', found
    && buildAsarFor(found.full) === path.join(scratch, 'win-unpacked', 'resources', 'app.asar'),
    found ? buildAsarFor(found.full) : '');
  // Compared for equality, not by prefix: "release-v9.9.9" starts with
  // "release", so a startsWith test here would pass the bug it is looking for.
  check('the stale default build is not the comparison target', found
    && buildAsarFor(found.full) !== path.join(staleRelease, 'win-unpacked', 'resources', 'app.asar'),
    found ? buildAsarFor(found.full) : '');

  // --- the comparison itself -------------------------------------------------
  const installed = path.join(stage, 'installed-app');
  fs.mkdirSync(path.join(installed, 'resources'), { recursive: true });
  const installedAsar = path.join(installed, 'resources', 'app.asar');
  fs.writeFileSync(installedAsar, 'FRESH BUILD');

  check('a matching install reads as match', compareInstall({
    builtAsar: buildAsarFor(found.full), installedAsar, beforeStat: null, afterStat: null,
  }) === 'match');

  fs.writeFileSync(installedAsar, 'SOMETHING ELSE');
  check('a genuinely different install reads as mismatch', compareInstall({
    builtAsar: buildAsarFor(found.full), installedAsar, beforeStat: null, afterStat: null,
  }) === 'mismatch');

  // The false failure: no build to compare and nothing there before. Reporting
  // "mismatch" here is what made a good install look broken.
  check('no evidence at all reads as unverified, not mismatch', compareInstall({
    builtAsar: path.join(stage, 'nope', 'app.asar'),
    installedAsar: path.join(stage, 'also-nope', 'app.asar'),
    beforeStat: null,
    afterStat: null,
  }) === 'unverified');

  check('a missing build does not mask a real mismatch', compareInstall({
    builtAsar: path.join(stage, 'nope', 'app.asar'),
    installedAsar,
    beforeStat: { mtimeMs: 1, size: 1 },
    afterStat: { mtimeMs: 2, size: 2 },
  }) === 'match', 'the timestamp path must still work without a build');

  // --- idempotence: re-running without rebuilding is still a pass -------------
  const before = { mtimeMs: 1000, size: 500 };
  check('an unchanged exe with no build is not claimed as replaced', compareInstall({
    builtAsar: path.join(stage, 'nope', 'app.asar'),
    installedAsar: path.join(stage, 'also-nope', 'app.asar'),
    beforeStat: before,
    afterStat: before,
  }) === 'mismatch');

  // --- no build at all -------------------------------------------------------
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-installer-empty-'));
  try {
    check('an empty tree finds no installer', findInstaller(empty) === null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }

  // --- the dev build must not write into release/ ----------------------------
  // This is what made the locked folder matter at all. A handle from Defender
  // or the search indexer stayed on release\win-unpacked.tmp, and every build
  // then died with EBUSY on a file that could not be deleted or even renamed.
  // The build going somewhere fresh is the fix; this is the guard on it.
  const scripts = require(path.join(ROOT, 'package.json')).scripts;
  check('npm run dist does not invoke electron-builder directly', !/\belectron-builder\b/.test(scripts.dist || ''),
    scripts.dist);
  check('npm run dist goes through the scratch builder', /\btools\/dist\.js\b/.test(scripts.dist || ''),
    scripts.dist);

  const distSource = fs.readFileSync(path.join(ROOT, 'tools', 'dist.js'), 'utf8');
  check('the scratch builder passes an explicit output directory',
    /config\.directories\.output=/.test(distSource));
  check('the scratch builder never names release/ as its output',
    !/directories\.output=release['"/]/.test(distSource)
      && !/directories\.output=release\`/.test(distSource));
  check('the scratch builder never publishes on its own', /--publish=never/.test(distSource));
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

console.log(`\n${failed ? `${failed} failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);