/**
 * Dev check: when somebody read a message of yours.
 *
 * Beeper's `seen` map names every account that has read a message, and on a
 * message of yours it names *you* first, with the time your own window marked
 * the conversation read - a second or two after you hit send, because the
 * message is on screen in your window as you send it.
 *
 * That is not a delivery. Measured on the live account: of 246 messages of
 * yours carrying a seen map, 242 named only your own account, with a median
 * gap of **zero minutes** between the send and the "read" - and the four that
 * named somebody else were 0.1 to 108 minutes later, which is what a delivery
 * looks like.
 *
 * The rules live in `read-receipts.js`, which touches no DOM, so this suite
 * runs it under plain Node. No Electron, no window, no account and no network.
 *
 * Run with `npm run check:readreceipts`.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = pathToFileURL(
  path.join(ROOT, 'src', 'renderer', 'js', 'read-receipts.js'),
).href;

/**
 * The rules, if they can be loaded.
 *
 * The import is dynamic and inside a try/catch, so a module that reaches for
 * the DOM is a case that fails, not a suite that never starts.
 */
let receipts = null;
let importError = '';
try {
  receipts = await import(MODULE);
} catch (err) {
  importError = err && err.message ? err.message : String(err);
}

const cases = [];
const add = (name, fn) => {
  let ok = false;
  let detail = '';
  try {
    const result = fn();
    ok = result === true;
    if (result !== true) detail = String(result);
  } catch (err) {
    ok = false;
    detail = err && err.message ? err.message : String(err);
  }
  cases.push([name, ok, detail]);
};

const withRules = (fn) => {
  if (!receipts) return () => importError || 'the module could not be loaded';
  return () => fn(receipts);
};

// The load itself is a case. A rule that needs a window is a bug this suite
// exists to catch, so it is named rather than hidden.
add('the rules can be checked without a window', () =>
  receipts !== null || ('the module could not be loaded: ' + importError));

// The chat as the live account has it: exactly one participant marked self.
const chat = {
  id: 'c1',
  participants: {
    items: [
      { id: '@me:x', isSelf: true },
      { id: '@them:x', isSelf: false },
    ],
  },
};
const groupChat = {
  id: 'c2',
  participants: {
    items: [
      { id: '@me:x', isSelf: true },
      { id: '@them:x', isSelf: false },
      { id: '@other:x', isSelf: false },
    ],
  },
};
const SENT = '2026-11-09T12:00:00.000Z';
const message = (over) => Object.assign({
  id: 'm1',
  chatID: 'c1',
  isSender: true,
  senderID: '@me:x',
  text: 'hello',
  timestamp: SENT,
}, over || {});

// --- who is me ---------------------------------------------------------------

add('the chat says which participant is me', withRules((R) => {
  const ids = R.selfReaderIds(chat, message());
  return (ids.has('@me:x') && !ids.has('@them:x'))
    || ('it says ' + JSON.stringify([...ids]));
}));

add('CONTROL: a chat with no participant list falls back to the sender', withRules((R) => {
  // A message of yours came from you, so your sender id in that chat is you.
  const ids = R.selfReaderIds({}, message());
  return (ids.has('@me:x') && ids.size === 1)
    || ('it says ' + JSON.stringify([...ids]));
}));

// --- the delivery time -------------------------------------------------------

add('your own read of your own message is not a delivery', withRules((R) => {
  // The measured shape: the seen map names only you, a second after the send.
  const m = message({ seen: { '@me:x': '2026-11-09T12:00:03.000Z' } });
  const when = R.deliveryTime(m, R.selfReaderIds(chat, m));
  return when === null || ('it said ' + JSON.stringify(when));
}));

add('CONTROL: when somebody else has read it, that is the delivery', withRules((R) => {
  const m = message({
    seen: { '@me:x': '2026-11-09T12:00:03.000Z', '@them:x': '2026-11-09T12:17:36.000Z' },
  });
  const when = R.deliveryTime(m, R.selfReaderIds(chat, m));
  return when === '2026-11-09T12:17:36.000Z' || ('it said ' + JSON.stringify(when));
}));

add('the newest read wins when several people have read it', withRules((R) => {
  const m = message({
    seen: {
      '@me:x': '2026-11-09T12:00:03.000Z',
      '@them:x': '2026-11-09T12:17:36.000Z',
      '@other:x': '2026-11-09T13:02:11.000Z',
    },
  });
  const when = R.deliveryTime(m, R.selfReaderIds(groupChat, m));
  return when === '2026-11-09T13:02:11.000Z' || ('it said ' + JSON.stringify(when));
}));

add('CONTROL: a message nobody else has read has no delivery', withRules((R) => {
  const m = message({});
  const when = R.deliveryTime(m, R.selfReaderIds(chat, m));
  return when === null || ('it said ' + JSON.stringify(when));
}));

add('CONTROL: a bare true is not a time and has no delivery', withRules((R) => {
  const m = message({ seen: true });
  const when = R.deliveryTime(m, R.selfReaderIds(chat, m));
  return when === null || ('it said ' + JSON.stringify(when));
}));

add('CONTROL: an unreadable time is ignored rather than shown', withRules((R) => {
  const m = message({ seen: { '@them:x': 'not a time' } });
  const when = R.deliveryTime(m, R.selfReaderIds(chat, m));
  return when === null || ('it said ' + JSON.stringify(when));
}));

// --- the text on the message -------------------------------------------------

add('the receipt is two ticks and the time', withRules((R) => {
  const text = R.deliveryText('2026-11-09T12:17:36.000Z', SENT);
  return (text.startsWith('\u2713\u2713 ') && text.length > 6)
    || ('it said ' + JSON.stringify(text));
}));

add('CONTROL: the receipt is the other person\'s time, not yours', withRules((R) => {
  // The text is written in local time, so the expectation is written in local
  // time too: a hardcoded clock time is only right in some of the world's
  // timezones.
  const mineAt = '2026-11-09T12:00:03.000Z';
  const theirsAt = '2026-11-09T12:17:36.000Z';
  const localOf = (iso) => new Intl.DateTimeFormat(
    undefined, { hour: 'numeric', minute: '2-digit' },
  ).format(new Date(iso));
  const mine = R.deliveryText(mineAt, SENT);
  const theirs = R.deliveryText(theirsAt, SENT);
  return (mine !== theirs && theirs.includes(localOf(theirsAt)))
    || ('they said ' + JSON.stringify(mine) + ' and ' + JSON.stringify(theirs));
}));

add('a read on the same day carries only the time', withRules((R) => {
  // Local noon, read local a quarter past: the same day wherever this runs.
  const sent = new Date(2026, 10, 9, 12, 0, 0).toISOString();
  const read = new Date(2026, 10, 9, 12, 17, 0).toISOString();
  const expected = new Intl.DateTimeFormat(
    undefined, { hour: 'numeric', minute: '2-digit' },
  ).format(new Date(read));
  const text = R.deliveryText(read, sent);
  return text === '\u2713\u2713 ' + expected || ('it said ' + JSON.stringify(text));
}));

add('a read on another day carries the date as well', withRules((R) => {
  // 11pm, read at 8am the next morning: "8:03 AM" alone reads as the morning
  // before, which is the wrong morning.
  const sent = new Date(2026, 10, 9, 23, 0, 0).toISOString();
  const read = new Date(2026, 10, 10, 8, 3, 0).toISOString();
  const month = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(read));
  const text = R.deliveryText(read, sent);
  return (text.includes(month) && /\d/.test(text))
    || ('it said ' + JSON.stringify(text));
}));

add('CONTROL: no delivery time means no receipt text', withRules((R) =>
  R.deliveryText(null, SENT) === '' || 'it said something'));

// --- the report --------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
