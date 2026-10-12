/**
 * Build and install, without ever writing into `release/`.
 *
 * electron-builder's default output is `release/`, and it stages into
 * `release/win-unpacked.tmp` before renaming it into place. On this machine a
 * handle from Defender or the search indexer stayed on a stale
 * `win-unpacked.tmp\resources\default_app.asar`, so every build died with
 *
 *     EBUSY: resource busy or locked, unlink '...release\win-unpacked.tmp\...'
 *
 * and the folder could not be deleted or even renamed afterwards - the handle
 * denied modification, not just removal. The only thing that releases it is a
 * reboot, so it is not worth waiting on.
 *
 * Building somewhere fresh sidesteps it entirely, which is what tools/release.js
 * has always done with `release-v<version>/`. This brings the same discipline to
 * the ordinary dev loop, so `npm run dist` works whether or not `release/` is
 * usable, and the folder can be left exactly as it is.
 *
 * The output name matches release.js on purpose: one convention, and
 * install-update.js already searches every `release-v*` directory, so it finds
 * this build without being told where it went.
 *
 * Usage:  node tools/dist.js [--out-dir=<name>] [--no-install]
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts });
}

/** The electron-builder output directory: a fresh scratch name by default. */
function outDir() {
  return arg('out-dir') || `release-v${pkg.version}`;
}

const out = outDir();
const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builderCli)) {
  console.error(`\nelectron-builder is not installed (${builderCli} missing)\n`);
  process.exit(1);
}

console.log(`building into ${out}...`);
// --publish=never is not optional. npm sets lifecycle_event=release when this is
// reached through `npm run release`, and electron-builder reads that as "go and
// publish to GitHub", then fails without a PAT. tools/release.js publishes with
// `gh` deliberately instead.
run(process.execPath, [
  builderCli,
  '--win', '--x64',
  `--config.directories.output=${out}`,
  '--publish=never',
]);

const built = fs.existsSync(path.join(ROOT, out))
  && fs.readdirSync(path.join(ROOT, out)).find((f) => f.toLowerCase().endsWith('-setup.exe'));
if (!built) {
  console.error(`\nno *-setup.exe in ${out}\n`);
  process.exit(1);
}
console.log(`installer: ${built}`);

if (process.argv.includes('--no-install')) {
  console.log('\n--no-install, stopping before the install step.\n');
  process.exit(0);
}

// The out dir is passed explicitly as well as being discoverable, so the install
// step compares against *this* build even if a newer-looking one sits elsewhere.
console.log('\ninstalling...');
run(process.execPath, [path.join(__dirname, 'install-update.js'), `--out-dir=${out}`]);