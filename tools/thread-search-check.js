/**
 * Dev check: the rules behind searching inside a conversation.
 *
 * The matching rule, the merge of the two sources, the step order and the
 * highlighter all live in one module with no Electron and no thread import,
 * so they can be driven directly here. A rule that is wrong fails in this
 * file rather than in a thread nobody opened.
 *
 * Every case has a control that reproduces the behaviour it replaced,
 * because a suite that has been green over a feature nobody exercised is
 * worse than no suite at all.
 *
 * The DOM is generated from the real index.html, so the check cannot drift
 * from the app, and the API boundary is stubbed so no account and no network
 * are needed.
 *
 * Run with `npm run check:threadsearch`.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const HARNESS = path.join(__dirname, '.thread-search-harness.html');

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
  app.setPath('userData', path.join(os.tmpdir(), 'bb-thread-search-profile'));
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
        const TS = await import(${JSON.stringify(js('thread-search.js'))});

        // --- the matching rule -------------------------------------------

        await add('a fragment of a word matches', () =>
          TS.matchesQuery('the battery is flat', 'batt') === true || 'the fragment did not match');

        await add('the whole word matches too', () =>
          TS.matchesQuery('the battery is flat', 'battery') === true || 'the word did not match');

        await add('a word that is not there does not match', () =>
          TS.matchesQuery('the battery is flat', 'batteryx') === false || 'it matched anyway');

        await add('the match ignores case', () =>
          TS.matchesQuery('The Battery Is Flat', 'BATTERY') === true || 'the case mattered');

        await add('every term of a multi-word query must be found', () =>
          (TS.matchesQuery('the battery is flat', 'flat batt') === true
            && TS.matchesQuery('the battery is flat', 'flat missing') === false)
          || 'the terms were not all required');

        await add('an empty query matches nothing', () =>
          TS.matchesQuery('anything', '') === false || 'an empty query matched');

        await add('a single word query is one word', () =>
          (TS.isSingleWord('battery') === true && TS.isSingleWord('flat battery') === false)
          || 'the word count was wrong');

        await add('CONTROL: an empty query is not a single word', () =>
          TS.isSingleWord('') === false || 'an empty query counted as a word');

        // --- the merge ----------------------------------------------------

        await add('two sources are merged into one list', () => {
          const merged = TS.mergeHits(
            [{ chatID: 'c1', id: 'a', text: 'x', ts: 1000 }],
            [{ chatID: 'c1', id: 'b', text: 'y', timestamp: 2000 }],
          );
          return (merged.length === 2 && merged[0].id === 'a' && merged[1].id === 'b')
            || ('got ' + JSON.stringify(merged.map((h) => h.id)));
        });

        await add('a message both sides know about appears once', () => {
          const merged = TS.mergeHits(
            [{ chatID: 'c1', id: 'a', text: 'x', ts: 1000 }],
            [{ chatID: 'c1', id: 'a', text: 'x', timestamp: 1000 }],
          );
          return merged.length === 1 || ('got ' + merged.length);
        });

        await add('the local copy wins, so a known message is not fetched again', () => {
          const merged = TS.mergeHits(
            [{ chatID: 'c1', id: 'a', text: 'x', ts: 1000 }],
            [{ chatID: 'c1', id: 'a', text: 'x', timestamp: 1000 }],
          );
          return merged[0].source === 'local' || ('the source is ' + merged[0].source);
        });

        await add('hits are ordered oldest first, so stepping forward walks down the thread', () => {
          // The two timestamps are far apart on purpose: the local hit is in
          // epoch millis and Beeper's is a date string, and the order has to
          // come out right whichever shape each side used.
          const merged = TS.mergeHits(
            [{ chatID: 'c1', id: 'new', text: 'x', ts: 1800000000000 }],
            [{ chatID: 'c1', id: 'old', text: 'y', timestamp: '2024-01-01T00:00:00Z' }],
          );
          return merged[0].id === 'old' || ('the first is ' + merged[0].id);
        });

        await add('CONTROL: a hit with no id is dropped rather than drawn', () => {
          const merged = TS.mergeHits([{ chatID: 'c1', text: 'x', ts: 1000 }], []);
          return merged.length === 0 || ('got ' + merged.length);
        });

        // --- the step order -----------------------------------------------

        await add('stepping forward from nothing lands on the first hit', () =>
          TS.nextIndex(-1, 5, 1) === 0 || ('got ' + TS.nextIndex(-1, 5, 1)));

        await add('stepping forward advances', () =>
          TS.nextIndex(0, 5, 1) === 1 || ('got ' + TS.nextIndex(0, 5, 1)));

        await add('stepping back from nothing lands on the last hit', () =>
          TS.nextIndex(-1, 5, -1) === 4 || ('got ' + TS.nextIndex(-1, 5, -1)));

        await add('stepping past the end wraps to the first', () =>
          TS.nextIndex(4, 5, 1) === 0 || ('got ' + TS.nextIndex(4, 5, 1)));

        await add('stepping back past the start wraps to the last', () =>
          TS.nextIndex(0, 5, -1) === 4 || ('got ' + TS.nextIndex(0, 5, -1)));

        await add('CONTROL: with no hits there is nowhere to step to', () =>
          TS.nextIndex(-1, 0, 1) === -1 || ('got ' + TS.nextIndex(-1, 0, 1)));

        // --- the highlighter, against real markup --------------------------

        await add('a match in the thread is marked', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
          const count = TS.highlightIn(root, 'batt');
          return (count === 1 && root.querySelectorAll('mark.ts-hit').length === 1)
            || ('marked ' + count);
        });

        await add('the mark holds the matched text', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
          TS.highlightIn(root, 'batt');
          return root.querySelector('mark.ts-hit').textContent === 'batt'
            || ('the mark reads ' + root.querySelector('mark.ts-hit').textContent);
        });

        await add('a match inside markup is still found', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">a <strong>batt</strong>ery here</div></div>';
          const count = TS.highlightIn(root, 'batt');
          return count === 1 || ('marked ' + count);
        });

        await add('CONTROL: words that are not there are not marked', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">plain words</div></div>';
          const count = TS.highlightIn(root, 'strong');
          return count === 0 || ('marked ' + count);
        });

        await add('every match is marked, not only the first', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">batt and batt and batt</div></div>';
          const count = TS.highlightIn(root, 'batt');
          return count === 3 || ('marked ' + count);
        });

        await add('the text around a match is left exactly as it was', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
          TS.highlightIn(root, 'batt');
          return root.textContent === 'the battery is flat'
            || ('the text reads ' + root.textContent);
        });

        await add('clearing removes every mark and keeps the text', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
          TS.highlightIn(root, 'batt');
          const cleared = TS.clearHighlights(root);
          return (cleared === 1
            && root.querySelectorAll('mark.ts-hit').length === 0
            && root.textContent.includes('the battery is flat'))
            || ('cleared ' + cleared);
        });

        await add('CONTROL: a mark that was not ours is left alone', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">a <mark>real</mark> mark</div></div>';
          TS.clearHighlights(root);
          return root.querySelectorAll('mark').length === 1 || 'it removed a mark it did not make';
        });

        // --- the interface, driven through the wiring the app installs -----

        const envelope = (data) => ({ ok: true, data });
        const bubble = (id, ts, text, sender, chatID) => ({
          id, chatID: chatID || 'c-note', accountID: 'a1', senderID: sender,
          senderName: sender === 'a1' ? 'Me' : 'Them', text,
          timestamp: ts, isSender: sender === 'a1', type: 'TEXT',
        });

        const searchCalls = [];
        const refreshCalls = [];
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
            get: async (chatID, messageID) => envelope({
              id: messageID, chatID, accountID: 'a2', senderID: 'a2', senderName: 'Them',
              text: 'a message only Beeper had', timestamp: 1500,
              isSender: false, type: 'TEXT',
            }),
          },
          history: {
            open: async (chatID) => envelope({
              messages: chatID === 'c-other'
                ? [bubble('o1', 1000, 'a different conversation', 'a2', 'c-other')]
                : [
                    bubble('m1', 1000, 'the battery is flat', 'a2'),
                    bubble('m2', 2000, 'nothing to see here', 'a2'),
                    bubble('m3', 3000, 'batt batt batt', 'a1'),
                  ],
              complete: true,
              hasMore: false,
            }),
            page: async () => envelope({
              messages: [bubble('m0', 500, 'the oldest battery', 'a2')],
              hasMore: false,
              complete: true,
            }),
            upsert: async () => envelope({ written: 1 }),
            search: async () => envelope([]),
            searchInChat: async (chatID, query) => {
              searchCalls.push({ chatID, query });
              return envelope([
                { chatID: 'c-note', id: 'm1', text: 'the battery is flat', ts: 1000 },
                { chatID: 'c-note', id: 'm3', text: 'batt batt batt', ts: 3000 },
              ]);
            },
            status: async () => envelope({ messages: 0, chats: 0, bytes: 0 }),
            refresh: async (chatID) => {
              refreshCalls.push(chatID);
              return envelope({ queued: true });
            },
            jobs: async () => envelope({ jobs: [] }),
          },
        };

        const S = await import(${JSON.stringify(js('state.js'))});
        const T = await import(${JSON.stringify(js('thread.js'))});
        T.initThread();
        S.state.chats.set('c-note', {
          id: 'c-note', title: 'A conversation', type: 'single',
          participants: { items: [{ isSelf: true }, { isSelf: false }] },
        });
        await T.openChat('c-note');
        await settle(150);

        await add('the header has a search button', () =>
          Boolean(document.getElementById('btn-thread-search')) || 'there is no button');

        await add('the search row is hidden until the button is used', () =>
          document.getElementById('thread-search-row').hidden === true || 'the row was already open');

        await add('the button opens the row', () => {
          document.getElementById('btn-thread-search').click();
          return document.getElementById('thread-search-row').hidden === false || 'the row stayed shut';
        });

        await add('typing in the row searches the open chat', async () => {
          const field = document.getElementById('thread-search-input');
          field.value = 'batt';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await settle(400);
          return TS.threadSearchState().query === 'batt' || 'the query never arrived';
        });

        await add('and it asked the store about the chat that is open', () =>
          (searchCalls.length > 0 && searchCalls[0].chatID === 'c-note')
          || ('the store was asked ' + JSON.stringify(searchCalls)));

        await add('and the counter says how many there are', () =>
          /of\s*\d+/.test(document.getElementById('thread-search-count').textContent)
          || ('the counter reads ' + document.getElementById('thread-search-count').textContent));

        await add('and the matches are marked in the thread', () =>
          document.querySelectorAll('#message-list mark.ts-hit').length > 0 || 'nothing was marked');

        await add('the current match is marked apart from the others', () =>
          document.querySelectorAll('#message-list mark.ts-hit.is-current').length === 1
          || ('there are ' + document.querySelectorAll('#message-list mark.ts-hit.is-current').length));

        await add('Enter steps to the next match', async () => {
          const before = TS.threadSearchState().index;
          document.getElementById('thread-search-input')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await settle(150);
          const after = TS.threadSearchState().index;
          return (after !== before) || ('the index stayed at ' + after);
        });

        await add('Shift+Enter steps back', async () => {
          const before = TS.threadSearchState().index;
          document.getElementById('thread-search-input')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
          await settle(150);
          const after = TS.threadSearchState().index;
          return (after !== before) || ('the index stayed at ' + after);
        });

        await add('clearing the query removes every mark', async () => {
          const field = document.getElementById('thread-search-input');
          field.value = '';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await settle(400);
          return document.querySelectorAll('#message-list mark.ts-hit').length === 0
            || 'a mark was left behind';
        });

        await add('Escape closes the row', async () => {
          document.getElementById('btn-thread-search').click();
          const field = document.getElementById('thread-search-input');
          field.value = 'batt';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await settle(400);
          field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await settle(150);
          return document.getElementById('thread-search-row').hidden === true || 'the row stayed open';
        });

        await add('CONTROL: the sidebar search is not this search', () =>
          document.getElementById('search-input') !== document.getElementById('thread-search-input')
          || 'the two searches share an input');

        // --- reaching the rest of the conversation -------------------------

        await add('a hit only Beeper knows about is fetched and drawn', async () => {
          const fetched = await TS.fetchRemoteHit({
            chatID: 'c-note', id: 'remote-1', ts: 1500, source: 'remote',
          });
          if (fetched !== true) return 'the hit was not fetched';
          await settle(200);
          const list = document.getElementById('message-list');
          return list.querySelector('[data-message-id="remote-1"]') !== null
            || 'the message was not drawn';
        });

        await add('CONTROL: a hit the store already holds is not fetched again', async () => {
          const fetched = await TS.fetchRemoteHit({
            chatID: 'c-note', id: 'm1', ts: 1000, source: 'local',
          });
          return fetched === false || 'a known hit was fetched anyway';
        });

        await add('a refresh of the chat is queued', async () => {
          refreshCalls.length = 0;
          await TS.queueHistoryRefresh('c-note');
          await settle(150);
          return refreshCalls.includes('c-note')
            || ('the refresh was not queued for ' + JSON.stringify(refreshCalls));
        });

        await add('a hit older than the window is paged into view', async () => {
          const reached = await T.loadHistoryUntil(500);
          await settle(200);
          const list = document.getElementById('message-list');
          return (reached === true && list.querySelector('[data-message-id="m0"]') !== null)
            || ('reached ' + reached + ', drawn '
              + Boolean(list.querySelector('[data-message-id="m0"]')));
        });

        await add('CONTROL: paging to a hit that is already on screen does nothing', async () => {
          const reached = await T.loadHistoryUntil(9000);
          return reached === true || ('reached ' + reached);
        });

        await add('a message arriving during a search does not wipe the marks', async () => {
          document.getElementById('btn-thread-search').click();
          const field = document.getElementById('thread-search-input');
          field.value = 'batt';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await settle(400);
          const before = document.querySelectorAll('#message-list mark.ts-hit').length;

          // A new message makes the thread rebuild itself, which is exactly
          // when the marks would be lost if they were not put back.
          S.upsertMessages('c-note', [bubble('m4', 4000, 'a new message', 'a2')]);
          await settle(250);

          const after = document.querySelectorAll('#message-list mark.ts-hit').length;
          return (before > 0 && after === before)
            || ('before ' + before + ', after ' + after);
        });

        await add('re-opening the same conversation keeps the marks', async () => {
          document.getElementById('btn-thread-search').click();
          const field = document.getElementById('thread-search-input');
          field.value = 'batt';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await settle(400);
          const before = document.querySelectorAll('#message-list mark.ts-hit').length;

          // The same conversation, so the search stays open while the thread
          // is rebuilt from scratch underneath it.
          await T.openChat('c-note');
          await settle(250);

          const after = document.querySelectorAll('#message-list mark.ts-hit').length;
          return (before > 0 && after === before)
            || ('before ' + before + ', after ' + after);
        });

        // --- the marks belong to one conversation --------------------------

        await add('CONTROL: opening another conversation clears the marks', async () => {
          document.getElementById('btn-thread-search').click();
          const field = document.getElementById('thread-search-input');
          field.value = 'batt';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await settle(400);
          const marked = document.querySelectorAll('#message-list mark.ts-hit').length;

          S.state.chats.set('c-other', {
            id: 'c-other', title: 'Another conversation', type: 'single',
            participants: { items: [{ isSelf: true }, { isSelf: false }] },
          });
          await T.openChat('c-other');
          await settle(200);

          return (marked > 0
            && document.querySelectorAll('#message-list mark.ts-hit').length === 0
            && document.getElementById('thread-search-row').hidden === true)
            || ('marked ' + marked
              + ', left ' + document.querySelectorAll('#message-list mark.ts-hit').length
              + ', row hidden ' + document.getElementById('thread-search-row').hidden);
        });
      }
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:threadsearch' });
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

  // The wiring across the processes is checked against the source: a hit
  // that only Beeper knows about has to be fetched by id, and a break in any
  // of the three lists leaves the fetch doing nothing at all, with nothing
  // on screen to say so.
  //
  // The channel name is a string on both sides of the bridge, and a typo on
  // one side only leaves both source checks green while the feature does
  // nothing. So the two names are read out of the source and compared.
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'api.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'main.js'), 'utf8');

  const preloadChannel = (preloadSrc.match(/get: \(chatID, messageID\) => invoke\('([^']+)'/) || [])[1];
  const ipcChannel = (ipcSrc.match(/ipcMain\.handle\('([^']+)', handle\(async \(chatID, messageID\)/) || [])[1];

  const sourceCases = [
    ['the preload can ask for one message',
      /get: \(chatID, messageID\) => invoke\('messages:get'/.test(preloadSrc)],
    ['the main process has a handler for it',
      /ipcMain\.handle\('messages:get'/.test(ipcSrc)],
    ['and the two sides are talking about the same channel',
      Boolean(preloadChannel) && preloadChannel === ipcChannel,
      `the preload listens on "${preloadChannel}", the main process handles "${ipcChannel}"`],
    ['the renderer can ask for one message',
      /get: \(chatID, messageID\) => window\.beeper\.messages\.get\(/.test(apiSrc)],
    // The global Escape handler runs in the capture phase, so it sees the key
    // before the search row's own handler does. Without this guard one Escape
    // would close the row and the conversation behind it, and nothing in the
    // harness could catch it, because the harness does not load main.js.
    ['the global Escape handler leaves the conversation search alone',
      /if \(event\.target\?\.id === 'thread-search-input'\) return;/.test(mainSrc)],
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
