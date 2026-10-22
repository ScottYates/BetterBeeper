/**
 * Keeping the people in a chat up to date.
 *
 * A chat's participants are contact information as much as its messages are
 * content. Someone changes their name, or their picture, and the conversation
 * is still showing the old one - and so are the messages, because a message
 * carries the name its sender had when they wrote it.
 *
 * So refreshing a conversation re-checks the people in it as well.
 *
 * Pure, so tools/contact-refresh-check.mjs can exercise it directly. The parts
 * worth testing are the ones that fail quietly: a participant list that Beeper
 * chose to shorten must not look like everybody leaving, and a name we do not
 * have must never blank a name we already have.
 *
 * It also says what it found. A refresh that changed nothing used to look
 * exactly like a refresh that was broken, because neither of them said
 * anything - and for a contact Beeper knows only by a number, nothing is
 * ever going to change. The answer is worth saying out loud.
 */

/**
 * The name to put on a message for one participant.
 *
 * This is not the same question as the one participants.js asks. That one is
 * "what do we show for this person", and it answers with something for
 * everybody - a number, or the raw id, when there is no name. This one is "is
 * this a name worth putting on a message instead of the one it already has",
 * and the answer can be no.
 *
 * fullName first, then username. A phone number is contact information but it
 * is not a name, and the thread shows numbers in the subtitle already, so it
 * is not used as one here.
 *
 * A number in `fullName` is a number here too, and that is not a rare case:
 * Beeper fills `fullName` in with the number for a contact it has no name
 * for, so "the name" is a number for most of a phone network's contacts. A
 * number is never a name, and one must never be written over a name we
 * already have.
 *
 * Null means we know nothing better, which is a different answer from "this
 * person is called nothing" and must be treated as one. It is what keeps a
 * participant with no name from replacing a good one with their id.
 */
export function contactName(participant) {
  const full = typeof participant?.fullName === 'string' ? participant.fullName.trim() : '';
  if (full && !isPhoneNumber(full)) return full;
  const user = typeof participant?.username === 'string' ? participant.username.trim() : '';
  if (user && !isPhoneNumber(user)) return user;
  return null;
}

/**
 * Is this string a telephone number rather than a name?
 *
 * Beeper puts the number in `fullName` for a contact it has no name for, so a
 * name that is only a number is not a name. Measured on the live account: of
 * the 123 Google Voice contacts Beeper Desktop keeps, 68 have a number as
 * their name and 53 have a real one - so "the name is a number" is the normal
 * case for a phone network, not the rare one.
 *
 * A short code counts. "89464" is how Beeper knows that sender, and there is
 * still no name behind it.
 *
 * This is a different question from the one participants.js asks. That one is
 * "should the number be printed under the name", and it wants seven digits
 * before it will call two strings the same number. This one is "is there a
 * name here at all", and a number of any length is not one.
 */
export function isPhoneNumber(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!/[0-9]/.test(trimmed)) return false;
  // Nothing but the characters a telephone number is written with.
  return !/[^0-9+()\s.-]/.test(trimmed);
}

/**
 * The people in a chat, after a fresh list has been checked.
 *
 * Both arguments are the participants object Beeper sends: { items, hasMore,
 * total }.
 *
 * The trap is that `items` may be a subset. The schema says so outright -
 * "limited by the request; may be a subset" - and the chat endpoint is one
 * that limits. A chat with forty members can come back with five, and a plain
 * replace would take thirty-five people out of the app because the response
 * was short, not because anyone left.
 *
 * So the fresh list may only remove somebody when it is complete: nothing more
 * claimed, and as many as it says there are. Otherwise the two are merged by
 * id and the fresh copy of a person wins.
 *
 * An empty list counts as no information rather than as nobody. A chat always
 * has at least you in it, so an empty response is a response that left the
 * people out.
 */
export function mergeParticipants(previous, fresh) {
  const prevItems = Array.isArray(previous?.items) ? previous.items : [];
  const freshItems = Array.isArray(fresh?.items) ? fresh.items : [];

  if (!freshItems.length) {
    return {
      items: prevItems.slice(),
      hasMore: Boolean(previous?.hasMore),
      total: typeof previous?.total === 'number' ? previous.total : null,
    };
  }

  const complete = !fresh?.hasMore
    && (typeof fresh?.total !== 'number' || fresh.total <= freshItems.length);

  if (complete) {
    return {
      items: freshItems.slice(),
      hasMore: false,
      total: typeof fresh?.total === 'number' ? fresh.total : freshItems.length,
    };
  }

  // Partial: keep everybody we knew about and add whoever is new. The map
  // keeps the order people arrived in, and a fresh copy of somebody replaces
  // the old one where they sit rather than moving them to the end.
  const byID = new Map();
  const withoutID = [];
  for (const person of [...prevItems, ...freshItems]) {
    if (person?.id) byID.set(String(person.id), person);
    else withoutID.push(person);
  }

  return {
    items: [...byID.values(), ...withoutID],
    hasMore: Boolean(fresh?.hasMore),
    total: typeof fresh?.total === 'number' ? fresh.total : (previous?.total ?? null),
  };
}

/**
 * The name to show for each person in a chat, keyed by the id that the
 * messages carry.
 *
 * Only people we can actually name are in here. A participant with no name is
 * left out rather than entered as an empty string, so that applying this map
 * can never blank a name we already have.
 *
 * `skipSelf` leaves you out of the map. Your own messages are not renamed -
 * they are already labelled as yours - and the two places that write names
 * have to agree about that, or the app and the store end up saying different
 * things about the same message.
 */
export function nameMap(participants, { skipSelf = false } = {}) {
  const names = new Map();
  for (const person of participants || []) {
    if (!person?.id) continue;
    if (skipSelf && person.isSelf) continue;
    const name = contactName(person);
    if (name) names.set(String(person.id), name);
  }
  return names;
}

/**
 * Put fresh names on the messages we hold.
 *
 * Returns the messages and the ones that changed. A message is left alone when
 * the sender is not in the map, when the name is already right, or when it is
 * yours: your own messages are already labelled as yours and renaming them
 * would only make them inconsistent with the composer.
 */
export function applyNames(messages, names) {
  const list = Array.isArray(messages) ? messages : [];
  if (!names || typeof names.get !== 'function') return { messages: list, renamed: [] };

  const renamed = [];
  const out = list.map((message) => {
    if (!message || message.isSender) return message;
    const name = names.get(String(message.senderID ?? ''));
    // No name is no news. An unknown sender keeps whatever it was called.
    if (!name || name === message.senderName) return message;
    const next = { ...message, senderName: name };
    renamed.push(next);
    return next;
  });

  return { messages: out, renamed };
}

/**
 * A chat record with the fresh contact information folded in.
 *
 * The participants are merged rather than replaced, for the reason in
 * mergeParticipants. Everything else in the fresh record is Beeper's answer
 * and wins outright.
 */
export function mergeChatInfo(previous, fresh) {
  if (!fresh) return previous || null;
  const merged = { ...(previous || {}), ...fresh };
  const participants = mergeParticipants(previous?.participants, fresh?.participants);
  if (participants) merged.participants = participants;

  // The unread count is the one field the server does not get to give back.
  //
  // Opening a chat marks it read and says so straight away rather than waiting
  // for the server to agree. The server has not processed that mark when the
  // chat record comes back, so writing its count over the local one puts the
  // badge straight back on - which is the bug the count was cleared to fix, and
  // it returns the moment the full record is applied again.
  //
  // The count belongs to whoever set it last. This is only ever called for the
  // chat that is open, and the live socket is what brings a new count in.
  if (previous && 'unreadCount' in previous) merged.unreadCount = previous.unreadCount;

  return merged;
}

/**
 * What a refresh learned about the people in a chat.
 *
 * Two things, and they answer two different questions.
 *
 * `renamed` is who changed: the people whose messages carry a name that is no
 * longer the one Beeper has. Each entry is the old name and the new one.
 *
 * `unnamed` is who Beeper cannot name at all: the people it knows only by a
 * number. They are not a failure of the refresh - they are the answer. A
 * Google Voice contact with no name in Google Contacts is a number in every
 * layer Beeper has, and no amount of refreshing will turn it into a name.
 *
 * You are not in either list. You do not need a name to be recognised, and
 * your own messages are not renamed.
 */
export function contactReport(participants, messages, names) {
  const map = names instanceof Map ? names : new Map();

  const changed = new Map();
  for (const message of messages || []) {
    if (!message || message.isSender) continue;
    const to = map.get(String(message.senderID ?? ''));
    if (!to || to === message.senderName) continue;
    if (changed.has(message.senderID)) continue;
    changed.set(message.senderID, { id: message.senderID, from: message.senderName, to });
  }

  const unnamed = [];
  for (const person of participants || []) {
    if (!person?.id || person.isSelf) continue;
    if (map.has(String(person.id))) continue;
    const number = typeof person.phoneNumber === 'string' ? person.phoneNumber.trim() : '';
    if (number) unnamed.push(number);
  }

  return { renamed: [...changed.values()], unnamed };
}

/**
 * What to say after a refresh.
 *
 * The refresh used to say nothing at all, so a refresh that changed nothing
 * looked exactly like a refresh that was broken. From the reader's side the
 * two are the same, and only one of them is.
 *
 * So it says which of the two happened. `written` is how many messages the
 * store actually rewrote - the honest count, because the store holds the
 * whole conversation and the screen holds a page of it.
 */
export function contactRefreshMessage(report, written = 0) {
  const changed = (report?.renamed || []).map((entry) => entry.to);
  const unnamed = report?.unnamed || [];

  if (written > 0) {
    const head = `Updated ${written} name${written === 1 ? '' : 's'}`;
    return changed.length ? `${head}: ${list(changed, 3)}` : head;
  }
  if (unnamed.length) {
    return `Beeper has no name yet for ${list(unnamed, 2)}`;
  }
  return 'No contact changes';
}

/** A list short enough to read, with a count of what did not fit. */
function list(items, max) {
  const shown = items.slice(0, max).join(', ');
  const rest = items.length - max;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}
