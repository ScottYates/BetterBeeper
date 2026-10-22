/**
 * Red proof for check:contactrefresh.
 *
 * The bug: refreshing a conversation re-read the messages and nothing else, so
 * the people in it were never checked. Somebody who had changed their name
 * stayed under their old one, on the chat and on every message they had ever
 * written.
 *
 * Every mutation below reintroduces one part of that, and asserts that the
 * NAMED check fails. A mutation that leaves the suite green is reported as a
 * hole, because it means that rule is not actually load-bearing.
 *
 * The last one is the other direction: a neutral rewrite that must stay green.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/contact-refresh-redproof.js
 */
const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  contact: path.join(ROOT, 'src', 'renderer', 'js', 'contact-refresh.js'),
  store: path.join(ROOT, 'src', 'main', 'message-store.js'),
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Replace `from` with `to`, requiring it to appear exactly once.
 *
 * `from` and `to` may be arrays, for a mutation that needs more than one
 * piece changed - a SQL statement and the arguments that go with it, say.
 *
 * The repository is mostly LF with a few CRLF files, so a literal written with
 * \n would silently not match a CRLF file, every mutation would report SKIP, and
 * the suite would look green for the wrong reason.
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
    what: 'a participant list that came back short is taken as the whole list',
    file: 'contact',
    from: '  const complete = !fresh?.hasMore\n    && (typeof fresh?.total !== \'number\' || fresh.total <= freshItems.length);',
    to: '  const complete = true;',
    expect: 'a list that claims more than it carries is merged, not applied',
  },
  {
    what: 'an empty participant list empties the chat',
    file: 'contact',
    from: '  if (!freshItems.length) {',
    to: '  if (false) {',
    expect: 'an empty list is no information, not nobody',
  },
  {
    what: 'a participant we cannot name is entered with an empty name',
    file: 'contact',
    from: '    if (name) names.set(String(person.id), name);',
    to: '    names.set(String(person.id), name || \'\');',
    expect: 'a participant we cannot name is left out',
  },
  {
    what: 'your own messages get renamed along with everybody else',
    file: 'contact',
    from: '    if (!message || message.isSender) return message;',
    to: '    if (!message) return message;',
    expect: 'your own messages are left alone',
  },
  {
    what: 'the server writes its unread count back over the one the app cleared',
    file: 'contact',
    from: "  if (previous && 'unreadCount' in previous) merged.unreadCount = previous.unreadCount;",
    to: "  if (false) merged.unreadCount = previous.unreadCount;",
    expect: 'the unread count the app cleared is not written back by the server',
  },
  {
    what: 'the new name is overwritten by the old one',
    file: 'contact',
    from: '    const next = { ...message, senderName: name };',
    to: '    const next = { senderName: name, ...message };',
    expect: 'a renamed person gets the new name',
  },
  {
    what: 'a rename reaches into other chats',
    file: 'store',
    from: [
      '         WHERE chatID = ? AND gone = 0 AND senderID IN (${placeholders})',
      '        for (const row of select.all(chatID, ...entries.map(([id]) => id))) {',
      "      const loadPayload = db.prepare('SELECT payload FROM messages WHERE chatID = ? AND id = ?');",
      '          const stored = loadPayload.get(chatID, row.id);',
      '        UPDATE messages SET senderName = ?, payload = ? WHERE chatID = ? AND id = ?',
      '          update.run(row.name, JSON.stringify(isObject ? payload : stored?.payload), chatID, row.id);',
    ],
    to: [
      '         WHERE gone = 0 AND senderID IN (${placeholders})',
      '        for (const row of select.all(...entries.map(([id]) => id))) {',
      "      const loadPayload = db.prepare('SELECT payload FROM messages WHERE id = ?');",
      '          const stored = loadPayload.get(row.id);',
      '        UPDATE messages SET senderName = ?, payload = ? WHERE id = ?',
      '          update.run(row.name, JSON.stringify(isObject ? payload : stored?.payload), row.id);',
    ],
    expect: 'a rename in one chat does not touch another',
  },
  {
    what: 'the stored payload keeps the old name, so the app still shows it',
    file: 'store',
    from: '          if (isObject) payload.senderName = row.name;',
    to: '          if (false) payload.senderName = row.name;',
    expect: 'and the name the renderer reads is the new one',
  },
  {
    // Not a bug. The same name, reached the same way.
    what: 'TOLERATED: the sender id is read the other way round',
    file: 'contact',
    from: '    const name = names.get(String(message.senderID ?? \'\'));',
    to: '    const name = names.get(String(message.senderID || \'\'));',
    expect: 'a renamed person gets the new name',
    expectGreen: true,
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:contactrefresh', '--silent'], {
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
