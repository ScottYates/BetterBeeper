/**
 * Dev check: the sidebar reuses its rows, and the background jobs are visible.
 *
 * Found live: every avatar in the inbox blinked out and back whenever anything
 * re-rendered the list. The cause was renderChats doing clear(list) and
 * rebuilding, which destroys each avatar <img>; avatarNode then repaints from
 * initials only once its assets:resolve round trip lands, so every picture in
 * the list went initials -> image again on every chat event and on the inbox
 * timer. It also cost one IPC call per chat with a picture, per render.
 *
 * Reusing the rows is only correct if a row is rebuilt whenever anything it
 * draws changes - including the pins, archives and deletions that live outside
 * the chat object. Those are asserted here, because a row kept too long is a
 * silent lie: a deleted message would sit in a preview line for ever.
 *
 * The second half is the progress panel. It reads from two sources - live
 * events and one fetch at startup - because a reload misses every event that
 * came before it, and an empty panel beside work that carries on regardless is
 * worse than no panel.
 *
 * The harness page is generated from the real index.html with its scripts
 * stripped, so the DOM here cannot drift from the DOM the app ships.
 *
 * Run with `npm run check:sidebar`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const HARNESS = path.join(__dirname, '.sidebar-check-harness.html');

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
  app.setPath('userData', path.join(os.tmpdir(), 'bb-sidebar-check-profile'));
  buildHarness();

  // No backticks anywhere in here: this whole block is a String.raw template,
  // and one in a comment silently ends the string.
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
      const S = await import(${JSON.stringify(js('state.js'))});
      const B = await import(${JSON.stringify(js('sidebar.js'))});
      const J = await import(${JSON.stringify(js('jobs.js'))});

      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      const envelope = (data) => ({ ok: true, data });

      // Every avatar resolution is counted. A render that re-resolves avatars it
      // already has is the main-thread cost of the flashing, so it is measured
      // rather than assumed.
      let resolves = 0;
      const chat = (id, over) => ({
        id, title: 'Chat ' + id, network: 'Signal', type: 'single',
        imgURL: 'https://example.invalid/' + id + '.png',
        preview: { id: 'p-' + id, text: 'hello ' + id },
        lastActivity: '2026-01-0' + (id.slice(-1) || 1) + 'T00:00:00.000Z',
        participants: { items: [{ isSelf: true }, { isSelf: false }] },
        ...(over || {}),
      });

      window.beeper = {
        assets: {
          resolve: async () => { resolves++; return envelope({ url: 'beeper-file://local/x.png' }); },
        },
        images: {},
        shell: { openExternal: async () => envelope(true) },
        chats: { get: async () => envelope({}), markRead: async () => envelope(true) },
        messages: { list: async () => envelope({ items: [] }) },
        settings: { get: async () => envelope({}), set: async () => envelope({}) },
        events: { subscribe: async () => envelope({ subscribed: 0 }) },
        history: {
          open: async () => envelope({ messages: [], hasMore: false, complete: true }),
          page: async () => envelope({ messages: [], hasMore: false }),
          upsert: async () => envelope({ written: 1 }),
          search: async () => envelope([]),
          status: async () => envelope({ messages: 10, chats: 3, bytes: 1, mediaBytes: 2, mediaCount: 1, running: null, queued: 0 }),
          jobs: async () => envelope({ jobs: [], queued: 0, messages: 10, chats: 3 }),
          refresh: async () => { refreshCalls.push(true); return envelope({ queued: true }); },
        },
      };

      const refreshCalls = [];
      // Every subscriber gets every event. A stub that kept only the last one
      // made initThread() silently replace the jobs panel's listener, which is
      // exactly the kind of wiring bug the harness exists to catch - and it
      // caught this one instead.
      const progressListeners = [];
      window.beeper.on = {
        historyProgress: (fn) => { progressListeners.push(fn); },
      };
      // Jobs are given an updatedAt well in the past by default, because the
      // panel will not list a job younger than MIN_VISIBLE_MS, and every check
      // here is about work that has been going a while. The checks about that
      // delay pass fresh: true to say otherwise.
      const progress = (payload) => {
        for (const fn of progressListeners) {
          if (payload.fresh) {
            const { fresh, ...rest } = payload;
            fn(rest);
          } else {
            fn({ updatedAt: Date.now() - 5000, ...payload });
          }
        }
      };

      B.initSidebar({ onSelectChat: () => {}, onSelectView: () => {} });

      for (const id of ['a1', 'a2', 'a3']) S.upsertChat(chat(id));
      B.renderChats();
      // Long enough for every avatar round trip to land. Measuring before they
      // do would make the reuse assertions pass for the wrong reason.
      await new Promise((r) => setTimeout(r, 400));

      const list = document.getElementById('chat-list');
      const first = Array.from(list.children);

      add('the inbox drew a row per chat', () =>
        first.length === 3 || ('drew ' + first.length));

      add('an avatar image is drawn, not only initials', () =>
        list.querySelectorAll('.avatar img').length >= 3
        || ('images: ' + list.querySelectorAll('.avatar img').length));

      // --- the flashing fix --------------------------------------------------
      const afterFirst = resolves;

      B.renderChats();
      const second = Array.from(list.children);

      add('a second render keeps the very same row elements', () =>
        second.length === first.length && second.every((node, i) => node === first[i])
        || ('row identity changed on an unaltered render'));

      add('the avatar images are not destroyed and remade', () =>
        Array.from(list.querySelectorAll('.avatar img')).every((img, i) => img === first[i].querySelector('.avatar img'))
        || 'the img elements were replaced');

      add('an unaltered render does not re-resolve any avatar', () =>
        resolves === afterFirst
        || (resolves - afterFirst) + ' extra assets:resolve calls for an unaltered render');

      // --- a changed chat rebuilds only its own row --------------------------
      S.upsertChat(chat('a2', { title: 'Renamed' }));
      B.renderChats();
      const third = Array.from(list.children);
      const byChat = (nodes, id) => nodes.find((n) => n.dataset.chatId === id);

      add('a changed chat rebuilds its own row', () =>
        byChat(third, 'a2') !== byChat(second, 'a2') || 'the renamed row was reused');

      add('an unchanged chat keeps its row', () =>
        (byChat(third, 'a1') === byChat(second, 'a1') && byChat(third, 'a3') === byChat(second, 'a3'))
        || 'every row was rebuilt when one changed');

      add('the rename is actually drawn', () =>
        (byChat(third, 'a2').textContent || '').includes('Renamed')
        || ('row reads ' + JSON.stringify(byChat(third, 'a2').textContent.slice(0, 40))));

      // --- local state forces a rebuild --------------------------------------
      // A deleted preview only blanks when the history is loaded well enough to
      // know what else is there. With no messages at all the preview is left
      // alone on purpose, so the test loads one first - otherwise it would be
      // asserting that a deliberate fallback is a bug.
      const before = byChat(Array.from(list.children), 'a1');
      S.upsertMessage('a1', { id: 'fresh', chatID: 'a1', text: 'the real newest message', timestamp: Date.parse('2026-02-01T00:00:00Z') });
      S.setMessageDeleted('p-a1', true);
      S.upsertChat(chat('a1'));
      B.renderChats();
      const afterDelete = Array.from(list.children);
      const a1 = byChat(afterDelete, 'a1');

      add('a locally deleted preview rebuilds its row', () =>
        a1 !== before || 'the row survived a change to what it draws');

      add('a locally deleted preview stops showing its text', () =>
        !(a1.textContent || '').includes('hello a1')
        || ('still reads ' + JSON.stringify(a1.textContent.slice(0, 60))));

      S.setMessageDeleted('p-a1', false);
      // Un-deleting is itself a local-state change, which rebuilds every row by
      // design. Render once to settle before taking the baseline, or the re-sort
      // below looks like it destroyed rows that had just been rebuilt anyway.
      B.renderChats();

      // --- ordering moves rows rather than rebuilding them ------------------
      // The chat whose activity time moves is the one whose row must be rebuilt
      // - it draws that time. What must survive is every other row, which is
      // the difference between moving a list and replacing one.
      const beforeOrder = Array.from(list.children);
      S.state.chats.get('a3').lastActivity = '2027-01-01T00:00:00.000Z';
      B.renderChats();
      const afterOrder = Array.from(list.children);

      add('a re-sort keeps every row it does not have to rebuild', () =>
        (afterOrder.length === beforeOrder.length
          && ['a1', 'a2'].every((id) => byChat(afterOrder, id) === byChat(beforeOrder, id)))
        || 'reordering destroyed rows that had not changed');

      add('the moved row is actually first', () =>
        afterOrder[0].dataset.chatId === 'a3' || ('first is ' + afterOrder[0].dataset.chatId));

      // --- leaving the view removes the row ---------------------------------
      S.state.chats.delete('a3');
      B.renderChats();
      add('a chat that left the inbox loses its row', () =>
        !document.getElementById('chat-list').querySelector('[data-chat-id="a3"]')
        || 'a removed chat is still drawn');

      // --- the source-level guard -------------------------------------------
      add('the list is reconciled rather than cleared and rebuilt', () => {
        // One clear() is allowed: the empty-inbox path, which genuinely has to
        // put the placeholder in. What must not exist is a clear on the path
        // where there are rows - that is what destroys the avatars.
        const src = ${JSON.stringify(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'sidebar.js'), 'utf8'))};
        const start = src.indexOf('export function renderChats()');
        const body = src.slice(start, src.indexOf('\n}', start));
        const clears = (body.match(/clear\(list\)/g) || []).length;
        return clears <= 1 || 'renderChats clears the list ' + clears + ' times';
      });

      // --- background jobs panel -------------------------------------------
      J.initJobs();
      await new Promise((r) => setTimeout(r, 200));

      const panel = document.getElementById('jobs-panel');
      const summary = document.getElementById('jobs-summary');

      add('the jobs panel exists', () => !!panel || 'no #jobs-panel');

      add('an idle panel says what is stored', () =>
        /10 messages/.test(summary.textContent || '')
        || ('summary reads ' + JSON.stringify(summary.textContent)));

      progress({ chatID: 'a1', state: 'backfilling', pages: 12, fetched: 240 });
      await new Promise((r) => setTimeout(r, 120));

      add('a running job is listed by name', () =>
        (document.getElementById('jobs-list').textContent || '').includes('Chat a1')
        || 'no row for the running job');

      add('a running job shows how far it has got', () =>
        /12 pages/.test(document.getElementById('jobs-list').textContent || '')
        && /240 messages/.test(document.getElementById('jobs-list').textContent || '')
        || ('rows read ' + JSON.stringify(document.getElementById('jobs-list').textContent)));

      // Rendered on the next frame, so the row is not there yet: that delay is the
      // coalescing, and the checks below have to wait for it.
      progress({ chatID: 'a2', state: 'queued', pages: 0, fetched: 0 });
      await new Promise((r) => setTimeout(r, 150));

      add('a queued job says queued rather than claiming to be working', () => {
        const row = document.querySelector('.job-row[data-chat-id="a2"]');
        if (!row) return 'no row for the queued job';
        return row.dataset.state === 'queued' && /queued/i.test(row.querySelector('.job-detail').textContent)
          || ('row says ' + row.querySelector('.job-detail').textContent);
      });

      add('only the running job is shown as moving', () => {
        const queued = document.querySelector('.job-row[data-state="queued"]');
        const running = document.querySelector('.job-row[data-state="backfilling"]');
        if (!queued || !running) return 'needed both a queued and a running row';
        // A queue of a hundred chats should not look like a hundred simultaneous
        // downloads, so the queued row's bar is still.
        return getComputedStyle(queued.querySelector('.job-bar > i')).animationName === 'none'
          && getComputedStyle(running.querySelector('.job-bar > i')).animationName !== 'none'
          || 'the queued bar is moving, or the running one is not';
      });

      // Let the queued job finish. Left queued it would keep the panel busy for
      // every check after this one.
      progress({ chatID: 'a2', state: 'done', pages: 1, fetched: 20 });

      add('the panel says it is busy', () =>
        panel.dataset.state === 'busy' || ('state is ' + panel.dataset.state));

      add('the panel can be collapsed', () => {
        document.getElementById('jobs-toggle').click();
        return panel.classList.contains('is-collapsed') || 'the toggle did not collapse it';
      });

      // Both of the checks below wait for a real render. The panel repaints on
      // the next frame, so asserting straight after sending an event reads the
      // previous frame and passes whichever way the code goes.
      progress({ chatID: 'a1', state: 'backfilling', pages: 6, fetched: 120 });
      await new Promise((r) => setTimeout(r, 150));

      add('a collapse survives the progress events that follow it', () =>
        panel.classList.contains('is-collapsed')
        || 'a running sync reopened a panel the user had closed');

      // And it holds when the last job finishes, which is when the old code
      // decided to open it again.
      progress({ chatID: 'a1', state: 'done', pages: 6, fetched: 120 });
      await new Promise((r) => setTimeout(r, 150));

      add('a collapse still holds once the work is over', () =>
        panel.classList.contains('is-collapsed')
        || 'the panel opened itself again when the last job finished');

      document.getElementById('jobs-toggle').click();

      progress({ chatID: 'a1', state: 'done', pages: 12, fetched: 240 });
      await new Promise((r) => setTimeout(r, 120));

      add('a finished job is no longer reported as busy', () =>
        panel.dataset.state === 'idle' || ('state is ' + panel.dataset.state));

      add('a finished job is still shown, so the result is readable', () =>
        (document.getElementById('jobs-list').textContent || '').includes('Chat a1')
        || 'the finished job vanished');

      progress({ chatID: 'a1', state: 'failed', error: 'Beeper said no' });
      await new Promise((r) => setTimeout(r, 120));

      add('a failed job says why', () =>
        (document.getElementById('jobs-list').textContent || '').includes('Beeper said no')
        || ('rows read ' + JSON.stringify(document.getElementById('jobs-list').textContent)));

      // --- the panel must not rebuild itself either -------------------------
      // The panel flickered badly at four events a second, for the same reason
      // the inbox did: every event cleared the list and made the rows again.
      // New elements also restart the bar's CSS animation from zero, so a
      // rebuild made every bar lurch even when nothing had changed.
      progress({ chatID: 'a1', state: 'backfilling', pages: 30, fetched: 600 });
      await new Promise((r) => setTimeout(r, 150));
      const liveRow = document.querySelector('.job-row[data-chat-id="a1"]');
      const liveBar = liveRow.querySelector('.job-bar > i');
      const liveName = liveRow.querySelector('.job-name');

      progress({ chatID: 'a1', state: 'backfilling', pages: 31, fetched: 620 });
      await new Promise((r) => setTimeout(r, 150));
      const afterRow = document.querySelector('.job-row[data-chat-id="a1"]');

      add('a progress update keeps the same job row', () =>
        afterRow === liveRow || 'the job row was replaced on every progress event');

      add('a progress update keeps the same progress bar element', () =>
        (afterRow && afterRow.querySelector('.job-bar > i')) === liveBar
        || 'the bar element was replaced, restarting its animation');

      add('a progress update keeps the same name element', () =>
        (afterRow && afterRow.querySelector('.job-name')) === liveName
        || 'the name element was replaced');

      add('the progress numbers still update in place', () =>
        /31 pages/.test(afterRow.textContent || '') && /620 messages/.test(afterRow.textContent || '')
        || ('row reads ' + JSON.stringify((afterRow.textContent || '').slice(0, 60))));

      // Counted, not grepped. A source-level check for the call was useless here: the
      // regex matched the definition of scheduleRender further down the file, so
      // removing the call from ingest did not fail it.
      var realRaf = window.requestAnimationFrame.bind(window);
      var rafCalls = 0;
      window.requestAnimationFrame = function (cb) { rafCalls++; return realRaf(cb); };
      for (var tick = 1; tick <= 5; tick++) {
        progress({ chatID: 'a3', state: 'backfilling', pages: tick, fetched: tick * 20 });
      }
      var scheduled = rafCalls;
      window.requestAnimationFrame = realRaf;
      await new Promise(function (r) { setTimeout(r, 150); });

      add('many events in one frame are painted once', () =>
        scheduled === 1 || ('five events scheduled ' + scheduled + ' paints'));

      progress({ chatID: 'a3', state: 'done', pages: 5, fetched: 100 });

      // --- the refresh button ------------------------------------------------
      add('every chat has a refresh button', () =>
        !!document.getElementById('btn-refresh') || 'no #btn-refresh in the header');

      // The button is wired in initThread and reads the chat the thread is
      // showing, so the thread has to be open for a click to mean anything.
      const T = await import(${JSON.stringify(js('thread.js'))});
      window.beeper.chats.get = async () => envelope(chat('a1'));
      window.beeper.history.open = async () => envelope({
        messages: [{ id: 'm1', chatID: 'a1', timestamp: 1000, text: 'hi', senderID: 's', senderName: 'Someone' }],
        hasMore: false,
        complete: true,
      });
      T.initThread();
      await T.openChat('a1');
      await new Promise((r) => setTimeout(r, 300));

      add('opening a chat shows its own refresh button', () =>
        !!document.querySelector('.thread-header #btn-refresh')
        || 'the header has no refresh button');

      refreshCalls.length = 0;
      document.getElementById('btn-refresh').click();
      // The handler queues the work and returns, so the call lands on the next
      // turn rather than during the click.
      await new Promise((r) => setTimeout(r, 80));

      add('the refresh button asks the main process for a re-sync', () =>
        refreshCalls.length === 1 || ('made ' + refreshCalls.length + ' refresh calls'));

      add('the refresh button does not wait for the sync to finish', () => {
        // The button must be usable again immediately; the work is the main
        // process's and the panel is how it is watched.
        const el = document.getElementById('btn-refresh');
        return !el.disabled && el.getAttribute('aria-busy') !== 'true'
          || 'the button is left blocked on the job';
      });

      // --- the button tracks the job, in both directions --------------------
      // Opening a chat starts a sync of its own, so a refresh pressed while
      // that is running is served afterwards. When the first job finishes, the
      // button must not simply go idle - it has to come back for the second.
      progress({ chatID: 'a1', state: 'started', pages: 0, fetched: 0 });
      await new Promise((r) => setTimeout(r, 120));
      const btn = document.getElementById('btn-refresh');

      add('a job starting marks the refresh button busy', () =>
        btn.classList.contains('is-busy') || ('class is ' + btn.className));

      add('the tooltip says what is happening while it is busy', () =>
        /background/i.test(btn.dataset.tip || '') || ('tip is ' + btn.dataset.tip));

      progress({ chatID: 'a1', state: 'done', pages: 1, fetched: 20 });
      await new Promise((r) => setTimeout(r, 120));

      add('a job finishing clears the busy state', () =>
        !btn.classList.contains('is-busy') || ('class is ' + btn.className));

      add('the busy state is the button alone, not the whole header', () => {
        // renderHeader replaces the thread avatar, and a job event arrives
        // several times a second. If reacting to one redrew the header, the
        // avatar would repaint from initials every time.
        const before = document.getElementById('thread-avatar');
        progress({ chatID: 'a1', state: 'backfilling', pages: 2, fetched: 40 });
        const after = document.getElementById('thread-avatar');
        return before === after || 'the header avatar was rebuilt by a job event';
      });
      progress({ chatID: 'a1', state: 'done', pages: 2, fetched: 40 });

      // --- work too quick to report ------------------------------------------
      //
      // Opening a chat queues a sync of it, and for a chat that is already up
      // to date that is one page, over in about fifty milliseconds. Listed
      // anyway, it put an animated bar in the sidebar for a frame and took a row
      // away again, so moving between chats made the panel twitch - measured as
      // six rows in and six rows out over six switches, eleven bars rebuilt.
      const rowsOf = () => document.querySelectorAll('#jobs-list .job-row').length;
      const rowsBefore = rowsOf();

      progress({ chatID: 'quick1', state: 'queued', pages: 0, fetched: 0, fresh: true });
      progress({ chatID: 'quick1', state: 'started', pages: 0, fetched: 0, fresh: true });
      progress({ chatID: 'quick1', state: 'done', pages: 1, fetched: 20, fresh: true });
      await new Promise((r) => setTimeout(r, 150));

      // Asked about this job specifically, not by counting rows. The panel lists
      // at most two finished jobs, so one appearing can evict another and leave
      // the count identical - which would let this pass with the row right there.
      add('a sync that finishes at once never reaches the panel', () =>
        document.querySelector('.job-row[data-chat-id="quick1"]') === null
        || 'a one-page sync was given a row in the sidebar');

      // A one-page job that is still running has to wait out the delay.
      progress({ chatID: 'slow1', state: 'backfilling', pages: 1, fetched: 20, fresh: true });
      await new Promise((r) => setTimeout(r, 150));
      const tooEarly = document.querySelector('.job-row[data-chat-id="slow1"]') !== null;

      add('a one-page sync younger than the delay is not listed yet', () =>
        !tooEarly || 'a single-page sync was given a row before the delay passed');

      // A real walk declares itself, and is listed the moment it does.
      progress({ chatID: 'walk1', state: 'backfilling', pages: 4, fetched: 80, walked: true, fresh: true });
      await new Promise((r) => setTimeout(r, 150));

      add('a walk through history is listed at once', () =>
        document.querySelector('.job-row[data-chat-id="walk1"]') !== null
        || 'a walk waited for the delay before showing a row');

      // A failure is the one thing worth interrupting for, however new.
      progress({ chatID: 'bad1', state: 'failed', error: 'Beeper said no', fresh: true });
      await new Promise((r) => setTimeout(r, 150));

      add('a failure is listed even when it has only just happened', () =>
        document.querySelector('.job-row[data-chat-id="bad1"]') !== null
        || 'a failure was hidden by the delay');

      await new Promise((r) => setTimeout(r, 750));

      // Asked for by chat id rather than by counting rows, because a running job
      // replaces a finished one in the list: the count can stay the same while
      // the row is a different one entirely. Nothing has reported for slow1
      // since it was created above, so finding it now also shows the delayed
      // appearance was the reveal timer and not another progress event.
      add('a one-page sync still running is listed once the delay passes, unprompted', () =>
        document.querySelector('.job-row[data-chat-id="slow1"]') !== null
        || 'the delayed row never appeared');

      progress({ chatID: 'slow1', state: 'done', pages: 1, fetched: 20, fresh: true });
      progress({ chatID: 'walk1', state: 'done', pages: 4, fetched: 80, fresh: true });
      await new Promise((r) => setTimeout(r, 150));

      // --- an avatar rebuilt after the first paint ---------------------------
      //
      // The thread header is rebuilt on every open, and the chat list is rebuilt
      // on local state changes. Each rebuild used to start from initials and swap
      // in the picture a frame later, replaying that first frame in front of the
      // user every time. A cached resolution is constructed with the image
      // already in it.
      const avatarSrc = 'https://beeper.example/avatar/cached-test.png';
      const chatWithAvatar = { id: 'av1', title: 'Avatar Chat', imgURL: avatarSrc };

      const firstAvatar = B.avatarNode(chatWithAvatar, 'Avatar Chat');
      await new Promise((r) => setTimeout(r, 120));
      add('an avatar resolves to a picture when first shown', () =>
        firstAvatar.querySelector('img') !== null || 'the first avatar never became an image');

      const rebuilt = B.avatarNode(chatWithAvatar, 'Avatar Chat');
      add('a rebuilt avatar already holds its picture', () =>
        rebuilt.querySelector('img') !== null
        || 'the rebuilt avatar starts from initials, so the repaint is a flash');

      add('a rebuilt avatar is not left holding the initials too', () =>
        rebuilt.textContent.trim() === '' || 'initials are still in the rebuilt avatar');
      }
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:sidebar' });
  const win = new BrowserWindow({ show: false, width: 845, height: 656 });
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
