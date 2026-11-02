/**
 * The check runner must never put a window on the desktop.
 *
 * A check that does not parse is an uncaught exception in Electron's main
 * process, and Electron answers that with an error dialog: a window that
 * pops up in the middle of the desktop, looking like the app under test
 * crashing, for a mistake in a file nobody was even running.
 *
 * So every Electron check is launched through `tools/run-check.js`, which
 * parses the file before Electron loads it and reports a broken one in the
 * terminal instead.
 *
 * This runs under plain node, not Electron. There is no window to put on the
 * screen from here, and the two cases that need a file to be broken are
 * checked by running the launcher on it - the launcher only uses node's own
 * modules until it requires the check, so it can be driven without Electron
 * at all.
 *
 * Run with: npm run check:launcher
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LAUNCHER = path.join(__dirname, 'run-check.js');

const cases = [];
const add = (name, ok, detail = '') => cases.push([name, ok === true, ok === true ? '' : String(detail)]);

// --- every Electron check goes through the launcher ------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const electronChecks = Object.entries(pkg.scripts).filter(([, value]) => /^electron\s+tools\/.*\.js$/.test(value));
const bare = electronChecks.filter(([, value]) => !value.includes('run-check.js'));

add('every Electron check is launched through the validating runner',
  bare.length === 0,
  bare.length ? bare.map(([name]) => name).join(', ') + ' still launch Electron directly' : '');

add('there are Electron checks to protect',
  electronChecks.length > 20,
  'only ' + electronChecks.length + ' found');

// --- the runner reports a broken file instead of loading it ----------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-launcher-'));

// A file that does not parse: a stray backtick inside a template literal.
// This is the mistake that produced the dialog in the first place.
const broken = path.join(scratch, 'broken-check.js');
fs.writeFileSync(broken, "const harness = `a line with a 'flex: 1' in it`;`nconst x = 1;`n", 'utf8');

const brokenRun = spawnSync(process.execPath, [LAUNCHER, broken], { encoding: 'utf8' });

add('a file that does not parse is reported',
  brokenRun.status === 1 && /does not parse/.test(brokenRun.stdout + brokenRun.stderr),
  'exit ' + brokenRun.status + ': ' + String(brokenRun.stdout + brokenRun.stderr).slice(0, 200));

add('and the message names the file',
  /broken-check\.js/.test(brokenRun.stdout + brokenRun.stderr),
  String(brokenRun.stdout + brokenRun.stderr).slice(0, 200));

// A file that parses but throws when it is loaded.
const throws = path.join(scratch, 'throwing-check.js');
fs.writeFileSync(throws, "throw new Error('this check is broken');\n", 'utf8');

const throwRun = spawnSync(process.execPath, [LAUNCHER, throws], { encoding: 'utf8' });

add('a check that throws when it starts is reported',
  throwRun.status === 1 && /failed to start/.test(throwRun.stdout + throwRun.stderr),
  'exit ' + throwRun.status + ': ' + String(throwRun.stdout + throwRun.stderr).slice(0, 200));

// A file that is fine is loaded and runs.
const fine = path.join(scratch, 'fine-check.js');
fs.writeFileSync(fine, "console.log('the check ran');\n", 'utf8');

const fineRun = spawnSync(process.execPath, [LAUNCHER, fine], { encoding: 'utf8' });

add('a check that is fine still runs',
  fineRun.status === 0 && /the check ran/.test(fineRun.stdout),
  'exit ' + fineRun.status + ': ' + String(fineRun.stdout + fineRun.stderr).slice(0, 200));

fs.rmSync(scratch, { recursive: true, force: true });

// --- the runner cannot be interrupted by an exception -----------------------
//
// This one is a shape assertion, and it says so: the dialog appears when an
// exception reaches the top of the stack with nobody listening, so what
// matters is that the runner listens. Proving it by running a check that
// throws under Electron would risk the very dialog this is here to prevent.

const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');

add('the runner listens for an exception nobody caught',
  /process\.on\('uncaughtException'/.test(launcherSrc));

add('the runner listens for a promise nobody awaited',
  /process\.on\('unhandledRejection'/.test(launcherSrc));

add('the runner parses the file before it loads it',
  launcherSrc.indexOf('new vm.Script(') < launcherSrc.indexOf('require(file)'),
  'the parse has to come first, or a file that does not parse reaches Electron');

add('the runner loads the check inside a catch',
  /try\s*\{[^}]*require\(file\)[^}]*\}\s*catch/.test(launcherSrc));

// --- the report -------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
