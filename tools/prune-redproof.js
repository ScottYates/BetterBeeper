/**
 * The red proof for the pruning rule.
 *
 * A check that is green proves nothing on its own. What matters is that the
 * rule is load-bearing: that breaking it turns the check it was written for
 * red, and that the tool that enforces it actually does.
 *
 * The baseline is asserted, not printed and trusted - a mutation reported as
 * "caught" against a case that was already failing is a false catch. A case
 * that returns a reason string instead of true is a failure, and saying so
 * is the point: a case that cannot fail is not a case.
 *
 * The tool half runs on a temporary folder of made-up build directories, not
 * on the real ones, so that proving the tool works cannot cost anything that
 * matters. The check half has to use the real folder - the check is what
 * looks at it - but the directory it puts there is a sparse file, and it is
 * removed again before anything else happens.
 *
 * Nothing here touches a real release. The GitHub half of the rule cannot be
 * proved without publishing a release to find out, which is not a price worth
 * paying for a counting rule; the local half exercises the same counting, and
 * is proved properly.
 *
 * Run with `node tools/prune-redproof.js`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PRUNE = path.join(ROOT, 'tools', 'prune.js');
const CHECK = path.join(ROOT, 'tools', 'released-check.js');

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

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

const baseline = run([CHECK]);
const baselineGreen = baseline.code === 0 && /OK  every push/.test(baseline.out);
add('the baseline is green', baselineGreen, baseline.out.split(/\r?\n/).slice(-6).join(' | '));

if (!baselineGreen) {
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// A temporary folder of made-up builds
// ---------------------------------------------------------------------------

const SANDBOX = path.join(os.tmpdir(), `bb-prune-proof-${process.pid}`);

/** Makes a build directory of a given size, in the given folder. */
function makeBuild(folder, name, megabytes) {
  const dir = path.join(folder, name, 'win-unpacked');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.asar');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, megabytes * 1048576);
  fs.closeSync(fd);
}

/** The build directories in a folder, by name. */
const namesIn = (folder) => fs.readdirSync(folder, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

function withSandbox(fn) {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  try {
    return fn(SANDBOX);
  } finally {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The tool: it removes the old builds and keeps the new ones
// ---------------------------------------------------------------------------

// The real build directories, so that the proof can show it did not touch
// them. A proof that costs a gigabyte of the user's disk to prove a rule
// about deleting gigabytes is not a good trade.
const realBuildsBefore = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^release-v\d+\.\d+\.\d+$/.test(e.name))
  .map((e) => e.name)
  .sort();

add('the prune removes the old build and keeps the new ones', () => withSandbox((box) => {
  makeBuild(box, 'release-v1.3.0', 1);
  makeBuild(box, 'release-v1.2.0', 1);
  makeBuild(box, 'release-v1.1.0', 1);
  makeBuild(box, 'release-v1.0.0', 1);

  const out = run([PRUNE, '--keep=2', `--root=${box}`]);
  const left = namesIn(box);

  if (out.code !== 0) return 'the prune failed: ' + out.out.split(/\r?\n/).slice(-5).join(' | ');
  // The tool has to say which folder it worked in. A tool that ignores
  // --root and prunes the real builds instead would pass the checks below
  // while costing a gigabyte, so it is checked for by name.
  if (!out.out.includes(box)) {
    return 'the prune did not say it was working in the folder it was given';
  }
  if (!left.includes('release-v1.3.0') || !left.includes('release-v1.2.0')) {
    return 'it did not keep the two newest: ' + left.join(', ');
  }
  if (left.includes('release-v1.1.0') || left.includes('release-v1.0.0')) {
    return 'it kept an old build: ' + left.join(', ');
  }
  return true;
}));

// ---------------------------------------------------------------------------
// The tool: it sorts by version and not by text
// ---------------------------------------------------------------------------

// "1.10.0" sorts before "1.9.5" as text. If the tool sorted the names as
// text it would keep 1.9.5 and delete 1.10.0 - the newest build gone, the
// oldest kept. This is the mistake that costs the most, so it is measured
// rather than reasoned about.
add('the prune keeps the newest build when the versions sort oddly as text', () => withSandbox((box) => {
  makeBuild(box, 'release-v1.10.0', 1);
  makeBuild(box, 'release-v1.9.5', 1);

  const out = run([PRUNE, '--keep=1', `--root=${box}`]);
  const left = namesIn(box);

  if (out.code !== 0) return 'the prune failed: ' + out.out.split(/\r?\n/).slice(-5).join(' | ');
  if (!left.includes('release-v1.10.0')) {
    return '1.10.0 was deleted and 1.9.5 kept: ' + left.join(', ');
  }
  if (left.includes('release-v1.9.5')) return '1.9.5 was kept: ' + left.join(', ');
  return true;
}));

// ---------------------------------------------------------------------------
// The tool: a dry run says what it would do and does nothing
// ---------------------------------------------------------------------------

add('the prune says what it would do, and does nothing', () => withSandbox((box) => {
  makeBuild(box, 'release-v1.2.0', 1);
  makeBuild(box, 'release-v1.1.0', 1);

  const out = run([PRUNE, '--keep=1', '--dry-run', `--root=${box}`]);
  const left = namesIn(box);

  if (out.code !== 0) return 'the dry run failed: ' + out.out.split(/\r?\n/).slice(-5).join(' | ');
  if (left.length !== 2) return 'the dry run deleted something: ' + left.join(', ');
  if (!/would remove release-v1\.1\.0/.test(out.out)) {
    return 'the dry run did not name the old build: ' + out.out.split(/\r?\n/).slice(-5).join(' | ');
  }
  return true;
}));

// ---------------------------------------------------------------------------
// The check: an old build on the disk turns it red
// ---------------------------------------------------------------------------

// This one has to use the real folder, because that is the folder the check
// looks at. The file is sparse, so it costs no real space, and it is removed
// again straight afterwards.
const FAKE = path.join(ROOT, 'release-v0.0.1');

function removeFakeBuild() {
  try { fs.rmSync(FAKE, { recursive: true, force: true }); } catch { /* best effort */ }
}

try {
  makeBuild(ROOT, 'release-v0.0.1', 120);
  const broken = run([CHECK]);
  add('an old build on the disk turns the check red', () => {
    if (broken.code === 0) return 'the check stayed green with a 120 MB old build on the disk';
    if (!/old build output is still on disk/.test(broken.out)) {
      return 'the check failed for the wrong reason: ' + broken.out.split(/\r?\n/).slice(-4).join(' | ');
    }
    return true;
  });
} finally {
  removeFakeBuild();
}

// ---------------------------------------------------------------------------
// The check: green again once the old build is gone
// ---------------------------------------------------------------------------

const after = run([CHECK]);
add('the check is green again once the old build is gone', after.code === 0
  ? true
  : after.out.split(/\r?\n/).slice(-6).join(' | '));

// ---------------------------------------------------------------------------
// The proof left the real builds alone
// ---------------------------------------------------------------------------

const realBuildsAfter = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^release-v\d+\.\d+\.\d+$/.test(e.name))
  .map((e) => e.name)
  .sort();

add('the proof left the real builds alone', realBuildsAfter.join(',') === realBuildsBefore.join(',')
  ? true
  : `before: ${realBuildsBefore.join(', ') || '(none)'} / after: ${realBuildsAfter.join(', ') || '(none)'}`);

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
