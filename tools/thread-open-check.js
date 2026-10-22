/**
 * Dev check: opening a chat must never blank a conversation the window already has.
 *
 * The bug, reported as "I click into a chat and it shows blank while it syncs,
 * even though there were items there previously".
 *
 * It was not the sync. state.messages is a Map that keeps every chat this window
 * has loaded, and openChat cleared the thread, drew a bare "Loading messages...",
 * and only then awaited the store read - throwing away the messages it was
 * holding. The store read is local rather than a network call, so it is normally
 * quick, but it is still an IPC round trip into the very process that is running
 * the background syncs. Click back into a chat while a sync is in flight and the
 * read queues behind it, so the thread stays blank until the sync lets go. Every
 * other check passed throughout: the messages were in state the whole time, they
 * were simply not on screen.
 *
 * So the assertion is made on the screen while the read is still pending. The
 * harness stubs history.open with a promise it never resolves, which is the
 * queued-behind-a-sync state exactly, and then measures the DOM - no timing, no
 * thresholds, nothing that can pass slowly.
 *
 * The harness page is generated from the real index.html with its scripts
 * stripped, so the DOM here cannot drift from the DOM the app ships.
 *
 * Run with: npm run check:threadopen.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const HARNESS = path.join(__dirname, '.thread-open-harness.html');

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
  app.setPath('userData', path.join(os.tmpdir(), 'bb-thread-open-profile'));
  buildHarness();

  const harness = String.raw`
    (async () => {
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
          detail = e && (e.stack || e.message);
        }
        cases.push([name, ok, detail]);
      };

      try {
        await body();
      } catch (e) {
        cases.push(['the harness ran to completion', false, e && (e.stack || e.message)]);
      }
      return JSON.stringify(cases);

      async function body() {
        const envelope = (data) => ({ ok: true, data });
        const settle = () => new Promise((r) => setTimeout(r, 40));
        // A read that never comes back: the state a user is in when the main
        // process is busy and the round trip queues behind a sync.
        const forever = () => new Promise(() => {});
        const give = (page) => async () => envelope(page);
        const boom = () => Promise.reject(new Error('store unavailable'));

        let plan = forever;
        const opens = [];

        window.beeper = {
          app: { bootstrap: async () => envelope({}), refreshDiscovery: async () => envelope({}), badge: async () => envelope(true) },
          updater: { check: async () => envelope({}), download: async () => envelope({}), quit: async () => envelope({}) },
          auth: { status: async () => envelope({}), connect: async () => envelope({}), manual: async () => envelope({}), disconnect: async () => envelope({}) },
          accounts: { list: async () => envelope([]) },
          contacts: { list: async () => envelope({ items: [] }) },
          assets: { resolve: async () => envelope({ url: null }), reupload: async () => envelope({}) },
          images: {},
          shell: { openExternal: async () => envelope(true), showItemInFolder: async () => envelope(true) },
          mcp: { tools: async () => envelope({ tools: [] }) },
          settings: { get: async () => envelope({}), set: async () => envelope({}) },
          events: { subscribe: async () => envelope({ subscribed: 1 }) },
          chats: {
            list: async () => envelope([]),
            search: async () => envelope({ items: [] }),
            get: async () => envelope(null),
            patch: async () => envelope({}),
            archive: async () => envelope(true),
            markRead: async () => envelope(true),
            markUnread: async () => envelope(true),
            create: async () => envelope({}),
          },
          messages: { list: async () => envelope({ items: [], hasMore: false }) },
          history: {
            open: (chatID) => { opens.push(chatID); return plan(chatID); },
            page: async () => envelope({ messages: [], hasMore: false, complete: true }),
            upsert: async () => envelope({ written: 1 }),
            search: async () => envelope([]),
            status: async () => envelope({ messages: 0, chats: 0, bytes: 0, mediaBytes: 0, running: 0, queued: 0 }),
            refresh: async () => envelope({ queued: true }),
            jobs: async () => envelope({ jobs: [] }),
          },
        };

        const S = await import(${JSON.stringify(js('state.js'))});
        const T = await import(${JSON.stringify(js('thread.js'))});
        T.initThread();

        const listEl = document.getElementById('message-list');
        const msg = (id, chatID, text, at) => ({
          id: id, chatID: chatID, timestamp: at, text: text,
          senderID: 's', senderName: 'Someone', type: 'TEXT', attachments: [],
        });
        const chatRec = (id, title) => ({
          id: id, title: title, type: 'single',
          participants: { items: [{ isSelf: true }, { isSelf: false }] },
        });

        for (const c of ['c-cached', 'c-empty', 'c-more', 'c-broken']) {
          S.state.chats.set(c, chatRec(c, 'Chat ' + c));
        }
        // The cache this window already holds, from having had the chat open.
        S.state.messages.set('c-cached', [
          msg('k1', 'c-cached', 'cached message one', 1000),
          msg('k2', 'c-cached', 'cached message two', 2000),
        ]);

        const rows = () => listEl.querySelectorAll('[data-message-id]');
        const rowIDs = () => [...rows()].map((n) => n.getAttribute('data-message-id'));
        const loading = () => {
          const n = listEl.querySelector('.search-loading');
          return n ? n.textContent : '';
        };
        const hint = () => /scroll up/i.test(loading());
        const failedNote = () => /could not load messages/i.test(listEl.textContent || '');

        // Every open must still read the store, exactly once. Drawing the cache
        // first is not a reason to skip the read, and it is the read that
        // brings in anything the cache does not have. Counting the opens here
        // rather than writing the number out means this cannot drift when a
        // case above is added.
        let expectedOpens = 0;
        const open = (id) => {
          expectedOpens += 1;
          return T.openChat(id);
        };

        // --- a store that does report more on disk --------------------------
        // Baseline for the scroll-back case below: hasMore really does draw the
        // affordance, so its absence afterwards means something.
        plan = give({ messages: [msg('s1', 'c-more', 'stored message one', 1000)], hasMore: true, complete: false });
        await open('c-more');
        await settle();

        add('a store reporting older messages offers to scroll for more', () =>
          hint() || 'no scroll-up affordance although the store reported hasMore');

        // --- the bug ---------------------------------------------------------
        // c-cached is in state.messages and its read never returns.
        plan = forever;
        const pending = open('c-cached');
        await settle();

        add('a chat this window already has is drawn while the store read is pending', () =>
          (rowIDs().includes('k1') && rowIDs().includes('k2'))
          || ('rows on screen: ' + JSON.stringify(rowIDs())));

        add('a chat this window already has does not claim to be loading', () =>
          !/loading messages/i.test(loading())
          || ('thread is showing ' + JSON.stringify(loading())));

        // The cursor belongs in the composer, and it belongs there before the
        // store answers. The read is an IPC round trip that can queue behind a
        // background sync, and waiting for it would mean waiting for the
        // cursor too - which is the whole point of the complaint this answers.
        //
        // A window that is not on screen cannot take focus at all - Chromium
        // will not move the focus into a hidden window - so what is measured
        // here is that the app asks the composer for focus, and that the
        // composer is the last thing it asked.
        //
        // The spy is installed here rather than at the top of the harness so
        // it measures this open and not the ones before it.
        const focusCalls = [];
        const realProtoFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (...args) {
          focusCalls.push(this.id || this.tagName || 'unknown');
          return realProtoFocus.apply(this, args);
        };

        plan = forever;
        open('c-cached');
        await settle();

        add('the composer is asked for focus when a chat is opened', () =>
          focusCalls.includes('composer')
          || ('focus went to ' + JSON.stringify(focusCalls)));

        add('and the composer is the last thing focused', () =>
          focusCalls[focusCalls.length - 1] === 'composer'
          || ('the last focus went to ' + focusCalls[focusCalls.length - 1]));

        add('the caret goes to the end of the draft, not the start', () => {
          const input = document.getElementById('composer');
          input.value = 'a draft that is already there';
          T.focusComposer();
          return input.selectionStart === input.value.length
            || ('the caret is at ' + input.selectionStart);
        });

        HTMLElement.prototype.focus = realProtoFocus;

        add('no scroll-back header from the chat opened before this one', () =>
          !hint() || ('inherited ' + JSON.stringify(loading()) + ' from c-more'));

        // --- a chat this window has never opened is unchanged ---------------
        plan = forever;
        open('c-empty');
        await settle();

        add('a chat with nothing cached still says it is loading', () =>
          /loading messages/i.test(loading())
          || ('thread shows ' + JSON.stringify(listEl.textContent || '').slice(0, 80)));

        add('opening an uncached chat leaves nothing of the previous one behind', () =>
          rowIDs().length === 0 || ('carried over ' + JSON.stringify(rowIDs())));

        // --- the store still wins once it answers ---------------------------
        plan = give({
          messages: [msg('k3', 'c-cached', 'straight from the store', 3000)],
          hasMore: false, complete: true,
        });
        await open('c-cached');
        await settle();

        add('messages the store returned are drawn once the read answers', () =>
          rowIDs().includes('k3')
          || ('rows on screen: ' + JSON.stringify(rowIDs())));

        add('the cached messages are still there afterwards', () =>
          (rowIDs().includes('k1') && rowIDs().includes('k2'))
          || ('rows on screen: ' + JSON.stringify(rowIDs())));

        add('a store reporting nothing older drops the scroll-back header', () =>
          !hint() || 'still offering to scroll for more');

        // --- a read that fails ----------------------------------------------
        plan = boom;
        await open('c-cached');
        await settle();

        add('a failed read does not throw away messages already on screen', () =>
          (rowIDs().includes('k1') && rowIDs().includes('k2'))
          || ('rows on screen: ' + JSON.stringify(rowIDs())));

        add('a failed read is not reported over a thread that still has content', () =>
          !failedNote() || 'showed the failure note on top of the cached messages');

        plan = boom;
        await open('c-broken');
        await settle();

        add('a failed read with nothing cached does say so', () =>
          failedNote() || ('thread shows ' + JSON.stringify(listEl.textContent || '').slice(0, 80)));

        // --- and the read is still asked for ---------------------------------
        add('the store is still read once per open, not skipped', () =>
          opens.length === expectedOpens
          || (opens.length + ' store reads for ' + expectedOpens + ' opens'));

        document.getElementById('modal-root') && document.getElementById('modal-root').replaceChildren();
      }
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:threadopen' });
  const win = new BrowserWindow({ show: false, width: 1100, height: 800 });
  win.webContents.setZoomFactor(1.15);
  await win.loadFile(HARNESS);
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);

  const cases = JSON.parse(result);
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