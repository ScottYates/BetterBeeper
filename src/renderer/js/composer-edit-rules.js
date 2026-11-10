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
 * Why this message cannot be edited, or null when it can.
 *
 * The checks are in the same order `isEditableMessage` uses, so the reason and
 * the answer can never disagree: the answer is the reason being null. One
 * rule, two views of it.
 *
 * The codes are what the explanation is written from, so they are part of the
 * contract rather than an implementation detail.
 */
export function messageEditRefusal(chat, message, now = Date.now()) {
  if (!chat || !message) return 'no-message';
  if (!chatAllowsEdit(chat)) return 'chat-cannot-edit';
  // A read-only chat cannot be written to at all, so there is nothing to
  // edit in it either.
  if (chat.isReadOnly) return 'chat-read-only';
  if (!message.isSender) return 'not-mine';
  if (message.isDeleted) return 'deleted';
  if (message.isHidden) return 'hidden';
  // A message that only exists on this device is not a message Beeper has.
  if (!confirmedByBeeper(message)) return 'not-confirmed';
  // Beeper's own rule: a message with an attachment cannot be edited.
  if ((message.attachments || []).length) return 'has-attachment';

  const maxAge = editMaxAgeSeconds(chat);
  if (maxAge !== null) {
    const sent = millisOf(message.timestamp);
    if (!sent) return 'no-timestamp';
    if (now - sent > maxAge * 1000) return 'too-old';
  }
  return null;
}

/**
 * Can this message be edited, right now?
 *
 * `now` is a parameter so a check can ask about a message sent two days ago
 * without waiting two days.
 */
export function isEditableMessage(chat, message, now = Date.now()) {
  return messageEditRefusal(chat, message, now) === null;
}

/**
 * Your own messages, oldest first.
 *
 * The same list the up arrow walks, without the editability test on it: the
 * messages it cannot open are the ones the explanation is about.
 */
export function ownMessages(messages) {
  return (messages || [])
    .filter((m) => m && m.isSender && !m.isDeleted && !m.isHidden)
    .sort((a, b) => millisOf(a.timestamp) - millisOf(b.timestamp));
}

/**
 * Why there is nothing to edit in this chat, and which message it was.
 *
 * Null when something in the chat can be edited.
 *
 * The reason reported is the one that applies to the most of your messages,
 * because that is the one that explains the chat. A tie goes to the newest
 * message, because that is the one the arrow would have opened.
 */
export function chatEditRefusal(chat, messages, now = Date.now()) {
  if (!chat) return null;
  if (!chatAllowsEdit(chat)) {
    return { code: 'chat-cannot-edit', message: null, maxAgeSeconds: null, newestOwnAt: null };
  }
  if (chat.isReadOnly) {
    return { code: 'chat-read-only', message: null, maxAgeSeconds: null, newestOwnAt: null };
  }

  const own = ownMessages(messages);
  if (!own.length) {
    return { code: 'no-own-messages', message: null, maxAgeSeconds: null, newestOwnAt: null };
  }

  const reasons = own.map((m) => messageEditRefusal(chat, m, now));
  // Something in here can be edited, so there is nothing to explain.
  if (reasons.includes(null)) return null;

  const counts = new Map();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) || 0) + 1);
  const newestReason = reasons[reasons.length - 1];
  let best = newestReason;
  let bestCount = counts.get(newestReason) || 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }

  // The message the explanation is about is the newest one that fails for
  // that reason, so the reason and the message agree.
  let shown = null;
  for (let i = own.length - 1; i >= 0; i -= 1) {
    if (reasons[i] === best) {
      shown = own[i];
      break;
    }
  }

  return {
    code: best,
    message: shown,
    maxAgeSeconds: editMaxAgeSeconds(chat),
    newestOwnAt: shown ? millisOf(shown.timestamp) : null,
  };
}

/**
 * The edit window, written the way a person would say it.
 *
 * "24 hours" on Signal, "15 minutes" on Messenger, and '' for a chat with no
 * window at all.
 */
export function editWindowLabel(chat) {
  const seconds = editMaxAgeSeconds(chat);
  if (seconds === null) return '';
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
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
