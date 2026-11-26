/**
 * The red proof for the multi-person share.
 *
 * A check that is green proves nothing on its own. What matters is that the
 * rules are load-bearing: that breaking each one turns the check it was
 * written for red, and that the check is what catches it.
 *
 * The baseline is asserted, not printed and trusted - a mutation reported as
 * "caught" against a case that was already failing is a false catch.
 *
 * Every break here is in the source only, and every one of them is put back
 * before the next, byte for byte. Nothing runs against the account and
 * nothing touches the user's own messages.
 *
 * Run with `npm run check:sharequeueredproof`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron');

const QUEUE = path.join(ROOT, 'src', 'renderer', 'js', 'share-queue.js');
const SHARE = path.join(ROOT, 'src', 'renderer', 'js', 'share.js');
const MODALS = path.join(ROOT, 'src', 'renderer', 'js', 'modals.js');

const originals = {
  [QUEUE]: fs.readFileSync(QUEUE, 'utf8'),
  [SHARE]: fs.readFileSync(SHARE, 'utf8'),
  [MODALS]: fs.readFileSync(MODALS, 'utf8'),
};

/**
 * The line endings a file uses.
 *
 * The tree is CRLF, and a pattern written with LF would not be found in it -
 * a red proof that silently finds nothing is worse than no red proof.
 */
const endings = {};
function eol(file) {
  if (endings[file] === undefined) {
    endings[file] = fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  }
  return endings[file];
}

/** Runs a suite under plain node and says what it said. */
function run(file) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', file)], {
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
  queue: () => run('share-queue-check.mjs'),
  share: () => runElectron('tools/share-check.js'),
};

const baseline = {
  queue: suites.queue(),
  share: suites.share(),
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

/** A pattern as lines, so the file's own line endings are used. */
const lines = (file, ...rows) => rows.join(eol(file));

const mutations = [
  {
    name: 'a refusal in one destination stops the whole queue',
    file: QUEUE,
    from: lines(QUEUE,
      '    outcome.sent = res.sent.length;',
      '    outcome.pending = res.pending;',
      '    outcome.state = res.ok ? SENT : FAILED;',
      '    outcome.error = res.error || \'\';'),
    to: lines(QUEUE,
      '    outcome.sent = res.sent.length;',
      '    outcome.pending = res.pending;',
      '    outcome.state = res.ok ? SENT : FAILED;',
      '    outcome.error = res.error || \'\';',
      '    if (!res.ok) break;'),
    suites: ['queue'],
    // The queue has to carry on: the next destination is a different chat with
    // a different person.
  },
  {
    name: 'the retry sends everything again, including what went',
    file: SHARE,
    from: lines(SHARE, '        pending: list.slice(index),'),
    to: lines(SHARE, '        pending: list,'),
    suites: ['queue'],
    // Two files are already in the chat. Sending them again puts them there
    // twice.
  },
  {
    name: 'the count of messages counts destinations instead',
    file: QUEUE,
    from: lines(QUEUE,
      'export function planSendCount(plan) {',
      '  let total = 0;',
      '  for (const target of plan || []) {',
      '    total += (target?.payloads || []).length;',
      '  }',
      '  return total;',
      '}'),
    to: lines(QUEUE,
      'export function planSendCount(plan) {',
      '  return (plan || []).length;',
      '}'),
    suites: ['queue'],
    // Every destination needs its own copies of the files.
  },
  {
    name: "a destination's own payloads are ignored",
    file: QUEUE,
    from: lines(QUEUE, '      payloads: [...(own || shared)],'),
    to: lines(QUEUE, '      payloads: [...shared],'),
    suites: ['queue'],
    // The retry's whole point is that it sends only what did not go.
  },
  {
    name: 'the run is not stopped when it is told to',
    file: QUEUE,
    from: lines(QUEUE,
      '    if (io && typeof io.shouldStop === \'function\' && io.shouldStop()) {',
      '      outcome.state = STOPPED;',
      '      continue;',
      '    }'),
    to: lines(QUEUE,
      '    if (false) {',
      '      outcome.state = STOPPED;',
      '      continue;',
      '    }'),
    suites: ['queue'],
    // Closing the picker stops the queue: the rest is not sent.
  },
  {
    name: 'picking a second destination replaces the first',
    file: MODALS,
    from: lines(MODALS, '    selected = toggleSelection(selected, key);'),
    to: lines(MODALS, '    selected = [key];'),
    suites: ['share'],
    // Two people at once is the whole point of the picker.
  },
  {
    name: 'the picker closes even when something failed',
    file: MODALS,
    from: lines(MODALS, '    if (!failed.length && !stopped.length) {'),
    to: lines(MODALS, '    if (true) {'),
    suites: ['share'],
    // A retry needs somewhere to live, and a closed picker cannot be retried
    // from.
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
  queue: suites.queue(),
  share: suites.share(),
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
