/**
 * The red proof for the typing-marks-read check.
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
 * Run with: node tools/typeread-redproof.js
 */
const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  thread: path.join(ROOT, 'src', 'renderer', 'js', 'thread.js'),
  rule: path.join(ROOT, 'src', 'renderer', 'js', 'type-read.js'),
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
    what: 'typing does not mark the chat read',
    file: 'thread',
    from: '    markReadOnTyping();\n',
    to: '    // typing no longer marks anything read\n',
    expect: 'typing marks the open chat read',
  },
  {
    what: 'the rule ignores whether a chat is open',
    file: 'rule',
    from: '  if (!hasOpenChat) return false;',
    to: '  // the open chat no longer matters',
    expect: 'no open chat means nothing to have read',
  },
  {
    what: 'the rule ignores the unread count',
    file: 'rule',
    from: '  return Boolean(chatUnread);',
    to: '  return true;',
    expect: 'nothing to read, nothing is marked',
  },
  {
    what: 'the rule ignores the setting',
    file: 'rule',
    from: '  if (!markReadEnabled) return false;',
    to: '  // the setting no longer matters',
    expect: 'turning off mark-on-open also turns off mark-on-typing',
  },
  {
    what: 'every letter puts another call on the bridge',
    file: 'thread',
    from: '  if (marksInFlight.has(key)) return;\n',
    to: '  // no in-flight guard\n',
    expect: 'a burst of typing is one call, not one per letter',
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:typeread', '--silent'], {
      cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: true, windowsHide: true,
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

    const { out, code } = runCheck();
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
      if (code === 0) {
        holes.push(`${m.what} -- the case failed but the suite still exited zero`);
        console.log(`HOLE  ${m.what}\n      the case failed but the suite still said everything was fine`);
      } else {
        caught++;
        console.log(`RED   ${m.what}\n      "${m.expect}" failed as it should`);
      }
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
console.log('no holes.');
