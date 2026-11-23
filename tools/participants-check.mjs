/**
 * Dev check: the people in a conversation are named and ordered properly,
 * and their phone number is shown when there is one.
 *
 * The point of the list is that a group's title hides people - Beeper writes
 * "Eric, Hallie, Mike & 2 others" and names three of five - so the list has
 * to show all of them, and has to show them the way the reader would name
 * them. A list that says "eric:beeper.com" where a person is called Eric, or
 * that shows the same account twice, is worse than no list at all.
 *
 * The fixtures are the real shapes, measured against the live account on
 * 2026-11-23:
 *
 * - a chat participant is an id, a name, a picture and a few flags. That is
 *   all. NOT ONE of the 492 participants across 200 live chats carried a
 *   phone number, because Beeper's bridge omits it when it does not know
 *   it, and for most of a phone network's contacts it does not.
 * - a Beeper account has a username and no name.
 * - a Google Voice contact has a name that is often its own number.
 *
 * So the number arrives from somewhere else, as a map of id to number, and
 * that map is what this check is really about: a number that is in the map
 * has to reach the row, and a number that is not must not appear.
 *
 * Run with `npm run check:participants`.
 */
import {
  participantName,
  participantDetail,
  participantPhone,
  participantTags,
  participantList,
} from '../src/renderer/js/participants.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) fails += 1;
};

// --- the shapes, as they arrive ---------------------------------------------

// A Beeper account in a group. No full name, no picture, an admin.
const beeperAccount = {
  id: '@eric:beeper.com',
  username: 'eric:beeper.com',
  isSelf: false,
  isAdmin: true,
  isPending: false,
  isNetworkBot: false,
  cannotMessage: false,
};

// A Signal contact, exactly as the bridge sends it: an id, a name, a picture
// and the flags. The phone number is not here, and that is the whole point
// of the check below.
const signalContact = {
  id: '@g1dvtdhUgwiwN6W9x_gy2xUPmBQGVal745KScIT-FG2hxIbW0AP7qZC6x-JYVngnQy4ddEQgaK1T40qI8kapLw:local-signal.localhost',
  fullName: 'Jim Kraai',
  imgURL: 'file:///C:/Users/Scott/AppData/Roaming/BeeperTexts/media/localhostlocal-signal/abc',
  cannotMessage: false,
  isSelf: false,
  isAdmin: false,
  isPending: false,
  isNetworkBot: false,
};

// A Google Voice contact, whose name is its own number.
const voiceContact = {
  id: '@voice:beeper.com',
  fullName: '+15154932243',
  cannotMessage: false,
  isSelf: false,
  isAdmin: false,
  isPending: false,
  isNetworkBot: false,
};

// A Google Voice contact with a real name.
const namedVoiceContact = {
  id: '@named:beeper.com',
  fullName: 'Kevin Nabity',
  cannotMessage: false,
  isSelf: false,
  isAdmin: false,
  isPending: false,
  isNetworkBot: false,
};

// The numbers, read out of Beeper Desktop's own store, keyed by the very id
// the bridge hands out.
const numbers = {
  [signalContact.id]: '+15159887152',
  [voiceContact.id]: '+15154932243',
  [namedVoiceContact.id]: '+15158659563',
};

// --- the name ----------------------------------------------------------------

ok('a name is used when there is one', participantName(signalContact) === 'Jim Kraai');
ok('an account with no name is named by its address', participantName(beeperAccount) === 'eric:beeper.com');
ok('a number is used when there is nothing else', participantName(voiceContact) === '+15154932243');
ok(
  'the raw id is the last resort',
  participantName({ id: '@someone:elsewhere' }) === '@someone:elsewhere',
  participantName({ id: '@someone:elsewhere' }),
);
ok('a participant with nothing at all does not crash', participantName(undefined) === '');
ok('a blank name is not a name', participantName({ fullName: '   ', id: '@x:y' }) === '@x:y');
ok('a non-string name is not a name', participantName({ fullName: 42, username: 'u:v' }) === 'u:v');

// --- the line underneath ----------------------------------------------------

ok(
  'a chat participant carries no identifier of its own',
  participantDetail(signalContact) === '',
  'the bridge does not send a username or a number, so there is nothing to put under the name',
);
ok(
  'an account whose id is its address shows nothing extra',
  participantDetail(beeperAccount) === '',
  'the id is the username with an @ in front, and printing both is noise',
);
ok(
  'a number already beside the name is not repeated underneath it',
  participantDetail({ id: '@x:y', fullName: 'Someone', phoneNumber: '+15159887152' }, '+15159887152') === '',
  'a bridge that sends its own number would print it twice',
);
ok(
  'a username is still shown under the name',
  participantDetail({ id: '@x:y', fullName: 'Someone', username: 'someone:y' }, '+15159887152') === 'someone:y',
);
ok('a participant with nothing at all shows nothing', participantDetail(undefined) === '');

// --- the number beside the name --------------------------------------------

ok(
  'a contact with a number is given it',
  participantPhone(signalContact, numbers) === '+15159887152',
  participantPhone(signalContact, numbers),
);
ok(
  'a contact with no number is given none',
  participantPhone({ id: '@nobody:y', fullName: 'Nobody' }, numbers) === '',
);
ok(
  'a contact whose name is its own number is given nothing',
  participantPhone(voiceContact, numbers) === '',
  'printing the number beside the number is noise',
);
ok(
  'a number written two ways is still the name',
  participantPhone({ id: '@x:y', fullName: '+1 515-988-3633' }, { '@x:y': '+15159883633' }) === '',
  'the name is already the number',
);
ok(
  'a named contact still gets its number',
  participantPhone(namedVoiceContact, numbers) === '+15158659563',
);
ok(
  'a record that carries its own number still works',
  participantPhone({ id: '@x:y', fullName: 'Someone', phoneNumber: '+15551234567' }, {}) === '+15551234567',
  'the schema has one, and a bridge that knows it should not be second-guessed',
);
ok('a participant with no id is given no number', participantPhone({ fullName: 'Nobody' }, numbers) === '');
ok(
  'a broken map is not a crash',
  participantPhone(signalContact, null) === '' && participantPhone(signalContact, 'nonsense') === '',
);
ok(
  'the id is matched exactly',
  participantPhone({ id: '@someone-else:y', fullName: 'Someone' }, numbers) === '',
  'one contact\'s number must not land on another contact',
);

// --- the tags ---------------------------------------------------------------

ok('you are told that you are you', participantTags({ isSelf: true }).includes('You'));
ok('an admin is told', participantTags({ isAdmin: true }).includes('Admin'));
ok('a pending invite is said to be pending', participantTags({ isPending: true }).includes('Pending'));
ok('a bot is said to be a bot', participantTags({ isNetworkBot: true }).includes('Bot'));
ok('an ordinary person has no tags', participantTags(signalContact).length === 0);
ok('you come before admin in the tags', participantTags({ isSelf: true, isAdmin: true })[0] === 'You');

// --- the list ---------------------------------------------------------------

const group = {
  id: '!group',
  type: 'group',
  title: 'Eric, Hallie, Mike & 2 others',
  participants: {
    total: 5,
    items: [
      { id: '@mike:beeper.com', username: 'mike:beeper.com' },
      { id: '@eric:beeper.com', username: 'eric:beeper.com', isAdmin: true },
      { id: '@you:beeper.com', username: 'you:beeper.com', isSelf: true },
      { id: '@hallie:beeper.com', username: 'hallie:beeper.com' },
      { id: '@zoe:beeper.com', username: 'zoe:beeper.com' },
    ],
  },
};

const listed = participantList(group);
ok('everybody in the conversation is listed', listed.people.length === 5, 'got ' + listed.people.length);
ok('none of them is hidden', listed.hidden === 0);
ok('you are first', listed.people[0].id === '@you:beeper.com', listed.people[0].id);
ok('the admins come next', listed.people[1].id === '@eric:beeper.com', listed.people[1].id);
ok(
  'the rest are by name',
  listed.people.slice(2).map((p) => p.name).join(',') === 'hallie:beeper.com,mike:beeper.com,zoe:beeper.com',
  listed.people.slice(2).map((p) => p.name).join(','),
);
ok(
  'the list does not reshuffle itself',
  participantList(group).people.map((p) => p.id).join(',') === listed.people.map((p) => p.id).join(','),
);
ok('the names are the friendliest ones', listed.people[0].name === 'you:beeper.com');
ok(
  'a list built without the numbers has no numbers',
  listed.people.every((p) => p.phone === ''),
  'the numbers are not in the chat record, so a list that has not been given them has none',
);

// A person cannot be in the room twice, and a merged conversation can list the
// same account more than once.
const doubled = participantList({
  participants: {
    total: 2,
    items: [
      { id: '@eric:beeper.com', username: 'eric:beeper.com' },
      { id: '@eric:beeper.com', username: 'eric:beeper.com' },
    ],
  },
});
ok('the same account is not listed twice', doubled.people.length === 1, 'got ' + doubled.people.length);

// The server says how many are in the conversation. When it says more than it
// sent, the difference has to be said rather than quietly dropped.
const partial = participantList({
  participants: { total: 40, items: [{ id: '@a:b', username: 'a:b' }] },
});
ok('the ones that were not sent are counted', partial.hidden === 39, 'got ' + partial.hidden);
ok('the ones that were sent are listed', partial.people.length === 1);

// A conversation with nobody in it is not a crash.
ok('a chat with no participants lists nobody', participantList({}).people.length === 0);
ok('a chat with no participants hides nobody', participantList({}).hidden === 0);
ok('a chat with no items and no total lists nobody', participantList({ participants: {} }).people.length === 0);
ok('a chat with a broken item does not crash', participantList({ participants: { items: [null, {}, { id: '@a:b' }] } }).people.length === 1);

// --- the numbers reach the list ---------------------------------------------

const withNumbers = participantList(
  {
    participants: {
      total: 2,
      items: [signalContact, namedVoiceContact],
    },
  },
  { numbers }
);
ok(
  'a list given the numbers shows them',
  withNumbers.people.map((p) => p.phone).join(',') === '+15159887152,+15158659563',
  withNumbers.people.map((p) => p.phone).join(','),
);
ok(
  'and the names are still the names',
  withNumbers.people.map((p) => p.name).join(',') === 'Jim Kraai,Kevin Nabity',
  withNumbers.people.map((p) => p.name).join(','),
);
ok(
  'a person with no number in the map is given none',
  participantList({ participants: { items: [{ id: '@nobody:y', fullName: 'Nobody' }] } }, { numbers })
    .people[0].phone === '',
);

// The control: the list is worth showing before the numbers arrive, and the
// numbers change what is in it. A check that only ever saw the list WITH the
// numbers would not notice if the numbers were never read.
{
  const without = participantList({ participants: { items: [signalContact] } });
  const with2 = participantList({ participants: { items: [signalContact] } }, { numbers });
  ok(
    'CONTROL: the numbers are what change between the two lists',
    without.people[0].phone === '' && with2.people[0].phone === '+15159887152',
    `without: "${without.people[0].phone}" with: "${with2.people[0].phone}"`,
  );
  ok('and the name is the same in both', without.people[0].name === with2.people[0].name);
}

// The control: the title is what hides people in the first place, so the list
// has to be longer than the title is.
{
  const named = 'Eric, Hallie, Mike & 2 others';
  const shown = listed.people.length;
  ok(
    'CONTROL: the list shows more people than the title names',
    shown > 3,
    `the title names 3 of ${shown}`,
  );
  ok('and the title really is the truncated one', named.includes('& 2 others'));
}

console.log(`\n${fails ? 'FAIL' : 'OK'}  ${fails} failing of the cases above.`);
process.exit(fails ? 1 : 0);
