/**
 * The red proof for the delivery receipt.
 *
 * A check that is green proves nothing on its own. What matters is that the
 * rule is load-bearing: that breaking it turns the check it was written for
 * red, and that the tool that enforces it actually does.
 *
 * The baseline is asserted, not printed and trusted - a mutation reported as
 * "caught" against a case that was already failing is a false catch.
 *
 * Every break here is in the source only, and every one of them is put back
 * before the next. Nothing runs against the account and nothing touches the
 * user's own messages.
 *
 * Run with `node tools/send-status-redproof.js`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron');

const STATUS = path.join(ROOT, 'src', 'renderer', 'js', 'send-status.js');
const THREAD = path.join(ROOT, 'src', 'renderer', 'js', 'thread.js');

const originals = {
  [STATUS]: fs.readFileSync(STATUS, 'utf8'),
  [THREAD]: fs.readFileSync(THREAD, 'utf8'),
};

/** Runs a suite and says what it said. */
function run(file, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', file), ...(args || [])], {
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

/** Runs the Electron suite, which needs the Electron binary rather than node. */
function runElectron(file) {
  try {
    const out = execFileSync(ELECTRON, ['tools/run-check.js', file], {
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

const green = (result) => result.code === 0 && /checks passed/.test(result.out);
const failing = (result) => result.out.split(/\r?\n/).filter((l) => /^FAIL/.test(l.trim()))
  .map((l) => l.replace(/^FAIL\s+/, ''));

const checks = [];
const add = (name, ok, detail) => checks.push([name, ok, detail || '']);

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

const suites = {
  sendstatus: () => run('send-status-check.mjs'),
  rules: () => run('composer-edit-rules-check.mjs'),
  render: () => runElectron('tools/history-render-check.js'),
};

const baseline = {
  sendstatus: suites.sendstatus(),
  rules: suites.rules(),
  render: suites.render(),
};

const baselineGreen = Object.values(baseline).every(green);
add('the baseline is green', baselineGreen,
  Object.entries(baseline)
    .filter(([, r]) => !green(r))
    .map(([name, r]) => `${name}: ${r.out.split(/\r?\n/).slice(-4).join(' | ')}`)
    .join(' ; '));

if (!baselineGreen) {
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The mutations
// ---------------------------------------------------------------------------

const mutations = [
  {
    name: 'the receipt is not read as a receipt',
    file: STATUS,
    from: '    if (code === DELIVERED) return SENT;',
    to: '    if (code === DELIVERED) return PENDING;',
    // The reader is what both the edit rule and the bubble ask.
    suites: ['sendstatus', 'rules'],
  },
  {
    name: 'a flag nobody has seen is read as sent',
    file: STATUS,
    from: `    if (status === FAILED) return FAILED;
    // 'pending', and anything nobody has seen: not sent yet.
    return PENDING;`,
    to: `    if (status === FAILED) return FAILED;
    return SENT;`,
    suites: ['sendstatus'],
  },
  {
    name: 'the confirmation is compared with the string sent again',
    file: STATUS,
    from: `export function confirmedByBeeper(message) {
  return sendState(message) === SENT;
}`,
    to: `export function confirmedByBeeper(message) {
  const status = message?.sendStatus;
  if (status === undefined || status === null) return true;
  return status === 'sent';
}`,
    suites: ['rules'],
  },
  {
    name: 'the bubble reads the field instead of the state',
    file: THREAD,
    from: '    const status = sendState(message);',
    to: "    const status = message.sendStatus || 'sent';",
    suites: ['render'],
  },
  {
    name: 'the thread signature reads the field instead of the state',
    file: THREAD,
    from: '      sendState(m),',
    to: "      m.sendStatus || '',",
    suites: ['render'],
  },
];

for (const mutation of mutations) {
  const original = originals[mutation.file];
  if (!original.includes(mutation.from)) {
    add(mutation.name, false, 'the pattern is not in the file any more');
    continue;
  }

  fs.writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));

  try {
    const results = {};
    for (const name of mutation.suites) results[name] = suites[name]();

    const stillGreen = Object.entries(results).filter(([, r]) => green(r));
    if (stillGreen.length) {
      add(mutation.name, false, `${stillGreen.map(([n]) => n).join(', ')} stayed green`);
      continue;
    }

    const caught = Object.values(results).flatMap((r) => failing(r));
    if (!caught.length) {
      add(mutation.name, false, 'the suites went red without naming a case');
      continue;
    }
    add(mutation.name, true, caught.join(' ; '));
  } finally {
    fs.writeFileSync(mutation.file, original);
  }
}

// ---------------------------------------------------------------------------
// The tree is as it was
// ---------------------------------------------------------------------------

const restored = Object.entries(originals).every(([file, text]) => fs.readFileSync(file, 'utf8') === text);
add('the files are exactly as they were', restored);

const after = {
  sendstatus: suites.sendstatus(),
  rules: suites.rules(),
  render: suites.render(),
};
const afterGreen = Object.values(after).every(green);
add('every suite is green again', afterGreen,
  Object.entries(after).filter(([, r]) => !green(r))
    .map(([name, r]) => `${name}: ${r.out.split(/\r?\n/).slice(-4).join(' | ')}`)
    .join(' ; '));

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
