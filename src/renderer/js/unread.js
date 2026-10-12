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