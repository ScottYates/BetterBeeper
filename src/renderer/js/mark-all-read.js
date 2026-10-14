/**
 * Choosing and pacing a mark-all-read.
 *
 * Pure, so tools/mark-all-read-check.mjs can exercise it directly. The parts
 * worth testing are the two that are easy to get subtly wrong and impossible
 * to notice: which chats get picked at all, and whether the batching actually
 * visits every one of them.
 */

/**
 * The chats a mark-all-read acts on.
 *
 * Unread count is the whole test, because that is the only thing the action
 * changes. Merged-away chats are excluded because they are not rows anyone can
 * see, and marking something read that the user cannot click would be marking
 * it on faith.
 *
 * The count is read through Number() because it arrives from JSON and can
 * arrive as anything; `Number(x) > 0` also does the right thing for a chat
 * whose count is missing, which is zero.
 */
export function markAllTargets(chats) {
  return (chats || []).filter(
    (chat) => !chat?.mergedIntoChatID && Number(chat?.unreadCount || 0) > 0,
  );
}

/**
 * Run `work` over every item, `size` at a time, in order.
 *
 * Returns each item's result in the original order. Batching is only worth
 * having if it still covers everything, which is exactly the part worth
 * asserting: a loop written as `i += size` over a shrinking array skips the
 * tail, and the symptom is a few chats quietly still unread.
 */
export async function inBatches(items, size, work) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const settled = await Promise.all(items.slice(i, i + size).map(work));
    out.push(...settled);
  }
  return out;
}