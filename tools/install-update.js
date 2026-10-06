#!/usr/bin/env node
/**
 * Post-build step: silently install the freshly built setup.exe over whatever copy
 * is currently installed, so `npm run dist` is the only command you ever run.
 *
 *   1. find the existing install (registry first, so a custom install dir works)
 *   2. close any running copy, since the installer cannot replace locked files
 *   3. run the installer with NSIS /S and wait for it
 *   4. verify the installed copy actually matches *the build that installer came
 *      from*
 *
 * Flags:
 *   --keep-running   skip step 2 (install will likely fail or leave stale files)
 *   --check          report what would happen, install nothing
 *   --out-dir=<dir>  the electron-builder output directory (default: searched for)
 */
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const KEEP_RUNNING = process.argv.includes('--keep-running');
const CHECK_ONLY = process.argv.includes('--check');
const OUT_DIR_OVERRIDE = (() => {
  const arg = process.argv.find((a) => a.startsWith('--out-dir='));
  return arg ? arg.slice('--out-dir='.length) : process.env.BB_OUT_DIR || null;
})();

const pkg = require(path.join(ROOT, 'package.json'));
const PRODUCT = pkg.build?.productName || pkg.productName || pkg.name;

// Older product names whose install is still registered. Without these the very
// first deploy after a rename would not find the existing copy to replace.
const LEGACY_PRODUCTS = ['Beeper Desktop Chat'];

/** Run a PowerShell snippet and return trimmed stdout ('' on failure). */
function ps(script, env = {}) {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 },
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Every electron-builder output directory worth looking in.
 *
 * electron-builder's default is `release/`, but this project deliberately builds
 * into a scratch `release-v<version>/` whenever the default one is locked by a
 * stale artifact. Hardcoding `release/` made the installer lookup fail and, worse,
 * made the verification compare against the *previous* release's build - so a
 * successful install was reported as "nothing was replaced".
 */
function buildDirs(root = ROOT) {
  if (OUT_DIR_OVERRIDE) return [path.resolve(root, OUT_DIR_OVERRIDE)];
  return fs
    .readdirSync(root)
    .filter((name) => name === 'release' || name.startsWith('release-v'))
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(dir))
    .sort((a, b) => (a === RELEASE ? -1 : b === RELEASE ? 1 : a.localeCompare(b)));
}

/**
 * The newest setup.exe across the build directories, with the directory it came
 * from. Both matter: the asar to verify against lives beside the installer, not
 * in a hardcoded place.
 */
function findInstaller(root = ROOT) {
  let best = null;
  for (const dir of buildDirs(root)) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('-setup.exe')) continue;
      const full = path.join(dir, name);
      let mtime;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) best = { full, mtime, dir };
    }
  }
  return best;
}

/**
 * The app.asar of the build an installer came from.
 *
 * electron-builder writes the installer and `win-unpacked/` side by side, so
 * deriving this from the installer's own directory keeps the comparison
 * self-consistent: it is impossible to compare against a different build than
 * the one being installed.
 */
function buildAsarFor(installerPath) {
  return path.join(path.dirname(installerPath), 'win-unpacked', 'resources', 'app.asar');
}

/**
 * Resolve the install directory from the per-user uninstall registry key.
 *
 * InstallLocation is often blank for electron-builder NSIS, so fall back to
 * DisplayIcon (strip the ",0" icon index) and then to the UninstallString path.
 *
 * Every matching entry is considered, not just the first. The stale
 * "Beeper Desktop Chat 1.0.0" entry sorts ahead of the real one, and taking it
 * and giving up reported "installed: none found" for an app that was plainly
 * installed - which then made the later verification fall back to no evidence at
 * all.
 */
function findInstallDir(products = [PRODUCT]) {
  const list = products.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',');
  const raw = ps(`
$ErrorActionPreference = 'SilentlyContinue'
$names = @(${list})
Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' |
  ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if (-not $p.DisplayName) { return }
    if (-not ($names | Where-Object { $p.DisplayName -like "*$_*" })) { return }
    $dir = $p.InstallLocation
    if (-not $dir -and $p.DisplayIcon)    { $dir = ($p.DisplayIcon -replace ',\\d+$', '') }
    if (-not $dir -and $p.UninstallString) { $dir = ($p.UninstallString -replace '^"', '') -replace '"$', '' }
    if ($dir) { $dir = Split-Path -Parent $dir }
    if ($dir) { Write-Output "DIR=$dir" }
    Write-Output "VER=$($p.DisplayVersion)"
  }
`);

  // Each block is a DIR= line (optional) followed by a VER= line.
  const blocks = [];
  let dir = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('DIR=')) dir = line.slice(4).trim();
    else if (line.startsWith('VER=')) {
      blocks.push({ dir, ver: line.slice(4).trim() });
      dir = null;
    }
  }
  if (!blocks.length) return null;

  // Only accept a directory that actually holds one of the named exes, so a
  // stale uninstall entry cannot send verification at the wrong folder - and
  // report which exe was found, since during a rename that is the old name.
  const candidates = [PRODUCT, ...products.filter((n) => n !== PRODUCT)];
  for (const block of blocks) {
    if (!block.dir) continue;
    const exe = candidates.map((n) => path.join(block.dir, `${n}.exe`)).find((p) => fs.existsSync(p));
    if (exe) return { dir: block.dir, ver: block.ver, exe };
  }
  return null;
}

/** Kill every process running from the install dir (the app spawns 4 of them). */
function stopRunning(dir) {
  return Number(
    ps(
      `$ErrorActionPreference = 'SilentlyContinue'
$d = $env:APP_INSTALL_DIR
$n = 0
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($d, 'OrdinalIgnoreCase') } | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  $n++
}
Start-Sleep -Milliseconds 900
Write-Output $n`,
      { APP_INSTALL_DIR: dir },
    ) || '0',
  );
}

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Is the installed copy the build this installer came from?
 *
 * Answers 'match', 'mismatch' or 'unverified'. The third one is the one that
 * matters: when there is no build to compare against and nothing was there
 * before, "cannot tell" is the truth, and reporting that as a mismatch makes a
 * good install look like a failed one.
 */
function compareInstall({ builtAsar, installedAsar, beforeStat, afterStat }) {
  if (builtAsar && installedAsar && fs.existsSync(builtAsar) && fs.existsSync(installedAsar)) {
    return sha256(builtAsar) === sha256(installedAsar) ? 'match' : 'mismatch';
  }
  if (beforeStat && afterStat) {
    const changed = beforeStat.mtimeMs !== afterStat.mtimeMs || beforeStat.size !== afterStat.size;
    return changed ? 'match' : 'mismatch';
  }
  return 'unverified';
}

function main() {
  const found = findInstaller();
  if (!found) {
    console.error('✗ No *-setup.exe found in any build directory (release/, release-v*).');
    console.error('  Run electron-builder first, or pass --out-dir=<dir>.');
    process.exit(1);
  }

  const { full: installer, mtime: installerTime, dir: installerDir } = found;
  const existing = findInstallDir([PRODUCT, ...LEGACY_PRODUCTS]);

  console.log(`\n  installer : ${path.basename(installer)}`);
  console.log(`  build dir : ${path.relative(ROOT, installerDir) || '.'}`);
  console.log(`  built     : ${new Date(installerTime).toLocaleString()}`);

  let beforeStat = null;
  if (existing) {
    const st = fs.statSync(existing.exe);
    beforeStat = { mtimeMs: st.mtimeMs, size: st.size };
    console.log(`  installed : ${existing.dir}`);
    console.log(`  current   : ${new Date(st.mtimeMs).toLocaleString()} (v${existing.ver || '?'})`);
  } else {
    console.log('  installed : none found - installing anyway');
  }

  if (CHECK_ONLY) {
    console.log('\n  --check only, nothing installed.\n');
    process.exit(0);
  }

  if (existing && !KEEP_RUNNING) {
    const killed = stopRunning(existing.dir);
    if (killed > 0) console.log(`  closing   : ${killed} running process(es)`);
  }

  // electron-builder's NSIS is a standard NSIS build, so /S is a silent reinstall.
  console.log('\n  installing silently...');
  const run = spawnSync(installer, ['/S'], { stdio: 'inherit', timeout: 10 * 60 * 1000 });

  if (run.error) {
    console.error(`\n✗ Could not run the installer: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) {
    console.error(`\n✗ Installer exited with code ${run.status}.`);
    console.error('  If the app was running, close it and run `npm run deploy`.');
    process.exit(1);
  }

  const after = findInstallDir();
  if (!after) {
    console.error('\n✗ Install finished but the app is not registered. Check the install dir.');
    process.exit(1);
  }

  const stat = fs.statSync(after.exe);

  // The installed exe carries the timestamp of the build it came from, which is
  // *older* than the setup.exe that carries it, so "is the install current?" is
  // answered by comparing content against the build, not by comparing timestamps.
  // That also makes this idempotent: re-running without rebuilding is still a pass.
  const verdict = compareInstall({
    builtAsar: buildAsarFor(installer),
    installedAsar: path.join(after.dir, 'resources', 'app.asar'),
    beforeStat,
    afterStat: { mtimeMs: stat.mtimeMs, size: stat.size },
  });

  console.log(`  installed : ${after.dir}`);
  console.log(`  updated   : ${new Date(stat.mtimeMs).toLocaleString()} (v${after.ver || '?'})`);
  if (beforeStat) console.log(`  previous  : ${new Date(beforeStat.mtimeMs).toLocaleString()}`);

  if (verdict === 'mismatch') {
    console.error('\n✗ The installed copy does not match the build this installer came from.');
    console.error('  The installer did run, so something else replaced the files afterwards.');
    process.exit(1);
  }

  if (verdict === 'unverified') {
    console.log('\n! Installed, but this could not be verified: there was no build to compare');
    console.log('  against and nothing was there before. Nothing suggests it failed.');
    console.log('');
    return;
  }

  console.log('\n✓ Installed copy matches this build.\n');

  // A rename installs into a new folder, so the previous one can be left behind
  // on disk. Say so rather than leaving a confusing duplicate install around.
  for (const legacy of LEGACY_PRODUCTS) {
    const dir = path.join(path.dirname(after.dir), legacy);
    if (path.resolve(dir) === path.resolve(after.dir)) continue;
    if (!fs.existsSync(dir)) continue;
    console.log(`  note: the previous install is still at`);
    console.log(`        ${dir}`);
    console.log('        It is no longer used. Remove it when convenient.');
  }
  console.log('');
}

if (require.main === module) main();

module.exports = { buildDirs, findInstaller, buildAsarFor, findInstallDir, compareInstall, OUT_DIR_OVERRIDE };