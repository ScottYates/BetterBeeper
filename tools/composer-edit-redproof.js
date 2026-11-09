/**
 * Red proof for editing a message from the composer.
 *
 * A check that has never been seen to fail is not evidence of anything. This
 * reintroduces each rule one at a time and asserts that the NAMED check
 * fails. A mutation that leaves the suite green is reported as a hole,
 * because it means that rule is not actually load-bearing.
 *
 * The last one is the other direction: a neutral rewrite that must stay green.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/composer-edit-redproof.js
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  edit: path.join(ROOT, 'src', 'renderer', 'js', 'composer-edit.js'),
  thread: path.join(ROOT, 'src', 'renderer', 'js', 'thread.js'),
};

// Which suite proves which file.
const SUITE = {
  edit: 'check:composeredit',
  thread: 'check:composeredit',
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Replace `from` with `to`, requiring it to appear exactly once.
 *
 * The repository is mostly LF with a few CRLF files, so a literal written
 * with \n would silently not match a CRLF file, every mutation would report
 * SKIP, and the suite would look green for the wrong reason.
 */
function replaceOnce(original, from, to) {
  for (const pattern of [from, from.replace(/\n/g, '\r\n')]) {
    if (pattern !== from && !original.includes('\r\n')) continue;
    const count = original.split(pattern).length - 1;
    if (count === 1) return { ok: true, text: original.replace(pattern, to) };
    if (count > 1) return { ok: false, why: 'pattern appears ' + count + ' times' };
  }
  return { ok: false, why: 'pattern not found' };
}

function applyEdit(original, from, to) {
  const froms = Array.isArray(from) ? from : [from];
  const tos = Array.isArray(to) ? to : [to];
  if (froms.length !== tos.length) return { ok: false, why: 'mismatched edit counts' };
  let text = original;
  for (let i = 0; i < froms.length; i++) {
    const result = replaceOnce(text, froms[i], tos[i]);
    if (!result.ok) return { ok: false, why: result.why };
    text = result.text;
  }
  return { ok: true, text };
}

const MUTATIONS = [
  {
    what: 'the up arrow opens nothing',
    file: 'edit',
    from: "    const started = startEditFromComposer();\n    if (started) event.preventDefault();\n    return started;",
    to: "    return false;",
    expect: 'the up arrow on an empty composer opens an edit',
  },
  {
    what: 'the arrow steps towards the present instead of the past',
    file: 'edit',
    from: "  const step = event.key === 'ArrowUp' ? -1 : 1;",
    to: "  const step = event.key === 'ArrowUp' ? 1 : -1;",
    expect: 'the up arrow again steps to the older message',
  },
  {
    what: 'the arrow acts even when the composer has text',
    file: 'edit',
    from: "    if (text.trim() !== '') return false;\n",
    to: '',
    expect: 'CONTROL: the up arrow does nothing when the composer has text',
  },
  {
    what: 'the arrow steps even after the text has been changed',
    file: 'edit',
    from: "  if (text !== session.original) return false;\n",
    to: '',
    expect: 'CONTROL: the up arrow does not step once the text has been changed',
  },
  {
    what: 'a chat with no capabilities object is refused',
    file: 'edit',
    from: "  if (!caps || typeof caps !== 'object') return true;",
    to: "  if (!caps || typeof caps !== 'object') return false;",
    expect: 'a chat with no capabilities object may be edited',
  },
  {
    what: 'a chat whose capabilities have no edit key is allowed',
    file: 'edit',
    from: "  if (level === undefined || level === null) return false;",
    to: "  if (level === undefined || level === null) return true;",
    expect: 'a chat whose capabilities have no edit key may not be edited',
  },
  {
    what: 'the edit window is ignored',
    file: 'edit',
    from: "    if (now - sent > maxAge * 1000) return false;",
    to: "    if (false) return false;",
    expect: 'CONTROL: a message past the edit window cannot be edited',
  },
  {
    what: 'a message with an attachment can be edited',
    file: 'edit',
    from: "  if ((message.attachments || []).length) return false;",
    to: '',
    expect: 'a message with an attachment cannot be edited',
  },
  {
    what: 'somebody else\'s message can be edited',
    file: 'edit',
    from: "  if (!message.isSender) return false;",
    to: '',
    expect: 'CONTROL: somebody else\'s message cannot be edited',
  },
  {
    // Enter has to save the edit. The thread's own send path knows about an
    // open edit as well, so taking the composer's layer away on its own
    // leaves the other one to save it and the suite stays green. This takes
    // the save away from the key the composer claims, so neither path runs.
    what: 'Enter does not save the edit',
    file: 'edit',
    from: "      event.preventDefault();\n      saveEdit();\n      return true;",
    to: "      event.preventDefault();\n      return true;",
    expect: 'Enter saves the edit',
  },
  {
    what: 'the edit is not written to the local store',
    file: 'edit',
    from: "  await call(() => api.history.upsert(chatID, updated), { context: 'history', fallback: null });",
    to: '',
    expect: 'the edit is written to the local store',
  },
  {
    // The rule as it stands: every message is drawn as a bubble, and the one
    // being edited is marked rather than replaced. The old bubble editor put
    // a textarea in the message instead, so that is what comes back here.
    what: 'the bubble editor is back: the edited bubble carries an editor',
    file: 'thread',
    from: "  if (state.editing === message.id) bubbleWrap.classList.add('is-editing');",
    to: "  if (state.editing === message.id) { bubbleWrap.classList.add('is-editing'); bubbleWrap.append(el('div', { class: 'msg-bubble' }, el('textarea', { rows: '2' }))); }",
    expect: 'CONTROL: there is no editor in the bubble any more',
  },
  {
    // The bubble being edited is marked, so the reader can see which
    // message the composer is about to change. The marker is the only
    // thing on screen that says so.
    what: 'the message being edited is not marked in the thread',
    file: 'thread',
    from: "  if (state.editing === message.id) bubbleWrap.classList.add('is-editing');",
    to: '',
    expect: 'the message being edited is marked in the thread',
  },
  {
    what: 'the menu offers Edit on a message that cannot be edited',
    file: 'thread',
    from: "  const canEdit = isEditableMessage(currentChat, message);",
    to: "  const canEdit = message.isSender && !message.isDeleted;",
    expect: 'CONTROL: the menu does not offer Edit on a message that cannot be edited',
  },
  {
    what: 'the menu takes away the delete item along with Edit',
    file: 'thread',
    from: "  const canDelete = message.isSender && !message.isDeleted;",
    to: "  const canDelete = canEdit;",
    expect: 'CONTROL: the menu still offers Delete for everyone on a message that cannot be edited',
  },
  {
    // The message being edited stays in the thread, marked. It is not taken
    // out of it while the edit is open.
    what: 'the message being edited is dropped from the thread',
    file: 'thread',
    from: "  return (list || []).filter((m) => !m.isHidden && !isMessageDeleted(m.id));",
    to: "  return (list || []).filter((m) => !m.isHidden && !isMessageDeleted(m.id) && m.id !== state.editing);",
    expect: 'the message being edited stays in the thread while the edit is open',
  },
  {
    // A reply and an edit cannot both be pending: the newest action wins.
    what: 'choosing a reply does not cancel an open edit',
    file: 'thread',
    from: "  cancelEdit();\n",
    to: '',
    expect: 'CONTROL: a reply cancels an open edit',
  },
  {
    // The composer placeholder is the chat's name again once the edit ends.
    what: 'the composer placeholder is not put back when the edit ends',
    file: 'edit',
    from: "  if (composer) composer.placeholder = defaultPlaceholder;\n",
    to: '',
    expect: 'CONTROL: the composer placeholder goes back to the chat after the edit',
  },
  {
    // An edit that changes nothing is not sent to Beeper at all.
    what: 'an edit that changes nothing is still sent',
    file: 'edit',
    from: "  if (text === session.original) {\n    cancelEdit();\n    return false;\n  }\n",
    to: '',
    expect: 'CONTROL: an edit that changes nothing is not sent',
  },
  {
    // Not a bug. The same rule, written the other way round.
    what: 'TOLERATED: the step is written as a branch',
    file: 'edit',
    from: "  const step = event.key === 'ArrowUp' ? -1 : 1;",
    to: "  const step = event.key !== 'ArrowUp' ? 1 : -1;",
    expect: 'the up arrow again steps to the older message',
    expectGreen: true,
  },
];

function runCheck(suite) {
  try {
    const out = execFileSync('npm.cmd', ['run', suite, '--silent'], {
      cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: true,
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
console.log(`baseline: ${runCheck('check:composeredit').out.match(/(\d+\/\d+) checks passed/)?.[1] || '?'}\n`);

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

    const { out } = runCheck(SUITE[m.file]);
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
    if (now !== before[m.file]) {
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
