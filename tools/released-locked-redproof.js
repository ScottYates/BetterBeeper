/**
 * The red proof for the disk rule.
 *
 * A check that is green proves nothing on its own. What matters is that the
 * rule is load-bearing: that breaking it turns the check it was written for
 * red.
 *
 * The rule has two halves and both are proved here.
 *
 * The first is the old one: an old build sitting on the disk turns the check
 * red. That is proved by putting a build there.
 *
 * The second is the one that was missing: an old build whose files are held
 * open by another program is NOT a build sitting on the disk. It is the
 * leftover of a build that has already been emptied, and nothing - not the
 * prune tool, not a restart of anything - can remove it until the handle is
 * released. Counting it would make the check red for something that cannot
 * be fixed, and a check that cries wolf is a check that gets ignored.
 *
 * So the proof holds a file open - for real, with a real exclusive handle -
 * and shows that the check stops counting it, says so, and stays as it was.
 * The handle is a PowerShell process that opens the file with no sharing at
 * all, which is the same thing that stops a file being deleted.
 *
 * The assertions are about the difference between two runs rather than about
 * an absolute number, so the proof says the same thing on a machine whose
 * own old builds are locked and on one whose are not.
 *
 * Nothing here touches a real release. The file it puts on the disk is
 * sparse - it costs no space - and it is taken away again before anything
 * else happens.
 *
 * Run with `node tools/released-locked-redproof.js`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHECK = path.join(ROOT, 'tools', 'released-check.js');

// The fake build is older than any real one, so it is always among the old
// ones the rule is about. The name is not one the prune tool would ever
// create, so it cannot be confused with a real build.
const FAKE = path.join(ROOT, 'release-v0.0.2');
const FAKE_FILE = path.join(FAKE, 'win-unpacked', 'resources', 'app.asar');
const FAKE_MB = 120;

function run(args) {
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' && err.status !== 0 ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

const checks = [];

/**
 * Records a case.
 *
 * A case may pass `true`, or a function that returns true or a reason. The
 * function form is the one that matters: a function is truthy, so a harness
 * that treated it as the answer would report every one of them as a pass.
 */
const add = (name, ok, detail) => {
  if (typeof ok === 'function') {
    const result = ok();
    checks.push([name, result === true, result === true ? '' : String(result)]);
    return;
  }
  checks.push([name, Boolean(ok), detail || '']);
};

/** The numbers the check prints about the old build output. */
function parseStale(out) {
  const m = out.match(/^old output\s*:\s*(\d+) MB on disk, (\d+) MB removable, (\d+) MB held open/m);
  if (!m) return null;
  return { onDisk: Number(m[1]), removable: Number(m[2]), locked: Number(m[3]) };
}

// ---------------------------------------------------------------------------
// The fake build
// ---------------------------------------------------------------------------

/** Makes a sparse build directory that looks like a real one. */
function makeFakeBuild() {
  fs.mkdirSync(path.dirname(FAKE_FILE), { recursive: true });
  const fd = fs.openSync(FAKE_FILE, 'w');
  fs.ftruncateSync(fd, FAKE_MB * 1048576);
  fs.closeSync(fd);
}

/**
 * Takes the fake build away again.
 *
 * Only ever the one directory this proof made, and only by its exact name -
 * a cleanup that can reach anything else is a cleanup that can go wrong.
 */
function removeFakeBuild() {
  if (path.dirname(FAKE) !== ROOT) return;
  if (!/^release-v0\.0\.2$/.test(path.basename(FAKE))) return;
  try { fs.rmSync(FAKE, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// A file held open
// ---------------------------------------------------------------------------

/**
 * Holds the fake build's file open with no sharing at all.
 *
 * A file can only be deleted if every handle on it was opened with
 * FILE_SHARE_DELETE, so a handle that shares nothing stops the deletion -
 * which is exactly what happens when the desktop app is running out of the
 * build folder.
 *
 * The returned function releases it.
 */
function holdOpen(file) {
  const script =
    "$f = [System.IO.File]::Open('" + file.replace(/'/g, "''") + "', 'Open', 'ReadWrite', 'None'); " +
    'Start-Sleep -Seconds 300; $f.Dispose()';
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return () => {
    try { child.kill(); } catch { /* already gone */ }
  };
}

/** Waits for the holder to have the file before anyone asks about it. */
function settle(ms) {
  execFileSync(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { windowsHide: true });
}

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

/** The real build directories, so that the proof can show it did not touch them. */
const realBuildsBefore = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^release-v\d+\.\d+\.\d+$/.test(e.name))
  .map((e) => e.name)
  .sort();

const baseline = run([CHECK]);
const baselineStale = parseStale(baseline.out);
add('the baseline is readable', baselineStale !== null
  ? true
  : 'the check did not report the old output: ' + baseline.out.split(/\r?\n/).slice(-6).join(' | '));

if (!baselineStale) {
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// An old build on the disk turns the check red
// ---------------------------------------------------------------------------

let unlocked = null;
try {
  makeFakeBuild();
  unlocked = run([CHECK]);
  add('an old build on the disk turns the check red', () => {
    if (unlocked.code === 0) return 'the check stayed green with a 120 MB old build on the disk';
    if (!/old build output is still on disk/.test(unlocked.out)) {
      return 'the check failed for the wrong reason: ' + unlocked.out.split(/\r?\n/).slice(-4).join(' | ');
    }
    const stale = parseStale(unlocked.out);
    if (!stale) return 'the check did not report the old output';
    if (stale.removable < FAKE_MB) {
      return `the 120 MB old build was not counted as removable: ${stale.removable} MB`;
    }
    return true;
  });
} finally {
  removeFakeBuild();
}

// ---------------------------------------------------------------------------
// The same build, held open, is not a build sitting on the disk
// ---------------------------------------------------------------------------

let release = null;
let locked = null;
try {
  makeFakeBuild();
  release = holdOpen(FAKE_FILE);
  settle(1500);
  locked = run([CHECK]);
  add('an old build held open is not counted as a build on the disk', () => {
    const stale = parseStale(locked.out);
    if (!stale) return 'the check did not report the old output';
    if (stale.removable >= FAKE_MB) {
      return `the held-open build was still counted as removable: ${stale.removable} MB`;
    }
    if (stale.locked < FAKE_MB) {
      return `the held-open build was not reported as held open: ${stale.locked} MB`;
    }
    return true;
  });

  add('the check says which output is held open', () => {
    if (!/held open/.test(locked.out)) {
      return 'the check did not say anything about the held-open output: ' +
        locked.out.split(/\r?\n/).slice(-6).join(' | ');
    }
    return true;
  });

  add('a held-open build does not turn the check red', () => {
    if (locked.code !== baseline.code) {
      return `the check went from ${baseline.code} to ${locked.code} because of a held-open file`;
    }
    return true;
  });
} finally {
  if (release) release();
  settle(500);
  removeFakeBuild();
}

// ---------------------------------------------------------------------------
// The check is back to where it started
// ---------------------------------------------------------------------------

const after = run([CHECK]);
const afterStale = parseStale(after.out);
add('the check is back to where it started once the fake build is gone', () => {
  if (!afterStale) return 'the check did not report the old output';
  if (afterStale.removable !== baselineStale.removable) {
    return `the removable bytes changed: ${baselineStale.removable} MB -> ${afterStale.removable} MB`;
  }
  if (afterStale.locked !== baselineStale.locked) {
    return `the held-open bytes changed: ${baselineStale.locked} MB -> ${afterStale.locked} MB`;
  }
  return true;
});

// ---------------------------------------------------------------------------
// The proof left the real builds alone
// ---------------------------------------------------------------------------

const realBuildsAfter = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^release-v\d+\.\d+\.\d+$/.test(e.name))
  .map((e) => e.name)
  .sort();

add('the proof left the real builds alone', !fs.existsSync(FAKE)
  && realBuildsAfter.join(',') === realBuildsBefore.join(',')
  ? true
  : `before: ${realBuildsBefore.join(', ')} / after: ${realBuildsAfter.join(', ')}`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let failures = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}

console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
process.exit(failures ? 1 : 0);
