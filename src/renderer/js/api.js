/** Unwraps the main process's {ok, data|error} envelope and surfaces errors. */

const listeners = new Set();

export function onApiError(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function report(context, err) {
  const message = err?.message || 'Something went wrong.';
  for (const fn of listeners) fn({ context, message, code: err?.code });
  if (!listeners.size) console.error(`[${context}]`, err);
  return null;
}

/**
 * Wraps an IPC call. Returns `fallback` when the call fails so views can
 * degrade gracefully instead of throwing.
 */
export async function call(fn, { context = 'request', fallback = null, throwOnError = false } = {}) {
  try {
    const res = await fn();
    if (!res) return fallback;
    if (res.ok) return res.data;
    const err = new Error(res.error?.message || 'Request failed');
    err.code = res.error?.code;
    err.status = res.error?.status;
    if (throwOnError) throw err;
    return report(context, err) ?? fallback;
  } catch (err) {
    if (throwOnError) throw err;
    return report(context, err) ?? fallback;
  }
}

/**
 * Beeper answers some endpoints - archiving a chat, for one - with 204 and no
 * body, so a *successful* call can legitimately resolve to null. Callers that
 * must tell success from failure use this sentinel and compare identity, rather
 * than testing the result for truthiness.
 */
export const FAILED = Symbol('call failed');

export async function callOk(fn, opts = {}) {
  return call(fn, { ...opts, fallback: FAILED });
}

export const api = {
  bootstrap: () => window.beeper.app.bootstrap(),
  refreshDiscovery: () => window.beeper.app.refreshDiscovery(),

  updateCheck: () => window.beeper.updater.check(),
  updateDownload: () => window.beeper.updater.download(),
  updateQuit: () => window.beeper.updater.quit(),

  authStatus: () => window.beeper.auth.status(),
  connect: () => window.beeper.auth.connect(),
  manualConnect: (token) => window.beeper.auth.manual(token),
  disconnect: () => window.beeper.auth.disconnect(),

  accounts: () => window.beeper.accounts.list(),
  contacts: (accountID, params) => window.beeper.contacts.list(accountID, params),

  chats: {
    list: (params) => window.beeper.chats.list(params),
    search: (params) => window.beeper.chats.search(params),
    get: (chatID, params) => window.beeper.chats.get(chatID, params),
    patch: (chatID, patch) => window.beeper.chats.patch(chatID, patch),
    archive: (chatID, archived = true) => window.beeper.chats.archive(chatID, archived),
    markRead: (chatID, messageID) => window.beeper.chats.markRead(chatID, messageID),
    markUnread: (chatID) => window.beeper.chats.markUnread(chatID),
    create: (payload) => window.beeper.chats.create(payload),
  },

  messages: {
    list: (chatID, params) => window.beeper.messages.list(chatID, params),
    send: (chatID, payload) => window.beeper.messages.send(chatID, payload),
    edit: (chatID, messageID, text) => window.beeper.messages.edit(chatID, messageID, text),
    remove: (chatID, messageID) => window.beeper.messages.remove(chatID, messageID),
    react: (chatID, messageID, key) => window.beeper.messages.react(chatID, messageID, key),
    unreact: (chatID, messageID, key) => window.beeper.messages.unreact(chatID, messageID, key),
    search: (params) => window.beeper.messages.search(params),
  },

  assets: {
    upload: (path) => window.beeper.assets.upload(path),
    uploadBytes: (payload) => window.beeper.assets.uploadBytes(payload),
    download: (input) => window.beeper.assets.download(input),
    resolve: (attachment) => window.beeper.assets.resolve(attachment),
    saveAs: (attachment) => window.beeper.assets.saveAs(attachment),
    pick: () => window.beeper.assets.pick(),
  },

  events: {
    subscribe: (chatIDs) => window.beeper.events.subscribe(chatIDs),
  },

  history: {
    open: (chatID) => window.beeper.history.open(chatID),
    page: (chatID, opts) => window.beeper.history.page(chatID, opts),
    upsert: (chatID, message) => window.beeper.history.upsert(chatID, message),
    search: (query, opts) => window.beeper.history.search(query, opts),
    status: () => window.beeper.history.status(),
    refresh: (chatID) => window.beeper.history.refresh(chatID),
    jobs: () => window.beeper.history.jobs(),
  },

  mcp: {
    tools: () => window.beeper.mcp.tools(),
  },

  settings: {
    get: () => window.beeper.settings.get(),
    set: (patch) => window.beeper.settings.set(patch),
  },

  shell: {
    openExternal: (url) => window.beeper.shell.openExternal(url),
    showItemInFolder: (p) => window.beeper.shell.showItemInFolder(p),
  },
};
