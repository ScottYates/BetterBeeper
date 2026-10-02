'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');

const { DEFAULT_BASE_URL, ENDPOINTS } = require('./config');
const { TokenStore } = require('./token-store');
const { SettingsStore } = require('./settings');
const { BeeperClient, BeeperError } = require('./beeper-client');
const { BeeperEvents } = require('./beeper-ws');
const { McpClient } = require('./mcp-client');
const auth = require('./auth');
const { runAssistantTurn } = require('./assistant');

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

function register({ getWindow, openImageViewer }) {
  const userData = app.getPath('userData');
  const tokenStore = new TokenStore(userData);
  const settings = new SettingsStore(userData);

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
  ipcMain.handle('chats:list', handle((params) => client.listChats(params || {})));
  ipcMain.handle('chats:search', handle((params) => client.searchChats(params || {})));
  ipcMain.handle('chats:get', handle((chatID, params) => client.getChat(chatID, params || {})));
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

  ipcMain.handle('assets:download', handle(async (input) => client.downloadAsset(input || {})));

  ipcMain.handle('assets:resolve', handle(async (attachment) => {
    // Turn a possibly-remote attachment into something the renderer can load.
    if (!attachment) return null;

    const local = localMediaUrl(attachment.srcURL || attachment.imgURL);
    if (local) return { ...attachment, url: local };

    try {
      const res = await client.downloadAsset({
        url: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      });
      if (res?.srcURL) return { ...attachment, url: toRendererUrl(res.srcURL) };
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

  ipcMain.handle('dialog:pickAttachment', handle(async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Attach a file',
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return ok([]);
    return ok(res.filePaths.map((p) => ({ path: p, name: path.basename(p) })));
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

  // ---- assistant --------------------------------------------------------

  ipcMain.handle('settings:get', handle(() => settings.read()));
  ipcMain.handle('settings:set', handle((patch) => settings.write(patch || {})));

  ipcMain.handle('mcp:tools', handle(async () => {
    const res = await mcp.connect();
    if (!res.ok) return fail({ message: res.error, code: 'mcp_unavailable' });
    return ok(res.tools);
  }));

  ipcMain.handle('assistant:ask', handle(async (history) => {
    const config = settings.read();
    if (!config.model) {
      throw Object.assign(new Error('No AI model configured. Open Settings to add one.'), {
        code: 'no_model',
      });
    }

    const res = await mcp.connect();
    if (!res.ok) throw Object.assign(new Error(res.error), { code: 'mcp_unavailable' });

    broadcast('assistant:event', { type: 'turn_start' });

    const onEvent = (evt) => broadcast('assistant:event', evt);

    try {
      const result = await runAssistantTurn({
        config,
        history,
        tools: mcp.tools,
        callTool: (name, args) => mcp.callTool(name, args),
        onEvent,
      });
      return ok({ text: result.text });
    } catch (err) {
      onEvent({ type: 'error', message: err.message });
      throw err;
    }
  }));

  ipcMain.handle('assistant:clear', handle(() => ok(true)));

  // Invoke a single Beeper MCP tool directly. Used by the assistant's tool
  // loop, and exposed so a tool can be run on its own from diagnostics.
  ipcMain.handle('assistant:callTool', handle(async (name, args) => {
    const res = await mcp.connect();
    if (!res.ok) throw Object.assign(new Error(res.error), { code: 'mcp_unavailable' });
    return ok(await mcp.callTool(name, args || {}));
  }));

  return { client, events, mcp, settings, tokenStore, discover, startLive, stopLive, endpoints };
}

/**
 * Beeper is inconsistent about local media locations: message attachments come
 * back as `file:///C:/...` URLs, while chat avatars are bare filesystem paths
 * such as `C:\Users\...`. Both mean "a file on this machine".
 *
 * They are rewritten to `beeper-file://local/<path>`. The fixed `local` host
 * keeps the drive letter inside the path segment, so a Windows drive can never
 * be mistaken for a URL hostname.
 */
function localMediaUrl(raw) {
  if (!raw) return null;
  const value = String(raw);

  if (/^(https?|data):/i.test(value)) return value;

  let filePath = null;
  if (/^file:\/\//i.test(value)) {
    filePath = decodeURIComponentSafe(value.replace(/^file:\/\/\/?/i, ''));
  } else if (/^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')) {
    filePath = value;
  } else if (value.startsWith('/')) {
    filePath = value;
  }
  if (!filePath) return null;

  return `beeper-file://local/${filePath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

/** Passes anything already usable (http/data) through untouched. */
function toRendererUrl(raw) {
  return localMediaUrl(raw) ?? String(raw);
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

module.exports = { register };
