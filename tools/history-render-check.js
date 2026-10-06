/**
 * Dev check: the thread reads history from disk, not from Beeper.
 *
 * The whole point of the local store is that opening a chat and scrolling back
 * do not go to the network. That is invisible to every other check: check:api
 * only compares channel names, and check:history tests the store in isolation.
 * Only this one can catch the thread quietly going back to api.messages.list,
 * which would leave every test green and the app exactly as slow as before.
 *
 * So the assertion is made on the bridge, not on the source: the stub counts
 * what the thread actually asks for.
 *
 * The harness page is generated from the real index.html with its scripts
 * stripped, so the DOM here cannot drift from the DOM the app ships.
 *
 * Run with `npm run check:historyrender`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const HARNESS = path.join(__dirname, '.history-render-harness.html');

/** Real markup, real stylesheet, no app scripts. */
function buildHarness() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const stripped = html
    // Strip every script, whatever it is, so nothing tries to boot the app.
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    // The page is served from tools/, so the app's relative asset paths move.
    .replace(/(href|src)="\.\//g, '$1="../src/renderer/');
  fs.writeFileSync(HARNESS, stripped);
}

async function main() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-history-render-profile'));
  buildHarness();

  const harness = String.raw`
    (async () => {
      const cases = [];
      try {
        await body();
      } catch (e) {
        cases.push(['the harness ran to completion', false, e && (e.stack || e.message)]);
      }
      return JSON.stringify(cases);

      async function body() {
      const T = await import(${JSON.stringify(js('thread.js'))});

      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      // What the thread actually asked the main process for.
      const asked = { list: 0, historyOpen: 0, historyPage: 0, upsert: 0 };

      const envelope = (data) => ({ ok: true, data });

      window.beeper = {
        assets: { resolve: async () => envelope({ url: null }) },
        images: {},
        shell: { openExternal: async () => envelope(true) },
        chats: {
          get: async () => envelope({ id: 'h1', title: 'A chat' }),
          markRead: async () => envelope(true),
        },
        messages: {
          // The call this feature exists to stop making.
          list: async () => { asked.list++; return envelope({ items: [], hasMore: false }); },
        },
        settings: { get: async () => envelope({}), set: async () => envelope({}) },
        events: { subscribe: async () => envelope({ subscribed: 0 }) },
        history: {
          open: async () => {
            asked.historyOpen++;
            return envelope({
              messages: [
                { id: 'h-m2', chatID: 'h1', timestamp: 2000, text: 'stored message two', senderID: 's', senderName: 'Someone' },
                { id: 'h-m1', chatID: 'h1', timestamp: 1000, text: 'stored message one', senderID: 's', senderName: 'Someone' },
              ],
              complete: false,
            });
          },
          page: async () => {
            asked.historyPage++;
            return envelope({ messages: [], hasMore: false, complete: true });
          },
          upsert: async () => { asked.upsert++; return envelope({ written: 1 }); },
          search: async () => envelope([]),
          status: async () => envelope({ messages: 0, chats: 0, bytes: 0, mediaBytes: 0 }),
        },
      };

      const chat = {
        id: 'h1',
        title: 'A chat',
        type: 'single',
        participants: { items: [{ isSelf: true }, { isSelf: false }] },
      };

      // The scroll listener that triggers scroll-back is bound in
      // initThread(), so it has to run before scrolling can mean anything.
      T.initThread();

      await T.openChat('h1');

      const listEl = document.getElementById('message-list');

      add('opening a chat asks the local store, not Beeper', () => {
        return (asked.historyOpen === 1 && asked.list === 0)
          || ('history.open ' + asked.historyOpen + ', messages.list ' + asked.list);
      });

      add('the stored messages are what gets drawn', () => {
        const text = listEl.textContent || '';
        return (text.includes('stored message one') && text.includes('stored message two'))
          || ('thread drew ' + JSON.stringify(text.slice(0, 80)));
      });

      add('an unfinished chat still offers to scroll for more', () => {
        const hint = listEl.querySelector('.search-loading');
        return (hint && /scroll up/i.test(hint.textContent))
          || 'no scroll-up affordance on an incomplete chat';
      });

      // Scrolling back must read from disk too, driven the way a user drives
      // it rather than by calling an internal. openChat holds a settle window
      // open for about 1.5s so its own scrolling is not read as the user
      // scrolling up, so the wait below is that window, not padding.
      asked.historyPage = 0;
      asked.list = 0;
      await new Promise((r) => setTimeout(r, 1700));
      listEl.scrollTop = 0;
      listEl.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 400));

      add('scrolling back asks the local store for older messages', () =>
        (asked.historyPage > 0 && asked.list === 0)
        || ('history.page ' + asked.historyPage + ', messages.list ' + asked.list));

      add('scrolling back never calls Beeper', () =>
        asked.list === 0 || ('called messages.list ' + asked.list + ' times'));

      // --- a backfill landing on the open chat -------------------------------
      //
      // Found live: opening a chat nobody had opened before drew "No messages
      // here yet", and the thousands of messages the queue then fetched stayed
      // invisible until the chat was opened a second time. The store filled up
      // perfectly; the renderer was simply never told.
      let progress = null;
      let pageTwo = {
        messages: [
          { id: 'h-m1', chatID: 'h1', timestamp: 1000, text: 'stored message one', senderID: 's', senderName: 'Someone' },
          { id: 'h-m2', chatID: 'h1', timestamp: 2000, text: 'stored message two', senderID: 's', senderName: 'Someone' },
        ],
        complete: true,
      };
      window.beeper.on = {
        historyProgress: (fn) => { progress = fn; },
      };
      window.beeper.history.open = async () => envelope(pageTwo);

      // Restart initThread so the real subscription is in place.
      T.initThread();
      await T.openChat('h1');
      await new Promise((r) => setTimeout(r, 120));

      add('the thread subscribes to the backfill queue', () =>
        typeof progress === 'function' || 'no progress subscription');

      // A chat id nobody has opened, so the store genuinely has nothing for it.
      pageTwo = { messages: [], complete: false };
      await T.openChat('h-empty');
      await new Promise((r) => setTimeout(r, 120));
      const emptyText = listEl.textContent || '';

      pageTwo = {
        messages: [
          { id: 'b1', chatID: 'h-empty', timestamp: 1000, text: 'arrived from the backfill', senderID: 's', senderName: 'Someone' },
          { id: 'b2', chatID: 'h-empty', timestamp: 2000, text: 'also arrived late', senderID: 's', senderName: 'Someone' },
        ],
        complete: true,
      };
      progress({ chatID: 'h-empty', state: 'done' });
      await new Promise((r) => setTimeout(r, 200));

      add('a chat with nothing stored yet says so', () =>
        /No messages here yet/i.test(emptyText) || ('drew ' + JSON.stringify(emptyText.slice(0, 60))));

      add('messages the backfill fetched appear without reopening', () =>
        (listEl.textContent || '').includes('arrived from the backfill')
        || ('thread still shows ' + JSON.stringify((listEl.textContent || '').slice(0, 60))));

      add('the scroll-up hint goes away once the chat is complete', () => {
        const hint = listEl.querySelector('.search-loading');
        return !hint || !/scroll up/i.test(hint.textContent) || 'still offering to scroll for more';
      });

      // --- search covers the local store -----------------------------------
      //
      // Beeper caps message search at 20 and only reaches what a bridge has
      // indexed. The local store is merged in for everything else, and a
      // message both sides know about must not appear twice.
      const M = await import(${JSON.stringify(js('modals.js'))});
      const B = await import(${JSON.stringify(js('sidebar.js'))});

      const overlap = { id: 'h-m1', chatID: 'h1', text: 'stored message one', senderName: 'Someone' };
      let remoteHits = [];
      let localHits = [
        overlap,
        { id: 'h-m2', chatID: 'h1', text: 'stored message two', senderName: 'Someone' },
      ];
      window.beeper.messages.search = async () => envelope({ items: remoteHits });
      window.beeper.history.search = async () => envelope(localHits);
      window.beeper.chats.search = async () => envelope({ items: [] });
      window.beeper.chats.list = async () => envelope([]);

      B.initSidebar({ onSelectChat: () => {}, onSelectView: () => {} });
      const searchInput = document.getElementById('search-input');
      searchInput.value = 'stored';
      searchInput.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 700));
      const chatList = document.getElementById('chat-list');

      const countOf = (text, needle) => (text.split(needle).length - 1);

      add('search shows local hits', () =>
        (chatList.textContent || '').includes('stored message two') || 'no local hit drawn');

      add('a message both sides know about is drawn once', () =>
        countOf(chatList.textContent || '', 'stored message one') === 1
        || ('drawn ' + countOf(chatList.textContent || '', 'stored message one') + ' times'));

      // --- settings reports measured numbers, not written-in ones -----------
      window.beeper.history.status = async () =>
        envelope({
          messages: 4242,
          chats: 7,
          bytes: 1234567,
          mediaCount: 3,
          mediaBytes: 987654321,
          running: null,
          queued: 0,
        });

      await M.openSettings();
      await new Promise((r) => setTimeout(r, 150));
      const stats = document.querySelector('.history-stats-inner');
      const statsText = stats ? stats.textContent : '';

      add('settings has a history section', () => statsText.length > 0 || 'section missing');

      add('the stored message count comes from the main process', () =>
        statsText.includes('4242') || ('got ' + JSON.stringify(statsText.slice(0, 80))));

      add('the database size is the real byte count', () =>
        statsText.includes('1.2 MB') || ('got ' + JSON.stringify(statsText.slice(0, 120))));

      add('the attachment total is measured too', () =>
        statsText.includes('3 files, 941.9 MB') || ('got ' + JSON.stringify(statsText.slice(0, 160))));

      add('the history section is visible without scrolling', () => {
        const body = document.querySelector('.modal-body');
        if (!body || !stats) return 'nothing to measure';
        const box = stats.getBoundingClientRect();
        const view = body.getBoundingClientRect();
        return box.top >= view.top && box.bottom <= view.bottom
          || ('section at ' + Math.round(box.top) + '-' + Math.round(box.bottom)
            + ' inside ' + Math.round(view.top) + '-' + Math.round(view.bottom));
      });

      document.getElementById('modal-root')?.replaceChildren();
      }
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:historyrender' });
  const win = new BrowserWindow({ show: false, width: 1100, height: 780 });
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