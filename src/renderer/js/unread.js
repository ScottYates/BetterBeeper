/**
 * The unread total the app icon shows.
 *
 * Its own file with no imports on purpose. The rule for what counts as unread
 * is the one thing that must not exist twice: a renderer that counts archived
 * chats and a main process that does not is how a badge ends up never reaching
 * zero, which is the exact failure the badge exists to avoid.
 *
 * Archived chats are excluded - they are filed away, not waiting. Muted chats
 * are not: muting is about interrupting someone, not about hiding that a
 * message arrived.
 */

/**
 * @param chats    the rows as the sidebar holds them
 * @param isArchived  predicate, because "archived" differs by process: the
 *   renderer also knows about the user's local un-archive overrides
 */
export function totalUnread(chats, isArchived = (chat) => Boolean(chat && chat.isArchived)) {
  let total = 0;
  for (const chat of chats || []) {
    if (!chat || isArchived(chat)) continue;
    if (chat.mergedIntoChatID) continue; // counted on the chat it merged into
    const n = Number(chat.unreadCount);
    if (Number.isFinite(n) && n > 0) total += Math.floor(n);
  }
  return total;
}

/**
 * Is this chat unread?
 *
 * The count is the whole test, because the count is the only unread signal
 * this app has. The row class in the sidebar, the badge beside it and the
 * number on the app icon are all drawn from this one predicate on purpose:
 * styling a row from a second, separately-written condition is how you end
 * up with a tinted bold row next to a badge that says the chat is read, or
 * the reverse. One source, several consequences.
 *
 * The count is read through Number() because it arrives from JSON and can
 * arrive as anything, and `Number(x) > 0` also does the right thing for a
 * chat whose count is missing, which is zero.
 *
 * It used to be the newest message's `isUnread` flag, which was never right:
 * no message this app has ever seen carries that field. Measured against the
 * live account, Beeper's message objects are id, chatID, accountID,
 * senderID, senderName, timestamp, sortKey, type, text, isSender, isDeleted
 * and mentions, and the local store keeps exactly those. A gate on a field
 * that does not exist never passes, which is why opening a chat never marked
 * it read.
 */
export function chatIsUnread(chat) {
  return Number(chat?.unreadCount || 0) > 0;
}