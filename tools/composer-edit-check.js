/**
 * Dev check: editing a message you have already sent.
 *
 * The rules that decide what can be edited live in one module with no
 * Electron and no thread import, so they can be driven directly here. A rule
 * that is wrong fails in this file rather than in a chat nobody opened.
 *
 * Every case has a control that reproduces the behaviour it replaced,
 * because a suite that has been green over a feature nobody exercised is
 * worse than no suite at all.
 *
 * The DOM is generated from the real index.html, so the check cannot drift
 * from the app, and the API boundary is stubbed so no account and no network
 * are needed.
 *
 * Run with `npm run check:composeredit`.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const HARNESS = path.join(__dirname, '.composer-edit-harness.html');

/** Real markup, real stylesheet, no app scripts. */
function buildHarness() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/href="styles\.css"/g, 'href="../src/renderer/styles.css"')
    .replace(/(href|src)="\.\//g, '$1="../src/renderer/');
  fs.writeFileSync(HARNESS, stripped);
}

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-composer-edit-profile'));
  buildHarness();

  const harness = String.raw`
    (async () => {
      const cases = [];
      const add = async (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = await fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };
      const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60));

      // A throw anywhere in the body must not take the cases collected so
      // far with it: a harness that dies reports one failure and hides the
      // rest, which is how a broken check looks like a passing one.
      try {
        await body();
      } catch (e) {
        cases.push(['the harness ran to the end', false, e && (e.stack || e.message)]);
      }
      return JSON.stringify(cases);

      async function body() {
        const CE = await import(${JSON.stringify(js('composer-edit.js'))});

        // --- the chat's capability -----------------------------------------

        const chat = (caps) => ({ id: 'c1', title: 'A chat', capabilities: caps });
        const NOW = Date.parse('2026-11-08T12:00:00Z');
        const own = (over) => Object.assign({
          id: 'm1',
          chatID: 'c1',
          isSender: true,
          isDeleted: false,
          type: 'TEXT',
          text: 'hello',
          timestamp: new Date(NOW - 1000).toISOString(),
        }, over || {});

        await add('a chat with no capabilities object may be edited', () =>
          CE.chatAllowsEdit(chat(undefined)) === true || 'it was refused');

        await add('CONTROL: a chat that says editing is full may be edited', () =>
          CE.chatAllowsEdit(chat({ edit: 2 })) === true || 'it was refused');

        await add('a chat that says editing is partial may be edited', () =>
          CE.chatAllowsEdit(chat({ edit: 1 })) === true || 'it was refused');

        await add('a chat that says editing is unsupported may not be edited', () =>
          CE.chatAllowsEdit(chat({ edit: 0 })) === false || 'it was allowed');

        await add('a chat that says editing is rejected may not be edited', () =>
          CE.chatAllowsEdit(chat({ edit: -2 })) === false || 'it was allowed');

        await add('a chat whose capabilities have no edit key may not be edited', () =>
          CE.chatAllowsEdit(chat({ attachments: {}, maxTextLength: 160 })) === false
          || 'it was allowed');

        await add('CONTROL: no capabilities object is not the same as no edit key', () =>
          (CE.chatAllowsEdit(chat(undefined)) === true
            && CE.chatAllowsEdit(chat({ maxTextLength: 160 })) === false)
          || 'the two states were treated the same');

        await add('the edit window is read in seconds', () =>
          CE.editMaxAgeSeconds(chat({ edit: 2, editMaxAge: 900 })) === 900
          || ('it read ' + CE.editMaxAgeSeconds(chat({ edit: 2, editMaxAge: 900 }))));

        await add('CONTROL: a chat with no edit window has no age limit', () =>
          CE.editMaxAgeSeconds(chat({ edit: 2 })) === null
          || ('it read ' + CE.editMaxAgeSeconds(chat({ edit: 2 }))));

        // --- the message ---------------------------------------------------

        await add('your own message can be edited', () =>
          CE.isEditableMessage(chat({ edit: 2 }), own(), NOW) === true || 'it was refused');

        await add('CONTROL: somebody else\'s message cannot be edited', () =>
          CE.isEditableMessage(chat({ edit: 2 }), own({ isSender: false }), NOW) === false
          || 'it was allowed');

        await add('a deleted message cannot be edited', () =>
          CE.isEditableMessage(chat({ edit: 2 }), own({ isDeleted: true }), NOW) === false
          || 'it was allowed');

        await add('a hidden message cannot be edited', () =>
          CE.isEditableMessage(chat({ edit: 2 }), own({ isHidden: true }), NOW) === false
          || 'it was allowed');

        await add('a message with an attachment cannot be edited', () =>
          CE.isEditableMessage(
            chat({ edit: 2 }), own({ attachments: [{ mimeType: 'image/png' }] }), NOW,
          ) === false || 'it was allowed');

        await add('a message inside the edit window can be edited', () =>
          CE.isEditableMessage(
            chat({ edit: 2, editMaxAge: 900 }),
            own({ timestamp: new Date(NOW - 600000).toISOString() }),
            NOW,
          ) === true || 'it was refused');

        await add('CONTROL: a message past the edit window cannot be edited', () =>
          CE.isEditableMessage(
            chat({ edit: 2, editMaxAge: 900 }),
            own({ timestamp: new Date(NOW - 1000000).toISOString() }),
            NOW,
          ) === false || 'it was allowed');

        await add('CONTROL: a chat with no edit window has no age limit', () =>
          CE.isEditableMessage(
            chat({ edit: 2 }),
            own({ timestamp: new Date(NOW - 100000000).toISOString() }),
            NOW,
          ) === true || 'an old message was refused');

        await add('CONTROL: a message with no timestamp cannot be edited', () =>
          CE.isEditableMessage(
            chat({ edit: 2, editMaxAge: 900 }), own({ timestamp: null }), NOW,
          ) === false || 'it was allowed');

        await add('a read-only chat may not be edited', () =>
          CE.isEditableMessage(
            { id: 'c1', isReadOnly: true, capabilities: { edit: 2 } }, own(), NOW,
          ) === false || 'it was allowed');

        // --- the list ------------------------------------------------------

        await add('the editable list is oldest first', () => {
          const list = CE.editableMessages(chat({ edit: 2 }), [
            own({ id: 'm3', timestamp: new Date(NOW - 3000).toISOString() }),
            own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
            own({ id: 'm2', timestamp: new Date(NOW - 6000).toISOString() }),
          ], NOW);
          return (list.length === 3 && list[0].id === 'm1' && list[2].id === 'm3')
            || ('got ' + list.map((m) => m.id).join(','));
        });

        await add('CONTROL: the editable list skips everything that cannot be edited', () => {
          const list = CE.editableMessages(chat({ edit: 2 }), [
            own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
            own({ id: 'm2', isSender: false, timestamp: new Date(NOW - 8000).toISOString() }),
            own({ id: 'm3', attachments: [{}], timestamp: new Date(NOW - 7000).toISOString() }),
            own({ id: 'm4', isDeleted: true, timestamp: new Date(NOW - 6000).toISOString() }),
            own({ id: 'm5', timestamp: new Date(NOW - 5000).toISOString() }),
          ], NOW);
          return (list.length === 2 && list[0].id === 'm1' && list[1].id === 'm5')
            || ('got ' + list.map((m) => m.id).join(','));
        });

        await add('the same chat and the same messages always give the same list', () => {
          const messages = [
            own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
            own({ id: 'm2', timestamp: new Date(NOW - 8000).toISOString() }),
          ];
          const a = CE.editableMessages(chat({ edit: 2 }), messages, NOW).map((m) => m.id);
          const b = CE.editableMessages(chat({ edit: 2 }), messages, NOW).map((m) => m.id);
          return (a.length === 2 && a.join(',') === b.join(',')) || 'the list changed between calls';
        });

        // --- the session, driven through the app ---------------------------

        const editCalls = [];
        const storeCalls = [];

        const envelope = (data) => ({ ok: true, data });
        const bubble = (id, ts, text, over) => Object.assign({
          id, chatID: 'c-edit', accountID: 'a1', senderID: 'a1', senderName: 'Me',
          text, timestamp: ts, isSender: true, type: 'TEXT', attachments: [],
        }, over || {});

        window.beeper = {
          on: () => {},
          chats: {
            list: async () => envelope([]),
            get: async () => envelope(null),
            patch: async () => envelope({}),
            markRead: async () => envelope(true),
            markUnread: async () => envelope(true),
            archive: async () => envelope(true),
            create: async () => envelope({}),
          },
          messages: {
            list: async () => envelope({ items: [], hasMore: false }),
            search: async () => envelope({ items: [] }),
            get: async () => envelope(null),
            edit: async (chatID, messageID, text) => {
              editCalls.push({ chatID, messageID, text });
              return envelope({ id: messageID, chatID, text });
            },
          },
          assets: {
            resolve: async () => envelope(null),
            download: async () => envelope(null),
            reupload: async () => envelope(null),
            saveAs: async () => envelope(null),
            pick: async () => envelope([]),
            upload: async () => envelope(null),
            uploadBytes: async () => envelope(null),
          },
          history: {
            // Five messages, and the two in the middle cannot be edited:
            // one is not mine and one has a picture. With only two eligible
            // messages the step could never be caught skipping anything, so
            // the skipping would be untested.
            open: async () => envelope({
              messages: [
                bubble('oldest', new Date(NOW - 5000).toISOString(), 'the oldest one'),
                bubble('theirs', new Date(NOW - 4000).toISOString(), 'not mine', { isSender: false }),
                bubble('pictures', new Date(NOW - 3000).toISOString(), 'with a picture', { attachments: [{ mimeType: 'image/png' }] }),
                bubble('middle', new Date(NOW - 2000).toISOString(), 'the middle one'),
                bubble('newest', new Date(NOW - 1000).toISOString(), 'the newest one'),
              ],
              complete: true,
              hasMore: false,
            }),
            page: async () => envelope({ messages: [], hasMore: false, complete: true }),
            upsert: async (chatID, message) => {
              storeCalls.push({ chatID, id: message.id, text: message.text });
              return envelope({ written: 1 });
            },
            search: async () => envelope([]),
            searchInChat: async () => envelope([]),
            status: async () => envelope({ messages: 0, chats: 0, bytes: 0 }),
            refresh: async () => envelope({ queued: true }),
            jobs: async () => envelope({ jobs: [] }),
          },
        };

        const S = await import(${JSON.stringify(js('state.js'))});
        const T = await import(${JSON.stringify(js('thread.js'))});
        T.initThread();
        S.state.chats.set('c-edit', {
          id: 'c-edit',
          title: 'A conversation',
          type: 'single',
          participants: { items: [{ isSelf: true }, { isSelf: false }] },
          capabilities: { edit: 2, editMaxCount: 10, editMaxAge: 86400 },
        });
        await T.openChat('c-edit');
        await settle(150);

        const composer = document.getElementById('composer');
        const banner = document.getElementById('edit-preview');
        const press = (key, extra) => composer.dispatchEvent(
          new KeyboardEvent('keydown', Object.assign({ key, bubbles: true }, extra || {})),
        );

        await add('the banner exists and is hidden to begin with', () =>
          (banner !== null && banner.hidden === true) || 'there is no banner');

        await add('the up arrow on an empty composer opens an edit', () => {
          press('ArrowUp');
          return CE.isEditing() === true || 'no edit was opened';
        });

        await add('the composer holds the text of the message being edited', () =>
          composer.value === 'the newest one' || ('it holds ' + composer.value));

        await add('the banner says what is being edited', () =>
          /Editing message/.test(document.getElementById('edit-preview-text').textContent)
          || 'the banner says nothing');

        await add('the composer placeholder says an edit is in progress', () =>
          /edit/i.test(composer.placeholder) || ('it reads ' + composer.placeholder));

        await add('the up arrow again steps to the older message', () => {
          press('ArrowUp');
          return composer.value === 'the middle one' || ('it holds ' + composer.value);
        });

        await add('CONTROL: the up arrow steps over another person\'s message and over a picture', () => {
          press('ArrowUp');
          return composer.value === 'the oldest one' || ('it holds ' + composer.value);
        });

        await add('CONTROL: there is nothing older to step to', () => {
          press('ArrowUp');
          return composer.value === 'the oldest one' || ('it holds ' + composer.value);
        });

        await add('the down arrow steps back to the newer message', () => {
          press('ArrowDown');
          press('ArrowDown');
          return composer.value === 'the newest one' || ('it holds ' + composer.value);
        });

        await add('CONTROL: the up arrow does nothing when the composer has text', () => {
          CE.cancelEdit();
          composer.value = 'a message being written';
          press('ArrowUp');
          const opened = CE.isEditing();
          composer.value = '';
          CE.cancelEdit();
          return opened === false || 'the arrow took over a draft';
        });

        await add('CONTROL: the up arrow does not step once the text has been changed', () => {
          press('ArrowUp');
          const before = composer.value;
          composer.value = before + ' and changed';
          press('ArrowUp');
          const after = composer.value;
          CE.cancelEdit();
          return after === before + ' and changed' || ('it stepped to ' + after);
        });

        await add('the message being edited stays in the thread while the edit is open', async () => {
          press('ArrowUp');
          const before = document.querySelector('[data-message-id="newest"]');
          // An upsert of the message is what makes the thread rebuild, and
          // the rebuild is when a bubble being edited could go missing.
          const stored = S.state.messages.get('c-edit') || [];
          const message = stored.find((m) => m.id === 'newest');
          S.upsertMessage('c-edit', { ...message });
          await settle(200);
          const after = document.querySelector('[data-message-id="newest"]');
          const kept = after && after.textContent.includes('the newest one');
          const rebuilt = after !== before;
          CE.cancelEdit();
          return (kept && rebuilt)
            || ('the bubble ' + (kept ? 'was not rebuilt' : 'went missing'));
        });

        await add('CONTROL: the composer placeholder goes back to the chat after the edit', () => {
          press('ArrowUp');
          const during = composer.placeholder;
          CE.cancelEdit();
          const after = composer.placeholder;
          return (/edit/i.test(during) && after === 'A conversation')
            || ('it says ' + after);
        });

        await add('CONTROL: a reply cancels an open edit', () => {
          press('ArrowUp');
          const opened = CE.isEditing();
          const stored = S.state.messages.get('c-edit') || [];
          const message = stored.find((m) => m.id === 'newest');
          const items = T.messageMenuItems(null, message);
          const reply = items.find((item) => item.label === 'Reply');
          reply.onSelect();
          const closed = CE.isEditing() === false;
          const bannerHidden = banner.hidden === true;
          const replyShown = document.getElementById('reply-preview').hidden === false;
          return (opened && closed && bannerHidden && replyShown)
            || ('the edit and the reply were both up: ' + closed + '/' + bannerHidden + '/' + replyShown);
        });

        await add('CONTROL: an edit that changes nothing is not sent', async () => {
          press('ArrowUp');
          editCalls.length = 0;
          press('Enter');
          await settle(150);
          const none = editCalls.length === 0;
          const closed = CE.isEditing() === false;
          CE.cancelEdit();
          return (none && closed)
            || (editCalls.length + ' calls were made, still editing: ' + !closed);
        });

        await add('Enter saves the edit', async () => {
          press('ArrowUp');
          composer.value = 'the newest one, corrected';
          editCalls.length = 0;
          press('Enter');
          await settle(200);
          return editCalls.length === 1 || (editCalls.length + ' calls were made');
        });

        await add('the edit goes to the message being edited', () =>
          (editCalls[0] && editCalls[0].messageID === 'newest' && editCalls[0].chatID === 'c-edit')
          || ('it went to ' + JSON.stringify(editCalls[0])));

        await add('the edit carries the new text', () =>
          (editCalls[0] && editCalls[0].text === 'the newest one, corrected')
          || ('it carried ' + JSON.stringify(editCalls[0] && editCalls[0].text)));

        await add('the bubble shows the new text', async () => {
          await settle(200);
          const node = document.querySelector('[data-message-id="newest"]');
          return (node && node.textContent.includes('the newest one, corrected'))
            || 'the bubble still shows the old text';
        });

        await add('the edit is written to the local store', async () => {
          await settle(200);
          const written = storeCalls.find((c) => c.id === 'newest');
          return (written && written.text === 'the newest one, corrected')
            || ('the store was told ' + JSON.stringify(storeCalls));
        });

        await add('CONTROL: the banner is hidden once the edit is saved', () =>
          banner.hidden === true || 'the banner stayed open');

        await add('CONTROL: Escape cancels the edit', () => {
          press('ArrowUp');
          const opened = CE.isEditing();
          press('Escape');
          return (opened === true && CE.isEditing() === false) || 'the edit survived';
        });

        await add('CONTROL: a cancelled edit makes no call', async () => {
          editCalls.length = 0;
          press('ArrowUp');
          press('Escape');
          await settle(150);
          return editCalls.length === 0 || (editCalls.length + ' calls were made');
        });

        await add('CONTROL: a cancelled edit empties the composer', () => {
          press('ArrowUp');
          press('Escape');
          return composer.value === '' || ('it holds ' + composer.value);
        });

        await add('CONTROL: an empty edit is not sent', async () => {
          press('ArrowUp');
          composer.value = '   ';
          editCalls.length = 0;
          press('Enter');
          await settle(150);
          const none = editCalls.length === 0;
          CE.cancelEdit();
          return none || (editCalls.length + ' calls were made');
        });

        await add('CONTROL: a read-only chat does not open an edit', () => {
          const chat = S.state.chats.get('c-edit');
          const was = chat.isReadOnly;
          chat.isReadOnly = true;
          press('ArrowUp');
          const opened = CE.isEditing();
          chat.isReadOnly = was;
          CE.cancelEdit();
          return opened === false || 'the edit opened in a read-only chat';
        });

        await add('the session says which message is being edited', () => {
          press('ArrowUp');
          const session = CE.editSession();
          const ok = (session.messageID === 'newest' && session.total === 3 && session.index === 2);
          CE.cancelEdit();
          return ok || ('it says ' + JSON.stringify(session));
        });

        await add('CONTROL: opening another conversation cancels the edit', async () => {
          press('ArrowUp');
          const opened = CE.isEditing();
          S.state.chats.set('c-other', {
            id: 'c-other', title: 'Another conversation', type: 'single',
            participants: { items: [{ isSelf: true }, { isSelf: false }] },
          });
          await T.openChat('c-other');
          await settle(200);
          return (opened === true && CE.isEditing() === false) || 'the edit survived the switch';
        });

        // --- one edit mode -------------------------------------------------

        // The conversation is opened again first, so the menu is asked about
        // the chat that advertises editing rather than the one the switch
        // left behind.
        await T.openChat('c-edit');
        await settle(200);

        await add('the menu offers Edit on an editable message', () => {
          const message = S.state.messages.get('c-edit').find((m) => m.id === 'newest');
          const items = T.messageMenuItems(document.body, message);
          return items.some((i) => i.label === 'Edit') || 'there is no Edit item';
        });

        await add('CONTROL: the menu does not offer Edit on a message that cannot be edited', () => {
          const message = S.state.messages.get('c-edit').find((m) => m.id === 'pictures');
          const items = T.messageMenuItems(document.body, message);
          return items.some((i) => i.label === 'Edit') === false || 'Edit was offered';
        });

        await add('CONTROL: the menu still offers Delete for everyone on a message that cannot be edited', () => {
          const message = S.state.messages.get('c-edit').find((m) => m.id === 'pictures');
          const items = T.messageMenuItems(document.body, message);
          return items.some((i) => i.label === 'Delete for everyone')
            || 'the delete item was taken away';
        });

        await add('CONTROL: the menu Edit opens the composer session', () => {
          const message = S.state.messages.get('c-edit').find((m) => m.id === 'newest');
          const items = T.messageMenuItems(document.body, message);
          const edit = items.find((i) => i.label === 'Edit');
          if (!edit) return 'there is no Edit item';
          edit.onSelect();
          const opened = CE.isEditing();
          CE.cancelEdit();
          return opened === true || 'the session did not open';
        });

        await add('CONTROL: there is no editor in the bubble any more', async () => {
          press('ArrowUp');
          // The thread is drawn again while the edit is open, which is when
          // the old bubble editor would have put its textarea on screen.
          S.upsertMessage(
            'c-edit',
            bubble('newest', new Date(NOW - 1000).toISOString(), 'the newest one, corrected'),
          );
          await settle(250);
          const textareas = document.querySelectorAll('#message-list textarea').length;
          CE.cancelEdit();
          return textareas === 0 || (textareas + ' textareas are in the thread');
        });
      }
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:composeredit' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(HARNESS);
  let harnessCases;
  try {
    const result = await win.webContents.executeJavaScript(harness, true);
    harnessCases = JSON.parse(result);
  } catch (err) {
    harnessCases = [['the browser harness ran to the end', false, err.message]];
  }
  app.exit(0);

  // The wiring across the processes is checked against the source: the edit
  // has to reach Beeper, and a break in any of the three lists leaves the
  // button doing nothing at all, with nothing on screen to say so.
  //
  // The channel name is a string on both sides of the bridge, and a typo on
  // one side only leaves both source checks green while the feature does
  // nothing. So the two names are read out of the source and compared.
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'api.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'main.js'), 'utf8');

  const preloadChannel = (preloadSrc.match(/edit: \(chatID, messageID, text\) => invoke\('([^']+)'/) || [])[1];
  const ipcChannel = (ipcSrc.match(/ipcMain\.handle\('([^']+)', handle\(\(chatID, messageID, text\)/) || [])[1];

  const sourceCases = [
    ['the renderer can ask for an edit',
      /edit: \(chatID, messageID, text\) => window\.beeper\.messages\.edit\(/.test(apiSrc)],
    ['the preload can send one',
      /edit: \(chatID, messageID, text\) => invoke\('messages:edit'/.test(preloadSrc)],
    ['the main process has a handler for it',
      /ipcMain\.handle\('messages:edit'/.test(ipcSrc)],
    ['and the two sides are talking about the same channel',
      Boolean(preloadChannel) && preloadChannel === ipcChannel,
      `the preload listens on "${preloadChannel}", the main process handles "${ipcChannel}"`],
    // The global Escape handler runs in the capture phase, so it sees the key
    // before the composer's own handler does. Without this guard one Escape
    // would cancel the edit and close the conversation behind it, and
    // nothing in the harness could catch it, because the harness does not
    // load main.js.
    ['the global Escape handler leaves an edit alone',
      /if \(state\.editing\) return;/.test(mainSrc)],
  ].map(([name, ok, detail]) => [name, ok, detail || '']);

  const cases = harnessCases.concat(sourceCases);
  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
