'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  protocol,
  net,
  screen,
  shell,
} = require('electron');

const ipc = require('./ipc');
const { shouldNotify, notificationBody } = require('./notify');

const isDev = process.argv.includes('--dev');

/**
 * Electron names the `userData` folder after `productName`, so renaming the app
 * would silently strand every preference in the previous folder. Carry
 * `settings.json` across.
 *
 * `auth.json` is deliberately NOT copied. Electron's `safeStorage` binds its
 * ciphertext to the app name, so a token encrypted as "Beeper Desktop Chat"
 * cannot be decrypted as "Better Beeper" - copying it would only leave a file
 * that fails to decrypt on every launch. One re-approval in Beeper is the price
 * of the rename, and that is the right trade against a permanently broken token.
 */
const LEGACY_USER_DATA_NAMES = ['Beeper Desktop Chat'];

function migrateUserData() {
  try {
    const current = app.getPath('userData');
    for (const legacyName of LEGACY_USER_DATA_NAMES) {
      const legacy = path.join(path.dirname(current), legacyName);
      if (path.resolve(legacy) === path.resolve(current)) continue;
      if (!fs.existsSync(legacy)) continue;

      const from = path.join(legacy, 'settings.json');
      const to = path.join(current, 'settings.json');
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.mkdirSync(current, { recursive: true });
      fs.copyFileSync(from, to);
    }
  } catch {
    /* a failed migration just means starting from default preferences */
  }
}

migrateUserData();

let mainWindow = null;
let services = null;

// Beeper hands us local file:// paths for avatars, images and voice notes.
// The renderer (which runs under contextIsolation with no Node access) loads
// them through a dedicated privileged scheme instead of relaxing webSecurity.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'beeper-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function registerFileProtocol() {
  protocol.handle('beeper-file', async (request) => {
    try {
      const url = new URL(request.url);
      // Producer always writes beeper-file://local/<absolute path>
      let filePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');

      // Be tolerant of callers that drop the "local" host segment.
      if (!filePath && url.hostname && url.hostname !== 'local') {
        filePath = decodeURIComponent(url.hostname + url.pathname);
      }
      if (!filePath) {
        return new Response('Bad media path', { status: 400 });
      }
      if (process.platform === 'win32') {
        // C:/Users/... -> C:\Users\...
        filePath = filePath.replace(/\//g, '\\');
      }
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      return new Response(`Failed to load attachment: ${err.message}`, { status: 404 });
    }
  });
}

const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

// Text size is applied as Chromium page zoom rather than a CSS font-size
// override. Zoom scales type, icons, padding and hit targets together and keeps
// pointer coordinates in one consistent space, which matters because the
// sidebar splitter and the tooltips both convert between client coordinates and
// CSS pixels. A font-size override would scale the text but leave the boxes, the
// pointer maths and the 200-620px sidebar clamp all describing a different size.
// The View menu's zoomIn / zoomOut / resetZoom roles already drive this same
// mechanism, so this makes that behaviour persistent rather than adding a
// parallel one.
const DEFAULT_TEXT_SCALE = 1;
const MIN_TEXT_SCALE = 0.5;
const MAX_TEXT_SCALE = 3;

function clampTextScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TEXT_SCALE;
  return Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, n));
}

/** Apply the text size to every window the app owns. */
function applyTextScale(value) {
  const scale = clampTextScale(value);
  for (const win of [mainWindow, viewerWindow]) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.setZoomFactor(scale);
    } catch {
      // A window mid-teardown is not worth failing a settings save over.
    }
  }
  return scale;
}

let boundsTimer = 0;

/**
 * Where the window was last left. Clamped to whichever display currently owns
 * that position, so unplugging a monitor cannot strand the window off-screen.
 */
function restoreBounds() {
  const saved = services?.settings?.read().windowBounds;
  if (!saved || typeof saved !== 'object') return {};

  try {
    const area = screen.getDisplayMatching({
      x: saved.x,
      y: saved.y,
      width: saved.width,
      height: saved.height,
    }).workArea;

    const width = Math.max(MIN_WIDTH, Math.min(saved.width || area.width, area.width));
    const height = Math.max(MIN_HEIGHT, Math.min(saved.height || area.height, area.height));

    return {
      width,
      height,
      x: Math.round(Math.min(Math.max(saved.x, area.x), area.x + area.width - width)),
      y: Math.round(Math.min(Math.max(saved.y, area.y), area.y + area.height - height)),
    };
  } catch {
    return {}; // stored bounds were nonsense; fall back to the defaults
  }
}

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Minimised and full-screen bounds would be saved as the "normal" size.
    if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
    try {
      // getNormalBounds() is deliberately the pre-maximize rectangle, so a
      // maximized window restores to the size it had before it was maximized.
      // The maximized flag is saved alongside it, otherwise closing a maximized
      // window and reopening it would quietly un-maximize it.
      services?.settings?.write({
        windowBounds: mainWindow.getNormalBounds(),
        windowMaximized: mainWindow.isMaximized(),
      });
    } catch {
      /* a failed write just means we open at the default size next time */
    }
  }, 400);
}

// ---------------------------------------------------------------------------
// Image viewer window
// ---------------------------------------------------------------------------

let viewerWindow = null;

/**
 * Open an image in its own always-on-top window covering the display.
 *
 * It is a separate window rather than an overlay inside the app for two
 * reasons the in-window lightbox could not give: the image is limited by the
 * display instead of by the main window's size, and zooming here never scrolls
 * or re-renders the chat list and thread behind it.
 *
 * Only one viewer exists at a time - opening another closes the first.
 */
function openImageViewer(srcURL, alt = '') {
  if (!srcURL) return false;

  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.close();
    viewerWindow = null;
  }

  // The viewer must land on the monitor the app is actually on, or it opens
  // over whatever the user is working in instead of over the chat.
  //
  // `getDisplay()` asks the window directly which display it occupies, which
  // is exactly the question being asked here. `getDisplayMatching()` is only a
  // fallback: it is driven by a rectangle, so it can disagree when the window
  // straddles a boundary or when mixed-DPI coordinates are in play - and when
  // it did disagree it silently answered with the primary display, putting a
  // full-screen always-on-top window on the wrong monitor.
  let display = null;
  try {
    if (typeof mainWindow?.getDisplay === 'function') display = mainWindow.getDisplay();
    if (!display && mainWindow && typeof mainWindow.getBounds === 'function') {
      display = screen.getDisplayMatching(mainWindow.getBounds());
    }
  } catch {
    display = null;
  }
  if (!display) display = screen.getPrimaryDisplay();
  const area = display.workArea;

  viewerWindow = new BrowserWindow({
    ...area,
    backgroundColor: '#08080a',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The viewer only ever shows a beeper-file/data/https image handed to it
      // by the app, and it is a plain loadFile with no preload at all.
    },
  });

  // 'screen-saver' keeps it above other always-on-top windows; without it the
  // viewer would drop behind ordinary apps the moment they take focus.
  viewerWindow.setAlwaysOnTop(true, 'screen-saver');
  viewerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const viewer = viewerWindow;
  viewer.once('ready-to-show', () => {
    viewer.show();
    viewer.focus();
  });

  // Hand focus back to the app when the viewer goes away.
  viewer.on('closed', () => {
    if (viewerWindow === viewer) viewerWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  });

  // `query` must be an object here - Electron serialises it itself. Passing a
  // pre-built query string silently produces a URL with no search string at all.
  viewer.loadFile(path.join(__dirname, '..', 'renderer', 'viewer.html'), {
    query: { src: srcURL, alt },
  });

  // The viewer honours the same text size as the app, so its toolbar and zoom
  // badge match the rest of the UI. Re-applied after load for the same reason as
  // the main window: Chromium restores its own per-origin zoom during load.
  viewer.webContents.on('did-finish-load', () => {
    applyTextScale(services?.settings?.read().textScale);
  });
  applyTextScale(services?.settings?.read().textScale);
  return true;
}

function createWindow() {
  const saved = restoreBounds();
  const maximized = services?.settings?.read().windowMaximized === true;

  mainWindow = new BrowserWindow({
    width: saved.width || 1360,
    height: saved.height || 900,
    ...(Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#12141a',
    title: 'Better Beeper',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs `require`
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    // The size and position passed to the constructor do not survive contact
    // with a mixed-DPI desktop. On Windows the construction-time width and
    // height are converted using the *primary* display's scale factor, so on a
    // second monitor at a different scale the window comes out at the wrong
    // size: a window asked for 720x520 opened at 480x347, because the primary
    // display here is at 150%. Position was unaffected, which is what made it
    // look like a clamp bug rather than a DPI one.
    //
    // Re-applying the same bounds once the window exists uses the scale of the
    // display the window actually landed on, and the size then holds. It is
    // also safe to skip when the saved state says the window was maximized:
    // setBounds on a maximized window would drop it back to windowed.
    if (!maximized) {
      // Only pass a position that is actually a number. `setBounds` converts its
      // arguments eagerly and throws on undefined, which is what happens on a
      // first run where restoreBounds() found nothing to restore and returned
      // {}. The constructor above guards x and y the same way.
      const target = { width: saved.width || 1360, height: saved.height || 900 };
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        target.x = saved.x;
        target.y = saved.y;
      }
      mainWindow.setBounds(target);
    }
    if (maximized) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Apply the remembered text size before the first paint, so the window never
  // opens at one size and then visibly jumps to another.
  applyTextScale(services?.settings?.read().textScale);

  // ...and again once the document is loaded, because Chromium keeps a page
  // zoom of its own per origin and restores it during load. Setting the zoom
  // only up front loses to that restore: the app would reopen at whatever was
  // last set through the View menu's zoom roles, ignoring the saved setting
  // entirely. Re-applying after load makes the stored value the last word.
  mainWindow.webContents.on('did-finish-load', () => {
    applyTextScale(services?.settings?.read().textScale);
  });

  // Remember the size and position across runs.
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  mainWindow.on('maximize', persistBounds);
  mainWindow.on('unmaximize', persistBounds);

  // Never open app windows or arbitrary files in-app; send them to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel) => () => mainWindow?.webContents.send(channel);

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Chat',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+N',
          click: send('menu:newChat'),
        },
        {
          label: 'Search',
          accelerator: 'CmdOrCtrl+F',
          click: send('menu:focusSearch'),
        },
        { type: 'separator' },
        { label: 'Toggle Assistant', accelerator: 'CmdOrCtrl+Shift+A', click: send('menu:toggleAssistant') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Beeper Desktop API Docs',
          click: () => shell.openExternal('https://developers.beeper.com/desktop-api/'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Notification preferences, read straight from the settings store. Cached for a
 * moment so a burst of messages does not re-read the file per frame - short
 * enough that flipping a switch feels immediate.
 */
let notifyCache = { at: 0, value: null };
function notificationPrefs() {
  const now = Date.now();
  if (notifyCache.value && now - notifyCache.at < 1500) return notifyCache.value;
  let value = null;
  try {
    value = services?.settings?.read() || null;
  } catch {
    value = null;
  }
  notifyCache = { at: now, value };
  return value;
}

/** Desktop notification for messages that land while the window is in the background. */
function wireNotifications() {
  if (!Notification.isSupported()) return;
  const { events, client } = services;

  events.on('message.upserted', async (frame) => {
    const chatID = frame.chatID;
    if (!chatID) return;

    // Cheap pre-check: skip the chat fetch entirely when notifications are off.
    const early = notificationPrefs();
    if (!early || early.notifyEnabled === false) return;
    if (!early.notifyWhenFocused && mainWindow?.isFocused() && mainWindow?.isVisible()) return;

    try {
      const chat = await client.getChat(chatID);

      const ids = new Set(frame.ids || []);
      const entry = frame.entries?.find((e) => ids.has(String(e.id))) || frame.entries?.[0];
      if (!entry) return;

      // Re-check after the await: settings may have changed, and the user may
      // have focused the window while we were fetching the chat.
      const allowed = shouldNotify({
        prefs: notificationPrefs(),
        windowFocused: Boolean(mainWindow?.isFocused()),
        windowVisible: Boolean(mainWindow?.isVisible()),
        chat,
        messageIsOwn: Boolean(entry.isSender),
      });
      if (!allowed) return;

      const notification = new Notification({
        title: chat.title || 'Beeper',
        body: notificationBody(entry, early.notifyPreview || 'full').slice(0, 160),
        silent: early.notifySound === false,
      });

      notification.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      });
      notification.show();
    } catch {
      /* notifications are best-effort */
    }
  });
}

app.whenReady().then(async () => {
  registerFileProtocol();
  buildMenu();
  services = ipc.register({
    getWindow: () => mainWindow,
    openImageViewer,
    applyTextScale,
  });
  createWindow();
  wireNotifications();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    services?.stopLive();
  } catch {
    /* ignore */
  }
});
