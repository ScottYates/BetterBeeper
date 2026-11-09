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
 * The baseline is asserted before anything is touched. A named case that is
 * already red in the baseline proves nothing when a mutation makes it red
 * again, so the proof refuses to run against a baseline that is not green or
 * that does not print the case at all.
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
  rules: path.join(ROOT, 'src', 'renderer', 'js', 'composer-edit-rules.js'),
  entities: path.join(ROOT, 'src', 'renderer', 'js', 'entities.js'),
  css: path.join(ROOT, 'src', 'renderer', 'styles.css'),
};

// Which suite proves which file.
const SUITE = {
  edit: 'check:composeredit',
  thread: 'check:composeredit',
  rules: 'check:composereditrules',
  entities: 'check:composeredit',
  css: 'check:composeredit',
};

// The suites the proof needs a baseline for. Every one of them has to be
// green before a single byte is changed.
const BASELINE_SUITES = ['check:composereditrules', 'check:composeredit'];

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Replace `from` with `to`, requiring it to appear exactly once.
 *
 * The repository is mostly LF with a few CRLF files, so a literal written
 * with \n would silently not match a CRLF file, every mutation would report
 * SKIP, and the suite would look green for the wrong reason. The replacement
 * is given the same line endings as the file it goes into, so a mutated file
 * stays a file the next pattern can match.
 */
function replaceOnce(original, from, to) {
  for (const pattern of [from, from.replace(/\n/g, '\r\n')]) {
    if (pattern !== from && !original.includes('\r\n')) continue;
    const crlf = pattern !== from;
    const count = original.split(pattern).length - 1;
    if (count === 1) {
      const replacement = crlf ? to.replace(/\n/g, '\r\n') : to;
      return { ok: true, text: original.replace(pattern, replacement) };
    }
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
    file: 'rules',
    from: "  if (!caps || typeof caps !== 'object') return true;",
    to: "  if (!caps || typeof caps !== 'object') return false;",
    expect: 'a chat with no capabilities object may be edited',
  },
  {
    what: 'a chat whose capabilities have no edit key is allowed',
    file: 'rules',
    from: "  if (level === undefined || level === null) return false;",
    to: "  if (level === undefined || level === null) return true;",
    expect: 'a chat whose capabilities have no edit key may not be edited',
  },
  {
    what: 'the edit window is ignored',
    file: 'rules',
    from: "    if (now - sent > maxAge * 1000) return false;",
    to: "    if (false) return false;",
    expect: 'CONTROL: a message past the edit window cannot be edited',
  },
  {
    what: 'a message with an attachment can be edited',
    file: 'rules',
    from: "  if ((message.attachments || []).length) return false;",
    to: '',
    expect: 'a message with an attachment cannot be edited',
  },
  {
    what: 'somebody else\'s message can be edited',
    file: 'rules',
    from: "  if (!message.isSender) return false;",
    to: '',
    expect: 'CONTROL: somebody else\'s message cannot be edited',
  },
  {
    // A message that only exists on this device is not a message Beeper has.
    // Without the rule the up arrow lands on the optimistic bubble, and Enter
    // then asks Beeper to edit an id it has never heard of.
    what: 'a message that has not been sent yet can be edited',
    file: 'rules',
    from: "  if (!confirmedByBeeper(message)) return false;",
    to: '',
    expect: 'a message that has not been sent yet cannot be edited',
  },
  {
    // The rules have to be loadable without a window, or they cannot be
    // checked at all: the module they live in reached for `document` the
    // moment it was imported.
    what: 'the rules need a window to be loaded',
    file: 'rules',
    from: "import { parseTs } from './util.js';",
    to: "import { parseTs } from './util.js';\n\ndocument.addEventListener('DOMContentLoaded', () => {});",
    expect: 'the rules can be checked without a window',
  },
  {
    // The stored message keeps its references. Storing the decoded text
    // loses one level of entity resolution, in the bubble and on disk.
    what: 'the stored text is not encoded',
    file: 'entities',
    from: `export function encodeEntities(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}`,
    to: `export function encodeEntities(value) {
  return String(value ?? '');
}`,
    expect: 'an edited character reference is shown once and stored encoded',
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
    from: "  await call(() => api.history.upsert(chatID, stored), { context: 'history', fallback: null });",
    to: '',
    expect: 'the edit is written to the local store',
  },
  {
    // The thread is not drawn again for the marker. Drawing it again
    // detaches every image in it, which restarts an animated GIF.
    what: 'the arrow draws the whole thread again',
    file: 'edit',
    from: "  deps.markEditing(message.id);",
    to: "  deps.renderAll();",
    expect: 'stepping does not rebuild the thread',
  },
  {
    // The marker is put on the bubble when the edit opens. Without it the
    // reader is not told which message the composer is about to change.
    what: 'the marker is never put on the bubble',
    file: 'edit',
    from: "  deps.markEditing(message.id);\n",
    to: '',
    expect: 'the message being edited is marked in the thread',
  },
  {
    // The marker moves with the edit. Leaving it behind would show two
    // bubbles marked as being edited.
    what: 'the marker is left on the message stepped away from',
    file: 'thread',
    from: "    if (id === messageID) wrap.classList.add('is-editing');\n    else wrap.classList.remove('is-editing');",
    to: "    if (id === messageID) wrap.classList.add('is-editing');",
    expect: 'the marker moves to the message being edited',
  },
  {
    // The drawn thread has to say what the state says, or the next event
    // that changes nothing visible rebuilds the thread and restarts the
    // GIFs all over again.
    what: 'the signature is left stale when the marker moves',
    file: 'thread',
    from: "  lastThreadSignature = threadSignature(renderableMessages(state.activeChatID));",
    to: '',
    expect: 'an upsert that changes nothing visible does not rebuild the thread',
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
    // thing on screen that says so, and it is drawn with the bubble: a
    // thread that is drawn again while the edit is open comes back with it.
    what: 'the message being edited is not marked in the thread',
    file: 'thread',
    from: "  if (state.editing === message.id) bubbleWrap.classList.add('is-editing');",
    to: '',
    expect: 'the message being edited is still marked after the thread is drawn again',
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
    // The composer is one line for everything else, and as tall as the text
    // needs while a message is being edited. Without the rule the text runs
    // off to the right in a box that shows one line of it, and the end of it
    // - and the cursor with it - is off the screen.
    what: 'the composer does not grow for the text being edited',
    file: 'css',
    from: '.composer.is-editing .composer-field textarea {\n  field-sizing: content;\n  white-space: pre-wrap;\n  height: auto;\n  max-height: 30vh;\n}\n',
    to: '',
    expect: 'the composer is made big enough for the text being edited',
  },
  {
    // And it only grows while an edit is open. The composer is one line
    // always, because a composer that grows as you type pushes the thread up
    // and leaves the newest message riding at the top of the window.
    what: 'the composer grows even when nothing is being edited',
    file: 'css',
    from: '.composer.is-editing .composer-field textarea {',
    to: '.composer .composer-field textarea {',
    expect: 'CONTROL: the composer is one line when it is not editing',
  },
  {
    // The cursor belongs at the end of the text that was loaded: that is the
    // whole message, and the cursor at its end is where the next edit starts.
    what: 'the cursor goes to the start of the text instead of the end',
    file: 'thread',
    from: "  const end = String(input.value || '').length;\n  if (typeof input.setSelectionRange === 'function') {\n    input.setSelectionRange(end, end);\n  }",
    to: "  const end = String(input.value || '').length;\n  if (typeof input.setSelectionRange === 'function') {\n    input.setSelectionRange(0, 0);\n  }",
    expect: 'the cursor is at the end of the text being edited',
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
const suiteFor = (m) => m.suite || SUITE[m.file];

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

const holes = [];

// ---------------------------------------------------------------------------
// The baseline
//
// A mutation "caught" against a case that was already red proves nothing, so
// the baseline has to be green and every named case has to be in it, PASS.
// ---------------------------------------------------------------------------

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
  const suite = suiteFor(m);
  const verdict = verdictFor(baseline[suite].out, m.expect);
  if (verdict === 'PASS') continue;
  holes.push(`${m.what} -- "${m.expect}" is ${verdict === null ? 'not in the baseline' : verdict}`);
  console.log(`HOLE  ${m.what}\n      "${m.expect}" is ${verdict === null ? 'not in the baseline' : 'already ' + verdict}`);
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
    if (now !== before[m.file]) {
      console.log(`\nRESTORE FAILED for ${path.basename(target)}`);
      process.exit(1);
    }
  }
}

// Every file the proof touched has to be back where it started, not just the
// one the last mutation happened to be in.
for (const [k, p] of Object.entries(FILES)) {
  if (hash(p) !== before[k]) {
    console.log(`\nRESTORE FAILED for ${path.basename(p)}`);
    process.exit(1);
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
