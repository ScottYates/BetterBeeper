/**
 * The people in a conversation.
 *
 * Pure, so tools/participants-check.mjs can exercise it directly.
 *
 * A group's title is Beeper's own summary, and it hides people behind an
 * ellipsis: "Eric, Hallie, Mike & 2 others" names three of five and says
 * nothing about the other two. The app is given every one of them - the
 * chat's participants carry the full list - and shows none of them. This is
 * the part that decides what each of them is called and in what order they
 * are listed.
 */

/**
 * The name to show for a participant.
 *
 * The friendliest thing the record has, in that order: the name Beeper
 * knows them by, then the address on their account, then their number, then
 * the raw id. A Signal contact arrives with a fullName and a phone number; a
 * Beeper account arrives with a username and no name at all. Both have to
 * come out as something a person would recognise.
 */
export function participantName(participant) {
  const p = participant || {};
  return firstText(p.fullName, p.username, p.phoneNumber, p.id);
}

/**
 * The second line: the identifier, when it is not the same thing as the name.
 *
 * A name on its own does not tell you which of two people with the same
 * first name you are looking at, so the number or the address goes underneath
 * it. It is left out when it says nothing the name does not: a Beeper
 * account's id is its username with an @ in front, and printing both is
 * noise.
 *
 * Only a way of reaching the person goes here. The raw id is the last resort
 * for the name, never a second line under it - a Signal id is a hundred
 * characters of noise, and a contact whose name is its own number has
 * nothing left to add.
 */
export function participantDetail(participant) {
  const p = participant || {};
  const name = participantName(p);
  for (const candidate of [p.phoneNumber, p.username]) {
    const value = text(candidate);
    if (!value) continue;
    if (sameThing(value, name)) continue;
    return value;
  }
  return '';
}

/**
 * The short tags beside a name.
 *
 * "You" first, because that is the one the reader most needs to be sure of.
 * The rest say what the person is to this conversation rather than who they
 * are: an admin, someone who has not accepted their invite yet, a network
 * bot.
 */
export function participantTags(participant) {
  const p = participant || {};
  const tags = [];
  if (p.isSelf) tags.push('You');
  if (p.isAdmin) tags.push('Admin');
  if (p.isPending) tags.push('Pending');
  if (p.isNetworkBot) tags.push('Bot');
  return tags;
}

/**
 * Everyone in the chat, in the order they should be listed.
 *
 * You come first, then the admins, then everyone else, each group by name.
 * The order is the same every time, because a list that reshuffles itself
 * between openings is a list nobody can learn.
 *
 * A person appears once. Beeper can list the same account twice in a
 * conversation that has been merged, and a person who is in the room once
 * should be listed once.
 *
 * Returns { people, hidden } - hidden is how many the server says are in the
 * conversation but did not send, which is not zero for a large group.
 */
export function participantList(chat) {
  const participants = chat?.participants || {};
  const items = Array.isArray(participants.items) ? participants.items : [];

  const seen = new Set();
  const people = [];
  for (const participant of items) {
    const id = text(participant?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    people.push({
      participant,
      id,
      name: participantName(participant),
      detail: participantDetail(participant),
      tags: participantTags(participant),
    });
  }

  people.sort((a, b) => {
    const ra = rank(a.participant);
    const rb = rank(b.participant);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const total = Number(participants.total);
  const hidden = Number.isFinite(total) && total > people.length ? total - people.length : 0;
  return { people, hidden };
}

/** You, then admins, then the rest. */
function rank(participant) {
  if (participant?.isSelf) return 0;
  if (participant?.isAdmin) return 1;
  return 2;
}

/** The first of these that is a non-empty string. */
function firstText(...values) {
  for (const value of values) {
    const t = text(value);
    if (t) return t;
  }
  return '';
}

/** A trimmed string, or empty for anything that is not one. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Are these the same thing, said two ways?
 *
 * A Beeper account's id is its username with an @ in front of it, so "@eric"
 * and "eric" are one account and not two. Case does not make a difference
 * either, because addresses are not case sensitive.
 *
 * A phone number is the same number however it is written: Beeper gives one
 * contact the name "+1 515-988-3633" and the number "+15159883633", and
 * printing the number under the name that already is the number is noise.
 */
function sameThing(a, b) {
  const strip = (v) => v.replace(/^@/, '').toLowerCase();
  if (strip(a) === strip(b)) return true;
  const digitsA = a.replace(/\D/g, '');
  const digitsB = b.replace(/\D/g, '');
  return digitsA.length >= 7 && digitsA === digitsB;
}
