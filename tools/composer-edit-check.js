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
