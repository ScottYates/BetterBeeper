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
  mergeParticipants,
  nameMap,
  applyNames,
  mergeChatInfo,
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

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
