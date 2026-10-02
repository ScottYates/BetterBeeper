/**
 * Dev check: pinning must control both the row's paperclip and its position,
 * for ordinary chats and for note-to-self chats alike.
 *
 * The bug this exists for: the note-to-self rows were built by a separate
 * noteItem() that hard-coded the pin flag and were pushed into a partition
 * ahead of everything else, so a note chat could be unpinned with the header
 * button and nothing on screen would change. The button said "off" while the
 * row kept its paperclip and stayed at the top, which reads as "unpinning is
 * broken". Note chats are now pinned by default via isPinned() instead, so an
 * explicit unpin behaves like it does for any other chat.
 *
 * The test drives the real renderChats() over synthetic chats, so it fails the
 * moment the ordering or the flag goes back to being hard-coded.
 *
 * Run with `npm run check:pin`.
 */
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const stateURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'state.js')).href;
const sidebarURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'sidebar.js')).href;

// state.js and sidebar.js use DOM globals, so exercise them in a real browser
// via Electron.
async function main() {
  const { app, BrowserWindow } = require('electron');

  // An isolated profile, so the test can never read a cached copy of the
  // renderer modules. Chromium caches file:// modules in userData, which means a
  // stale renderer can otherwise be executed after the source changed.
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-pin-check-profile'));

  const harness = `
    (async () => {
      const S = await import(${JSON.stringify(stateURL)});
      const B = await import(${JSON.stringify(sidebarURL)});

      const PIN = '\\u{1F4CC}';

      // A note chat is a single chat whose every participant is you; an
      // ordinary one has somebody else in it too.
      const note = (id, title, lastActivity) => ({
        id: id, title: title, lastActivity: lastActivity, type: 'single',
        participants: { items: [{ isSelf: true }] },
        unreadCount: 0,
      });
      const person = (id, title, lastActivity) => ({
        id: id, title: title, lastActivity: lastActivity, type: 'single',
        participants: { items: [{ isSelf: true }, { isSelf: false }] },
        unreadCount: 0,
      });

      // Deliberately the OLDEST chat of the lot. A note chat is only at the top
      // because it is pinned, and this is what proves it: nothing about its
      // recency would put it there.
      const NOTE_A = note('!note-a', 'Signal Note to self', '2025-12-01T10:00:00Z');
      const NOTE_B = note('!note-b', 'Note', '2026-01-06T10:00:00Z');
      const ALPHA = person('!a', 'Alpha', '2026-01-01T10:00:00Z');
      const BRAVO = person('!b', 'Bravo', '2026-01-02T10:00:00Z');
      const CHARLIE = person('!c', 'Charlie', '2026-01-03T10:00:00Z');
      const DELTA = person('!d', 'Delta', '2026-01-04T10:00:00Z');

      const ALL = [NOTE_A, NOTE_B, ALPHA, BRAVO, CHARLIE, DELTA];

      const seed = () => {
        S.state.chats.clear();
        for (const c of ALL) S.state.chats.set(c.id, c);
        S.state.filter = 'all';
        S.state.searchQuery = '';
        S.state.activeChatID = null;
      };

      const draw = () => {
        B.renderChats();
        return [...document.querySelectorAll('#chat-list > .chat-item')].map((n) => ({
          title: (n.querySelector('.chat-item-title') || {}).textContent,
          flags: (n.querySelector('.chat-flags') || {}).textContent || '',
          isNote: n.classList.contains('is-note'),
        }));
      };

      const order = (rows) => rows.map((r) => r.title).join(',');
      const at = (rows, title) => rows.findIndex((r) => r.title === title);
      const flagged = (rows, title) => {
        const row = rows.find((r) => r.title === title);
        return row ? row.flags.includes(PIN) : false;
      };

      const cases = [];
      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      add('note chats are pinned and on top by default', () => {
        seed(); S.loadPins({});
        const rows = draw();
        return order(rows) === 'Note,Note to self,Delta,Charlie,Bravo,Alpha'
          || ('order: ' + order(rows));
      });

      add('a note chat shows the pin flag by default', () => {
        seed(); S.loadPins({});
        const rows = draw();
        return (flagged(rows, 'Note') && flagged(rows, 'Note to self'))
          || ('flags: ' + JSON.stringify(rows.map((r) => r.title + '=' + r.flags)));
      });

      add('unpinning a note chat clears its pin flag', () => {
        // The regression. noteItem() used to hard-code the flag, so this row
        // kept its paperclip no matter what the pin button said.
        seed(); S.loadPins({ '!note-a': false });
        const rows = draw();
        return !flagged(rows, 'Note to self') || ('flags: ' + JSON.stringify(rows.map((r) => r.title + '=' + r.flags)));
      });

      add('unpinning a note chat moves it down by recency', () => {
        // NOTE_A is the oldest chat in the set, so once it is not pinned there
        // is nothing left to hold it up and it must sink to the bottom.
        seed(); S.loadPins({ '!note-a': false });
        const rows = draw();
        return order(rows) === 'Note,Delta,Charlie,Bravo,Alpha,Note to self'
          || ('order: ' + order(rows));
      });

      add('re-pinning a note chat puts it back at the top', () => {
        seed(); S.loadPins({ '!note-a': false });
        const down = draw();
        S.loadPins({ '!note-a': true });
        const up = draw();
        return at(down, 'Note to self') === 5 && at(up, 'Note to self') === 1 && flagged(up, 'Note to self')
          || ('down: ' + order(down) + ' / up: ' + order(up));
      });

      add('an ordinary chat pins above the unpinned ones', () => {
        seed(); S.loadPins({ '!b': true });
        const rows = draw();
        // Pinned first, then by recency *within* the pinned group, which is why
        // the old note chat trails Bravo but still leads the unpinned ones.
        return order(rows) === 'Note,Bravo,Note to self,Delta,Charlie,Alpha'
          || ('order: ' + order(rows));
      });

      add('unpinning an ordinary chat restores recency order', () => {
        seed(); S.loadPins({ '!b': true });
        const pinned = draw();
        S.loadPins({ '!b': false });
        const back = draw();
        return at(pinned, 'Bravo') === 1 && at(back, 'Bravo') === 4
          || ('pinned: ' + order(pinned) + ' / back: ' + order(back));
      });

      add('an explicit unpin overrides a Beeper-reported pin', () => {
        // Beeper reports isPinned on its own for some chats. The override has to
        // win, or a chat could never be unpinned in this app.
        seed();
        S.state.chats.set('!c', { ...CHARLIE, isPinned: true });
        const on = draw();
        S.loadPins({ '!c': false });
        const off = draw();
        return at(on, 'Charlie') === 1 && at(off, 'Charlie') === 3
          || ('on: ' + order(on) + ' / off: ' + order(off));
      });

      add('an unpinned note chat keeps its own row type', () => {
        // Unpinning must not turn a note into an ordinary row: it keeps the
        // "Note" label and the avatar that opens the chat instead of the
        // image viewer.
        seed(); S.loadPins({ '!note-a': false });
        const rows = draw();
        const row = rows.find((r) => r.title === 'Note to self');
        return row && row.isNote === true || ('row: ' + JSON.stringify(row));
      });

      add('pinned chats sort by recency among themselves', () => {
        seed(); S.loadPins({ '!a': true, '!d': true });
        const rows = draw();
        return order(rows) === 'Note,Delta,Alpha,Note to self,Charlie,Bravo'
          || ('order: ' + order(rows));
      });

      add('muted and draft glyphs survive on a note row', () => {
        seed();
        S.state.chats.set('!note-a', { ...NOTE_A, isMuted: true, draft: { text: 'later' } });
        const rows = draw();
        const row = rows.find((r) => r.title === 'Note to self');
        return row && row.flags.includes(PIN) && row.flags.length > 2
          || ('flags: ' + JSON.stringify(row));
      });

      // Report from the page, decide the exit code in Node: the renderer has
      // no process object to exit with.
      return JSON.stringify(cases.map(([name, ok, detail]) => [name, ok, detail]));
    })()
  `;

  await app.whenReady();
  const win = new BrowserWindow({ show: false });
  // A real file:// page, because a data: URL cannot import an ES module.
  await win.loadFile(path.join(__dirname, 'pin-harness.html'));
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);
  return JSON.parse(result);
}

main()
  .then((cases) => {
    let failed = 0;
    for (const [name, ok, detail] of cases) {
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
    }
    console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('failed:', err.message);
    process.exit(1);
  });
