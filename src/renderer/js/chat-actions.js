/** Chat list actions that both the sidebar rows and the thread header trigger. */

import { api, call, callOk, FAILED } from './api.js';
import { state, setArchivedOverride, archivedList } from './state.js';

/**
 * How hard to try before deciding Beeper ignored the request.
 *
 * The confirming GET is not ordered behind the PATCH: Beeper can still report
 * the previous value for a moment after accepting a write. Without the retries
 * a perfectly ordinary archive reads as ignored and picks up a local override
 * it does not need.
 */
const CONFIRM_ATTEMPTS = 5;
const CONFIRM_DELAY_MS = 400;

/**
 * Ask Beeper whether the archive actually landed.
 *
 * Returns `agreed` when a read confirmed the new value, `disagreed` when it
 * kept reading the old one, and `unknown` when it could not be read at all -
 * which is not evidence either way and must not be recorded as one.
 */
async function confirmArchive(chatID, archived) {
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
    const fresh = await call(() => api.chats.get(chatID), {
      context: archived ? 'archive check' : 'unarchive check',
      fallback: null,
    });
    if (!fresh) return { fresh: null, verdict: 'unknown' };
    if (Boolean(fresh.isArchived) === archived) return { fresh, verdict: 'agreed' };
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_DELAY_MS));
  }
  return { fresh: null, verdict: 'disagreed' };
}

/**
 * Archive or restore a chat, and make sure the change actually sticks.
 *
 * Beeper's API usually applies `isArchived`, but it ignores it for its own
 * built-in "Note to self" chat: the PATCH answers ok and a fresh GET a second
 * later still reports isArchived false. The optimistic update is then undone by
 * the next chat event and the row never leaves the inbox, which reads as "the
 * archive button does nothing".
 *
 * So the change is confirmed rather than assumed. When Beeper disagrees, the
 * user's choice is recorded locally and the list filters on the resolved value.
 * The request is still sent either way, so the two agree if Beeper ever fixes
 * this.
 *
 * Returns `{ ok, localOnly }`. `localOnly` means Beeper did not apply the
 * change and the caller should say so.
 */
export async function setArchived(chat, archived) {
  if (!chat?.id) return { ok: false, localOnly: false };

  const result = await callOk(() => api.chats.archive(chat.id, archived), {
    context: archived ? 'archive' : 'unarchive',
  });
  if (result === FAILED) return { ok: false, localOnly: false };

  const { fresh, verdict } = await confirmArchive(chat.id, archived);

  if (!archived) {
    // Restoring is always the user's explicit choice, so it always wins.
    setArchivedOverride(chat.id, false);
  } else if (verdict === 'disagreed') {
    setArchivedOverride(chat.id, true);
  } else if (verdict === 'agreed') {
    // Beeper is doing it, so any workaround we had recorded is now redundant
    // and would only make this chat a special case forever after.
    setArchivedOverride(chat.id, false);
  }

  // The local view follows the user's choice either way. Without this the next
  // chat event would merge Beeper's stale value back in and undo the change.
  state.chats.set(chat.id, {
    ...state.chats.get(chat.id),
    ...(fresh || {}),
    isArchived: archived,
  });

  await call(() => api.settings.set({ archivedChats: archivedList() }), {
    context: 'save archive state',
    fallback: null,
  });

  return { ok: true, localOnly: archived && verdict === 'disagreed' };
}
