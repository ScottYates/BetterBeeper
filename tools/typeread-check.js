/**
 * Dev check: typing in a chat counts as having read it.
 *
 * The ask: "If there is a new message in a chat, mark it as read also after i
 * type anything in it's chat window."
 *
 * What was missing: the app had three ways to mark a chat read - opening it,
 * the window coming back to the front, and a message arriving while the
 * window had focus. Typing was not one of them, and it is the one signal that
 * cannot be faked: the chat is open, the conversation is on the screen, and
 * the user is answering in it.
 *
 * It is also the only thing that clears a badge that should not be there. A
 * message that arrives while the window has focus is marked read, and then
 * the sidebar is refreshed from the server - and the server's answer can
 * still carry the old count, because the mark had not reached it when the
 * refresh was issued. The badge comes back on a chat that is open and on
 * screen, and nothing else asks again.
 *
 * The rule is pure (type-read.js) and driven directly. The behaviour is driven
 * over real state with only the IPC boundary replaced, because the failure
 * this replaces was a call site that was never made - a correct rule that
 * nothing invokes is the same as no rule.
 *
 * Run with `npm run check:typeread`.
 */
const path = require('path');
const fs = require('node:fs');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const url = (...p) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', ...p)).href;
const typeReadURL = url('type-read.js');
const threadURL = url('thread.js');
const stateURL = url('state.js');
const threadPath = path.join(ROOT, 'src', 'renderer', 'js', 'thread.js');

// thread.js pulls in DOM helpers, so exercise it in a real browser via Electron.
async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-typeread-check-profile'));

  const harness = `
  (async () => {
      // The harness page has no preload, so window.beeper does not exist. This
      // is the boundary: everything above it is the app's own code.
      const marks = [];
      // How long the mark-read call takes. The burst case needs a call that is
      // still on its way when the next letter arrives, because that is the
      // situation the in-flight guard exists for.
      let markDelay = 0;
      window.beeper = new Proxy({}, {
        get: (_t, ns) => new Proxy({}, {
          get: (_t2, fn) => (...args) => {
            if (ns === 'chats' && fn === 'markRead') {
              // A null messageID means the whole chat was marked.
              marks.push({ chatID: args[0], messageID: args[1] === undefined ? null : args[1] });
              const done = { ok: true, data: {} };
              if (!markDelay) return Promise.resolve(done);
              return new Promise((r) => setTimeout(() => r(done), markDelay));
            }
            if (ns === 'chats' && fn === 'get') return Promise.resolve({ ok: true, data: CHAT });
            if (ns === 'chats' && fn === 'list') return Promise.resolve({ ok: true, data: { items: [CHAT] } });
            if (ns === 'messages' && fn === 'list') return Promise.resolve({ ok: true, data: { items: [] } });
            return Promise.resolve({ ok: true, data: {} });
          },
        }),
      });

      const TR = await import(${JSON.stringify(typeReadURL)});
      const T = await import(${JSON.stringify(threadURL)});
      const St = await import(${JSON.stringify(stateURL)});

      const cases = [];
      // Strict on purpose. A case that fails has to say so: an assertion that
      // returns a detail string as its value would otherwise be truthy, and
      // the whole case would pass while proving nothing.
      const add = (name, ok, detail) =>
        cases.push([name, ok === true, ok === true ? '' : String(detail || ok)]);
      const check = (name, fn) => {
        try {
          const r = fn();
          add(name, r === true, r === true ? '' : String(r));
        } catch (e) { add(name, false, e.message); }
      };

      const ALL = { hasOpenChat: true, chatUnread: true, markReadEnabled: true };

      // ---- the rule -------------------------------------------------------

      check('typing in a chat with a message waiting marks it read', () =>
        TR.shouldMarkOnTyping(ALL) === true || 'the rule said no');

      check('nothing to read, nothing is marked', () =>
        TR.shouldMarkOnTyping(Object.assign({}, ALL, { chatUnread: false })) === false
          || 'an already-read chat was marked again');

      check('no open chat means nothing to have read', () =>
        TR.shouldMarkOnTyping(Object.assign({}, ALL, { hasOpenChat: false })) === false
          || 'it marked an empty screen as read');

      check('turning off mark-on-open also turns off mark-on-typing', () =>
        TR.shouldMarkOnTyping(Object.assign({}, ALL, { markReadEnabled: false })) === false
          || 'the setting was ignored on the typing path');

      check('a missing answer is a no, not a crash', () =>
        TR.shouldMarkOnTyping() === false || 'shouldMarkOnTyping() with nothing did not say no');

      check('every condition is load-bearing', () => {
        // Flip each one and the rule must stop saying yes. This is what catches
        // a condition written into the signature but never actually consulted.
        const keys = ['hasOpenChat', 'chatUnread', 'markReadEnabled'];
        const inert = keys.filter((k) => TR.shouldMarkOnTyping(Object.assign({}, ALL, { [k]: !ALL[k] })) === true);
        return inert.length === 0 || 'these had no effect: ' + inert.join(', ');
      });

      // ---- the real behaviour, over real state ---------------------------

      const CHAT = { id: '!type-check', title: 'Typing chat', unreadCount: 1, lastActivity: '2026-03-04T00:00:00Z' };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      // The real shape of a message in this app: no isUnread flag, because no
      // message Beeper sends carries one.
      const msg = (id) => ({
        id: id, chatID: CHAT.id, text: 'hello', senderName: 'Someone',
        isSender: false,
        timestamp: new Date().toISOString(), sortKey: id, attachments: [],
      });

      // Focus emulation. A hidden harness window reports hasFocus() false, so
      // without this the cases that need a focused window could not be driven.
      const asWindow = async (focused, visible, run) => {
        const realHasFocus = document.hasFocus.bind(document);
        document.hasFocus = () => focused;
        const real = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
        Object.defineProperty(Document.prototype, 'visibilityState', {
          get: () => (visible ? 'visible' : 'hidden'), configurable: true,
        });
        try { return await run(); } finally {
          document.hasFocus = realHasFocus;
          if (real) Object.defineProperty(Document.prototype, 'visibilityState', real);
        }
      };

      // Open the chat with the window focused and visible, and clear the marks
      // that opening it made. What is left is a chat that is open, read, and
      // waiting for something to happen in it.
      const seedOpen = async (settings) => {
        marks.length = 0;
        markDelay = 0;
        St.state.chats.set(CHAT.id, Object.assign({}, CHAT));
        St.state.messages.set(CHAT.id, [msg('~type:old')]);
        St.state.settings = Object.assign({}, St.state.settings, { markReadOnOpen: true }, settings || {});
        T.closeThread();
        await asWindow(true, true, async () => { await T.openChat(CHAT.id); await wait(150); });
        marks.length = 0;
      };

      /**
       * The chat has unread messages again.
       *
       * The unread count is what the mark path gates on, so a case that needs
       * an unread chat sets it. The count is zero after the open above, which
       * is the point: opening the chat is what clears it.
       */
      const becomesUnread = (count = 1) => {
        St.state.chats.set(CHAT.id, Object.assign({}, St.state.chats.get(CHAT.id), { unreadCount: count }));
      };

      // Wire the real event path. Without this the composer has no listener,
      // nothing ever re-renders, and every check about what happens when you
      // type passes for the wrong reason: there was no typing at all.
      T.initThread();
      await wait(120);

      /** Type into the composer, the way a person does: value, then an input event. */
      const type = async (text) => {
        const composer = document.querySelector('#composer');
        composer.value = text;
        composer.dispatchEvent(new Event('input'));
        await wait(150);
      };

      // ---- the thing that was asked for -----------------------------------

      await seedOpen();
      becomesUnread();
      {
        marks.length = 0;
        await type('hello');
        add('typing in a chat with a message waiting marks it read',
          (marks.length === 1 && marks[0].chatID === CHAT.id && marks[0].messageID === null)
            ? true : JSON.stringify(marks));
      }

      {
        // And it really took: the badge the user can see is driven off this.
        const chat = St.state.chats.get(CHAT.id) || {};
        add('the unread count comes back to zero', chat.unreadCount === 0 ? true : 'unreadCount=' + chat.unreadCount);
      }

      {
        // Typing again in a chat that is already read must not call again.
        marks.length = 0;
        await type('more');
        add('typing in a chat that is already read marks nothing',
          marks.length === 0 ? true : JSON.stringify(marks));
      }

      {
        // The burst. One call per chat at a time, or every letter of every
        // word would put another call on the bridge.
        await seedOpen();
        becomesUnread();
        markDelay = 250;
        marks.length = 0;
        const composer = document.querySelector('#composer');
        for (let i = 0; i < 6; i++) {
          composer.value = 'h' + i;
          composer.dispatchEvent(new Event('input'));
        }
        await wait(600);
        markDelay = 0;
        add('a burst of typing is one call, not one per letter',
          marks.length === 1 ? true : JSON.stringify(marks));
      }

      // ---- the negatives ---------------------------------------------------

      {
        await seedOpen();
        marks.length = 0;
        await type('hello');
        add('typing in a chat with nothing unread marks nothing',
          marks.length === 0 ? true : JSON.stringify(marks));
      }

      {
        await seedOpen({ markReadOnOpen: false });
        becomesUnread();
        marks.length = 0;
        await type('hello');
        add('the mark-on-open setting is respected when typing',
          marks.length === 0 ? true : JSON.stringify(marks));
      }

      {
        await seedOpen();
        T.closeThread();
        await wait(80);
        becomesUnread();
        marks.length = 0;
        await type('hello');
        add('no open chat means typing marks nothing',
          marks.length === 0 ? true : JSON.stringify(marks));
      }

      // ---- the path the badge takes ----------------------------------------

      {
        // The race this is really about: the chat is marked read, and then the
        // sidebar is refreshed from the server, and the server's answer still
        // carries the old count. The badge comes back on an open chat, and
        // typing in it has to clear it.
        await seedOpen();
        becomesUnread();
        // The server's answer, arriving after the mark.
        St.state.chats.set(CHAT.id, Object.assign({}, St.state.chats.get(CHAT.id), { unreadCount: 1 }));
        marks.length = 0;
        await type('hello');
        const chat = St.state.chats.get(CHAT.id) || {};
        add('a badge that came back on an open chat is cleared by typing',
          (marks.length === 1 && chat.unreadCount === 0)
            ? true : JSON.stringify({ marks: marks, unreadCount: chat.unreadCount }));
      }

      St.state.chats.delete(CHAT.id);
      St.state.messages.delete(CHAT.id);

      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:typeread' });

  // The source checks are computed here, before the browser runs, and merged
  // with whatever it produced. A harness that dies on load must still be able
  // to report "the typing path is not exported" - which is precisely what
  // happens when the export is removed, since main.js then cannot import it at
  // all and the whole module graph fails before a single check prints.
  const threadSrc = fs.readFileSync(threadPath, 'utf8');
  const sourceCases = [
    // Matched as whole statements, not as "somewhere nearby": a loose pattern
    // happily spans from one handler into the next and passes while the
    // composer handler does nothing.
    ['typing marks the open chat read',
      /composer\.addEventListener\('input', \(\) => \{[\s\S]*?markReadOnTyping\(\);[\s\S]*?\}\);/.test(threadSrc)],
    ['the typing path is exported for the renderer to call',
      /export function markReadOnTyping\(\)/.test(threadSrc)],
    ['the typing path uses the shared rule, not its own copy',
      /const should = shouldMarkOnTyping\(\{/.test(threadSrc)],
    ['only one mark-read call per chat at a time',
      /if \(marksInFlight\.has\(key\)\) return;/.test(threadSrc)],
  ].map(([name, ok]) => [name, ok, '']);

  const win = new BrowserWindow({ show: false });
  // A real file:// page, because a data: URL cannot import an ES module.
  await win.loadFile(path.join(__dirname, 'typeread-harness.html'));
  let harnessCases;
  try {
    const result = await win.webContents.executeJavaScript(harness, true);
    harnessCases = JSON.parse(result);
  } catch (err) {
    harnessCases = [['the browser harness ran to the end', false, err.message]];
  }
  app.exit(0);
  return harnessCases.concat(sourceCases);
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
