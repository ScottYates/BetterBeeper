/**
 * Sharing a message with someone else.
 *
 * The decisions, kept apart from the picking and the sending so they can be
 * checked without a window, a network, or a Beeper account. The only thing
 * imported here is the character-reference decoder, which touches no DOM, so
 * the rules are still the part worth testing, and they are still worth
 * testing because they can be loaded on their own.
 *
 * Two of these rules exist because of what the network actually does:
 *
 *   - Beeper accepts one attachment per send, so a message with three files is
 *     four messages, not one. The text rides along with the first.
 *   - Sending into a read-only chat fails, so those chats are not offered.
 *     A dead end in a picker is worse than a short list with a reason.
 */

import { decodeEntities } from './entities.js';
import { inboxChats, inboxOrder, lastActivityOf } from './inbox-chats.js';

/**
 * How many rows are drawn at a time.
 *
 * A rendering detail, not a limit. The list keeps filling as the user
 * scrolls, it asks Beeper for the next page when it runs out, and the count
 * underneath says how many there are in all - so a list of three hundred
 * chats is a list you can scroll through, not a list that stops at twenty.
 */
export const CHAT_CHUNK = 50;

/**
 * Is there anything here worth sending?
 *
 * A deleted message is nothing, and a message with neither text nor files is
 * nothing - offering to share either would be an option that always fails.
 */
export function canShare(message) {
  if (!message || message.isDeleted) return false;
  if (String(message.text || '').trim()) return true;
  return Array.isArray(message.attachments) && message.attachments.length > 0;
}

/**
 * The text that goes into the other chat.
 *
 * The message, unchanged, and nothing added to it. There used to be a
 * "Forwarded from Alex in Team chat" line prefixed here. It is gone because the
 * text is editable before it goes, and a line the sender never typed sitting
 * above their own words reads to the recipient as though they wrote it.
 */
export function shareText(message) {
  return String(message?.text || '').trim();
}

/**
 * The sends this share turns into.
 *
 * `text` is what the user left in the box, which is not necessarily what the
 * message said: it can be rewritten, trimmed, or emptied. Defaulting to the
 * original keeps the callers that only care about shape - how many sends, in
 * what order - from having to invent a text.
 *
 * Beeper takes a single attachment per message, so the queue mirrors the
 * composer: the first file carries the text, the rest travel alone. A message
 * with no attachments is one send.
 */
export function shareQueue(message, text = shareText(message)) {
  const body = String(text || '');
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return [{ text: body }];
  return [
    { text: body || undefined, attachment: attachments[0] },
    ...attachments.slice(1).map((attachment) => ({ attachment })),
  ];
}

/**
 * How many files a share will send.
 *
 * Shown before the user commits, because four messages appearing in someone
 * else's chat is not something to discover afterwards.
 */
export function shareSendCount(message, text) {
  return shareQueue(message, text).length;
}

/**
 * What to say before anyone commits.
 *
 * Because Beeper takes one attachment per message, sharing a message with files
 * is several messages. That is not obvious from the picker's appearance, and it
 * is somebody else's conversation it happens in, so the count goes up front.
 *
 * The wording is deliberately counted from the queue rather than written by
 * hand: an earlier version said "the text, then 2 files" for three files, which
 * reads as though the first message carried no file at all. It carries the first
 * one.
 */
export function shareNotice(message, text) {
  const sends = shareQueue(message, text).length;
  if (sends <= 1) return 'Pick one or more people to send this to.';
  return `Each person gets ${sends} messages, one per file - Beeper takes a single file at a time.`;
}

function matches(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(needle);
}

/**
 * What makes two chats look like the same destination, or '' if unknowable.
 *
 * Beeper's Google Voice bridge hands out a fresh chat id for the same person
 * minutes apart, so the picker showed "Benji" twice, both on Google Voice,
 * both leading to the same place. The name and the network together are what
 * a person reads as "that chat", so that is what is compared.
 *
 * An untitled chat gets no key at all, so it is never collapsed: two untitled
 * chats may well be two different groups, and there is nothing to tell them
 * apart by.
 */
export function shareIdentity(chat) {
  const title = String(chat?.title || '').trim().toLowerCase();
  if (!title) return '';
  // NUL rather than a visible separator, so a title containing it cannot make
  // two different chats collide.
  return `${title}\u0000${String(chat?.network || '').trim().toLowerCase()}`;
}

/**
 * The chats worth offering: the Inbox's chats, in the Inbox's order.
 *
 * This is the Inbox's own list - the chats that are not archived, not merged
 * into another one, and not the chat the message came from. The sidebar and
 * the picker therefore agree, which is the point: a picker offering a chat
 * the sidebar hides would be a third answer to one question.
 *
 * Then same-named chats on the same network are collapsed to the most recent
 * one, which is the conversation actually in use. Only the picker does this:
 * the sidebar still lists both, because there you are browsing conversations
 * and the older one may hold messages the newer one does not.
 *
 * Beeper did not return mergedIntoChatID on any of the 50 chats measured on
 * this account, so that half currently never fires. It stays because the
 * sidebar (sidebar.js) and the unread count (unread.js) apply the same rule.
 *
 * There is no cap. The list is drawn a chunk at a time and filled in as the
 * user scrolls, and it asks Beeper for the next page when it runs out, so the
 * answer to "who can I send this to" is the whole Inbox rather than the
 * twenty chats that happened to be at the top of it.
 */
export function shareableChats(chats, { sourceChatID = '', query = '' } = {}) {
  const needle = String(query || '').trim().toLowerCase();

  const set = inboxChats(chats, { excludeChatID: sourceChatID });
  const filtered = needle
    ? set.filter((chat) => matches(decodeEntities(chat.title), needle))
    : set;

  // Collapse to the most recent chat of each name-and-network pair.
  //
  // The most recent is chosen by activity rather than by position in the
  // list, because the list above is in the Inbox's order and a pinned chat
  // would otherwise beat a newer one to it.
  const newest = new Map();
  const untitled = [];
  for (const chat of filtered) {
    const key = shareIdentity(chat);
    if (!key) {
      // No name means no key, so it is never collapsed: two untitled chats
      // may well be two different groups.
      untitled.push(chat);
      continue;
    }
    const before = newest.get(key);
    if (!before) {
      newest.set(key, chat);
      continue;
    }
    if (lastActivityOf(chat) > lastActivityOf(before)) newest.set(key, chat);
  }

  const out = [...newest.values(), ...untitled];
  out.sort(inboxOrder);
  return out;
}

/**
 * Which of those can actually receive a message.
 *
 * Split rather than folded in, so the picker can say why a chat is missing
 * instead of quietly pretending it does not exist.
 */
export function partitionShareable(list) {
  const writable = [];
  const readOnly = [];
  for (const chat of list || []) {
    if (chat?.isReadOnly) readOnly.push(chat);
    else writable.push(chat);
  }
  return { writable, readOnly };
}

/** What the recipient's chat will be called, the way the sidebar calls it. */
export function chatDisplayName(chat) {
  const title = decodeEntities(String(chat?.title || '')).trim();
  return title || 'Untitled chat';
}

/**
 * Send the payloads of one queue, and say which of them went.
 *
 * The network is passed in rather than imported, so the part that decides what
 * goes out and in what order can be run against a recording instead of a real
 * account. Beeper takes one attachment per message, so this is a loop and not a
 * single call, and it stops at the first failure: pressing on after a rejected
 * send puts half of somebody else's conversation in front of them.
 *
 * It reports WHICH payloads went, not just how many, because a share to
 * several people has to be able to send the leftovers again later. A queue
 * that failed on its third of three files has two files in somebody else's
 * chat already, and a retry that sent all three would put the first two there
 * a second time.
 *
 * Never throws. The failed payload and every one after it come back as
 * `pending`, so a caller can pick the run up from where it stopped.
 *
 * @param io  { reupload(attachment), send({text, attachment}) }
 * @returns  { ok, sent: [payload], pending: [payload], error }
 */
export async function deliverPayloads(payloads, io) {
  const list = Array.isArray(payloads) ? payloads : [];
  const sent = [];
  for (let index = 0; index < list.length; index += 1) {
    const payload = list[index];
    try {
      // A file cannot cross chats by pointing at where it was: the other chat
      // has no access to this one's assets, so it is copied across first.
      const attachment = payload.attachment ? await io.reupload(payload.attachment) : undefined;
      await io.send({ text: payload.text, attachment });
      sent.push(payload);
    } catch (err) {
      return {
        ok: false,
        sent,
        pending: list.slice(index),
        error: err?.message || 'Could not share this.',
      };
    }
  }
  return { ok: true, sent, pending: [] };
}

/**
 * Send the queue into one chat.
 *
 * A thin answer on top of deliverPayloads: how many went, and what went
 * wrong. The rule about stopping at the first failure lives in
 * deliverPayloads, so there is one place that decides it.
 *
 * Never throws. Returns what happened, including how far it got, because "it
 * did not send" and "the first three went and the fourth did not" are different
 * things to tell someone whose chat it is.
 *
 * @param io  { reupload(attachment), send({text, attachment}) }
 */
export async function deliverQueue(queue, io) {
  const res = await deliverPayloads(queue, io);
  if (res.ok) return { ok: true, count: res.sent.length };
  return { ok: false, count: res.sent.length, error: res.error };
}