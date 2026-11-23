/**
 * Red proof for the people list and the phone numbers in it.
 *
 * A check that has never gone red is not evidence about anything. Each
 * mutation below reintroduces one specific bug and asserts that the NAMED
 * check fails. A mutation that leaves the check green is reported as a hole,
 * because it means that rule is not actually load-bearing.
 *
 * Three checks are covered here, because the feature is in three places: the
 * pure naming rules, the read out of Beeper Desktop's own store, and the list
 * that draws the number beside the name.
 *
 * Every file is restored in a finally, and the restore is verified by content
 * hash: if this script is killed part way through it must not leave the tree
 * mutated, and a restore that silently did nothing is worse than none.
 *
 * Run with: node tools/people-redproof.js
 */
const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  modals: path.join(ROOT, 'src', 'renderer', 'js', 'modals.js'),
  participants: path.join(ROOT, 'src', 'renderer', 'js', 'participants.js'),
  numbers: path.join(ROOT, 'src', 'main', 'participant-numbers.js'),
  css: path.join(ROOT, 'src', 'renderer', 'styles.css'),
};

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const MUTATIONS = [
  {
    what: 'the number is never put into the row',
    file: 'modals',
    check: 'people',
    from: '      if (number) slots.phone.textContent = number;',
    to: "      if (number) slots.phone.textContent = '';",
    expect: 'a number is shown beside the name',
  },
  {
    what: 'the list never asks for the numbers',
    file: 'modals',
    check: 'people',
    from: "  call(() => api.participants.numbers(ids), { context: 'phone numbers', fallback: {} }).then((numbers) => {",
    to: "  call(() => Promise.resolve({}), { context: 'phone numbers', fallback: {} }).then((numbers) => {",
    expect: 'the numbers were asked for by id',
  },
  {
    what: 'the number is drawn on a line of its own instead of beside the name',
    file: 'css',
    check: 'people',
    // Two edits, because it takes two to put the number on a line of its
    // own: the line has to stop being a row, and the number has to stop
    // being inline. The line alone is not enough - two inline spans in a
    // block still share a line - and the number alone is not enough
    // either, because a block child of a flex row is still a row member.
    edits: [
      [
        '.result-item-line { display: flex; align-items: baseline; gap: 7px; min-width: 0; }',
        '.result-item-line { display: block; min-width: 0; }',
      ],
      [
        '.result-item-phone { font-size: 12px; color: var(--text-dim); flex: none; }',
        '.result-item-phone { display: block; font-size: 12px; color: var(--text-dim); flex: none; }',
      ],
    ],
    expect: 'and the number is really drawn beside the name',
  },
  {
    what: 'a number is never found for anybody',
    file: 'participants',
    check: 'participants',
    from: "  const number = (id ? text(map[id]) : '') || text(p.phoneNumber);",
    to: "  const number = '';",
    expect: 'a contact with a number is given it',
  },
  {
    what: 'a person whose name is their own number is given the number as well',
    file: 'participants',
    check: 'participants',
    from: '  if (sameThing(number, participantName(p))) return \'\';',
    to: '  // broken on purpose: the number is printed beside the number',
    expect: 'a contact whose name is its own number is given nothing',
  },
  {
    what: 'the number is printed twice, beside the name and under it',
    file: 'participants',
    check: 'participants',
    from: '    if (shown && sameThing(value, shown)) continue;',
    to: '    // broken on purpose: the number is shown twice',
    expect: 'a number already beside the name is not repeated underneath it',
  },
  {
    what: 'the store is read for the wrong kind of identifier',
    file: 'numbers',
    check: 'participantnumbers',
    from: "WHERE identifier_type = 'phone'",
    to: "WHERE identifier_type = 'email'",
    expect: 'the number is found',
  },
  {
    what: 'the ids are not matched against the store',
    file: 'numbers',
    check: 'participantnumbers',
    from: '    const number = all[key];',
    to: "    const number = all['x' + key];",
    expect: 'the number is found',
  },
  {
    what: 'the answer is thrown away instead of being kept',
    file: 'numbers',
    check: 'participantnumbers',
    from: '  if (cache && cache.folder === folder && now - cache.at < CACHE_MS) return cache.numbers;',
    to: '  if (cache && cache.folder === folder && now - cache.at < CACHE_MS) return {};',
    expect: 'the answer is kept rather than read again',
  },
];

function runCheck(name) {
  try {
    const out = execFileSync(NPM, ['run', `check:${name}`, '--silent'], {
      windowsHide: true,
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300000,
      shell: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

/** The PASS/FAIL verdict for one named check, or null if it never printed. */
function verdictFor(out, name) {
  for (const line of out.split(/\r?\n/)) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean.startsWith('PASS') && !clean.startsWith('FAIL')) continue;
    const rest = clean.slice(5).trim();
    // The name of the case ends where its reason begins. The two check
    // styles print the reason differently, so both are cut here.
    const cut = rest.search(/\s+-\s|\s{2}\[/);
    const printed = cut === -1 ? rest : rest.slice(0, cut);
    if (printed === name) return clean.startsWith('FAIL') ? 'FAIL' : 'PASS';
  }
  return null;
}

/**
 * Apply one edit, whatever line endings the file happens to use.
 *
 * The patterns below are all written with plain \n, because that is what is
 * readable. Half the repo is CRLF and half is LF, so a pattern is retried
 * with CRLF line endings before it is called unmatched - rather than every
 * mutation carrying its own guess about the file it lands in, which is a
 * rule written once per file and certain to drift.
 */
function applyEdit(original, from, to) {
  for (const pattern of [from, from.replace(/\n/g, '\r\n')]) {
    if (pattern !== from && !original.includes('\r\n')) continue;
    const count = original.split(pattern).length - 1;
    if (count === 1) return { ok: true, text: original.replace(pattern, to) };
    if (count > 1) return { ok: false, why: 'pattern appears ' + count + ' times' };
  }
  return { ok: false, why: 'pattern not found' };
}

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

let caught = 0;
const holes = [];

console.log('the untouched tree must pass');
for (const name of ['people', 'participantnumbers', 'participants']) {
  const run = runCheck(name);
  const green = run.code === 0;
  console.log(`  ${green ? 'PASS' : 'FAIL'}  check:${name} is green on the real files`);
  if (!green) {
    holes.push(`the baseline: check:${name} was already red`);
    console.log(run.out.split(/\r?\n/).slice(-20).join('\n'));
  }
}
console.log('');

for (const m of MUTATIONS) {
  const target = FILES[m.file];
  const original = fs.readFileSync(target, 'utf8');
  let applied = false;
  try {
    // A mutation may be more than one edit. Each one has to land, and the
    // first that does not is reported rather than quietly skipped.
    const edits = m.edits || [[m.from, m.to]];
    let text = original;
    let why = '';
    for (const [from, to] of edits) {
      const edit = applyEdit(text, from, to);
      if (!edit.ok) {
        why = edit.why;
        break;
      }
      text = edit.text;
    }
    if (why) {
      holes.push(`${m.what} -- ${why}`);
      console.log(`SKIP  ${m.what}\n      ${why}`);
      continue;
    }
    fs.writeFileSync(target, text, 'utf8');
    applied = true;

    const { code, out } = runCheck(m.check);
    const verdict = verdictFor(out, m.expect);
    if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
      console.log(out.split(/\r?\n/).slice(-25).join('\n'));
    } else if (verdict === 'FAIL') {
      caught++;
      console.log(`RED   ${m.what}\n      "${m.expect}" failed as it should`);
    } else {
      holes.push(`${m.what} -- "${m.expect}" stayed green`);
      console.log(`GREEN ${m.what}\n      "${m.expect}" stayed green`);
      console.log(out.split(/\r?\n/).slice(-25).join('\n'));
    }
  } finally {
    if (applied) fs.writeFileSync(target, original, 'utf8');
    // The restore is verified, not assumed. A restore that silently did
    // nothing would leave the tree broken for whatever came next.
    const now = hash(target);
    if (now !== before[m.file]) {
      holes.push(`${m.what} -- the file was not restored`);
      console.log(`  the file ${m.file} was not restored`);
    }
  }
}

// Every file is back where it started.
let restored = true;
for (const [k, p] of Object.entries(FILES)) {
  if (hash(p) !== before[k]) restored = false;
}
console.log(restored ? '\nthe tree is back where it started' : '\nTHE TREE WAS NOT RESTORED');

const missed = holes.length;
console.log(`\n${missed ? 'FAILED' : 'OK'}  ${caught} caught, ${missed} missed`);
process.exit(missed ? 1 : 0);
