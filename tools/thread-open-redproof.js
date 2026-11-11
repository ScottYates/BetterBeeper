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
 * Two of the mutations below are about the thread not being drawn when
 * nothing changed: the signature that decides it has to describe what is on
 * screen, and a message has to be in the store before the change is
 * announced, or the thread is told about a message it cannot see.
 *
 * The baseline is asserted. A mutation "caught" against a case that was
 * already red proves nothing, so the suite has to be green and every named
 * case has to be PASS in it, or the proof refuses to run.
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
  state: path.join(ROOT, 'src', 'renderer', 'js', 'state.js'),
  css: path.join(ROOT, 'src', 'renderer', 'styles.css'),
  receipts: path.join(ROOT, 'src', 'renderer', 'js', 'read-receipts.js'),
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
    // The signature is what decides that the thread does not have to be
    // drawn again. After a draw it has to describe what is on screen, or
    // the next event that changes nothing computes a different signature
    // and the thread is drawn again - detaching every image in it, which
    // restarts an animated GIF.
    what: 'the signature is left describing what was on screen before the last draw',
    file: 'thread',
    from: '  lastThreadSignature = threadSignature(messages);\n}',
    to: '}',
    expect: 'the same messages arriving again do not draw the thread again',
  },
  {
    // The message has to be in the store before the change is announced. A
    // chat this window has never opened has no list yet, so the array the
    // message goes into would only reach the store after the announcement:
    // the thread would be told about a message it could not see, and the
    // first message in a chat would not be drawn.
    what: 'a message is announced before it is in the store',
    file: 'state',
    from: '  let list = state.messages.get(chatID);\n  if (!list) {\n    list = [];\n    state.messages.set(chatID, list);\n  }\n  applyMessage(list, message);\n  sortForDisplay(list);\n  publish(chatID, message);',
    to: '  const list = state.messages.get(chatID) || [];\n  applyMessage(list, message);\n  sortForDisplay(list);\n  publish(chatID, message);\n  state.messages.set(chatID, list);',
    expect: 'a message arriving in a chat with no history is drawn',
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
  {
    // The notice about an attachment the bridge could not fetch is above the
    // words of the message, not beside them. The bubble is a row of text and
    // timestamp, so a notice in that row squeezes the words into a narrow
    // column down the side of the bubble.
    what: 'the notice about the missing attachment is beside the words again',
    file: 'thread',
    from: "      const stack = el('div', { class: 'bubble-stack' });\n      stack.append(missingAttachmentNode());\n      stack.append(words);\n      inner.append(stack);",
    to: "      inner.append(missingAttachmentNode());\n      inner.append(words);",
    expect: 'the notice is above the words, not beside them',
  },
  {
    // The same rule, in the stylesheet: the column the notice and the words
    // share has to be a column.
    what: 'the notice and the words are laid out in a row',
    file: 'css',
    from: '.bubble-stack {\n  display: flex; flex-direction: column; align-items: stretch;',
    to: '.bubble-stack {\n  display: flex; flex-direction: row; align-items: stretch;',
    expect: 'the notice is above the words, not beside them',
  },
  {
    // The read receipt is somebody else's read, not your own. Beeper's seen
    // map names your own account on your own messages, with the time your
    // own window marked the conversation read - a second or two after you
    // hit send. Taking that as the delivery put a time on the screen that
    // said "read" about a message the other person had not read.
    what: 'your own read counts as a delivery again',
    file: 'receipts',
    from: '    if (selfIds && selfIds.has(id)) continue;\n',
    to: '',
    expect: 'a message only you have read carries no receipt',
  },
  {
    // The same rule, at the place the receipt is written.
    what: 'the receipt is written from any seen time, whoever read it',
    file: 'thread',
    from: '  const when = deliveryTime(message, selfReaderIds(chat, message));',
    to: '  const when = deliveryTime(message, new Set());',
    expect: 'a message only you have read carries no receipt',
  },
  {
    // The thread's signature has to watch the *other* person's read time: it
    // is the receipt that is drawn, and it is that time arriving that has to
    // make the thread redraw. A signature that forgets it leaves the receipt
    // off the message until something else happens to redraw the thread.
    what: 'the signature forgets the delivery time',
    file: 'thread',
    from: '      deliveryTime(m, self) || \'\',',
    to: '      deliveryTime(m, new Set(Object.keys(m.seen || {}))) || \'\',',
    expect: 'the receipt appears when the other person reads it',
  },
  {
    // In a conversation with several people, the message has been read by
    // all of them when the last of them has read it.
    what: 'the oldest read wins instead of the newest',
    file: 'receipts',
    from: '    if (best === null || at > best.at) best = { at, value };',
    to: '    if (best === null || at < best.at) best = { at, value };',
    expect: 'the newest read wins when several people have read it',
    suite: 'check:readreceipts',
  },
];

function runCheck(suite) {
  try {
    const out = execFileSync('npm.cmd', ['run', suite, '--silent'], {
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

/** The suite a mutation is judged by. */
const suiteFor = (m) => m.suite || 'check:threadopen';

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

const holes = [];

// ---------------------------------------------------------------------------
// The baseline
//
// A mutation "caught" against a case that was already red proves nothing, so
// the baseline has to be green and every named case has to be in it, PASS.
// ---------------------------------------------------------------------------

const BASELINE_SUITES = ['check:threadopen', 'check:readreceipts'];

const baseline = {};
for (const suite of BASELINE_SUITES) {
  const { code, out } = runCheck(suite);
  const counts = out.match(/(\d+)\/(\d+) checks passed/);
  if (!counts) {
    console.log(`BASELINE FAILED  ${suite}\n      the suite did not print a count`);
    process.exit(1);
  }
  if (code !== 0 || counts[1] !== counts[2]) {
    console.log(`BASELINE FAILED  ${suite}\n      it printed ${counts[1]}/${counts[2]} checks passed`);
    process.exit(1);
  }
  baseline[suite] = { out, passed: counts[1], total: counts[2] };
  console.log(`baseline  ${suite}  ${counts[1]}/${counts[2]} checks passed`);
}

for (const m of MUTATIONS) {
  const verdict = verdictFor(baseline[suiteFor(m)].out, m.expect);
  if (verdict === 'PASS') continue;
  const state = verdict === null ? 'not in the baseline' : 'already ' + verdict;
  holes.push(`${m.what} -- "${m.expect}" is ${state}`);
  console.log(`HOLE  ${m.what}\n      "${m.expect}" is ${state}`);
}

if (holes.length) {
  console.log('\nThe baseline does not prove these mutations, so the proof cannot run.');
  process.exit(1);
}
console.log('');

let caught = 0;
let tolerated = 0;
const expected = MUTATIONS.filter((m) => !m.expectGreen).length;

for (const m of MUTATIONS) {
  const key = m.file || 'thread';
  const target = FILES[key];
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

    const { out } = runCheck(suiteFor(m));
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
    if (now !== before[key]) {
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