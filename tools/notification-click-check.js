/**
 * Dev check: clicking a desktop notification opens that conversation and puts
 * the cursor in its composer.
 *
 * Clicking a toast used to do one thing: bring the window up. The user then
 * had to find the conversation in the list, click it, and click the composer
 * before they could reply. A toast is a request to reply, so it now opens
 * the conversation it was about and puts the caret in the composer.
 *
 * The interesting part is the second half. The window is often not the
 * foreground window when the click arrives - the main process has only just
 * been asked to show it, and Windows can refuse the foreground request
 * outright - and a caret set in a background window does not always survive
 * the activation. So the composer is asked for focus again when the window
 * takes focus.
 *
 * That second attempt is armed once, and only for a click that asked for it.
 * An ordinary return to the window must not drag the caret back into the
 * composer, because the user may have been somewhere else entirely. The
 * control case below is the one that would fail if the flag leaked.
 *
 * The click is driven through the subscription the app really installs, not
 * by calling the module's function, so a wiring that stopped opening the
 * conversation shows up here rather than in a source match.
 *
 * The DOM is generated from the real index.html, so the check cannot drift
 * from the app, and the API boundary is stubbed so no account and no network
 * are needed.
 *
 * Run with `npm run check:notificationclick`.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const HARNESS = path.join(__dirname, '.notification-click-harness.html');

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
  app.setPath('userData', path.join(os.tmpdir(), 'bb-notification-click-profile'));
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

      // A throw anywhere in the body must not take the cases collected so far
      // with it: a harness that dies reports one failure and hides the rest,
      // which is how a broken check looks like a passing one.
      try {
        await body();
      } catch (e) {
        cases.push(['the harness ran to the end', false, e && (e.stack || e.message)]);
      }
      return JSON.stringify(cases);

      async function body() {
        // The API boundary, stubbed. Nothing here needs an account.
        const envelope = (data) => ({ ok: true, data });
        window.beeper = {
          app: { bootstrap: async () => envelope({}), refreshDiscovery: async () => envelope({}), badge: async () => envelope(true) },
          updater: { check: async () => envelope({}), download: async () => envelope({}), quit: async () => envelope({}) },
          auth: { status: async () => envelope({}), connect: async () => envelope({}), manual: async () => envelope({}), disconnect: async () => envelope({}) },
          accounts: { list: async () => envelope([]) },
          contacts: { list: async () => envelope({ items: [] }) },
          assets: {
            uploadBytes: async () => envelope({ uploadID: 'u-1' }),
            resolve: async () => envelope({ url: null }),
            reupload: async () => envelope({}),
          },
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
            open: async () => envelope({ messages: [], complete: true }),
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
        const NC = await import(${JSON.stringify(js('notification-click.js'))});
        T.initThread();

        // The real subscription, not a call into the module: the handler the
        // app installs is the one under test, so a wiring that stopped
        // opening the conversation would show up here.
        let clickHandler = null;
        window.beeper.on = Object.assign({}, window.beeper.on, {
          notificationClick: (fn) => { clickHandler = fn; },
        });
        NC.wireNotificationClicks();

        const chatRecord = (id, title) => ({
          id: id, title: title, type: 'single',
          participants: { items: [{ isSelf: true }, { isSelf: false }] },
        });
        S.state.chats.set('c-note', chatRecord('c-note', 'A conversation'));
        S.state.chats.set('c-other', chatRecord('c-other', 'Another conversation'));

        // A window that is not on screen cannot take focus - Chromium will
        // not move the focus into a hidden window - so what is measured is
        // that the app asks the composer for focus.
        const focusCalls = [];
        const realFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (...args) {
          focusCalls.push(this.id || this.tagName || 'unknown');
          return realFocus.apply(this, args);
        };

        // --- the click ------------------------------------------------------

        await add('the app listens for the click at all', () =>
          typeof clickHandler === 'function' || 'nothing subscribed to the click');

        const opened = clickHandler ? clickHandler('c-note') : false;
        await settle();

        await add('a notification click opens that conversation', () =>
          opened === true || 'the click was refused');

        await add('and it is the conversation the notification was about', () =>
          S.state.activeChatID === 'c-note' || ('the open chat is ' + S.state.activeChatID));

        await add('and the thread is on screen', () =>
          document.getElementById('thread').hidden === false || 'the thread is still hidden');

        await add('and the header names it', () => {
          const name = document.getElementById('thread-name').textContent || '';
          return /A conversation/.test(name) || ('the header reads ' + name);
        });

        await add('and the cursor is in the composer', () =>
          focusCalls.includes('composer') || ('focus went to ' + JSON.stringify(focusCalls)));

        // --- a click that names no conversation -----------------------------

        focusCalls.length = 0;
        const before = S.state.activeChatID;
        if (clickHandler) clickHandler('');

        await add('a click that names no conversation is refused', () =>
          NC.openFromNotification('') === false || 'it was not refused');

        await add('and leaves the user where they were', () =>
          S.state.activeChatID === before || ('it moved to ' + S.state.activeChatID));

        await add('and does not move the cursor', () =>
          focusCalls.length === 0 || ('focus went to ' + JSON.stringify(focusCalls)));

        // --- the window was not the foreground window when the click arrived

        focusCalls.length = 0;
        NC.openFromNotification('c-note', { windowActive: false });
        await settle();

        await add('the conversation opens even when the window is not in front', () =>
          S.state.activeChatID === 'c-note' || ('the open chat is ' + S.state.activeChatID));

        focusCalls.length = 0;
        const waited = NC.focusComposerOnWindowFocus();

        await add('the composer is asked for focus again when the window takes focus', () =>
          waited === true || 'the window focus was not waiting for anything');

        await add('and the caret really goes there', () =>
          focusCalls.includes('composer') || ('focus went to ' + JSON.stringify(focusCalls)));

        // --- and only once --------------------------------------------------

        focusCalls.length = 0;
        const again = NC.focusComposerOnWindowFocus();

        await add('and only once: an ordinary return to the window leaves the caret alone', () =>
          (again === false && focusCalls.length === 0)
            || ('it fired again, focus went to ' + JSON.stringify(focusCalls)));

        // --- the control: a click that landed in an active window ------------

        focusCalls.length = 0;
        NC.openFromNotification('c-note', { windowActive: true });
        await settle();
        focusCalls.length = 0;
        const notArmed = NC.focusComposerOnWindowFocus();

        await add('CONTROL: a click in an active window does not steal the caret later', () =>
          (notArmed === false && focusCalls.length === 0)
            || ('it stole the caret, focus went to ' + JSON.stringify(focusCalls)));
      }
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:notificationclick' });
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

  // The wiring across the three processes is checked against the source: the
  // click travels main -> preload -> renderer, and a break in any of those
  // leaves the click doing nothing at all, with nothing on screen to say so.
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'main.js'), 'utf8');

  // The channel name is a string on both sides of the bridge, and a typo on
  // one side only leaves both source checks green while the click does
  // nothing at all. So the two names are read out of the source and compared.
  const mainChannel = (mainSrc.match(/webContents\.send\('([^']+)', chatID\)/) || [])[1];
  const preloadChannel = (preloadSrc.match(/notificationClick: \(fn\) => on\('([^']+)', fn\)/) || [])[1];

  const sourceCases = [
    ['the main process sends the chat the notification was about',
      /notification\.on\('click', \(\) => \{[\s\S]*?webContents\.send\('notification:click', chatID\);\s*\}\);/.test(mainSrc)],
    ['the preload carries the click to the renderer',
      /notificationClick: \(fn\) => on\('notification:click', fn\)/.test(preloadSrc)],
    ['and the two sides are talking about the same channel',
      Boolean(mainChannel) && mainChannel === preloadChannel,
      `main sends "${mainChannel}", the preload listens on "${preloadChannel}"`],
    ['the renderer listens for the click',
      /wireNotificationClicks\(\);/.test(rendererSrc)],
    ['and the window focus is where the composer is asked for again',
      /addEventListener\('focus', \(\) => \{[\s\S]{0,400}?focusComposerOnWindowFocus\(\);/.test(rendererSrc)],
    ['and so is the window becoming visible again, which is the other way back',
      /visibilitychange', \(\) => \{[\s\S]{0,900}?focusComposerOnWindowFocus\(\);/.test(rendererSrc)],
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
