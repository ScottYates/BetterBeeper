/**
 * Red proof for check:notificationclick.
 *
 * A check that has never been seen to fail is not evidence of anything. This
 * reintroduces each part of the feature one at a time and asserts that the
 * NAMED check fails. A mutation that leaves the suite green is reported as a
 * hole, because it means that rule is not load-bearing.
 *
 * The last one is the other direction: a neutral rewrite that must stay green.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/notification-click-redproof.js
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  module: path.join(ROOT, 'src', 'renderer', 'js', 'notification-click.js'),
  main: path.join(ROOT, 'src', 'main', 'main.js'),
  preload: path.join(ROOT, 'src', 'preload', 'preload.js'),
  renderer: path.join(ROOT, 'src', 'renderer', 'js', 'main.js'),
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Replace `from` with `to`, requiring it to appear exactly once.
 *
 * `from` and `to` may be arrays, for a mutation that needs more than one
 * piece changed.
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
    what: 'the main process brings the window up but never says which chat',
    file: 'main',
    from: "        mainWindow.webContents.send('notification:click', chatID);",
    to: '        void chatID;',
    expect: 'the main process sends the chat the notification was about',
  },
  {
    what: 'the preload does not carry the click to the renderer',
    file: 'preload',
    from: "    notificationClick: (fn) => on('notification:click', fn),",
    to: '',
    expect: 'the preload carries the click to the renderer',
  },
  {
    what: 'the preload listens on a different channel than the main process sends',
    file: 'preload',
    from: "    notificationClick: (fn) => on('notification:click', fn),",
    to: "    notificationClick: (fn) => on('notification-clicked', fn),",
    expect: 'and the two sides are talking about the same channel',
  },
  {
    what: 'the renderer never listens for the click',
    file: 'renderer',
    from: '  wireNotificationClicks();',
    to: '  void wireNotificationClicks;',
    expect: 'the renderer listens for the click',
  },
  {
    what: 'the window focus no longer asks for the composer',
    file: 'renderer',
    from: '    // foreground window when the click arrived.\n    focusComposerOnWindowFocus();',
    to: '    // foreground window when the click arrived.',
    expect: 'and the window focus is where the composer is asked for again',
  },
  {
    what: 'the window becoming visible again no longer asks for the composer',
    file: 'renderer',
    from: '    // request is one-shot, so whichever arrives first takes it.\n    focusComposerOnWindowFocus();',
    to: '    // request is one-shot, so whichever arrives first takes it.',
    expect: 'and so is the window becoming visible again, which is the other way back',
  },
  {
    what: 'the click opens no conversation',
    file: 'module',
    from: '  openChat(id);',
    to: '  void id;',
    expect: 'and it is the conversation the notification was about',
  },
  {
    what: 'the window focus does not put the cursor in the composer',
    file: 'module',
    from: '  waitingForWindowFocus = false;\n  focusComposer();',
    to: '  waitingForWindowFocus = false;',
    expect: 'and the caret really goes there',
  },
  {
    what: 'the one-shot never fires once',
    file: 'module',
    from: '  waitingForWindowFocus = false;\n  focusComposer();',
    to: '  focusComposer();',
    expect: 'and only once: an ordinary return to the window leaves the caret alone',
  },
  {
    what: 'the second attempt is armed even when the window was already active',
    file: 'module',
    from: '  waitingForWindowFocus = !active;',
    to: '  waitingForWindowFocus = true;',
    expect: 'CONTROL: a click in an active window does not steal the caret later',
  },
  {
    what: 'a click that names no conversation is not refused',
    file: 'module',
    from: '  if (!id) return false;',
    to: '  if (false) return false;',
    expect: 'a click that names no conversation is refused',
  },
  {
    what: 'the wiring listens to nothing',
    file: 'module',
    from: '  window.beeper.on.notificationClick((chatID) => openFromNotification(chatID));',
    to: '  void window.beeper.on;',
    expect: 'the app listens for the click at all',
  },
  {
    // Not a bug. The same name, reached the same way.
    what: 'TOLERATED: the chat id is read the other way round',
    file: 'module',
    from: "  const id = String(chatID || '').trim();",
    to: "  const id = String(chatID ?? '').trim();",
    expect: 'a notification click opens that conversation',
    expectGreen: true,
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm.cmd', ['run', 'check:notificationclick', '--silent'], {
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
