/**
 * Runs every check suite, by exit code.
 *
 * Exit code, never a text match: a heuristic over the output once reported five
 * green suites as failures because the word "FAIL" appeared in a passing check
 * name.
 *
 * The suite list comes from package.json rather than being written out here,
 * because these do not all launch the same way - several need the Electron
 * binary and a couple are .mjs under plain node, and a runner that assumed
 * either would report them as failures.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const scripts = require(path.join(root, 'package.json')).scripts;
// The live probes drive the installed app over a debugging port; they are run
// deliberately against a running build, not as part of the suite sweep.
const LIVE = new Set(['check:live', 'check:paste-live', 'check:imagecopy-live', 'check:sendrace']);
// This script is itself a `check:` entry, and sweeping it would recurse.
const suites = Object.keys(scripts).filter(
  (name) => name.startsWith('check:') && !LIVE.has(name) && name !== 'check:all',
);

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = only.length ? suites.filter((s) => only.some((o) => s === o || s === `check:${o}`)) : suites;

let failed = 0;
for (const suite of targets) {
  let code = 0;
  try {
    execFileSync('npm', ['run', suite, '--silent'], {
      cwd: root,
      stdio: 'pipe',
      timeout: 900000,
      shell: true,
    });
  } catch (err) {
    code = typeof err.status === 'number' && err.status !== 0 ? err.status : 1;
    const tail = String(err.stdout || `${err.message}`)
      .trim()
      .split('\n')
      .slice(-6)
      .join('\n      ');
    console.log(`FAIL  npm run ${suite}\n      ${tail}`);
  }
  if (code !== 0) failed += 1;
  else process.stdout.write(`PASS  ${suite}\n`);
}

console.log(`\n${targets.length - failed}/${targets.length} suites passed`);
process.exit(failed ? 1 : 0);