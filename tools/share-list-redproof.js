/**
 * The red proof for the share list.
 *
 * The picker used to offer the first twenty chats and stop, in an order of
 * its own, and it was not the Inbox's list at all. It now offers the Inbox's
 * chats, fills in as the user scrolls, and asks Beeper for the page after it
 * when it runs out.
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
 * Run with `npm run check:sharelistredproof`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron');

const INBOX = path.join(ROOT, 'src', 'renderer', 'js', 'inbox-chats.js');
const SHARE = path.join(ROOT, 'src', 'renderer', 'js', 'share.js');
const MODALS = path.join(ROOT, 'src', 'renderer', 'js', 'modals.js');
const STYLES = path.join(ROOT, 'src', 'renderer', 'styles.css');

const originals = {
  [INBOX]: fs.readFileSync(INBOX, 'utf8'),
  [SHARE]: fs.readFileSync(SHARE, 'utf8'),
  [MODALS]: fs.readFileSync(MODALS, 'utf8'),
  [STYLES]: fs.readFileSync(STYLES, 'utf8'),
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
  share: () => runElectron('tools/share-check.js'),
};

const baseline = suites.share();
const baselineGreen = green(baseline);
add('the baseline is green', baselineGreen,
  baselineGreen ? '' : baseline.out.split(/\r?\n/).slice(-4).join(' | '));

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
    name: 'the list stops at twenty chats again',
    file: SHARE,
    from: lines(SHARE, '  const set = inboxChats(chats, { excludeChatID: sourceChatID });'),
    to: lines(SHARE, '  const set = inboxChats(chats, { excludeChatID: sourceChatID }).slice(0, 20);'),
    // The whole point of the change: anybody with more conversations than
    // that could not be shared into at all.
  },
  {
    name: 'the picker offers its own list instead of the Inbox',
    file: SHARE,
    from: lines(SHARE, '  const set = inboxChats(chats, { excludeChatID: sourceChatID });'),
    to: lines(SHARE, '  const set = (chats || []).filter((chat) => chat && chat.id !== sourceChatID);'),
    // Two lists that happen to look alike are two answers to one question.
  },
  {
    name: 'the same person is offered twice',
    file: SHARE,
    from: lines(SHARE, '    const key = shareIdentity(chat);'),
    to: lines(SHARE, '    const key = \'\';'),
    // Beeper's Google Voice bridge hands out a second chat id for the same
    // person minutes apart.
  },
  {
    name: 'an archived chat is offered again',
    file: INBOX,
    from: lines(INBOX, '    if (isArchived(chat)) continue;'),
    to: lines(INBOX, '    // the archive rule is gone'),
    // The Inbox leaves the archived chats out, and so must the picker.
  },
  {
    name: 'a merged chat is offered again',
    file: INBOX,
    from: lines(INBOX, '    if (chat.mergedIntoChatID) continue;'),
    to: lines(INBOX, '    // the merge rule is gone'),
    // The conversation it belongs to is in the list under its own name.
  },
  {
    name: 'the chat a message came from is offered back to itself',
    file: INBOX,
    from: lines(INBOX, '    if (!chat || chat.id === excludeChatID) continue;'),
    to: lines(INBOX, '    if (!chat) continue;'),
    // Forwarding it back where it already is is a no-op that still posts.
  },
  {
    name: 'the pinned chats no longer come first',
    file: INBOX,
    from: lines(INBOX,
      'export function inboxOrder(a, b) {',
      '  if (isPinned(b) !== isPinned(a)) return isPinned(b) ? 1 : -1;',
      '  return lastActivityOf(b) - lastActivityOf(a);',
      '}'),
    to: lines(INBOX,
      'export function inboxOrder(a, b) {',
      '  return lastActivityOf(b) - lastActivityOf(a);',
      '}'),
    // Beeper's order is pinned first, then most recent activity.
  },
  {
    name: 'the list does not fill in as the user scrolls',
    file: MODALS,
    from: lines(MODALS, '  scroll.addEventListener(\'scroll\', () => { if (atEnd()) fillMore(); });'),
    to: lines(MODALS, '  scroll.addEventListener(\'scroll\', () => {});'),
    // A list of fifty rows is a list nobody can scroll through.
  },
  {
    name: 'the picker never asks Beeper for the next page',
    file: MODALS,
    from: lines(MODALS, '    if (!hasMore || !cursor) return;'),
    to: lines(MODALS, '    if (true) return;'),
    // The app loads two pages of chats and the account has more than that.
  },
  {
    name: 'the count says how many rows are drawn, not how many chats there are',
    file: MODALS,
    from: lines(MODALS,
      "    if (matches.length) parts.push(`${matches.length} chat${matches.length === 1 ? '' : 's'}`);"),
    to: lines(MODALS,
      "    if (results.childElementCount) parts.push(`${results.childElementCount} chat${results.childElementCount === 1 ? '' : 's'}`);"),
    // A count of fifty when there are a hundred and twenty is a count that
    // cannot be trusted.
  },
  {
    name: 'the list is not capped, so it cannot scroll',
    file: STYLES,
    from: lines(STYLES, '.share-pick > .share-scroll { max-height: 42vh; min-height: 0; overflow-y: auto; }'),
    to: lines(STYLES, '.share-pick > .share-scroll { min-height: 0; overflow-y: auto; }'),
    // A list as tall as its content is a list that does not scroll: it is
    // clipped flat, and the chats below the cut can never be reached.
  },
  {
    name: 'the picker says null in the middle of itself',
    file: MODALS,
    from: lines(MODALS, '  ].filter(Boolean));'),
    to: lines(MODALS, '  ]);'),
    // The native append takes a null as the text "null", so a message with
    // no files puts the word in the middle of the picker.
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
    const result = suites.share();

    if (green(result)) {
      add(mutation.name, false, 'the suite stayed green');
      continue;
    }

    const caught = failing(result);
    if (!caught.length) {
      add(mutation.name, false, 'the suite went red without naming a case');
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

const after = suites.share();
const afterGreen = green(after);
add('every suite is green again', afterGreen,
  afterGreen ? '' : after.out.split(/\r?\n/).slice(-4).join(' | '));

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
