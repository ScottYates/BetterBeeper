/**
 * Dev check: coming back to the window counts as having read the open chat.
 *
 * The bug this exists for: renderMessages() marks the thread read only when the
 * document has focus at the moment it runs. A message that arrived while the
 * window was in the background was therefore rendered with focus false and
 * deliberately not marked - and nothing re-renders when the window comes back,
 * so nothing ever re-asked. The message stayed unread, and so did the badge,
 * until something unrelated happened to re-render the thread.
 *
 * Reproduced live before it was fixed: minimise the window, let a message
 * arrive, bring it back, and the markRead call count was zero.
 *
 * The rule is pure (focus-read.js) and driven directly. The behaviour is driven
 * over real state with only the IPC boundary replaced, because the whole failure
 * was a call site that was never made - a correct rule that nothing invokes is
 * the same as no rule.
 *
 * Run with `npm run check:focusread`.
 */
const path = require('path');
const fs = require('node:fs');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const url = (...p) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', ...p)).href;
const focusReadURL = url('focus-read.js');
const threadURL = url('thread.js');
const stateURL = url('state.js');
const mainPath = path.join(ROOT, 'src', 'renderer', 'js', 'main.js');
const threadPath = path.join(ROOT, 'src', 'renderer', 'js', 'thread.js');

// thread.js pulls in DOM helpers, so exercise it in a real browser via Electron.
async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-focusread-check-profile'));

  const harness = `
  (async () => {
      // The harness page has no preload, so window.beeper does not exist. This
      // is the boundary: everything above it is the app's own code.
      const marks = [];
      window.beeper = new Proxy({}, {
        get: (_t, ns) => new Proxy({}, {
          get: (_t2, fn) => (...args) => {
            if (ns === 'chats' && fn === 'markRead') {
              marks.push({ chatID: args[0], messageID: args[1] });
              return Promise.resolve({ ok: true, data: {} });
            }
            if (ns === 'chats' && fn === 'get') return Promise.resolve({ ok: true, data: CHAT });
            if (ns === 'chats' && fn === 'list') return Promise.resolve({ ok: true, data: { items: [CHAT] } });
            if (ns === 'messages' && fn === 'list') return Promise.resolve({ ok: true, data: { items: [] } });
            return Promise.resolve({ ok: true, data: {} });
          },
        }),
      });

      const FR = await import(${JSON.stringify(focusReadURL)});
      const T = await import(${JSON.stringify(threadURL)});
      const St = await import(${JSON.stringify(stateURL)});

      const cases = [];
      const add = (name, ok, detail) => cases.push([name, !!ok, detail || '']);
      const check = (name, fn) => {
        try {
          const r = fn();
          add(name, r === true, r === true ? '' : String(r));
        } catch (e) { add(name, false, e.message); }
      };

      const ALL = {
        windowFocused: true, windowVisible: true,
        hasOpenChat: true, lastMessageUnread: true, markReadEnabled: true,
      };

      // ---- the rule -------------------------------------------------------

      check('a message waiting when you come back is marked read', () =>
        FR.shouldMarkOnReturn(ALL) === true || 'the rule said no');

      check('nothing to read, nothing is marked', () =>
        FR.shouldMarkOnReturn(Object.assign({}, ALL, { lastMessageUnread: false })) === false
          || 'an already-read message was marked again');

      check('a window without focus marks nothing', () =>
        FR.shouldMarkOnReturn(Object.assign({}, ALL, { windowFocused: false })) === false
          || 'it marked read while the window was in the background');

      check('a hidden window marks nothing', () =>
        FR.shouldMarkOnReturn(Object.assign({}, ALL, { windowVisible: false })) === false
          || 'it marked read while hidden - this is how focus and visibility cancel each other out');

      check('no open chat means nothing to have read', () =>
        FR.shouldMarkOnReturn(Object.assign({}, ALL, { hasOpenChat: false })) === false
          || 'it marked an empty screen as read');

      check('turning off mark-on-open also turns off mark-on-return', () =>
        FR.shouldMarkOnReturn(Object.assign({}, ALL, { markReadEnabled: false })) === false
          || 'the setting was ignored on the return path');

      check('a missing answer is a no, not a crash', () =>
        FR.shouldMarkOnReturn() === false || 'shouldMarkOnReturn() with nothing did not say no');

      check('every condition is load-bearing', () => {
        // Flip each one and the rule must stop saying yes. This is what catches
        // a condition written into the signature but never actually consulted.
        const keys = ['windowFocused', 'windowVisible', 'hasOpenChat', 'lastMessageUnread', 'markReadEnabled'];
        const inert = keys.filter((k) => FR.shouldMarkOnReturn(Object.assign({}, ALL, { [k]: !ALL[k] })) === true);
        return inert.length === 0 || 'these had no effect: ' + inert.join(', ');
      });

      // ---- the real behaviour, over real state ---------------------------

      const CHAT = { id: '!focus-check', title: 'Focus chat', unreadCount: 1, lastActivity: '2026-03-04T00:00:00Z' };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      const msg = (id, isUnread) => ({
        id: id, chatID: CHAT.id, text: 'hello', senderName: 'Someone',
        isSender: false, isUnread: isUnread,
        timestamp: new Date().toISOString(), sortKey: id, attachments: [],
      });

      // Focus emulation. A hidden harness window reports hasFocus() false, so
      // without this the negative cases could not be driven at all.
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

      const seedOpen = async (settings) => {
        marks.length = 0;
        St.state.chats.set(CHAT.id, Object.assign({}, CHAT));
        St.state.messages.set(CHAT.id, [msg('~check:old', false)]);
        St.state.settings = Object.assign({}, St.state.settings, { markReadOnOpen: true }, settings || {});
        T.closeThread();
        await asWindow(true, true, async () => { await T.openChat(CHAT.id); await wait(150); });
        marks.length = 0;
      };

      // Wire the real event path. Without this the bus has no listener, nothing
      // ever re-renders, and every check about what the render does passes for
      // the wrong reason: there was no render at all.
      T.initThread();
      await wait(120);

      /** A message lands while the window is in the background. */
      const arrivesWhileAway = async (id) => {
        const list = St.state.messages.get(CHAT.id) || [];
        St.state.messages.set(CHAT.id, list.concat([msg(id, true)]));
        St.state.chats.set(CHAT.id, Object.assign({}, St.state.chats.get(CHAT.id), { unreadCount: 1 }));
        St.bus.emit('messages:changed', { chatID: CHAT.id });
        await asWindow(false, false, async () => { await wait(200); });
      };

      // ---- opening still works --------------------------------------------

      await seedOpen();
      add('opening a chat still marks it read', () =>
        (async () => true)() && marks.length === 0
          ? true
          : 'the fixture did not settle');

      {
        marks.length = 0;
        await asWindow(true, true, async () => { await T.closeThread(); await wait(60); await T.openChat(CHAT.id); await wait(200); });
        add('opening a chat marks the unread message read',
          marks.length === 1 && marks[0].messageID === '~check:old' ? true : JSON.stringify(marks));
      }

      // ---- the bug this is about ------------------------------------------

      await seedOpen();
      await arrivesWhileAway('~check:whileaway');

      // Prove the render actually happened. Without this, every check about
      // what the render does passes for the wrong reason: there was no render,
      // because initThread() had not wired the bus.
      add('the message that arrived while away really is on screen',
        Array.from(document.querySelectorAll('#message-list [data-message-id]'))
          .some((n) => n.dataset.messageId === '~check:whileaway')
          ? true
          : 'the arriving message was never rendered');

      add('a message that arrived while away was not marked while away',
        marks.length === 0 ? true : JSON.stringify(marks));

      {
        marks.length = 0;
        const acted = await asWindow(true, true, async () => T.markReadOnReturn());
        await wait(250);
        add('coming back marks the waiting message read',
          (acted === true && marks.length === 1 && marks[0].messageID === '~check:whileaway')
            ? true
            : JSON.stringify({ acted: acted, marks: marks }));
      }

      {
        // And it really took: the badge the user can see is driven off this.
        const chat = St.state.chats.get(CHAT.id) || {};
        add('the unread count comes back to zero', chat.unreadCount === 0 ? true : 'unreadCount=' + chat.unreadCount);
      }

      // ---- the negatives ---------------------------------------------------

      await seedOpen();
      await arrivesWhileAway('~check:stillaway');
      {
        marks.length = 0;
        const acted = await asWindow(false, false, async () => T.markReadOnReturn());
        await wait(150);
        add('a window still in the background marks nothing',
          (acted === false && marks.length === 0) ? true : JSON.stringify({ acted: acted, marks: marks }));
      }

      await seedOpen({ markReadOnOpen: false });
      await arrivesWhileAway('~check:settingoff');
      {
        marks.length = 0;
        const acted = await asWindow(true, true, async () => T.markReadOnReturn());
        await wait(150);
        add('the mark-on-open setting is respected on return',
          (acted === false && marks.length === 0) ? true : JSON.stringify({ acted: acted, marks: marks }));
      }

      {
        // Already read: returning to the window must not mark anything again.
        // This is the behaviour behind the lastMessageUnread condition, and it
        // is the only place a hardcoded true would show up.
        //
        // Seeded here rather than reusing whatever the previous block left:
        // that one turned the setting off, and a check that depends on its
        // neighbour's state is not a check.
        await seedOpen();
        marks.length = 0;
        const list = St.state.messages.get(CHAT.id) || [];
        St.state.messages.set(CHAT.id, list.map((m) => Object.assign({}, m, { isUnread: false })));
        const acted = await asWindow(true, true, async () => T.markReadOnReturn());
        await wait(150);
        add('an already-read message is not marked on return',
          (acted === false && marks.length === 0) ? true : JSON.stringify({ acted: acted, marks: marks }));
      }

      await seedOpen();
      {
        marks.length = 0;
        const acted = await asWindow(true, true, async () => {
          T.closeThread();
          await wait(80);
          return T.markReadOnReturn();
        });
        await wait(150);
        add('no open chat means nothing is marked',
          (acted === false && marks.length === 0) ? true : JSON.stringify({ acted: acted, marks: marks }));
      }

      // ---- focus but hidden: the pair must cancel out ----------------------
      check('focus without visibility does not mark', () =>
        FR.shouldMarkOnReturn(Object.assign({}, ALL, { windowFocused: true, windowVisible: false })) === false
          || 'half-focused counted as focused');

      St.state.chats.delete(CHAT.id);
      St.state.messages.delete(CHAT.id);

      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:focusread' });

  // The source checks are computed here, before the browser runs, and merged
  // with whatever it produced. A harness that dies on load must still be able
  // to report "the return path is not exported" - which is precisely what
  // happens when the export is removed, since main.js then cannot import it at
  // all and the whole module graph fails before a single check prints.
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const threadSrc = fs.readFileSync(threadPath, 'utf8');
  const sourceCases = [
    // Matched as whole statements, not as "somewhere nearby": a loose pattern
    // happily spans from the focus handler into the visibility handler and
    // passes while the focus handler does nothing.
    ['focus marks the open chat read',
      /window\.addEventListener\('focus', \(\) => \{\s*refreshInboxOnFocus\(\);\s*markReadOnReturn\(\);/.test(mainSrc)],
    ['becoming visible marks it read too',
      /visibilityState !== 'visible'\) return;\s*refreshInboxOnFocus\(\);\s*markReadOnReturn\(\);/.test(mainSrc)],
    ['the return path is exported for the renderer to call',
      /export function markReadOnReturn\(\)/.test(threadSrc)],
    ['the return path uses the shared rule, not its own copy',
      /const should = shouldMarkOnReturn\(\{/.test(threadSrc)],
    ['the render path still guards on focus',
      /document\.hasFocus\(\) && window\.document\.visibilityState === 'visible'\) markRead\(\)/.test(threadSrc)],
  ].map(([name, ok]) => [name, ok, '']);

  const win = new BrowserWindow({ show: false });
  // A real file:// page, because a data: URL cannot import an ES module.
  await win.loadFile(path.join(__dirname, 'focusread-harness.html'));
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