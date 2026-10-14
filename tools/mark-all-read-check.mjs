/**
 * Dev check: mark-all-read picks the right chats and visits all of them.
 *
 * Both halves of this have a failure mode that produces no error at all. The
 * selection can quietly include a chat the user cannot see, or miss every chat
 * whose count came back in an unexpected shape. The batching can quietly skip
 * its tail - a loop stepping by the batch size over a shrinking array - and the
 * symptom is a handful of chats still sitting unread with no indication why.
 *
 * The last case is the control: a batching loop written the wrong way, run
 * here on purpose, which is what proves the other cases are measuring
 * something.
 *
 * Run with `npm run check:markallread`.
 */
import { markAllTargets, inBatches } from '../src/renderer/js/mark-all-read.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) fails += 1;
};

const chat = (id, unreadCount, over = {}) => ({ id, unreadCount, ...over });

// --- which chats -----------------------------------------------------------

ok('an unread chat is a target', markAllTargets([chat('a', 3)]).length === 1);
ok('a read chat is not', markAllTargets([chat('a', 0)]).length === 0);
ok(
  'a missing count is treated as read, not as unknown',
  markAllTargets([{ id: 'a' }]).length === 0,
);
ok(
  'a count of 1 is a target - zero is the only boundary',
  markAllTargets([chat('a', 1)]).length === 1,
);
ok(
  'a count arriving as a string still counts',
  markAllTargets([chat('a', '7')]).length === 1,
);
ok(
  'a merged-away chat is never a target',
  markAllTargets([chat('a', 5, { mergedIntoChatID: 'b' })]).length === 0,
  'it is not a row anyone can click',
);
ok(
  'selection keeps only the unread among a mixed list',
  (() => {
    const picked = markAllTargets([
      chat('read', 0), chat('unread', 4), chat('merged', 9, { mergedIntoChatID: 'z' }),
      chat('read2', 0), chat('unread2', 1),
    ]);
    return picked.map((c) => c.id).join(',') === 'unread,unread2';
  })(),
);
ok('an empty inbox has nothing to mark', markAllTargets([]).length === 0);
ok('a missing chat list does not throw', markAllTargets(undefined).length === 0);

// --- batching --------------------------------------------------------------

const ids = (n) => Array.from({ length: n }, (_, i) => `c${i}`);
const record = async (item) => item;
const seen = [];
const collect = async (item) => { seen.push(item); return item; };

ok('one item runs once', (await inBatches(ids(1), 4, collect)).length === 1);
ok(
  'no items runs nothing',
  (await inBatches([], 4, collect)).length === 0,
);

const results = await inBatches(ids(89), 4, record);
ok('89 items come back as 89 results', results.length === 89, `got ${results.length}`);
ok(
  'and they come back in order',
  results.join(',') === ids(89).join(','),
);

seen.length = 0;
await inBatches(ids(89), 4, collect);
ok('every item was visited exactly once', seen.length === 89, `visited ${seen.length}`);
ok(
  'and no item was visited twice',
  new Set(seen).size === 89,
);

// The batch really is a batch, not a queue of one.
let inFlight = 0;
let peak = 0;
await inBatches(ids(20), 4, async (item) => {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await new Promise((r) => setTimeout(r, 1));
  inFlight -= 1;
  return item;
});
ok('no more than the batch size run at once', peak <= 4, `peak was ${peak}`);
ok('and the batch is actually used', peak > 1, `peak was ${peak}, so it ran one at a time`);

// The control. The mistake this guards against is stepping by the batch size
// while consuming the array, which silently drops the tail: with 89 chats and
// a batch of 4 that is 5 chats never marked read and no error anywhere.
seen.length = 0;
const shrinkAndStep = async (items, size, work) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const settled = await Promise.all(items.splice(i, size).map(work));
    out.push(...settled);
  }
  return out;
};
const wrong = await shrinkAndStep(ids(89), 4, collect);
ok(
  'CONTROL: the wrong batching loop does drop its tail',
  wrong.length < 89 && seen.length < 89,
  `it visited ${seen.length} of 89, which is the bug the real loop does not have`,
);

console.log(`\n${fails ? 'FAIL' : 'OK'}  ${fails} failing of the cases above.`);
process.exit(fails ? 1 : 0);