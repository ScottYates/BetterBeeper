/**
 * The Inbox's chats: which ones are in it, and in what order.
 *
 * Two places draw a list of conversations - the sidebar and the share picker -
 * and for a long time they had two answers. The sidebar offered the Inbox and
 * the picker offered whatever it had loaded, so "the same list" was two lists
 * that happened to look alike, and a chat could be in one of them and not the
 * other.
 *
 * The rule is here, once, so the two cannot drift:
 *
 *   - a chat is in the Inbox when it is not archived and not merged into
 *     another one;
 *   - the Inbox's order is Beeper's own - pinned first, then most recent
 *     activity.
 *
 * DOM-free on purpose: the sidebar draws it, the picker draws it, and it can
 * be checked without a window.
 */

import { isArchived, isPinned } from './state.js';

/**
 * When a chat was last active, as a number.
 *
 * A chat with no usable timestamp sorts as the oldest rather than as the
 * newest, because "unknown" is not "recent".
 */
export function lastActivityOf(chat) {
  const t = Date.parse(chat?.lastActivity || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Beeper's order: pinned first, then most recent activity.
 *
 * The note-to-self chats count as pinned, which is what puts them at the top
 * by default and what lets an explicit unpin send them back down with the
 * ordinary chats. `isPinned` also covers the pins the user set in this app,
 * not just the ones Beeper reports.
 */
export function inboxOrder(a, b) {
  if (isPinned(b) !== isPinned(a)) return isPinned(b) ? 1 : -1;
  return lastActivityOf(b) - lastActivityOf(a);
}

/**
 * The chats in the Inbox, in the Inbox's order.
 *
 * `excludeChatID` is the chat a share came from: sending it back where it
 * already is is a no-op that still posts a message, so it is left out of the
 * offer.
 */
export function inboxChats(chats, { excludeChatID = '' } = {}) {
  const set = [];
  for (const chat of chats || []) {
    if (!chat || chat.id === excludeChatID) continue;
    if (chat.mergedIntoChatID) continue;
    if (isArchived(chat)) continue;
    set.push(chat);
  }
  // A stable sort, so two chats with the same timestamp keep the order they
  // arrived in rather than swapping about between two renders.
  set.sort(inboxOrder);
  return set;
}
