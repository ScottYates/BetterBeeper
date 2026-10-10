/**
 * Dev check: the unread count on the app icon.
 *
 * Four things are easy to get wrong and invisible until they are on screen:
 *
 *   shouldApply   The icon is a shared, visible thing. Redrawing the same
 *                 number on every chat event repaints the taskbar continuously
 *                 on a busy account - and, worse, a count that drops to zero
 *                 must count as a change or the last number sits there for
 *                 good.
 *
 *   totalUnread   Archived chats are filed away, not waiting. Counting them
 *                 means the badge never reaches zero on an account that archives
 *                 as it reads, which is exactly when a user wants it to clear.
 *
 *   the API       `app.setOverlayIcon` was used here and it does not exist in
 *                 Electron 38, so every count change threw in the main process
 *                 and the badge never appeared. Nothing about the count or the
 *                 clearing would have caught that; only calling the real thing
 *                 does, which is what the preflight below is for.
 *
 * Run with `npm run check:badge`.
 */
const path = require('path');
const url = require('url');
const os = require('os');
const fs = require('node:fs');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const badgePath = path.join(ROOT, 'src', 'main', 'badge.js');
const sidebarPath = path.join(ROOT, 'src', 'renderer', 'js', 'sidebar.js');
const unreadPath = path.join(ROOT, 'src', 'renderer', 'js', 'unread.js');

const cases = [];
const add = (name, fn) => {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true;
    if (r !== true) detail = String(r);
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  cases.push([name, ok, detail]);
};

// ---- main-process decisions (pure) ------------------------------------------

async function main() {
  const { app } = require('electron');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-badge-check-profile'));

  const badge = require(badgePath);

  add('the same number is not a change', () =>
    badge.shouldApply(5, 5) === false || 'shouldApply(5, 5) was true');

  add('a different number is', () =>
    badge.shouldApply(5, 6) === true || 'shouldApply(5, 6) was false');

  // The one that matters most and is easiest to forget.
  add('dropping to zero is a change, so the badge clears', () =>
    badge.shouldApply(5, 0) === true || 'shouldApply(5, 0) was false');

  add('staying at zero is not', () =>
    badge.shouldApply(0, 0) === false || 'shouldApply(0, 0) was true');

  add('nothing applied yet is a change from nothing', () =>
    badge.shouldApply(null, 0) === true || 'shouldApply(null, 0) was false');

  // The counting lives with the chat list, in one place, and is pulled in
  // directly. It used to exist in the main process too, where it was dead code:
  // two copies of the same rule, and the renderer one is the correct one,
  // because only the renderer knows about the user's local un-archive overrides.
  const { totalUnread } = await import(url.pathToFileURL(unreadPath).href);

  add('archived chats are not counted', () => {
    const total = totalUnread([
      { id: 'a', unreadCount: 3 },
      { id: 'b', unreadCount: 4, isArchived: true },
    ]);
    return total === 3 || `got ${total}`;
  });

  add('muted chats are still counted', () => {
    const total = totalUnread([{ id: 'a', unreadCount: 2, isMuted: true }]);
    return total === 2 || `got ${total}`;
  });

  add('a chat merged elsewhere is not counted twice', () => {
    const total = totalUnread([
      { id: 'a', unreadCount: 2, mergedIntoChatID: 'b' },
      { id: 'b', unreadCount: 0 },
    ]);
    return total === 0 || `got ${total}`;
  });

  add('junk in the list cannot make the total nonsense', () => {
    const total = totalUnread([null, undefined, {}, { id: 'x', unreadCount: 'x' }]);
    return total === 0 || `got ${total}`;
  });

  // The one that makes the archive rule different between the two processes.
  add('a chat the user pulled back out of the archive counts again', () => {
    const unarchived = new Set(['b']);
    const total = totalUnread(
      [{ id: 'a', unreadCount: 1 }, { id: 'b', unreadCount: 4, isArchived: true }],
      (chat) => chat.isArchived && !unarchived.has(chat.id),
    );
    return total === 5 || `got ${total} - a local un-archive was ignored`;
  });

  add('nothing unread means a total of zero', () => {
    const total = totalUnread([{ id: 'a', unreadCount: 0 }, { id: 'b', unreadCount: -2 }]);
    return total === 0 || `got ${total}`;
  });

  // ---- the Electron API, for real -----------------------------------------
  //
  // Not a stub and not a shape check. This is the assertion that would have
  // caught the removed overlay API: it calls the same function the app calls
  // and reads the result back from Electron.

  await app.whenReady();
  harnessGuard(app, { label: 'check:badge' });

  add('the badge API this uses exists in this Electron', () => {
    if (typeof app.setBadgeCount !== 'function') return 'app.setBadgeCount is not a function';
    if (typeof app.getBadgeCount !== 'function') return 'app.getBadgeCount is not a function';
    return true;
  });

  add('setting a count puts it on the icon', () => {
    badge.resetBadge();
    badge.overlay.set(5);
    const got = app.getBadgeCount();
    badge.overlay.set(0);
    return got === 5 || `asked for 5, Electron reports ${got}`;
  });

  add('zero takes the badge off', () => {
    badge.overlay.set(3);
    badge.overlay.set(0);
    const got = app.getBadgeCount();
    return got === 0 || `after clearing, Electron still reports ${got}`;
  });

  // The whole seam, stubbed: what is asserted is that the call is made, once,
  // and only on a change.
  const applied = [];
  const realSet = badge.overlay.set;
  badge.overlay.set = (count) => {
    applied.push(count);
  };
  badge.resetBadge();

  const first = badge.applyBadge(3);
  const afterFirst = applied.length;
  const again = badge.applyBadge(3);
  const afterAgain = applied.length;
  const up = badge.applyBadge(9);
  const afterUp = applied.length;
  const cleared = badge.applyBadge(0);
  const afterClear = applied.length;
  const stillClear = badge.applyBadge(0);

  add('a new count puts a badge on', () =>
    first === true && afterFirst === 1 && applied[0] === 3
    || `applied=${JSON.stringify(applied)}`);
  add('the same count twice touches the icon once', () =>
    again === false && afterAgain === 1 || `touched the icon again: ${JSON.stringify(applied)}`);
  add('a different count replaces it', () =>
    up === true && afterUp === 2 && applied[1] === 9
    || `applied=${JSON.stringify(applied)}`);
  add('zero takes the badge off', () =>
    cleared === true && afterClear === 3 && applied[2] === 0
    || `clearing applied=${JSON.stringify(applied)}`);
  add('staying at zero touches nothing', () =>
    stillClear === false && applied.length === 3 || `applied ${applied.length} times`);
  add('the count on the icon is the one that was set', () =>
    badge.currentBadge() === 0 || `currentBadge() is ${badge.currentBadge()}`);

  add('a nonsense count is treated as none', () => {
    badge.resetBadge();
    for (const v of [null, undefined, NaN, -3, 'x']) {
      if (badge.applyBadge(v) !== true) continue;
      if (badge.currentBadge() !== 0) return `${JSON.stringify(v)} became ${badge.currentBadge()}`;
      badge.resetBadge();
    }
    return true;
  });

  add('a real count is not capped', () => {
    badge.resetBadge();
    badge.applyBadge(1234);
    const got = badge.currentBadge();
    badge.resetBadge();
    return got === 1234 || `1234 was shown as ${got} - something is capping it`;
  });

  badge.overlay.set = realSet;
  // No app.exit here: the report below prints and exits, and leaving early
  // would swallow the results.

  // ---- the renderer decides the number -------------------------------------

  const sidebarSrc = fs.readFileSync(sidebarPath, 'utf8');
  add('the chat list is what the badge counts', () =>
    /totalUnread\(chatList\(\), isArchived\)/.test(sidebarSrc)
    || 'syncBadge does not count chatList() with the archive rule the sidebar uses');
  add('there is one copy of the counting rule', () => {
    const mainSrc = fs.readFileSync(badgePath, 'utf8');
    if (/\btotalUnread\b/.test(mainSrc)) return 'the main process still has its own totalUnread';
    const unreadSrc = fs.readFileSync(unreadPath, 'utf8');
    return /export function totalUnread\(/.test(unreadSrc) || 'unread.js does not export totalUnread';
  });
  add('the badge is only sent when the number changes', () =>
    /if \(total === badgeCount\) return;/.test(sidebarSrc)
    || 'syncBadge sends on every render');
  add('a rendered chat list refreshes the badge', () =>
    /export function renderChats\(\) \{\s*\n\s*const list = \$\('#chat-list'\);\s*\n\s*syncBadge\(\);/.test(sidebarSrc)
    || 'renderChats does not call syncBadge');

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  // Exit through Electron, not process.exit: the preflight above puts a real
  // badge on the platform, and tearing the process down from under it with a
  // raw exit crashed on the way out (0xC0000005) after the results had printed.
  //
  // app.exit() alone was still not enough - the crash came back roughly two
  // runs in three, which is worse than useless in a release gate because it
  // looks like the change under test broke something. The shell needs a moment
  // to finish reacting to the badge before Electron is torn down underneath it.
  // Measured over six consecutive runs: exit immediately crashed 4 of 6; exit
  // after yielding to the shell crashed 0 of 6.
  setTimeout(() => {
    try {
      app.setBadgeCount(0);
    } catch {
      /* the badge is already off; nothing to do */
    }
    app.exit(failed ? 1 : 0);
  }, 350);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});