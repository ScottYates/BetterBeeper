/**
 * Working out what a refresh of the chat list found.
 *
 * Pure, so tools/refresh-chats-check.mjs can exercise it directly. The diff
 * is the part worth testing: it decides what the user is told, and a diff
 * that is wrong in the wrong direction either misses a chat that arrived or
 * announces one that did not.
 */

/**
 * The chats in a refresh response that were not in the list already.
 *
 * Ids are the comparison, not titles and not timestamps. A chat that was
 * renamed, or that received a message, is the same chat and is not new, and
 * comparing anything else would announce it as one. The question being
 * answered is "has a new chat come in", and a chat only becomes a different
 * chat by having a different id.
 *
 * `knownIDs` is the set of ids that were on screen before the call. A chat
 * that somehow appears twice in the response is counted once.
 */
export function newChats(knownIDs, items) {
  const known = knownIDs instanceof Set ? knownIDs : new Set(knownIDs || []);
  const seen = new Set();
  const fresh = [];
  for (const chat of items || []) {
    const id = chat?.id;
    if (!id || known.has(id) || seen.has(id)) continue;
    seen.add(id);
    fresh.push(chat);
  }
  return fresh;
}

/**
 * The line to show after a refresh.
 *
 * Two cases read differently and must not be confused. When the list was
 * already on screen, "no new chats" is a real answer and is worth saying out
 * loud: the user pressed the button to find out, and silence would be
 * indistinguishable from a button that does nothing. When nothing was loaded
 * before the call, every chat in the response is new to the app but new to
 * nobody, so the honest line is that the list was loaded, and the count is
 * the size of the list rather than the number of arrivals.
 *
 * Returns { message, kind }, where kind is a toast kind.
 */
export function refreshOutcome(fresh, hadChats, total) {
  const count = fresh?.length || 0;
  if (!hadChats) {
    return {
      message: total ? `Loaded ${total} chat${total === 1 ? '' : 's'}` : 'No chats found',
      kind: 'info',
    };
  }
  if (count === 1) return { message: '1 new chat', kind: 'success' };
  if (count > 1) return { message: `${count} new chats`, kind: 'success' };
  return { message: 'No new chats', kind: 'info' };
}
