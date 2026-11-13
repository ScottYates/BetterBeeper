/**
 * The red proof for the "the update installs over the top" check.
 *
 * `tools/nsis-install-over-top-check.js` builds two NSIS programs and runs
 * them: one with the hook and one without. That check has a control built
 * into it - the program without the hook has to do the damage - but a control
 * inside the check says nothing about the *repository's* hook being broken.
 *
 * So this breaks the hook, in the repository, and requires the check to
 * notice. Two ways to break it, and each has its own case:
 *
 *   - the hook stops quitting, so the uninstaller carries on and deletes what
 *     it was told to delete.
 *   - the hook quits with a failure code, so the installer sees the uninstall
 *     fail and stops. The installer carries on only if the uninstaller
 *     succeeded, so a failure code here is the update failing, not the update
 *     being quick.
 *
 * The baseline is asserted, not trusted: the same number of cases before and
 * after, and every named case green in the baseline.
 *
 * Run with: node tools/nsis-install-over-top-redproof.js
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'tools', 'nsis', 'installer.nsh');

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
    what: 'the uninstaller is allowed to delete the shortcuts again',
    from: `  SetErrorLevel 0
  Quit`,
    to: `  SetErrorLevel 0
  ; The uninstaller carries on as usual.`,
    expect: 'with the hook the uninstaller stops before it deletes anything',
  },
  {
    what: 'the hook gives up with a failure code',
    from: '  SetErrorLevel 0',
    to: '  SetErrorLevel 1',
    expect: 'the uninstaller gives up with a success code, so the installer carries on',
  },
];

function runCheck() {
  try {
    const out = execFileSync('node', [path.join(ROOT, 'tools', 'nsis-install-over-top-check.js')], {
      cwd: ROOT, encoding: 'utf8', timeout: 600000, windowsHide: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
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

function caseCount(out) {
  const lines = out.split(/\r?\n/).filter((line) => /^\s*(PASS|FAIL)\s/.test(line));
  return lines.length;
}

const before = hash(HOOK);

let caught = 0;
const holes = [];

console.log('running the baseline...');
const baselineRun = runCheck();
const baselineCases = caseCount(baselineRun.out);
if (baselineRun.code !== 0 || baselineCases === 0) {
  console.log('the baseline is not green, so a mutation could not be caught by it');
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

console.log(`baseline: ${baselineCases} cases, ${namedCases.length} named cases green\n`);

for (const m of MUTATIONS) {
  const original = fs.readFileSync(HOOK, 'utf8');
  let applied = false;
  try {
    const edit = applyEdit(original, m.from, m.to);
    if (!edit.ok) {
      holes.push(`${m.what} -- ${edit.why}`);
      console.log(`SKIP  ${m.what}\n      ${edit.why}`);
      continue;
    }
    fs.writeFileSync(HOOK, edit.text, 'utf8');
    applied = true;

    const { out, code } = runCheck();
    const verdict = verdictFor(out, m.expect);
    const after = caseCount(out);

    if (after !== baselineCases) {
      holes.push(`${m.what} -- the check reported ${after} cases, not ${baselineCases}`);
      console.log(`HOLE  ${m.what}\n      the check lost cases: ${after} instead of ${baselineCases}`);
    } else if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
    } else if (verdict === 'FAIL') {
      if (code === 0) {
        holes.push(`${m.what} -- the case failed but the check still exited zero`);
        console.log(`HOLE  ${m.what}\n      the case failed but the check still said everything was fine`);
      } else {
        caught++;
        console.log(`RED   ${m.what}\n      "${m.expect}" failed as it should`);
      }
    } else {
      holes.push(`${m.what} -- "${m.expect}" stayed green`);
      console.log(`HOLE  ${m.what}\n      "${m.expect}" stayed green`);
    }
  } finally {
    if (applied) fs.writeFileSync(HOOK, original, 'utf8');
    const now = hash(HOOK);
    if (now !== before) {
      console.log('\nRESTORE FAILED for the hook script');
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
console.log('no holes.');
