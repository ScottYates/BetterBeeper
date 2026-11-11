/**
 * When somebody read a message of yours.
 *
 * Beeper's `seen` field is a map of account ids to timestamps: who has read
 * the message, and when. Measured against the live account, it holds **your**
 * own id on your own messages, and the time is the moment your own client
 * marked the conversation read - which is a second or two after you hit send,
 * because the message is on screen in your window as you send it.
 *
 * That is not a delivery. The other person's read time is the delivery, and
 * it is in the same map under their own id, when their bridge reports one.
 *
 * So the receipt shown on a message of yours has to be somebody else's read
 * time, and a message nobody else has read has no receipt at all - just the
 * tick that says it was sent.
 *
 * The rules live in their own module, and they live there on purpose: this
 * module touches no DOM, so it can be loaded by plain Node with no Electron
 * and no window at all, and a rule nobody can check is a rule nobody checks.
 */

/**
 * The ids that are you, in this chat.
 *
 * The chat's own participant list is the authority: every one of the 100
 * chats on the live account marks exactly one participant with `isSelf`, and
 * that is the account the seen map names when you read your own message.
 *
 * The message's own sender id is the fallback for when the chat has no
 * participant list to say with: a message of yours came from you, so your
 * sender id in that chat is you.
 */
export function selfReaderIds(chat, message) {
  const ids = new Set();
  for (const person of chat?.participants?.items || []) {
    if (person?.isSelf && person.id) ids.add(person.id);
  }
  if (!ids.size && message?.isSender && message.senderID) ids.add(message.senderID);
  return ids;
}

/**
 * When somebody other than you read this message, or null when nobody else
 * has.
 *
 * The most recent read wins: in a conversation with several people, the
 * message has been read by all of them when the last of them has read it.
 */
export function deliveryTime(message, selfIds) {
  const seen = message?.seen;
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) return null;

  let best = null;
  for (const [id, value] of Object.entries(seen)) {
    if (typeof value !== 'string' || !value) continue;
    if (selfIds && selfIds.has(id)) continue;
    const at = new Date(value).getTime();
    if (Number.isNaN(at)) continue;
    if (best === null || at > best.at) best = { at, value };
  }
  return best ? best.value : null;
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** The calendar day a timestamp falls on, in local time. */
function dayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * The receipt as it is written on the message.
 *
 * Two ticks and the time, when the message was read. The date is included
 * when the read happened on a different day than the message was sent: a
 * message sent at 11pm and read at 8am says "8:03 AM" on its own, and that
 * reads as the morning before rather than the morning after.
 */
export function deliveryText(deliveryISO, sentISO) {
  if (!deliveryISO) return '';
  const at = new Date(deliveryISO);
  if (Number.isNaN(at.getTime())) return '';

  const sameDay = sentISO ? dayKey(deliveryISO) === dayKey(sentISO) : true;
  const when = sameDay ? TIME_FMT.format(at) : DATE_TIME_FMT.format(at);
  return `\u2713\u2713 ${when}`;
}
