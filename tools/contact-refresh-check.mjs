/**
 * Dev check: refreshing a conversation also re-checks the people in it.
 *
 * Two halves, and both fail quietly.
 *
 * The decisions are in contact-refresh.js: which name a participant goes by,
 * what to do with a participant list that came back short, and which messages
 * get a new name put on them. The dangerous one is the short list. Beeper's
 * schema says the participants "may be a subset" - limited by the request -
 * so a chat with forty members can come back with five, and treating that as
 * the whole list would take thirty-five people out of the app because the
 * response was short rather than because anyone left.
 *
 * The other half is the store, which holds every message in the chat rather
 * than the page on screen. The renderer can only rename what it is showing;
 * the rest of the conversation is the store's, and without it the old names
 * come back the next time the app starts.
 *
 * And then there is the quietest failure of the lot: a refresh that changed
 * nothing looks exactly like a refresh that was broken, because neither of
 * them said anything. Most of the time nothing has changed. And for a contact
 * Beeper knows only by a number - 68 of the 123 Google Voice contacts on the
 * live account - nothing ever will. So the refresh has to be able to say
 * which of the two happened.
 *
 * Plain node, no Electron: message-store.js deliberately imports nothing from
 * electron so it can be exercised here.
 *
 * Run with: npm run check:contactrefresh.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contactName,
  isPhoneNumber,
  mergeParticipants,
  nameMap,
  applyNames,
  mergeChatInfo,
  contactReport,
  contactRefreshMessage,
} from '../src/renderer/js/contact-refresh.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { openMessageStore } = require(path.join(ROOT, 'src', 'main', 'message-store.js'));

const cases = [];

function add(name, fn) {
  let ok = false;
  let detail = '';
  try {
    // A plain boolean is fine for the simple cases; a function is used where
    // the work would otherwise sit in the argument list.
    const r = typeof fn === 'function' ? fn() : fn;
    ok = r === true;
    if (r !== true) detail = String(r);
  } catch (e) {
    ok = false;
    detail = e && (e.stack || e.message);
  }
  cases.push([name, ok, detail]);
}

// ---------------------------------------------------------------------------
// The name a participant goes by
// ---------------------------------------------------------------------------

add('a full name is the name', contactName({ fullName: 'Bea Example' }) === 'Bea Example');
add('a username is used when there is no full name', contactName({ username: 'bea' }) === 'bea');
add(
  'a full name that is only spaces is not a name',
  contactName({ fullName: '   ', username: 'bea' }) === 'bea',
  'and the username is used instead',
);
add(
  'a participant with nothing to call them has no name',
  contactName({ phoneNumber: '+15551234' }) === null,
  'a number is contact information, not a name',
);
add('a missing participant has no name', contactName(null) === null);
add('a name is trimmed', contactName({ fullName: '  Bea  ' }) === 'Bea');

// ---------------------------------------------------------------------------
// A number is not a name
// ---------------------------------------------------------------------------
//
// Beeper puts the number in fullName for a contact it has no name for, so
// "the name is a number" is the normal case for a phone network and not the
// rare one. Measured on the live account: 68 of the 123 Google Voice contacts
// Beeper Desktop keeps are called by their number, and 53 have a real name.
//
// The damage this does is not that a number is shown - the thread shows
// numbers in the subtitle anyway, and that is right. The damage is that a
// number is written over a name we already had.

add('a telephone number is a number', isPhoneNumber('+16414858965') === true);
add('a number written the way people write them is a number', isPhoneNumber('+1 515-988-3633') === true);
add('a number with brackets is a number', isPhoneNumber('(515) 988-3633') === true);
add('a short code is a number too', isPhoneNumber('89464') === true);
add('a name is not a number', isPhoneNumber('Trae Johnson') === false);
add('a name with a number in it is not a number', isPhoneNumber('Agent 47') === false);
add('nothing at all is not a number', isPhoneNumber('') === false);
add('something that is not a string is not a number', isPhoneNumber(null) === false);

add(
  'a name that is only a number is not a name',
  contactName({ fullName: '+16414858965' }) === null,
  'Beeper calls a contact it has no name for by its number, and that is not a name',
);
add(
  'a username is used when the full name is only a number',
  contactName({ fullName: '+16414858965', username: 'trae' }) === 'trae',
);
add(
  'a participant whose name is a number is left out of the map',
  !nameMap([{ id: '!num', fullName: '+16414858965' }]).has('!num'),
  'so a number can never be written over a name we already have',
);

// ---------------------------------------------------------------------------
// The map from person to name
// ---------------------------------------------------------------------------

const names = nameMap([
  { id: '!u1', fullName: 'Bea Example' },
  { id: '!u2', username: 'sam' },
  { id: '!u3', phoneNumber: '+15551234' },
  { fullName: 'Nobody In Particular' },
]);

add('a named participant is in the map', names.get('!u1') === 'Bea Example');
add('a participant with only a username is in the map', names.get('!u2') === 'sam');
add(
  'a participant we cannot name is left out',
  !names.has('!u3'),
  'so applying it can never blank a name we already had',
);
add('a participant with no id is left out', !names.has('undefined'));
add('the map holds only the people we can name', names.size === 2);

// ---------------------------------------------------------------------------
// A participant list that came back short
// ---------------------------------------------------------------------------

const known = {
  items: [
    { id: '!a', fullName: 'Ada' },
    { id: '!b', fullName: 'Bea' },
    { id: '!c', fullName: 'Cy' },
  ],
  hasMore: false,
  total: 3,
};

add(
  'a complete list replaces the one we had',
  mergeParticipants(known, { items: [{ id: '!a', fullName: 'Ada' }, { id: '!b', fullName: 'Bea' }], hasMore: false, total: 2 })
    .items.length === 2,
  'somebody left, and that is real',
);
add(
  'a list that claims more than it carries is merged, not applied',
  mergeParticipants(known, { items: [{ id: '!a', fullName: 'Ada' }], hasMore: false, total: 3 }).items.length === 3,
  'the other two are still in the chat, the response was just short',
);
add(
  'a list that says there is more is merged, not applied',
  mergeParticipants(known, { items: [{ id: '!a', fullName: 'Ada' }], hasMore: true, total: 3 }).items.length === 3,
);
add(
  'an empty list is no information, not nobody',
  mergeParticipants(known, { items: [], hasMore: false, total: 0 }).items.length === 3,
  'a chat always has at least you in it',
);
add(
  'the fresh copy of a person wins',
  mergeParticipants(known, { items: [{ id: '!a', fullName: 'Ada Lovelace' }], hasMore: true, total: 3 })
    .items.find((p) => p.id === '!a').fullName === 'Ada Lovelace',
);
add(
  'somebody new is added',
  mergeParticipants(known, { items: [{ id: '!d', fullName: 'Dee' }], hasMore: true, total: 4 }).items.length === 4,
);
add(
  'a merged list keeps the people we knew about first',
  mergeParticipants(known, { items: [{ id: '!d', fullName: 'Dee' }], hasMore: true, total: 4 })
    .items.map((p) => p.id).join(',') === '!a,!b,!c,!d',
);
add(
  'with no previous list, the fresh one is the list',
  mergeParticipants(null, { items: [{ id: '!a', fullName: 'Ada' }], hasMore: false, total: 1 }).items.length === 1,
);
add(
  'with no fresh list, the previous one is kept',
  mergeParticipants(known, null).items.length === 3,
);

// ---------------------------------------------------------------------------
// Putting names on messages
// ---------------------------------------------------------------------------

const held = [
  { id: 'm1', senderID: '!a', senderName: 'Ada', isSender: false },
  { id: 'm2', senderID: '!b', senderName: 'Bea', isSender: false },
  { id: 'm3', senderID: '!me', senderName: 'You', isSender: true },
  { id: 'm4', senderID: '!c', senderName: 'Cy', isSender: false },
];

const applied = applyNames(held, new Map([['!a', 'Ada Lovelace']]));

add('a renamed person gets the new name', applied.messages[0].senderName === 'Ada Lovelace');
add('everybody else keeps theirs', applied.messages[1].senderName === 'Bea');
add(
  'your own messages are left alone',
  // The map has to name you as well, or this would pass because there was no
  // name to apply rather than because your messages are protected.
  applyNames(held, new Map([['!me', 'Ada Lovelace']])).messages[2].senderName === 'You',
);
add(
  'somebody we have no name for keeps theirs',
  applyNames(held, new Map([['!zz', 'Nobody']])).messages[3].senderName === 'Cy',
);
add(
  'a name we already have is not reported as a change',
  applyNames(held, new Map([['!b', 'Bea']])).renamed.length === 0,
);
add('only the changed message is reported', applied.renamed.length === 1);
add('the reported message is the new one', applied.renamed[0].id === 'm1');
add(
  'the list we were given is not changed underneath us',
  held[0].senderName === 'Ada',
  'a rename must not mutate the state the caller still holds',
);
add(
  'a message with no sender keeps its name',
  applyNames([{ id: 'm9', senderName: 'Somebody' }], new Map([['!a', 'Ada']])).messages[0].senderName === 'Somebody',
);
add(
  'no names at all changes nothing',
  applyNames(held, new Map()).renamed.length === 0,
);

// ---------------------------------------------------------------------------
// You
// ---------------------------------------------------------------------------
//
// Your own messages are not renamed: they are already labelled as yours. The
// screen has always known that, and the store has to know it too, or the app
// and the store end up saying different things about the same message.

const withYou = [
  { id: '!me', fullName: 'Scott Yates', isSelf: true },
  { id: '!them', fullName: 'Bea Example' },
];

add(
  'you are in the map that puts names on the screen',
  nameMap(withYou).has('!me'),
);
add(
  'you are left out of the map that goes to the store',
  !nameMap(withYou, { skipSelf: true }).has('!me'),
  'your own messages are not renamed, and the store has to agree with the screen',
);
add(
  'everybody else is still in the map that goes to the store',
  nameMap(withYou, { skipSelf: true }).get('!them') === 'Bea Example',
);

// ---------------------------------------------------------------------------
// What a refresh found
// ---------------------------------------------------------------------------
//
// A refresh that changed nothing used to look exactly like a refresh that was
// broken, because neither of them said anything. Most of the time nothing has
// changed, and when there is no name to be had - a Google Voice contact
// Beeper knows only by a number - that is the answer rather than a failure.
// So the refresh has to be able to say which of the two it was.

const reportPeople = [
  { id: '!a', fullName: 'Ada Lovelace' },
  { id: '!b', fullName: '+16414858965', phoneNumber: '+16414858965' },
  { id: '!me', fullName: '+1 515-988-3633', phoneNumber: '+15159883633', isSelf: true },
];
const reportMsgs = [
  { id: 'm1', senderID: '!a', senderName: 'Ada', isSender: false },
  { id: 'm2', senderID: '!b', senderName: '+16414858965', isSender: false },
  { id: 'm3', senderID: '!me', senderName: 'You', isSender: true },
];
const reportNames = nameMap(reportPeople);
const report = contactReport(reportPeople, reportMsgs, reportNames);

add(
  'the person whose name changed is reported',
  report.renamed.length === 1,
  'and only that person',
);
add(
  'the old name and the new one are both reported',
  report.renamed[0]?.from === 'Ada' && report.renamed[0]?.to === 'Ada Lovelace',
);
add(
  'a person Beeper knows only by a number is reported',
  report.unnamed.join(',') === '+16414858965',
);
add(
  'you are not reported as having no name',
  !report.unnamed.includes('+15159883633'),
  'you do not need a name to be recognised',
);
add(
  'a person with a name is not reported as having none',
  !report.unnamed.includes('Ada Lovelace'),
);
add(
  'a report with nothing in it is still a report',
  contactReport([], [], new Map()).renamed.length === 0
    && contactReport([], [], new Map()).unnamed.length === 0,
);

add(
  'a refresh that changed something says so',
  contactRefreshMessage({ renamed: [{ to: 'Ada Lovelace' }], unnamed: [] }, 4) === 'Updated 4 names: Ada Lovelace',
);
add(
  'one name is not plural',
  contactRefreshMessage({ renamed: [{ to: 'Ada Lovelace' }], unnamed: [] }, 1) === 'Updated 1 name: Ada Lovelace',
);
add(
  'a refresh that changed nothing says so',
  contactRefreshMessage({ renamed: [], unnamed: [] }, 0) === 'No contact changes',
);
add(
  'a person Beeper cannot name is said out loud',
  contactRefreshMessage({ renamed: [], unnamed: ['+16414858965'] }, 0) === 'Beeper has no name yet for +16414858965',
);
add(
  'the number of names is what the store wrote',
  contactRefreshMessage({ renamed: [], unnamed: [] }, 12) === 'Updated 12 names',
  'the store holds the whole conversation, and the screen only a page of it',
);

// ---------------------------------------------------------------------------
// The chat record
// ---------------------------------------------------------------------------

const mergedChat = mergeChatInfo(
  { id: 'c1', title: 'Old title', participants: known },
  { id: 'c1', title: 'New title', participants: { items: [{ id: '!a', fullName: 'Ada Lovelace' }], hasMore: true, total: 3 } },
);

add('a fresh field wins', mergedChat.title === 'New title');
add('the people are merged, not replaced', mergedChat.participants.items.length === 3);
add(
  'and the fresh copy of a person wins',
  mergedChat.participants.items.find((p) => p.id === '!a').fullName === 'Ada Lovelace',
);
add('a chat with no fresh record is left alone', mergeChatInfo({ id: 'c1' }, null).id === 'c1');

// The unread count is the one field the server does not get to give back.
// Opening a chat marks it read and says so at once; the server has not
// processed that mark when the record comes back, so writing its count over
// the local one puts the badge straight back on.
add(
  'the unread count the app cleared is not written back by the server',
  mergeChatInfo({ id: 'c1', unreadCount: 0 }, { id: 'c1', unreadCount: 4 }).unreadCount === 0,
);
add(
  'a count the app had is kept even when the fresh record has none',
  mergeChatInfo({ id: 'c1', unreadCount: 2 }, { id: 'c1' }).unreadCount === 2,
);
add(
  'a chat with no count of its own takes the one it is given',
  mergeChatInfo({ id: 'c1' }, { id: 'c1', unreadCount: 3 }).unreadCount === 3,
);

// ---------------------------------------------------------------------------
// The store, which holds every message in the chat
// ---------------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-contact-check-'));
const store = openMessageStore(dir);

const msg = (id, ts, senderID, senderName, chatID = 'c1') => ({
  id, chatID, timestamp: ts, text: 'hello', senderID, senderName,
});

store.upsertMessages('c1', [
  msg('s1', 1000, '!a', 'Ada'),
  msg('s2', 2000, '!a', 'Ada'),
  msg('s3', 3000, '!b', 'Bea'),
]);
store.upsertMessages('c2', [msg('s4', 1000, '!a', 'Ada', 'c2')]);

const storedNames = (chatID) => {
  const { messages } = store.pageWithMore(chatID, { limit: 50 });
  return messages.map((m) => `${m.id}:${m.senderName}`).join(',');
};

add('a rename reaches the messages in the store', () => {
  const written = store.renameSenders('c1', { '!a': 'Ada Lovelace' });
  return written === 2 || ('wrote ' + written + ' messages');
});

add(
  'and the name the renderer reads is the new one',
  storedNames('c1') === 's1:Ada Lovelace,s2:Ada Lovelace,s3:Bea',
  storedNames('c1'),
);
add(
  'a rename in one chat does not touch another',
  storedNames('c2') === 's4:Ada',
  storedNames('c2'),
);
add(
  'renaming again changes nothing',
  store.renameSenders('c1', { '!a': 'Ada Lovelace' }) === 0,
);
add(
  'a name we do not have changes nothing',
  store.renameSenders('c1', { '!zz': 'Nobody' }) === 0,
);
add(
  'a chat with no names at all changes nothing',
  store.renameSenders('c1', {}) === 0,
);
add(
  'the column and the payload agree after a rename',
  (() => {
    const { messages } = store.pageWithMore('c1', { limit: 50 });
    return messages.every((m) => m.senderName === 'Ada Lovelace' || m.senderName === 'Bea');
  })(),
);

store.close();

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------
//
// The decisions are in contact-refresh.js, but the decision to leave you out
// of the store's map is made by the caller, in thread.js, and a check of the
// pure functions cannot see it. So the call is read out of the file and
// checked where it is made.
//
// What is asserted is the shape of the call: a map built with skipSelf, and
// that map is the one handed to the store. Matching the words skipSelf
// anywhere in the file would pass on a call that is not the one being made,
// so both halves have to hold at once.

const threadSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'thread.js'), 'utf8');
const applyContactInfoSrc = (threadSrc.match(/async function applyContactInfo\([^)]*\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';

add('the store is given names that leave you out', () => {
  if (!applyContactInfoSrc) return 'could not find applyContactInfo in thread.js';
  const built = /const\s+(\w+)\s*=\s*nameMap\([^;]*?skipSelf:\s*true[^;]*?\);/.exec(applyContactInfoSrc);
  if (!built) return 'no name map is built with skipSelf';
  const given = new RegExp(`renameSenders\\([^;]*?Object\\.fromEntries\\(\\s*${built[1]}\\s*\\)`);
  if (!given.test(applyContactInfoSrc)) {
    return `the rename is not given the map that leaves you out (${built[1]})`;
  }
  return true;
});

add('the refresh says what it found', () => {
  const refreshSrc = (threadSrc.match(/async function refreshThisChat\([^)]*\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  if (!refreshSrc) return 'could not find refreshThisChat in thread.js';
  if (!/contactRefreshMessage\(/.test(refreshSrc)) return 'the refresh does not work out what to say';
  return /toast\(\s*contactRefreshMessage\(/.test(refreshSrc)
    || 'what it found is worked out but never said';
});

// ---------------------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
