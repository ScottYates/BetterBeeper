'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { ipcMain, dialog, shell, app, BrowserWindow, clipboard, nativeImage } = require('electron');

const { DEFAULT_BASE_URL, ENDPOINTS } = require('./config');
const { TokenStore } = require('./token-store');
const { SettingsStore } = require('./settings');
const { BeeperClient, BeeperError } = require('./beeper-client');
const { BeeperEvents } = require('./beeper-ws');
const { McpClient } = require('./mcp-client');
const auth = require('./auth');
const badge = require('./badge');
const mediaPath = require('./media-path');
const assetSource = require('./asset-source');
const { openMessageStore, OPEN_PAGE } = require('./message-store');
const { openMediaStore } = require('./media-store');
const { createHistorySync } = require('./history-sync');
const { makeTitleRecorder } = require('./chat-titles');
const updater = require('./updater');

/** Wraps a handler so the renderer always gets {ok, data|error}. */
function ok(data) {
  return { ok: true, data };
}
function fail(err) {
  return {
    ok: false,
    error: {
      message: err?.message || String(err),
      code: err?.code || 'error',
      status: err?.status ?? 0,
    },
  };
}

/**
 * Runs a handler and normalises the result into the {ok, data|error}
 * envelope the renderer expects.
 *
 * Handlers may return a raw payload or an already-wrapped envelope; both work,
 * so a handler only has to opt into `ok(...)` when it wants to attach extra
 * fields. `ok` is only treated as pre-wrapped when it is an actual boolean,
 * which no Beeper resource payload ever has.
 */
const handle = (fn) => async (_event, ...args) => {
  try {
    const result = await fn(...args);
    if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
      return result;
    }
    return ok(result);
  } catch (err) {
    if (!(err instanceof BeeperError) && !(err instanceof auth.AuthError)) {
      console.error('[ipc]', err);
    }
    return fail(err);
  }
};

function register({ getWindow, openImageViewer, applyTextScale }) {
  const userData = app.getPath('userData');
  const tokenStore = new TokenStore(userData);
  const settings = new SettingsStore(userData);

  // Opened further down, once the client is known to be reachable. Declared
  // here because the chat handlers above already hold every title this app
  // will ever be told, and the history store is the only place worth keeping
  // them: without it, a synced chat can only be identified by its id.
  let historyStore = null;

  // Runs on the paths that already fetch chats, so it costs nothing extra.
  const rememberChatTitles = makeTitleRecorder(() => historyStore);

  // Live endpoint discovery, refreshed on startup and whenever Beeper restarts.
  const endpoints = {
    baseUrl: DEFAULT_BASE_URL,
    mcpUrl: `${DEFAULT_BASE_URL}/v0/mcp`,
    wsUrl: `${DEFAULT_BASE_URL.replace(/^http/, 'ws')}/v1/ws`,
  };

  const getToken = () => tokenStore.read()?.accessToken || null;

  const client = new BeeperClient({
    getToken,
    getBaseUrl: () => endpoints.baseUrl,
  });

  const events = new BeeperEvents({
    getToken,
    getWsUrl: () => endpoints.wsUrl,
  });

  const mcp = new McpClient({
    getToken,
    getMcpUrl: () => endpoints.mcpUrl,
  });

  const broadcast = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // ---- event fan-out ---------------------------------------------------

  events.on('status', (payload) => broadcast('events:status', payload));
  events.on('ready', (frame) => broadcast('events:ready', frame));
  events.on('event', (frame) => broadcast('events:frame', frame));
  mcp.on('status', (payload) => broadcast('mcp:status', payload));

  // ---- discovery / lifecycle ------------------------------------------

  async function discover() {
    try {
      const info = await client.info();
      if (info?.server?.base_url) endpoints.baseUrl = info.server.base_url;
      endpoints.mcpUrl = info?.endpoints?.mcp || `${endpoints.baseUrl}/v0/mcp`;
      endpoints.wsUrl = info?.endpoints?.ws_events || `${endpoints.baseUrl.replace(/^http/, 'ws')}/v1/ws`;
      events.connect();
      if (getToken()) mcp.connect();
      return { reachable: true, info, endpoints };
    } catch (err) {
      events.disconnect();
      return { reachable: false, error: err.message, endpoints };
    }
  }

  function startLive() {
    if (getToken()) {
      events.connect();
      mcp.connect();
    }
  }

  function stopLive() {
    events.disconnect();
    mcp.disconnect();
  }

  // ---- IPC surface -----------------------------------------------------

  // The unread count on the app icon. The renderer owns the chat list, so it
  // decides the number and main only applies it - one source of truth, and no
  // second copy of "what is unread" to keep in step.
  ipcMain.handle('app:badge', handle(async (count) => {
    const applied = await badge.applyBadge(count);
    return ok({ applied, count: badge.currentBadge() });
  }));

  ipcMain.handle('app:bootstrap', handle(async () => {
    const discovery = await discover();
    const token = tokenStore.read();
    return ok({
      discovery,
      authenticated: Boolean(token?.accessToken),
      identity: token?.identity ?? null,
      settings: settings.read(),
      // Seed the UI with the *current* connection state. Relying on pushed
      // status alone leaves the UI showing "offline" on launch, because the
      // socket usually connects before the renderer attaches its listener.
      live: { events: events.status, mcp: mcp.status },
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
      },
      platform: process.platform,
      tokenEncrypted: tokenStore.isEncrypted,
    });
  }));

  ipcMain.handle('app:refreshDiscovery', handle(async () => ok(await discover())));

  // Deferred until after discovery so the first chat can open immediately
  // rather than queueing behind a disk sweep.
  setTimeout(() => {
    adoptStoredMedia().catch((err) => {
      console.warn('[history] could not copy stored attachments:', err.message);
    });
  }, 5000);

  // ---- updates ---------------------------------------------------------
  //
  // The renderer asks, the user decides, and the download streams progress back
  // over a push channel. The install itself cannot happen here: the NSIS
  // installer cannot replace the executable of a running process, so the last
  // step stages a marker and quits, and the installer runs on the next launch.
  // See updater.js for why that split is unavoidable rather than merely awkward.

  ipcMain.handle('updater:check', handle(async () => {
    const result = await updater.checkForUpdate({ current: app.getVersion() });
    return ok({ ...result, ...updater.pendingStatus() });
  }));

  ipcMain.handle('updater:download', handle(async () => {
    const result = await updater.checkForUpdate({ current: app.getVersion() });
    if (!result.updateAvailable) return ok({ skipped: 'no-update' });
    if (!result.asset) {
      return ok({ skipped: result.reason || 'no-installer' });
    }

    broadcast('updater:progress', { phase: 'download', percent: 0, written: 0, total: result.asset.size || 0 });

    const installer = await updater.downloadAsset(result.asset, (progress) => {
      broadcast('updater:progress', { phase: 'download', ...progress });
    });

    const staged = updater.stageUpdate(installer);
    broadcast('updater:progress', { phase: 'ready', percent: 100 });
    return ok({ ...staged, version: result.version, requiresRestart: true });
  }));

  // Quitting is the main process's own business, but the renderer asks rather
  // than reaching for it, so the "restart now" button and the auto-quit after a
  // staged update go through one path.
  ipcMain.handle('updater:quit', handle(async () => {
    setTimeout(() => app.quit(), 150);
    return ok(true);
  }));

  ipcMain.handle('auth:status', handle(async () => {
    const token = tokenStore.read();
    if (!token?.accessToken) return ok({ authenticated: false });
    // Confirm the token still works before the UI claims it does.
    try {
      const accounts = await client.listAccounts();
      return ok({ authenticated: true, valid: true, accountCount: accounts.length });
    } catch (err) {
      return ok({ authenticated: true, valid: !err.isAuthError, error: err.message });
    }
  }));

  ipcMain.handle('auth:connect', handle(async () => {
    const discovery = await discover();
    const baseUrl = discovery.reachable ? endpoints.baseUrl : DEFAULT_BASE_URL;
    const win = getWindow();
    const token = await auth.authorize({ baseUrl, parentWindow: win });
    tokenStore.write(token);
    startLive();
    const accounts = await client.listAccounts();
    return ok({ authenticated: true, accounts });
  }));

  ipcMain.handle('auth:manual', handle(async (accessToken) => {
    const discovery = await discover();
    const baseUrl = discovery.reachable ? endpoints.baseUrl : DEFAULT_BASE_URL;
    const token = await auth.verifyManualToken({ baseUrl, accessToken: String(accessToken).trim() });
    tokenStore.write(token);
    startLive();
    const accounts = await client.listAccounts();
    return ok({ authenticated: true, accounts });
  }));

  ipcMain.handle('auth:disconnect', handle(async () => {
    const token = tokenStore.read();
    if (token?.accessToken) await auth.revoke({ baseUrl: endpoints.baseUrl, accessToken: token.accessToken });
    stopLive();
    tokenStore.clear();
    return ok({ authenticated: false });
  }));

  // ---- accounts & chats -------------------------------------------------

  ipcMain.handle('accounts:list', handle(() => client.listAccounts()));
  ipcMain.handle('contacts:list', handle((accountID, params) => client.listContacts(accountID, params || {})));
  ipcMain.handle('chats:list', handle(async (params) => {
    const page = await client.listChats(params || {});
    rememberChatTitles(page);
    return page;
  }));
  ipcMain.handle('chats:search', handle(async (params) => {
    const page = await client.searchChats(params || {});
    rememberChatTitles(page);
    return page;
  }));
  ipcMain.handle('chats:get', handle(async (chatID, params) => {
    const chat = await client.getChat(chatID, params || {});
    rememberChatTitles([chat]);
    return chat;
  }));
  ipcMain.handle('chats:patch', handle((chatID, patch) => client.patchChat(chatID, patch)));
  ipcMain.handle('chats:archive', handle((chatID, archived) => client.archiveChat(chatID, archived !== false)));
  ipcMain.handle('chats:markRead', handle((chatID, messageID) => client.markChatRead(chatID, messageID)));
  ipcMain.handle('chats:markUnread', handle((chatID) => client.markChatUnread(chatID)));
  ipcMain.handle('chats:create', handle((payload) => client.createChat(payload)));

  // ---- messages ---------------------------------------------------------

  ipcMain.handle('messages:list', handle((chatID, params) => client.listMessages(chatID, params || {})));
  ipcMain.handle('messages:send', handle((chatID, payload) => client.sendMessage(chatID, payload || {})));
  ipcMain.handle('messages:edit', handle((chatID, messageID, text) => client.editMessage(chatID, messageID, text)));
  ipcMain.handle('messages:delete', handle((chatID, messageID) => client.deleteMessage(chatID, messageID)));
  ipcMain.handle('messages:react', handle((chatID, messageID, key) => client.addReaction(chatID, messageID, key)));
  ipcMain.handle('messages:unreact', handle((chatID, messageID, key) => client.removeReaction(chatID, messageID, key)));
  ipcMain.handle('messages:search', handle((params) => client.searchMessages(params || {})));

  // ---- assets -----------------------------------------------------------

  ipcMain.handle('assets:upload', handle(async (filePath) => client.uploadAsset(filePath)));

  // A pasted screenshot exists only as clipboard bytes, so there is no path to
  // read. The renderer hands over a Uint8Array (structured clone gives one for
  // an ArrayBuffer) and we put it straight into the same multipart upload.
  ipcMain.handle('assets:uploadBytes', handle(async (payload) => {
    const { data, fileName, mimeType } = payload || {};
    if (!data) throw new Error('no image data to upload');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!bytes.byteLength) throw new Error('the pasted image was empty');
    return client.uploadAssetBytes(bytes, fileName || 'pasted-image.png', mimeType);
  }));

  ipcMain.handle('assets:download', handle(async (input) => client.downloadAsset(input || {})));

  // Saving is the only way out of the app for anything that is not an image or
  // a video, so it has to accept whatever Beeper sends and must never let the
  // message choose where the file lands - hence safeFileName on the suggestion.
  ipcMain.handle('assets:saveAs', handle(async (attachment) => {
    if (!attachment) throw new Error('There was nothing to save.');

    const suggested = mediaPath.safeFileName(attachment.fileName, 'attachment');
    const win = getWindow();
    const choice = await dialog.showSaveDialog(win, {
      title: 'Save attachment',
      defaultPath: path.join(app.getPath('downloads'), suggested),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });

    // A cancelled dialog is not a failure, and must not read as one in the UI.
    if (choice.canceled || !choice.filePath) return ok({ saved: false, cancelled: true });

    const source = await assetSource.locateAttachment(attachment, (input) => client.downloadAsset(input));
    if (source.localPath) {
      await fs.promises.copyFile(source.localPath, choice.filePath);
    } else {
      // The rare remote case. Buffered rather than streamed, which is the wrong
      // shape for a very large file but is not the common path.
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`Beeper's bridge answered ${response.status}.`);
      await fs.promises.writeFile(choice.filePath, Buffer.from(await response.arrayBuffer()));
    }

    return ok({ saved: true, path: choice.filePath, name: path.basename(choice.filePath) });
  }));

  ipcMain.handle('assets:resolve', handle(async (attachment) => {
    // Turn a possibly-remote attachment into something the renderer can load.
    if (!attachment) return null;

    // Our own copy first, if the history store has one. It is the only copy
    // that is guaranteed to still be there after Beeper evicts its cache.
    const mine = historyMedia.urlFor(attachment.localMediaHash || '');
    if (mine) return { ...attachment, url: mine, ownedByUs: true };

    const local = mediaPath.localMediaUrl(attachment.srcURL || attachment.imgURL);
    if (local) return { ...attachment, url: local };

    try {
      const res = await client.downloadAsset({
        url: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      });
      if (res?.srcURL) return { ...attachment, url: mediaPath.toRendererUrl(res.srcURL) };
    } catch (err) {
      return { ...attachment, url: null, error: err.message };
    }
    return { ...attachment, url: null };
  }));

  // Hands off to the overlay viewer window in main.js. The URL is already a
  // renderer-safe one (beeper-file:, data: or https:) by the time it gets here.
  ipcMain.handle('images:openViewer', handle(async ({ srcURL, alt } = {}) => {
    if (!srcURL) return false;
    if (!/^(beeper-file|data|https):/i.test(srcURL)) return false;
    return openImageViewer(srcURL, alt || '');
  }));

  // Puts a real image on the system clipboard, so it can be pasted straight
  // back into this app or into anything else. Only local files and data URLs
  // are readable; a remote URL is refused rather than fetched.
  ipcMain.handle('images:copy', handle(async ({ srcURL } = {}) => {
    if (!mediaPath.isCopyableUrl(srcURL)) {
      throw new Error('That image cannot be copied.');
    }

    const bytes = /^data:/i.test(srcURL)
      ? mediaPath.dataUrlBuffer(srcURL)
      : await fs.promises.readFile(mediaPath.localPathFrom(srcURL) || '');

    const image = nativeImage.createFromBuffer(bytes || Buffer.alloc(0));
    if (image.isEmpty()) throw new Error('That file is not an image the clipboard can hold.');

    clipboard.writeImage(image);
    const size = image.getSize();
    return { copied: true, width: size.width, height: size.height };
  }));

  ipcMain.handle('dialog:pickAttachment', handle(async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Attach a file',
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return ok([]);
    return ok(res.filePaths.map((p) => ({ path: p, name: path.basename(p) })));
  }));

  // ---- local history ----------------------------------------------------
  //
  // Beeper serves a page of at most 20 messages and forgets nothing, but it
  // only replays what it still holds, and it replays it on every visit. This
  // is the local record that stops that mattering: opened instantly, survives a
  // restart, and readable while Beeper is unreachable.

  historyStore = openMessageStore(userData, {
    onRecover: ({ reason }) => {
      // Say so plainly. A store that silently starts empty is indistinguishable
      // from having lost the history, and this one really was lost.
      console.warn('[history] the local database was unreadable and has been reset:', reason);
      broadcast('history:progress', { state: 'recovered', error: reason });
    },
  });
  const historyMedia = openMediaStore(userData);
  const historySync = createHistorySync({
    store: historyStore,
    media: historyMedia,
    fetchPage: (chatID, params) => client.listMessages(chatID, params),
    // Copy each attachment into our own store before the page is written, so
    // the path to our copy travels with the message. Without this the whole
    // store is only as permanent as Beeper's cache, which is not a promise.
    adoptMedia: async (messages) => {
      for (const message of messages) {
        for (const attachment of message?.attachments || []) {
          if (!attachment || attachment.localMediaHash) continue;
          try {
            const source = await assetSource.locateAttachment(attachment, (input) => client.downloadAsset(input));
            if (!source.localPath) continue;
            const adopted = historyMedia.adopt(source.localPath, attachment);
            if (adopted) {
              attachment.localMediaPath = adopted.relativePath;
              attachment.localMediaHash = adopted.hash;
            }
          } catch {
            // A picture that will not copy is a picture that may stop loading.
            // It is not a reason to drop the message it belongs to.
          }
        }
      }
    },
    onProgress: (payload) => broadcast('history:progress', payload),
  });

  /**
   * Copy attachments for messages that were stored before media adoption
   * existed.
   *
   * Those chats are marked complete and will never be re-walked, so without
   * this their pictures stay exactly as temporary as Beeper's cache while
   * everything around them is local. No network is needed: the payload already
   * holds the source path, so this is a disk copy rather than another fetch.
   */
  async function adoptStoredMedia() {
    let cursor = 0;
    let adopted = 0;
    for (let batch = 0; batch < 500; batch++) {
      const rows = historyStore.afterRowid(cursor, 200);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].rowid;

      for (const row of rows) {
        const message = row.message;
        const attachments = message?.attachments || [];
        if (!attachments.length) continue;
        let changed = false;
        for (const attachment of attachments) {
          if (!attachment || attachment.localMediaHash) continue;
          try {
            const source = await assetSource.locateAttachment(attachment, (input) => client.downloadAsset(input));
            if (!source.localPath) continue;
            const got = historyMedia.adopt(source.localPath, attachment);
            if (got) {
              attachment.localMediaPath = got.relativePath;
              attachment.localMediaHash = got.hash;
              changed = true;
              adopted++;
            }
          } catch {
            /* the file is gone; the message stays */
          }
        }
        if (changed) historyStore.upsertMessages(row.chatID, [message]);
      }
      broadcast('history:progress', { state: 'adopting', adopted });
    }
    if (adopted) console.log(`[history] copied ${adopted} stored attachments into the local media folder`);
    return adopted;
  }

  ipcMain.handle('history:open', handle(async (chatID) => {
    if (!chatID) return ok({ messages: [], hasMore: false, complete: false });
    const status = historyStore.chatStatus(chatID);
    // hasMore comes from the store, not from `complete`. A finished backfill
    // says Beeper has nothing older; it says nothing about the thousands of
    // messages already sitting in this database.
    const { messages, hasMore } = historyStore.pageWithMore(chatID, { limit: OPEN_PAGE });
    // Ask the queue to bring this chat up to date in the background. A chat
    // already complete costs one page; an unfinished one resumes where it
    // stopped.
    historySync.request(chatID);
    const sync = historySync.status();
    return ok({
      messages,
      hasMore,
      complete: status.complete,
      syncing: sync.runningChats.includes(chatID),
      queued: sync.queued.includes(chatID),
    });
  }));

  ipcMain.handle('history:page', handle(async (chatID, { before, limit } = {}) => {
    if (!chatID) return ok({ messages: [], hasMore: false, complete: false });
    const { messages, hasMore } = historyStore.pageWithMore(chatID, {
      before,
      limit: limit || 50,
    });
    const status = historyStore.chatStatus(chatID);
    return ok({
      messages,
      // Whatever is behind this page in the store, independent of whether the
      // backfill has finished. The thread keeps its scroll-up affordance up
      // for as long as this stays true, and drops it only at the real start.
      hasMore,
      complete: status.complete,
    });
  }));

  // Live messages are written straight through, so the store stays current
  // without waiting for the next backfill.
  ipcMain.handle('history:upsert', handle(async (chatID, message) => {
    if (!chatID || !message?.id) return ok({ written: 0 });
    return ok({ written: historyStore.upsertMessages(chatID, [message]) });
  }));

  ipcMain.handle('history:search', handle(async (query, opts) =>
    ok(historyStore.search(query, opts || {}))));

  ipcMain.handle('history:status', handle(async () => {
    const stats = historyStore.stats();
    const sync = historySync.status();
    return ok({
      ...stats,
      running: sync.running,
      queued: sync.queued.length,
      mediaBytes: historyMedia.totalBytes(),
      mediaCount: historyMedia.count(),
    });
  }));

  // What every background job is doing, for the progress panel.
  //
  // Asked for once at startup and then driven by the history:progress events,
  // so a reload lands on the real state rather than an empty panel.
  ipcMain.handle('history:jobs', handle(async () => {
    const sync = historySync.status();
    return ok({
      jobs: sync.jobs,
      running: sync.running,
      queued: sync.queued.length,
      ...historyStore.stats(),
    });
  }));

  // The refresh button on one chat.
  //
  // Returns as soon as the chat is queued, never when it is finished. The walk
  // is the long part and belongs in the background; the panel is how the user
  // watches it. A caller that waited for the result would block the renderer on
  // a job that is deliberately built to outlive the click.
  ipcMain.handle('history:refresh', handle(async (chatID) => {
    if (!chatID) return ok({ queued: false });
    return ok({ queued: historySync.refresh(chatID) });
  }));

  ipcMain.handle('shell:openExternal', handle(async (url) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('Refusing to open non-http URL.');
    await shell.openExternal(String(url));
    return ok(true);
  }));

  ipcMain.handle('shell:showItemInFolder', handle((target) => {
    shell.showItemInFolder(target);
    return ok(true);
  }));

  // ---- live events ------------------------------------------------------

  ipcMain.handle('events:subscribe', handle((chatIDs) => {
    events.setSubscriptions(chatIDs || []);
    return ok({ subscribed: chatIDs?.length || 0 });
  }));

  ipcMain.handle('events:status', handle(async () => ok({ status: events.status })));

  // Diagnostic: what the live socket has actually seen.
  ipcMain.handle('events:debug', handle(async () => ok(events.debugState())));

  // ---- settings and diagnostics -----------------------------------------

  ipcMain.handle('settings:get', handle(() => settings.read()));
  ipcMain.handle('settings:set', handle((patch) => {
    const saved = settings.write(patch || {});
    // Text size is window state, not document state, so only the main process
    // can apply it. Re-applied on every write because the value is clamped and
    // idempotent, which also means it takes effect no matter which surface
    // saved it - the settings dialog, or the sidebar-width autosave.
    if (typeof applyTextScale === 'function') applyTextScale(saved.textScale);
    return saved;
  }));

  ipcMain.handle('mcp:tools', handle(async () => {
    const res = await mcp.connect();
    if (!res.ok) return fail({ message: res.error, code: 'mcp_unavailable' });
    return ok(res.tools);
  }));

  return {
    client,
    events,
    mcp,
    settings,
    tokenStore,
    discover,
    startLive,
    stopLive,
    endpoints,
    historyStore,
    historySync,
    // Closed on quit so WAL is checkpointed rather than left to be replayed on
    // the next launch.
    closeHistory: () => {
      historySync.stop();
      historyStore.close();
    },
  };
}

module.exports = { register };
