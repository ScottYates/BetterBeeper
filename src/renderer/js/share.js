/**
 * Sharing a message with someone else.
 *
 * The decisions, kept apart from the picking and the sending so they can be
 * checked without a window, a network, or a Beeper account. Nothing here
 * imports anything: the rules are the part worth testing, and they are only
 * worth testing if they can be loaded on their own.
 *
 * Two of these rules exist because of what the network actually does:
 *
 *   - Beeper accepts one attachment per send, so a message with three files is
 *     four messages, not one. The text rides along with the first.
 *   - Sending into a read-only chat fails, so those chats are not offered.
 *     A dead end in a picker is worse than a short list with a reason.
 */

/** How many chats to offer before the user has typed anything. */
export const CHAT_LIMIT = 20;

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
 * Where this came from, in one line.
 *
 * Said to the people receiving it, because a message forwarded with no context
 * reads as though they were the intended recipient. Empty when there is
 * genuinely nothing to say, rather than a line saying nothing.
 */
export function shareAttribution(message, chatTitle = '') {
  const who = String(message?.senderName || '').trim();
  const where = String(chatTitle || '').trim();
  if (who && where) return `Forwarded from ${who} in ${where}`;
  if (who) return `Forwarded from ${who}`;
  if (where) return `Forwarded from ${where}`;
  return '';
}

/**
 * The text that goes into the other chat.
 *
 * The attribution goes above the message rather than after it, so the first
 * line a reader sees says where it came from.
 */
export function shareText(message, chatTitle = '') {
  const head = shareAttribution(message, chatTitle);
  const body = String(message?.text || '').trim();
  if (head && body) return `${head}\n\n${body}`;
  return head || body;
}

/**
 * The sends this share turns into.
 *
 * Beeper takes a single attachment per message, so the queue mirrors the
 * composer: the first file carries the text, the rest travel alone. A message
 * with no attachments is one send.
 */
export function shareQueue(message, chatTitle = '') {
  const text = shareText(message, chatTitle);
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return [{ text }];
  return [
    { text: text || undefined, attachment: attachments[0] },
    ...attachments.slice(1).map((attachment) => ({ attachment })),
  ];
}

/**
 * How many files a share will send.
 *
 * Shown before the user commits, because four messages appearing in someone
 * else's chat is not something to discover afterwards.
 */
export function shareSendCount(message) {
  return shareQueue(message).length;
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
export function shareNotice(message, chatTitle = '') {
  const sends = shareQueue(message, chatTitle).length;
  if (sends <= 1) return 'Pick a chat or a contact to send this to.';
  return `Sending this sends ${sends} messages, one per file - Beeper takes a single file at a time.`;
}

function matches(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(needle);
}

function lastActivityOf(chat) {
  const t = Date.parse(chat?.lastActivity || '');
  return Number.isFinite(t) ? t : 0;
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
 * The chats worth offering, newest first.
 *
 * The chat the message came from is left out: forwarding it back where it
 * already is is a no-op that still posts a message. Merged rows go too, since
 * the conversation they belong to is in the list under its own name.
 *
 * Then same-named chats on the same network are collapsed to the most recent
 * one, which is the conversation actually in use. Only the picker does this:
 * the sidebar still lists both, because there you are browsing conversations
 * and the older one may hold messages the newer one does not.
 *
 * Beeper did not return mergedIntoChatID on any of the 50 chats measured on
 * this account, so that half currently never fires. It stays because the
 * sidebar (sidebar.js) and the unread count (unread.js) apply the same rule,
 * and a picker offering a chat the sidebar hides would be a third answer to
 * one question.
 */
export function shareableChats(chats, { sourceChatID = '', query = '', limit = CHAT_LIMIT } = {}) {
  const needle = String(query || '').trim().toLowerCase();

  const sorted = [...(chats || [])]
    .filter((chat) => {
      if (!chat || chat.id === sourceChatID) return false;
      if (chat.mergedIntoChatID) return false;
      if (!needle) return true;
      return matches(chat.title, needle);
    })
    .sort((a, b) => lastActivityOf(b) - lastActivityOf(a));

  const seen = new Set();
  const unique = [];
  for (const chat of sorted) {
    const key = shareIdentity(chat);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    unique.push(chat);
    if (unique.length >= limit) break;
  }
  return unique;
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
  const title = String(chat?.title || '').trim();
  return title || 'Untitled chat';
}

/**
 * Send the queue into one chat.
 *
 * The network is passed in rather than imported, so the part that decides what
 * goes out and in what order can be run against a recording instead of a real
 * account. Beeper takes one attachment per message, so this is a loop and not a
 * single call, and it stops at the first failure: pressing on after a rejected
 * send puts half of somebody else's conversation in front of them.
 *
 * Never throws. Returns what happened, including how far it got, because "it
 * did not send" and "the first three went and the fourth did not" are different
 * things to tell someone whose chat it is.
 *
 * @param io  { reupload(attachment), send({text, attachment}) }
 */
export async function deliverQueue(queue, io) {
  let count = 0;
  for (const payload of queue || []) {
    try {
      // A file cannot cross chats by pointing at where it was: the other chat
      // has no access to this one's assets, so it is copied across first.
      const attachment = payload.attachment ? await io.reupload(payload.attachment) : undefined;
      await io.send({ text: payload.text, attachment });
      count += 1;
    } catch (err) {
      return { ok: false, count, error: err?.message || 'Could not share this.' };
    }
  }
  return { ok: true, count };
}