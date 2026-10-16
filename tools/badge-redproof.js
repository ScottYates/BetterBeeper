/**
 * Red proof for check:badge.
 *
 * The bug this covers is not a shipped bug but a shipped check that could not
 * tell the difference between right and wrong. check:badge pinned the literal
 * text `totalUnread(chatList(), isArchived)` in sidebar.js. v1.19.0 bound
 * chatList() to a local, because the mark-all-read button needs the same list,
 * and the behaviour stayed correct - but the pinned string vanished and the
 * suite went red on a refactor.
 *
 * So this proves two things about the check that replaced it.
 *
 *   RED       every mutation that really breaks the wiring turns it red,
 *             including one the old regex would have passed: a call written
 *             inline as totalUnread(chatList(), isArchived) is correct-looking
 *             but is not the list the rest of syncBadge measures, and a check
 *             that only greps for that literal cannot see the difference.
 *
 *   TOLERATED a neutral refactor - renaming the local - stays green. A check
 *             that only survives because it re-pinned the new spelling would
 *             have broken again on the next rename, which is what happened
 *             once already.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * What this cannot know: syncBadge touches the DOM, so it cannot be imported
 * and called here. These assertions read the source, which means they would
 * also go red on a rewrite of syncBadge into an arrow function or a
 * differently named binding. That is the same limitation the neighbouring
 * source assertions in badge-check.js already carry, and it is a false
 * positive at worst - never a green on a real break, which is the direction
 * that matters in a release gate.
 *
 * Run with: node tools/badge-redproof.js
 */
const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  sidebar: path.join(ROOT, 'src', 'renderer', 'js', 'sidebar.js'),
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Replace `from` with `to`, requiring it to appear exactly once.
 *
 * The repository is mostly LF with a few CRLF files, so a literal written with
 * \n would silently not match a CRLF file and every mutation would report SKIP
 * and the suite would look green. Both forms are tried, and only for a file
 * that actually uses that ending.
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

// The two lines the check is about, in the shape v1.19.0 left them in.
const COUNTS = '  const chats = chatList();\n  const total = totalUnread(chats, isArchived);';

const MUTATIONS = [
  {
    what: 'the badge counts a filtered list instead of every chat',
    from: COUNTS,
    to: '  const chats = chatList();\n  const total = totalUnread(chats.filter((chat) => !chat.mergedIntoChatID), isArchived);',
  },
  {
    what: 'archived chats are counted again, so the badge never clears',
    from: COUNTS,
    to: '  const chats = chatList();\n  const total = totalUnread(chats);',
  },
  {
    what: 'the badge counts only the chats on screen',
    from: COUNTS,
    to: '  const chats = chatList();\n  const visible = chatList().filter((chat) => !chat.isLowPriority);\n  const total = totalUnread(visible, isArchived);',
  },
  {
    // The old check passed this one. The inline call is not wrong on its own,
    // but it counts a second, separately-built list, and the sidebar's own
    // list is no longer what reaches the count.
    what: 'the count is built from a fresh inline chatList() the old check could not see',
    from: COUNTS,
    to: '  const total = totalUnread(chatList(), isArchived);\n  const chats = chatList();',
  },
  {
    what: 'syncBadge stops asking for the chat list at all',
    from: '  const chats = chatList();',
    to: '  const chats = [];',
  },
  {
    // Not a bug. The local's name is not part of the rule, so this must stay
    // green; if it does not, the check has been re-pinned to the spelling.
    what: 'TOLERATED: the local holding the chat list is renamed',
    from: COUNTS,
    to: '  const all = chatList();\n  const total = totalUnread(all, isArchived);',
    expectGreen: true,
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:badge', '--silent'], {
      cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

/** The verdict for the one named check, ignoring every other line. */
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

const CHECK = 'the chat list is what the badge counts';

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

let caught = 0;
let tolerated = 0;
const holes = [];
const expected = MUTATIONS.filter((m) => !m.expectGreen).length;
console.log(`baseline: ${runCheck().out.match(/(\d+\/\d+) checks passed/)?.[1] || '?'}\n`);

for (const m of MUTATIONS) {
  const target = FILES.sidebar;
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
    const verdict = verdictFor(out, CHECK);
    if (verdict === null) {
      holes.push(`${m.what} -- "${CHECK}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
    } else if (m.expectGreen) {
      if (verdict === 'PASS') {
        tolerated++;
        console.log(`TOLERATED  ${m.what}\n      stayed green, as it should`);
      } else {
        holes.push(`${m.what} -- went red on a refactor, so it is pinned to the spelling`);
        console.log(`HOLE  ${m.what}\n      went red on a neutral rename`);
      }
    } else if (verdict === 'FAIL') {
      caught++;
      console.log(`RED   ${m.what}\n      "${CHECK}" failed as it should`);
    } else {
      holes.push(`${m.what} -- "${CHECK}" stayed green`);
      console.log(`HOLE  ${m.what}\n      "${CHECK}" stayed green`);
    }
  } finally {
    if (applied) fs.writeFileSync(target, original, 'utf8');
    const now = hash(target);
    if (now !== before.sidebar) {
      console.log(`\nRESTORE FAILED for ${path.basename(target)}`);
      process.exit(1);
    }
  }
}

console.log(`\n${caught}/${expected} mutations caught by the check they were written for`);
console.log(`${tolerated}/${MUTATIONS.length - expected} neutral refactors tolerated (not re-pinned)`);
if (holes.length) {
  console.log('\nHoles:');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);