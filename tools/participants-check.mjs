/**
 * Dev check: the people in a conversation are named and ordered properly.
 *
 * The point of the list is that a group's title hides people - Beeper writes
 * "Eric, Hallie, Mike & 2 others" and names three of five - so the list has
 * to show all of them, and has to show them the way the reader would name
 * them. A list that says "eric:beeper.com" where a person is called Eric, or
 * that shows the same account twice, is worse than no list at all.
 *
 * The fixtures are the real shapes, measured against the live account: a
 * Beeper account with a username and no name, a Signal contact with a name
 * and a phone number, and a Google Voice contact whose name is its own
 * number.
 *
 * Run with `npm run check:participants`.
 */
import {
  participantName,
  participantDetail,
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

// A Signal contact. A name, a number, and an id nobody can read.
const signalContact = {
  id: '@g1dvtdhUgwiwN6W9x_gy2xUPmBQGVal745KScIT-FG2hxIbW0AP7qZC6x-JYVngnQy4ddEQgaK1T40qI8kapLw:local-signal.localhost',
  phoneNumber: '+15159887152',
  fullName: 'Jim Kraai',
  isSelf: false,
  isAdmin: false,
  isPending: false,
  isNetworkBot: false,
  cannotMessage: false,
};

// A Google Voice contact, whose name is its own number.
const voiceContact = {
  id: '@voice:beeper.com',
  phoneNumber: '+15154932243',
  fullName: '+15154932243',
  isSelf: false,
  isAdmin: false,
  isPending: false,
  isNetworkBot: false,
  cannotMessage: false,
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

ok('a contact with a number shows it', participantDetail(signalContact) === '+15159887152');
ok(
  'an account whose id is its address shows nothing extra',
  participantDetail(beeperAccount) === '',
  'the id is the username with an @ in front, and printing both is noise',
);
ok('a contact whose name is its number shows nothing extra', participantDetail(voiceContact) === '');
ok(
  'a number written two ways is still one number',
  participantDetail({ fullName: '+1 515-988-3633', phoneNumber: '+15159883633' }) === '',
  'the name is already the number',
);
ok(
  'two different numbers are not the same number',
  participantDetail({ fullName: '+1 515-988-3633', phoneNumber: '+15159887152' }) === '+15159887152',
);
ok(
  'a raw address is never put under a name',
  participantDetail({ id: '@someone:elsewhere', fullName: 'Someone' }) === '',
  'an id is the last resort for the name, never a second line under it',
);
ok('a participant with nothing at all shows nothing', participantDetail(undefined) === '');

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
