/**
 * Dev check: archiving has to survive a Beeper that accepts the request and
 * then does nothing with it.
 *
 * The bug this exists for: Beeper honours `isArchived` for ordinary chats and
 * for the Signal note-to-self chat, but silently ignores it for its own
 * built-in "Note to self" chat on beeper.com. The PATCH answers ok, the app
 * set the flag optimistically, and the next chat event merged Beeper's stale
 * value back in - so the row came straight back and the archive button looked
 * broken.
 *
 * The fix confirms the change against the server and records the user's choice
 * locally when Beeper disagrees. The stub below can be told to ignore the
 * request, which is the case the real app hits and the one the test asserts
 * against, so the fix fails the moment the confirmation is dropped.
 *
 * Run with `npm run check:archive`.
 */
const path = require('path');
const harnessGuard = require('./harness-guard');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;

// These modules use DOM globals, so exercise them in a real browser via Electron.
async function main() {
  const { app, BrowserWindow } = require('electron');

  // An isolated profile, so the test can never read a cached copy of the
  // renderer modules from userData.
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-archive-check-profile'));

  const harness = `
    (async () => {
      const S = await import(${JSON.stringify(js('state.js'))});
      const B = await import(${JSON.stringify(js('sidebar.js'))});
      const A = await import(${JSON.stringify(js('chat-actions.js'))});

      // A fake Beeper. "server" holds the chat objects Beeper would report,
      // "honour" decides whether an archive request is actually applied, and
      // "getFails" stands in for a confirmation that could not be made at all.
      const server = {};
      let honour = true;
      let getFails = false;
      let applyDelayMs = 0;
      const saved = [];

      const make = (id, title, extra) => Object.assign({
        id: id, title: title, lastActivity: '2026-01-01T00:00:00Z',
        type: 'single', participants: { items: [{ isSelf: false }] },
        unreadCount: 0, isArchived: false,
      }, extra || {});

      // A note-to-self chat is structurally one whose every participant is you.
      // The chat Beeper refuses to archive is its own built-in one, so the stub
      // models it faithfully: the row is a note row, labelled "Note".
      const makeNote = (id, title) =>
        make(id, title, { type: 'single', participants: { items: [{ isSelf: true }] } });

      window.beeper = {
        chats: {
          archive: async (id, archived) => {
            if (honour) {
              if (applyDelayMs > 0) {
                // Beeper can report the old value for a moment after accepting
                // the write. This is the race that once made an ordinary
                // archive look ignored.
                setTimeout(() => {
                  server[id] = { ...server[id], isArchived: archived };
                }, applyDelayMs);
              } else {
                server[id] = { ...server[id], isArchived: archived };
              }
            }
            // Beeper answers a successful archive with 204 and no body.
            return { ok: true, data: null };
          },
          get: async (id) => {
            if (getFails) return { ok: false, error: { message: 'offline' } };
            return { ok: true, data: { ...server[id] } };
          },
        },
        settings: {
          set: async (patch) => { saved.push(patch); return { ok: true, data: {} }; },
        },
        assets: { resolve: async () => ({ ok: true, data: { url: null } }) },
        shell: { openExternal: async () => ({ ok: true, data: null }) },
      };

      const NOTE = '!note:beeper.com';
      const PERSON = '!person:signal.localhost';

      const seed = () => {
        server[NOTE] = makeNote(NOTE, 'Note to self');
        server[PERSON] = make(PERSON, 'Mike Fazio');
        S.state.chats.clear();
        S.state.chats.set(NOTE, { ...server[NOTE] });
        S.state.chats.set(PERSON, { ...server[PERSON] });
        S.loadPins({});
        S.loadArchived([]);
        S.state.filter = 'all';
        S.state.searchQuery = '';
        S.state.activeChatID = null;
        honour = true;
        getFails = false;
        applyDelayMs = 0;
        saved.length = 0;
      };

      // The chat event that used to undo the optimistic update.
      const chatEvent = (id) => S.upsertChat({ id: id, isArchived: server[id].isArchived });

      const titles = (filter) => {
        S.state.filter = filter || 'all';
        B.renderChats();
        return [...document.querySelectorAll('#chat-list > .chat-item')]
          .map((n) => (n.querySelector('.chat-item-title') || {}).textContent)
          .join(',');
      };

      // The cases are async because the fix under test is an async round trip
      // to a stubbed Beeper, so they are collected first and then awaited in
      // order. Running them one at a time keeps a failure's detail readable.
      const cases = [];
      const add = (name, fn) => cases.push([name, fn]);

      const run = async (fn) => {
        let ok = false;
        let detail = '';
        try { const r = await fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        return [ok, detail];
      };

      add('a normal archive leaves the inbox', async () => {
        seed();
        const res = await A.setArchived(S.state.chats.get(PERSON), true);
        return res.ok === true && res.localOnly === false && titles() === 'Note'
          || ('res: ' + JSON.stringify(res) + ' list: ' + titles());
      });

      add('an ignored archive still leaves the inbox', async () => {
        // The regression. Beeper accepts the request and keeps reporting the
        // chat as unarchived, so the optimistic flag was all there was.
        seed(); honour = false;
        const res = await A.setArchived(S.state.chats.get(NOTE), true);
        return res.ok === true && titles() === 'Mike Fazio'
          || ('res: ' + JSON.stringify(res) + ' list: ' + titles());
      });

      add('an ignored archive is recorded so the next chat event cannot undo it', async () => {
        seed(); honour = false;
        await A.setArchived(S.state.chats.get(NOTE), true);
        chatEvent(NOTE);
        return titles() === 'Mike Fazio' || ('list: ' + titles());
      });

      add('an ignored archive is reported as local only', async () => {
        seed(); honour = false;
        const res = await A.setArchived(S.state.chats.get(NOTE), true);
        seed(); honour = true;
        const ok = await A.setArchived(S.state.chats.get(PERSON), true);
        return res.localOnly === true && ok.localOnly === false
          || ('ignored: ' + JSON.stringify(res) + ' honoured: ' + JSON.stringify(ok));
      });

      add('restoring removes the local override and returns the chat', async () => {
        seed(); honour = false;
        await A.setArchived(S.state.chats.get(NOTE), true);
        const hidden = titles();
        await A.setArchived(S.state.chats.get(NOTE), false);
        return hidden === 'Mike Fazio' && titles() === 'Note,Mike Fazio'
          || ('archived: ' + hidden + ' restored: ' + titles());
      });

      add('a locally archived chat is listed under Archive', async () => {
        seed(); honour = false;
        await A.setArchived(S.state.chats.get(NOTE), true);
        const inbox = titles('all');
        // The note chat keeps its own "Note" label in the archive view.
        const archive = titles('archive');
        return inbox === 'Mike Fazio' && archive === 'Note'
          || ('inbox: ' + inbox + ' archive: ' + archive);
      });

      add('a server that applies late is not mistaken for one that ignored it', async () => {
        // The confirming GET is not ordered behind the PATCH, so a single read
        // can catch the old value. Without retries this records a local
        // override for a chat Beeper archived perfectly well.
        seed(); applyDelayMs = 600;
        const res = await A.setArchived(S.state.chats.get(PERSON), true);
        return res.localOnly === false && S.archivedList().length === 0 && titles() === 'Note'
          || ('res: ' + JSON.stringify(res) + ' overrides: ' + JSON.stringify(S.archivedList()) + ' list: ' + titles());
      });

      add('a failed confirmation does not invent an override', async () => {
        // A GET that could not be made is not evidence that Beeper ignored the
        // request, so nothing should be written.
        seed(); honour = false; getFails = true;
        await A.setArchived(S.state.chats.get(NOTE), true);
        const written = saved.some((p) => Array.isArray(p.archivedChats) && p.archivedChats.length > 0);
        return !written && S.archivedList().length === 0
          || ('saved: ' + JSON.stringify(saved));
      });

      add('an archive made in another client is not shadowed', async () => {
        // Only the chats Beeper refuses are recorded, so a server-side archive
        // still shows up here on its own.
        seed();
        server[PERSON] = { ...server[PERSON], isArchived: true };
        chatEvent(PERSON);
        return titles() === 'Note' || ('list: ' + titles());
      });

      add('a confirmed archive clears a stale local override', async () => {
        // If Beeper ever starts honouring the request, the workaround has to
        // retire itself. Leaving it behind would keep this chat a special
        // case for good, and would shadow the server from then on.
        seed(); honour = false;
        await A.setArchived(S.state.chats.get(NOTE), true);
        const recorded = S.archivedList().length === 1;
        honour = true;
        await A.setArchived(S.state.chats.get(NOTE), true);
        return recorded && S.archivedList().length === 0 && titles() === 'Mike Fazio'
          || ('recorded: ' + recorded + ' now: ' + JSON.stringify(S.archivedList()) + ' list: ' + titles());
      });

      add('the override survives a restart', async () => {
        seed(); honour = false;
        await A.setArchived(S.state.chats.get(NOTE), true);
        const savedIds = S.archivedList();
        // What bootstrap does on the next launch.
        S.loadArchived(savedIds);
        chatEvent(NOTE);
        return titles() === 'Mike Fazio' || ('list: ' + titles());
      });

      // Report from the page, decide the exit code in Node.
      const results = [];
      for (const [name, fn] of cases) results.push([name, ...(await run(fn))]);
      return JSON.stringify(results);
    })()
  `;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:archive' });
  const win = new BrowserWindow({ show: false });
  // A real file:// page, because a data: URL cannot import an ES module.
  await win.loadFile(path.join(__dirname, 'archive-harness.html'));
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
