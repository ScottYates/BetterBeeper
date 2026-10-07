'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire renderer-visible API. Every call returns the main process's
 * {ok, data|error} envelope so the UI never has to deal with rejections
 * crossing the bridge.
 */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const listeners = new Map();
function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  listeners.set(handler, [channel, wrapped]);
  return () => {
    const entry = listeners.get(handler);
    if (entry) {
      ipcRenderer.removeListener(entry[0], entry[1]);
      listeners.delete(handler);
    }
  };
}

contextBridge.exposeInMainWorld('beeper', {
  app: {
    bootstrap: () => invoke('app:bootstrap'),
    refreshDiscovery: () => invoke('app:refreshDiscovery'),
  },
  updater: {
    check: () => invoke('updater:check'),
    download: () => invoke('updater:download'),
    quit: () => invoke('updater:quit'),
  },
  auth: {
    status: () => invoke('auth:status'),
    connect: () => invoke('auth:connect'),
    manual: (token) => invoke('auth:manual', token),
    disconnect: () => invoke('auth:disconnect'),
  },
  accounts: {
    list: () => invoke('accounts:list'),
  },
  contacts: {
    list: (accountID, params) => invoke('contacts:list', accountID, params),
  },
  chats: {
    list: (params) => invoke('chats:list', params),
    search: (params) => invoke('chats:search', params),
    get: (chatID, params) => invoke('chats:get', chatID, params),
    patch: (chatID, patch) => invoke('chats:patch', chatID, patch),
    archive: (chatID, archived = true) => invoke('chats:archive', chatID, archived),
    markRead: (chatID, messageID) => invoke('chats:markRead', chatID, messageID),
    markUnread: (chatID) => invoke('chats:markUnread', chatID),
    create: (payload) => invoke('chats:create', payload),
  },
  messages: {
    list: (chatID, params) => invoke('messages:list', chatID, params),
    send: (chatID, payload) => invoke('messages:send', chatID, payload),
    edit: (chatID, messageID, text) => invoke('messages:edit', chatID, messageID, text),
    remove: (chatID, messageID) => invoke('messages:delete', chatID, messageID),
    react: (chatID, messageID, key) => invoke('messages:react', chatID, messageID, key),
    unreact: (chatID, messageID, key) => invoke('messages:unreact', chatID, messageID, key),
    search: (params) => invoke('messages:search', params),
  },
  assets: {
    upload: (filePath) => invoke('assets:upload', filePath),
    uploadBytes: (payload) => invoke('assets:uploadBytes', payload),
    download: (input) => invoke('assets:download', input),
    resolve: (attachment) => invoke('assets:resolve', attachment),
    saveAs: (attachment) => invoke('assets:saveAs', attachment),
    pick: () => invoke('dialog:pickAttachment'),
  },
  images: {
    openViewer: (srcURL, alt) => invoke('images:openViewer', { srcURL, alt }),
    copy: (srcURL) => invoke('images:copy', { srcURL }),
  },
  history: {
    open: (chatID) => invoke('history:open', chatID),
    page: (chatID, opts) => invoke('history:page', chatID, opts),
    upsert: (chatID, message) => invoke('history:upsert', chatID, message),
    search: (query, opts) => invoke('history:search', query, opts),
    status: () => invoke('history:status'),
    // Queues the work and returns. It never waits for the walk to finish.
    refresh: (chatID) => invoke('history:refresh', chatID),
    jobs: () => invoke('history:jobs'),
  },
  events: {
    subscribe: (chatIDs) => invoke('events:subscribe', chatIDs),
    status: () => invoke('events:status'),
    debug: () => invoke('events:debug'),
  },
  mcp: {
    tools: () => invoke('mcp:tools'),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  shell: {
    openExternal: (url) => invoke('shell:openExternal', url),
    showItemInFolder: (target) => invoke('shell:showItemInFolder', target),
  },

  // ---- push channels -----------------------------------------------------
  on: {
    eventsStatus: (fn) => on('events:status', fn),
    eventsReady: (fn) => on('events:ready', fn),
    eventsFrame: (fn) => on('events:frame', fn),
    mcpStatus: (fn) => on('mcp:status', fn),
    updaterProgress: (fn) => on('updater:progress', fn),
    menuNewChat: (fn) => on('menu:newChat', fn),
    menuFocusSearch: (fn) => on('menu:focusSearch', fn),
    historyProgress: (fn) => on('history:progress', fn),
  },
});
