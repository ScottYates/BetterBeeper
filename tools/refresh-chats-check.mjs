/**
 * Dev check: the chat list refresh tells the truth about what arrived.
 *
 * The refresh button exists for one question - has a new chat come in - and
 * its answer is read off a diff. A diff that is wrong in the wrong direction
 * is worse than no button at all: announcing a chat that did not arrive
 * sends the user looking for a conversation that is not there, and staying
 * quiet about one that did leaves them looking at a stale list.
 *
 * So the diff is compared on ids, and the check says so explicitly. A chat
 * that was renamed or that received a message is the same chat, and a diff
 * that noticed those would announce them as new.
 *
 * The wording is tested separately from the diff, because the two can be
 * right in opposite ways: a diff that finds one new chat paired with a
 * message that says "new chats" is still a wrong answer.
 *
 * Run with `npm run check:refreshchats`.
 */
import { newChats, refreshOutcome } from '../src/renderer/js/chat-list-refresh.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) fails += 1;
};

const chat = (id, over = {}) => ({ id, title: 'Chat ' + id, ...over });

// --- the diff ---------------------------------------------------------------

const known = new Set(['a', 'b', 'c']);

ok(
  'a chat that was already on screen is not new',
  newChats(known, [chat('a')]).length === 0,
);
ok(
  'a chat that was not on screen is new',
  newChats(known, [chat('z')]).length === 1,
);
ok(
  'only the one that arrived is new',
  newChats(known, [chat('a'), chat('z'), chat('b')]).length === 1,
);
ok(
  'the new chat is the one that is reported',
  newChats(known, [chat('a'), chat('z')])[0]?.id === 'z',
);
ok(
  'a renamed chat is not a new chat',
  newChats(known, [chat('a', { title: 'Renamed' })]).length === 0,
  'it has the same id, so it is the same conversation',
);
ok(
  'a chat that received a message is not a new chat',
  newChats(known, [chat('a', { lastActivity: '2026-10-20T00:00:00.000Z' })]).length === 0,
);
ok(
  'a chat with the same title but a different id is a new chat',
  newChats(known, [chat('z', { title: 'Chat a' })]).length === 1,
  'this is what a title-based diff would get wrong',
);
ok(
  'the same chat twice in one response is counted once',
  newChats(known, [chat('z'), chat('z')]).length === 1,
);
ok(
  'a chat with no id is ignored',
  newChats(known, [{ title: 'no id' }]).length === 0,
);
ok(
  'an empty response finds nothing',
  newChats(known, []).length === 0,
);
ok(
  'a missing response does not throw',
  newChats(known, undefined).length === 0,
);
ok(
  'a missing known set does not throw',
  newChats(undefined, [chat('z')]).length === 1,
);
ok(
  'an array of known ids works as well as a set',
  newChats(['a', 'b'], [chat('a'), chat('z')]).length === 1,
);

// --- the wording -----------------------------------------------------------

ok(
  'one new chat reads as one',
  refreshOutcome([chat('z')], true, 5).message === '1 new chat',
  refreshOutcome([chat('z')], true, 5).message,
);
ok(
  'several new chats are counted',
  refreshOutcome([chat('z'), chat('y')], true, 5).message === '2 new chats',
  refreshOutcome([chat('z'), chat('y')], true, 5).message,
);
ok(
  'nothing new says so, rather than saying nothing',
  refreshOutcome([], true, 5).message === 'No new chats',
  refreshOutcome([], true, 5).message,
);
ok(
  'nothing new is not dressed up as a success',
  refreshOutcome([], true, 5).kind === 'info',
);
ok(
  'a new chat is a success',
  refreshOutcome([chat('z')], true, 5).kind === 'success',
);
ok(
  'an empty list that had never loaded reports the load, not arrivals',
  refreshOutcome([chat('a'), chat('b')], false, 2).message === 'Loaded 2 chats',
  refreshOutcome([chat('a'), chat('b')], false, 2).message,
);
ok(
  'and never calls them new, because they are new to nobody',
  !/new/i.test(refreshOutcome([chat('a')], false, 1).message),
  refreshOutcome([chat('a')], false, 1).message,
);
ok(
  'an empty account says it found nothing',
  refreshOutcome([], false, 0).message === 'No chats found',
  refreshOutcome([], false, 0).message,
);
ok(
  'a single chat is not pluralised',
  !/chats/.test(refreshOutcome([], false, 1).message),
  refreshOutcome([], false, 1).message,
);

// --- the control ------------------------------------------------------------
//
// The whole point of the check is that it would catch a diff that got the
// comparison wrong. This is what that failure would look like, run on
// purpose: it compares titles instead of ids, and so reports a chat that was
// merely renamed as a brand new conversation.
const titleDiff = (knownIDs, items) => {
  const titles = new Set(
    (knownIDs instanceof Set ? [...knownIDs] : knownIDs || []).map((id) => 'Chat ' + id),
  );
  return (items || []).filter((c) => c?.title && !titles.has(c.title));
};

ok(
  'CONTROL: a title-based diff does call a renamed chat new',
  titleDiff(known, [chat('a', { title: 'Renamed' })]).length === 1,
  'it is the mistake the real diff does not make',
);
ok(
  'and the real diff does not',
  newChats(known, [chat('a', { title: 'Renamed' })]).length === 0,
);

console.log(`\n${fails ? 'FAIL' : 'OK'}  ${fails} failing of the cases above.`);
process.exit(fails ? 1 : 0);
