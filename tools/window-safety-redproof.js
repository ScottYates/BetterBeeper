/**
 * The red proof for "a check never puts a window on the user's screen".
 *
 * A check that is green proves nothing on its own. What matters is that each
 * rule here is load-bearing: that breaking it turns the check it was written
 * for red. That is what this does - it breaks each rule in turn and requires
 * the named check to catch it.
 *
 * The baseline is asserted, not printed and trusted. A harness that prints a
 * baseline and moves on is trusting it, and a mutation can then be reported
 * as "caught" against a case that was already failing - a false catch, and a
 * proof that looked green for the wrong reason. So the baseline has to be the
 * same number of cases as every later run, and every named case has to be
 * PASS in it, or this refuses to run at all.
 *
 * Run with `node tools/window-safety-redproof.js`.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  released: path.join(ROOT, 'tools', 'released-check.js'),
  typeread: path.join(ROOT, 'tools', 'typeread-check.js'),
  runner: path.join(ROOT, 'tools', 'private-desktop-runner.cs'),
  form: path.join(ROOT, 'tools', 'update-helper', 'StatusForm.cs'),
  updater: path.join(ROOT, 'src', 'main', 'updater.js'),
  handoff: path.join(ROOT, 'tools', 'update-handoff-check.js'),
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function applyEdit(original, from, to) {
  for (const pattern of [from, from.replace(/\n/g, '\r\n')]) {
    if (pattern !== from && !original.includes('\r\n')) continue;
    const count = original.split(pattern).length - 1;
    if (count === 1) return { ok: true, text: original.replace(pattern, to) };
    if (count > 1) return { ok: false, why: 'pattern appears ' + count + ' times' };
  }
  return { ok: false, why: 'pattern not found' };
}

const MUTATIONS = [
  {
    what: 'a tool starts a process without hiding its console',
    file: 'released',
    from: "{ windowsHide: true, cwd: ROOT, encoding: 'utf8' }",
    to: "{ cwd: ROOT, encoding: 'utf8' }",
    expect: 'no tool starts a process without hiding its console',
  },
  {
    // The flag has to be in the options Node reads. Written after them, it
    // looks like it is in force and does nothing at all - which is the same
    // as not writing it, except that it looks written.
    what: 'the flag is written where the call does not read it',
    file: 'released',
    from: "{ windowsHide: true, cwd: ROOT, encoding: 'utf8' }",
    to: "{ cwd: ROOT, encoding: 'utf8' }, { windowsHide: true }",
    expect: 'no tool starts a process without hiding its console',
  },
  {
    what: 'a check suite shows a browser window',
    file: 'typeread',
    from: 'const win = new BrowserWindow({ show: false });',
    to: 'const win = new BrowserWindow({ show: true });',
    expect: 'no check suite shows a browser window',
  },
  {
    what: 'the private desktop is the desktop the user is looking at',
    file: 'runner',
    from: 'startup.lpDesktop = "WinSta0\\\\" + desktopName;',
    to: 'startup.lpDesktop = "WinSta0\\\\Default";',
    expect: 'the private desktop is a desktop of its own',
  },
  {
    what: 'the helper takes the focus while it is off the screen',
    file: 'form',
    from: `                if (_offscreen)
                {
                    // A check must never take the focus.`,
    to: `                if (false)
                {
                    // A check must never take the focus.`,
    expect: 'the helper cannot take the focus while it is off the screen',
  },
  {
    what: 'the app runs the helper on a private desktop',
    file: 'updater',
    from: "  const args = [\n    '--installer', installer,",
    to: "  const args = [\n    '--private-desktop',\n    '--installer', installer,",
    expect: 'the app still starts the helper with a window',
  },
  {
    what: 'a check starts the helper on the desktop the user is looking at',
    file: 'handoff',
    from: `  const run = spawnSync(PRIVATE_DESKTOP_RUNNER, [
    PRIVATE_DESKTOP,
    HELPER_EXE,`,
    to: `  const run = spawnSync(HELPER_EXE, [
    PRIVATE_DESKTOP,`,
    expect: 'the helper is never run on the desktop the user is looking at',
  },
];

function runCheck() {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'window-safety-check.js')], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' && err.status !== 0 ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

function verdictFor(out, name) {
  for (const line of out.split(/\r?\n/)) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean.startsWith('PASS') && !clean.startsWith('FAIL')) continue;
    const rest = clean.slice(5).trim();
    const detail = rest.indexOf('  [');
    const printed = detail === -1 ? rest : rest.slice(0, detail);
    if (printed === name) return clean.startsWith('FAIL') ? 'FAIL' : 'PASS';
  }
  return null;
}

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

let caught = 0;
const holes = [];

// The baseline is asserted, not printed and trusted.
console.log('running the baseline...');
const baselineRun = runCheck();
const baselineCount = baselineRun.out.match(/(\d+)\/(\d+) checks passed/);
if (!baselineCount) {
  console.log('the baseline did not report a count');
  console.log(baselineRun.out.split(/\r?\n/).slice(-20).join('\n'));
  process.exit(1);
}

const namedCases = [...new Set(MUTATIONS.map((m) => m.expect))];
const notGreen = namedCases.filter((name) => verdictFor(baselineRun.out, name) !== 'PASS');
if (notGreen.length) {
  console.log('these named cases are not green in the baseline, so a mutation could not be caught by them:');
  for (const name of notGreen) console.log(`  - ${name}`);
  process.exit(1);
}

console.log(`baseline: ${baselineCount[1]}/${baselineCount[2]} checks passed, ${namedCases.length} named cases green\n`);

for (const m of MUTATIONS) {
  const target = FILES[m.file];
  const original = fs.readFileSync(target, 'utf8');
  let applied = false;
  try {
    const edit = applyEdit(original, m.from, m.to);
    if (!edit.ok) {
      holes.push(`${m.what} -- ${edit.why}`);
      console.log(`SKIP  ${m.what}\n      ${edit.why}`);
      continue;
    }
    fs.writeFileSync(target, edit.text, 'utf8');
    applied = true;

    const { out } = runCheck();
    const verdict = verdictFor(out, m.expect);
    const after = out.match(/(\d+)\/(\d+) checks passed/);

    if (!after) {
      holes.push(`${m.what} -- the suite did not report a count`);
      console.log(`HOLE  ${m.what}\n      the suite died before printing a count`);
    } else if (after[2] !== baselineCount[2]) {
      holes.push(`${m.what} -- the suite reported ${after[2]} cases, not ${baselineCount[2]}`);
      console.log(`HOLE  ${m.what}\n      the suite lost cases: ${after[2]} instead of ${baselineCount[2]}`);
    } else if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
    } else if (verdict === 'FAIL') {
      caught++;
      console.log(`RED   ${m.what}\n      "${m.expect}" failed as it should`);
    } else {
      holes.push(`${m.what} -- "${m.expect}" stayed green`);
      console.log(`HOLE  ${m.what}\n      "${m.expect}" stayed green`);
    }
  } finally {
    if (applied) fs.writeFileSync(target, original, 'utf8');
    const now = hash(target);
    if (now !== before[m.file]) {
      console.log(`\nRESTORE FAILED for ${path.basename(target)}`);
      process.exit(1);
    }
  }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught by the check they were written for`);
if (holes.length) {
  console.log('\nHoles (the rule is not actually load-bearing):');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);
