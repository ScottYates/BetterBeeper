'use strict';

/**
 * Note the names Beeper gives its chats.
 *
 * The local history store is the only part of this app that has to outlive
 * Beeper, and a row of messages with no name attached is close to useless when
 * you are the one looking for it. Beeper is also the only thing that knows
 * those names, and it is perfectly willing to be unreachable.
 *
 * This lives apart from ipc.js because ipc.js cannot be required without
 * Electron, and a rule nothing can run a check against is a rule that quietly
 * stops being true.
 */

/**
 * @param getStore  Called on each page; returns the message store, or null
 *                  before it has been opened.
 * @returns {function} A recorder taking a chat page, or a single chat.
 */
function makeTitleRecorder(getStore) {
  return function rememberChatTitles(payload) {
    const store = typeof getStore === 'function' ? getStore() : getStore;
    if (!store) return 0;

    // Beeper answers a list with { items } and a get with the chat itself.
    let chats;
    if (Array.isArray(payload)) {
      chats = payload;
    } else if (Array.isArray(payload?.items)) {
      chats = payload.items;
    } else if (payload && typeof payload === 'object') {
      chats = [payload];
    } else {
      chats = [];
    }

    let written = 0;
    for (const chat of chats) {
      const title = String(chat?.title ?? '').trim();
      if (!chat?.id || !title) continue;
      store.setTitle(chat.id, title);
      written++;
    }
    return written;
  };
}

module.exports = { makeTitleRecorder };