/**
 * The rules that decide which messages can be edited.
 *
 * They live in their own module, and they live there on purpose: the module
 * the composer edit used to live in imports the UI for its toasts, and the UI
 * reaches for `document` the moment it is loaded. A rule that can only be
 * checked with a window open is a rule nobody checks.
 *
 * So this module imports the utility helpers and nothing else, and it can be
 * loaded by plain Node with no Electron and no window at all.
 *
 * Which messages can be edited is a property of the chat as much as of the
 * message: Beeper advertises editing per chat, and the window it allows is
 * fifteen minutes on Messenger and twenty-four hours on Signal. The rules
 * below read that advertisement rather than assuming every network behaves
 * the same way.
 */

/** The utility helpers, and nothing that touches the DOM. */
import { parseTs } from './util.js';

/**
 * The lowest support level that still means "you may edit".
 *
 * Beeper's levels are -2 rejected, -1 dropped, 0 unsupported, 1 partially
 * supported, 2 fully supported. One is the point where an edit is allowed.
 */
const SUPPORTED = 1;

/**
 * Can this chat edit a message at all?
 *
 * Three states, and they are not the same:
 *
 *   no capabilities object  - the bridge did not say. Allowed, because that
 *                             is what the app has always done and Matrix
 *                             supports edits.
 *   a capabilities object
 *   with no edit key        - the bridge said it cannot edit. Refused.
 *   an edit level           - one or more may edit, zero or less may not.
 *
 * Google Voice is the second case and Beeper's own Matrix chats are the
 * first, and they were measured against the live bridge rather than guessed.
 */
export function chatAllowsEdit(chat) {
  const caps = chat?.capabilities;
  if (!caps || typeof caps !== 'object') return true;
  const level = caps.edit;
  if (level === undefined || level === null) return false;
  const value = Number(level);
  if (!Number.isFinite(value)) return false;
  return value >= SUPPORTED;
}

/**
 * The chat's edit window, in seconds, or null when it has none.
 *
 * Signal allows twenty-four hours, Messenger fifteen minutes, and the
 * Signal note to self has no limit at all - the key is simply not there.
 */
export function editMaxAgeSeconds(chat) {
  const caps = chat?.capabilities;
  if (!caps || typeof caps !== 'object') return null;
  const seconds = Number(caps.editMaxAge);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}

/** Epoch millis for any of the timestamp shapes Beeper sends. */
export function millisOf(value) {
  const date = parseTs(value);
  return date ? date.getTime() : 0;
}

/**
 * Has Beeper confirmed this message?
 *
 * A message with no status of its own came from Beeper - every real message
 * from the bridge looks like that. A status says the message is one this
 * device made: `pending` is the optimistic bubble the app puts on screen
 * before the send round trip comes back, and `failed` is one whose send did
 * not go through.
 *
 * Beeper has never heard of either id, so neither of them can be edited:
 * the edit would be sent for a message that does not exist.
 */
export function confirmedByBeeper(message) {
  const status = message?.sendStatus;
  if (status === undefined || status === null) return true;
  return status === 'sent';
}

/**
 * Can this message be edited, right now?
 *
 * `now` is a parameter so a check can ask about a message sent two days ago
 * without waiting two days.
 */
export function isEditableMessage(chat, message, now = Date.now()) {
  if (!chat || !message) return false;
  if (!chatAllowsEdit(chat)) return false;
  // A read-only chat cannot be written to at all, so there is nothing to
  // edit in it either.
  if (chat.isReadOnly) return false;
  if (!message.isSender) return false;
  if (message.isDeleted) return false;
  if (message.isHidden) return false;
  // A message that only exists on this device is not a message Beeper has.
  if (!confirmedByBeeper(message)) return false;
  // Beeper's own rule: a message with an attachment cannot be edited.
  if ((message.attachments || []).length) return false;

  const maxAge = editMaxAgeSeconds(chat);
  if (maxAge !== null) {
    const sent = millisOf(message.timestamp);
    if (!sent) return false;
    if (now - sent > maxAge * 1000) return false;
  }
  return true;
}

/**
 * The messages that can be edited, oldest first.
 *
 * Oldest first because that is the order the up arrow walks them: the
 * newest one is entered first, and each further press steps towards the
 * past.
 *
 * The order is made here rather than assumed of the caller: the list the
 * renderer holds is usually oldest first already, but a message that
 * arrives late, or a window that was paged in, does not have to be.
 * Sorting a copy leaves the caller's array alone, and the sort is stable,
 * so two messages sent in the same millisecond keep the order they came in.
 */
export function editableMessages(chat, messages, now = Date.now()) {
  return (messages || [])
    .filter((message) => isEditableMessage(chat, message, now))
    .sort((a, b) => millisOf(a.timestamp) - millisOf(b.timestamp));
}
