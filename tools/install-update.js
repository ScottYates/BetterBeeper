#!/usr/bin/env node
/**
 * Post-build step: silently install the freshly built setup.exe over whatever copy
 * is currently installed, so `npm run dist` is the only command you ever run.
 *
 *   1. find the existing install (registry first, so a custom install dir works)
 *   2. close any running copy, since the installer cannot replace locked files
 *   3. run the installer with NSIS /S and wait for it
 *   4. verify the installed exe actually changed
 *
 * Flags:
 *   --keep-running   skip step 2 (install will likely fail or leave stale files)
 *   --check          report what would happen, install nothing
 */
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const KEEP_RUNNING = process.argv.includes('--keep-running');
const CHECK_ONLY = process.argv.includes('--check');

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

/** The newest setup.exe in release/, which is the one we just built. */
function findInstaller() {
  if (!fs.existsSync(RELEASE)) return null;
  const candidates = fs
    .readdirSync(RELEASE)
    .filter((f) => f.toLowerCase().endsWith('-setup.exe'))
    .map((f) => {
      const full = path.join(RELEASE, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full || null;
}

/**
 * Resolve the install directory from the per-user uninstall registry key.
 * InstallLocation is often blank for electron-builder NSIS, so fall back to
 * DisplayIcon (strip the ",0" icon index) and then to the UninstallString path.
 */
function findInstallDir(products = [PRODUCT]) {
  const list = products.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',');
  const raw = ps(`
$ErrorActionPreference = 'SilentlyContinue'
$names = @(${list})
$key = Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' |
  Where-Object {
    $p = Get-ItemProperty $_.PSPath
    $p.DisplayName -and ($names | Where-Object { $p.DisplayName -like "*$_*" })
  } |
  Select-Object -First 1
if (-not $key) { exit 0 }
$p = Get-ItemProperty $key.PSPath
$dir = $p.InstallLocation
if (-not $dir -and $p.DisplayIcon)    { $dir = ($p.DisplayIcon -replace ',\\d+$', '') }
if (-not $dir -and $p.UninstallString) { $dir = ($p.UninstallString -replace '^"', '') -replace '"$', '' }
if ($dir) { $dir = Split-Path -Parent $dir }
if ($dir) { Write-Output "DIR=$dir" }
Write-Output "VER=$($p.DisplayVersion)"
`);
  const dir = raw.split(/\r?\n/).find((l) => l.startsWith('DIR='))?.slice(4).trim();
  const ver = raw.split(/\r?\n/).find((l) => l.startsWith('VER='))?.slice(4).trim();
  if (!dir) return null;
  // Only accept a directory that actually holds one of the named exes, so a
  // stale uninstall entry cannot send verification at the wrong folder - and
  // report which exe was found, since during a rename that is the old name.
  const candidates = [PRODUCT, ...products.filter((n) => n !== PRODUCT)];
  const exe = candidates.map((n) => path.join(dir, `${n}.exe`)).find((p) => fs.existsSync(p));
  return exe ? { dir, ver, exe } : null;
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

const installer = findInstaller();
if (!installer) {
  console.error('✗ No *-setup.exe found in release/. Run electron-builder first.');
  process.exit(1);
}

const installerTime = fs.statSync(installer).mtimeMs;
const existing = findInstallDir([PRODUCT, ...LEGACY_PRODUCTS]);

console.log(`\n  installer : ${path.basename(installer)}`);
console.log(`  built     : ${new Date(installerTime).toLocaleString()}`);

let beforeStat = null;
if (existing) {
  const st = fs.statSync(existing.exe);
  beforeStat = { mtimeMs: st.mtimeMs, size: st.size };
  console.log(`  installed : ${existing.dir}`);
  console.log(`  current   : ${new Date(st.mtimeMs).toLocaleString()} (v${existing.ver || '?'})`);
} else {
  console.log('  installed : none found — this will be a first install');
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
console.log('\n  installing silently…');
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
// *older* than the setup.exe that carries it — so "is the install current?" is
// answered by comparing content against the build, not by comparing timestamps.
// That also makes this idempotent: re-running without rebuilding is still a pass.
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const builtAsar = path.join(RELEASE, 'win-unpacked', 'resources', 'app.asar');
const installedAsar = path.join(after.dir, 'resources', 'app.asar');
let current = false;

if (fs.existsSync(builtAsar) && fs.existsSync(installedAsar)) {
  current = sha(builtAsar) === sha(installedAsar);
} else if (beforeStat) {
  current = beforeStat.mtimeMs !== stat.mtimeMs || beforeStat.size !== stat.size;
}

if (!current) {
  console.error('\n✗ The installed copy does not match this build — nothing was replaced.');
  console.error('  Close the app manually, then run `npm run deploy`.');
  process.exit(1);
}

console.log(`  installed : ${after.dir}`);
console.log(`  updated   : ${new Date(stat.mtimeMs).toLocaleString()} (v${after.ver || '?'})`);
if (beforeStat) console.log(`  previous  : ${new Date(beforeStat.mtimeMs).toLocaleString()}`);
console.log('\n✓ Installed copy matches this build.\n');

// A rename installs into a new folder, so the previous one can be left behind
// on disk. Say so rather than leaving a confusing duplicate install around.
for (const legacy of LEGACY_PRODUCTS) {
  const dir = path.join(path.dirname(after.dir), legacy);
  if (path.resolve(dir) === path.resolve(after.dir)) continue;
  if (!fs.existsSync(dir)) continue;
  console.log(`  note: the previous install is still at`);
  console.log(`        ${dir}`);
  console.log(`        It is no longer used. Remove it when convenient.`);
}
console.log('');
