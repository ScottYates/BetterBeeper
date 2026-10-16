/**
 * Red proof for check:threadopen.
 *
 * The bug: opening a chat cleared the thread, drew a bare "Loading messages...",
 * and only then read the local store - throwing away messages the window was
 * already holding. Reported as "it shows blank while it syncs, even though there
 * were items there previously".
 *
 * Every mutation below reintroduces one part of that, and asserts that the NAMED
 * check fails. A mutation that leaves the suite green is reported as a hole,
 * because it means that rule is not actually load-bearing.
 *
 * The last one is the other direction: a neutral rewrite that must stay green.
 * The check measures the screen, so it has to survive the code changing shape.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/thread-open-redproof.js
 */
const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  thread: path.join(ROOT, 'src', 'renderer', 'js', 'thread.js'),
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Replace `from` with `to`, requiring it to appear exactly once.
 *
 * The repository is mostly LF with a few CRLF files, so a literal written with
 * \n would silently not match a CRLF file, every mutation would report SKIP, and
 * the suite would look green for the wrong reason.
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

const MUTATIONS = [
  {
    what: 'the thread blanks a chat it already has, while the store read is pending',
    from: '  const cached = renderableMessages(chatID);\n  if (cached.length) {',
    to: '  const cached = renderableMessages(chatID);\n  if (false) {',
    expect: 'a chat this window already has is drawn while the store read is pending',
  },
  {
    what: 'a failed store read wipes the thread even though it had messages',
    from: '  if (!cached.length) {\n    clear(listEl);\n    renderedNodes.clear();\n  }',
    to: '  if (true) {\n    clear(listEl);\n    renderedNodes.clear();\n  }',
    expect: 'a failed read does not throw away messages already on screen',
  },
  {
    what: 'the failure note is drawn on top of a thread that still has content',
    from: "    if (!cached.length) {\n      listEl.append(\n        el('div', { class: 'empty-note', text: 'Could not load messages. Beeper may still be indexing this chat.' }),\n      );\n    }",
    to: "    if (true) {\n      listEl.append(\n        el('div', { class: 'empty-note', text: 'Could not load messages. Beeper may still be indexing this chat.' }),\n      );\n    }",
    expect: 'a failed read is not reported over a thread that still has content',
  },
  {
    what: 'hasMore survives the chat switch, so the previous chat offers to scroll for more',
    from: '  hasMore = false;\n  const cached = renderableMessages(chatID);',
    to: '  const cached = renderableMessages(chatID);',
    expect: 'no scroll-back header from the chat opened before this one',
  },
  {
    what: 'the cache is treated as the whole answer and the store page is dropped',
    from: '  upsertMessages(chatID, items);\n  renderAll();',
    to: '  if (!cached.length) upsertMessages(chatID, items);\n  renderAll();',
    expect: 'messages the store returned are drawn once the read answers',
  },
  {
    // Not a bug. The cached messages are worked out by calling the shared
    // filter directly instead of the one-line wrapper that calls it, which is
    // the same thing, so this must stay green.
    what: 'TOLERATED: the cached list is worked out without the one-line wrapper',
    from: '  const cached = renderableMessages(chatID);',
    to: '  const cached = renderableFrom(state.messages.get(chatID));',
    expect: 'a chat this window already has is drawn while the store read is pending',
    expectGreen: true,
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:threadopen', '--silent'], {
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

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

let caught = 0;
let tolerated = 0;
const holes = [];
const expected = MUTATIONS.filter((m) => !m.expectGreen).length;
console.log(`baseline: ${runCheck().out.match(/(\d+\/\d+) checks passed/)?.[1] || '?'}\n`);

for (const m of MUTATIONS) {
  const target = FILES.thread;
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
    if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
    } else if (m.expectGreen) {
      if (verdict === 'PASS') {
        tolerated++;
        console.log(`TOLERATED  ${m.what}\n      stayed green, as it should`);
      } else {
        holes.push(`${m.what} -- went red on a neutral rewrite, so it is pinned to the code`);
        console.log(`HOLE  ${m.what}\n      went red on a neutral rewrite`);
      }
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
    if (now !== before.thread) {
      console.log(`\nRESTORE FAILED for ${path.basename(target)}`);
      process.exit(1);
    }
  }
}

console.log(`\n${caught}/${expected} mutations caught by the check they were written for`);
console.log(`${tolerated}/${MUTATIONS.length - expected} neutral rewrites tolerated (not re-pinned)`);
if (holes.length) {
  console.log('\nHoles:');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);