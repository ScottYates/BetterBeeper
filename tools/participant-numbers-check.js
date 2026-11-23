/**
 * Dev check: the phone numbers of the people in a chat.
 *
 * Beeper's bridge does not send them - a chat's participants arrive with an
 * id, a name and a few flags, and the schema says the phone number is
 * omitted when it is unknown. Measured on the live account on 2026-11-23,
 * not one of the 492 participants across 200 chats carried one.
 *
 * The number is in Beeper Desktop's own store, in `participant_identifiers`,
 * keyed by the very id the bridge hands out. This check reads a store built
 * to the same shape and asks the module to find the numbers in it.
 *
 * The failures are the interesting half. The store belongs to another
 * program: it may not be there, it may be locked, it may be a different file
 * tomorrow, and the table may be gone. None of that may throw. A people
 * list with no numbers in it is still a people list.
 *
 * Run with `npm run check:participantnumbers`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const numbers = require(path.join(ROOT, 'src', 'main', 'participant-numbers.js'));

let fails = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) fails += 1;
};

/** A folder that holds a store of the given shape. */
function makeStore(rows, { table = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-participant-numbers-'));
  const folder = path.join(dir, 'appdata');
  fs.mkdirSync(path.join(folder, 'BeeperTexts'), { recursive: true });
  const file = path.join(folder, 'BeeperTexts', 'index.db');
  if (table) {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE participant_identifiers (
      account_id TEXT, participant_id TEXT, identifier TEXT, identifier_type TEXT
    )`);
    const insert = db.prepare(
      'INSERT INTO participant_identifiers (account_id, participant_id, identifier, identifier_type) VALUES (?, ?, ?, ?)'
    );
    for (const row of rows) insert.run(row[0], row[1], row[2], row[3]);
    db.close();
  }
  return folder;
}

const JIM = '@g1dvtdhUgwiwN6W9x_gy2xUPmBQGVal745KScIT-FG2hxIbW0AP7qZC6x-JYVngnQy4ddEQgaK1T40qI8kapLw:local-signal.localhost';
const KEVIN = '@named:beeper.com';
const ERIC = '@eric:beeper.com';

const store = makeStore([
  ['hungryserv', JIM, '+15159887152', 'phone'],
  ['hungryserv', KEVIN, '+15158659563', 'phone'],
  ['hungryserv', KEVIN, '+15159999999', 'phone'],
  ['hungryserv', JIM, 'jim@example.com', 'email'],
  ['hungryserv', ERIC, 'eric:beeper.com', 'username'],
]);

// ---- the happy path --------------------------------------------------------

numbers.clearCache();
const found = numbers.numbersFor([JIM, KEVIN, ERIC], { appData: store });

ok('the number is found', found[JIM] === '+15159887152', JSON.stringify(found));
ok('a second person is found too', found[KEVIN] === '+15158659563');
ok(
  'a person with no phone number is not given one',
  found[ERIC] === undefined,
  'the answer holds only numbers, and only for the ids that were asked for',
);
ok(
  'only the ids that were asked for come back',
  Object.keys(found).length === 2,
  'got ' + Object.keys(found).length,
);
ok(
  'an identifier that is not a phone number is ignored',
  found[JIM] === '+15159887152',
  'the same person also has an email address, and it must not be offered as a number',
);
ok(
  'a person with two numbers keeps the first',
  found[KEVIN] === '+15158659563',
  'the list is about reaching the person, not about every way to reach them',
);

// ---- the id has to match exactly -------------------------------------------

numbers.clearCache();
const wrong = numbers.numbersFor(['@someone-else:y', JIM + 'x', 'g1dvtdhUgwiwN6W9x_gy2xUPmBQGVal745KSc'], {
  appData: store,
});
ok(
  'an id that is not the same id is not given the number',
  wrong[JIM + 'x'] === undefined && Object.keys(wrong).length === 0,
  JSON.stringify(wrong),
);

// ---- the failures ----------------------------------------------------------

numbers.clearCache();
const missing = numbers.numbersFor([JIM], { appData: path.join(os.tmpdir(), 'bb-no-such-store') });
ok('a store that is not there gives nothing', Object.keys(missing).length === 0);

numbers.clearCache();
const empty = makeStore([], { table: false });
const noTable = numbers.numbersFor([JIM], { appData: empty });
ok('a store with no table gives nothing', Object.keys(noTable).length === 0);

numbers.clearCache();
const junk = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-participant-junk-'));
fs.mkdirSync(path.join(junk, 'BeeperTexts'), { recursive: true });
fs.writeFileSync(path.join(junk, 'BeeperTexts', 'index.db'), 'this is not a database');
const broken = numbers.numbersFor([JIM], { appData: junk });
ok('a store that is not a database gives nothing', Object.keys(broken).length === 0);

numbers.clearCache();
const nothing = numbers.numbersFor(undefined, { appData: store });
ok('asking for nothing gives nothing', Object.keys(nothing).length === 0);

numbers.clearCache();
const odd = numbers.numbersFor([JIM, '', null, 42], { appData: store });
ok('a broken id is ignored', odd[JIM] === '+15159887152' && Object.keys(odd).length === 1);

// ---- the read is cached, and the cache expires -----------------------------

numbers.clearCache();
const first = numbers.numbersFor([JIM], { appData: store, now: 1000 });
ok('the first read finds the number', first[JIM] === '+15159887152');
// Take the store away. The answer must not change: the read is cached, and
// reopening the file on every click would be a lot of work for a list that
// is opened often.
fs.rmSync(path.join(store, 'BeeperTexts', 'index.db'), { force: true });
const cached = numbers.numbersFor([JIM], { appData: store, now: 2000 });
ok('the answer is kept rather than read again', cached[JIM] === '+15159887152', JSON.stringify(cached));

// After the cache has expired, the store is read again - and it is gone.
const expired = numbers.numbersFor([JIM], { appData: store, now: 1000 + 60_000 + 1 });
ok('after the cache expires the store is read again', Object.keys(expired).length === 0, JSON.stringify(expired));

// A failure is not retried on every click either.
numbers.clearCache();
const failedOnce = numbers.numbersFor([JIM], { appData: path.join(os.tmpdir(), 'bb-still-no-store'), now: 5000 });
ok('a store that cannot be read gives nothing', Object.keys(failedOnce).length === 0);
const failedAgain = numbers.numbersFor([JIM], { appData: path.join(os.tmpdir(), 'bb-still-no-store'), now: 6000 });
ok('and asking again does not throw either', Object.keys(failedAgain).length === 0);

// ---- the control -----------------------------------------------------------

// The control: the same read against the same store, with the cache out of
// the way, has to find the number. Without this the cases above could all
// pass on a module that never reads anything at all.
numbers.clearCache();
const control = numbers.numbersFor([KEVIN], { appData: makeStore([
  ['hungryserv', KEVIN, '+15158659563', 'phone'],
]) });
ok('CONTROL: a store that is there is read', control[KEVIN] === '+15158659563', JSON.stringify(control));

// And the other control: a store that is there but holds no such row has
// nothing to give, which is what makes the case above mean something.
numbers.clearCache();
const other = numbers.numbersFor([KEVIN], { appData: makeStore([
  ['hungryserv', JIM, '+15159887152', 'phone'],
]) });
ok('CONTROL: and a store without that row gives nothing', other[KEVIN] === undefined);

console.log(`\n${fails ? 'FAIL' : 'OK'}  ${fails} failing of the cases above.`);
process.exit(fails ? 1 : 0);
