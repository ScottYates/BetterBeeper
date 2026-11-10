/**
 * Dev check: the rules that decide which messages can be edited.
 *
 * These rules used to live in the module that drives the composer edit, and
 * that module imports the UI for its toasts. The UI reaches for `document`
 * the moment it is loaded, so the rules could not be imported without a
 * window: a plain `import()` threw `ReferenceError: document is not defined`
 * before a single case had run.
 *
 * So the rules live in `composer-edit-rules.js`, which imports the utility
 * helpers and nothing else, and this suite runs it under plain Node. No
 * Electron, no window, no account and no network.
 *
 * The module is imported dynamically inside a try/catch on purpose. A module
 * that cannot be loaded without a window then becomes a named failing case
 * instead of a suite that dies before printing anything, which is the
 * difference between a failure that is reported and a failure that is
 * silent.
 *
 * Every case has a control that reproduces the behaviour it replaced,
 * because a suite that has been green over a feature nobody exercised is
 * worse than no suite at all.
 *
 * Run with `npm run check:composereditrules`.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = pathToFileURL(
  path.join(ROOT, 'src', 'renderer', 'js', 'composer-edit-rules.js'),
).href;

/**
 * The rules, if they can be loaded without a window.
 *
 * The import is dynamic and inside a try/catch, so a module that reaches for
 * the DOM is a case that fails, not a suite that never starts.
 */
let rules = null;
let importError = '';
try {
  rules = await import(RULES);
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

/**
 * Hand the rules to a case.
 *
 * When the module could not be loaded, every case that needs it fails with
 * the reason, so the report says why rather than showing a blank failure.
 */
const withRules = (fn) => {
  if (!rules) return () => importError || 'the rules module could not be loaded';
  return () => fn(rules);
};

// The load itself is a case. A rules module that needs a window is the bug
// this suite exists to catch, so it is named rather than hidden.
add('the rules can be checked without a window', () =>
  rules !== null || ('the rules module could not be loaded: ' + importError));

const chat = (caps) => ({ id: 'c1', title: 'A chat', capabilities: caps });
const NOW = Date.parse('2026-11-08T12:00:00Z');
const own = (over) => Object.assign({
  id: 'm1',
  chatID: 'c1',
  isSender: true,
  isDeleted: false,
  type: 'TEXT',
  text: 'hello',
  timestamp: new Date(NOW - 1000).toISOString(),
}, over || {});

// --- the chat's capability ---------------------------------------------------

add('a chat with no capabilities object may be edited', withRules((R) =>
  R.chatAllowsEdit(chat(undefined)) === true || 'it was refused'));

add('CONTROL: a chat that says editing is full may be edited', withRules((R) =>
  R.chatAllowsEdit(chat({ edit: 2 })) === true || 'it was refused'));

add('a chat that says editing is partial may be edited', withRules((R) =>
  R.chatAllowsEdit(chat({ edit: 1 })) === true || 'it was refused'));

add('a chat that says editing is unsupported may not be edited', withRules((R) =>
  R.chatAllowsEdit(chat({ edit: 0 })) === false || 'it was allowed'));

add('a chat that says editing is rejected may not be edited', withRules((R) =>
  R.chatAllowsEdit(chat({ edit: -2 })) === false || 'it was allowed'));

add('a chat whose capabilities have no edit key may not be edited', withRules((R) =>
  R.chatAllowsEdit(chat({ attachments: {}, maxTextLength: 160 })) === false
  || 'it was allowed'));

add('CONTROL: no capabilities object is not the same as no edit key', withRules((R) =>
  (R.chatAllowsEdit(chat(undefined)) === true
    && R.chatAllowsEdit(chat({ maxTextLength: 160 })) === false)
  || 'the two states were treated the same'));

add('the edit window is read in seconds', withRules((R) =>
  R.editMaxAgeSeconds(chat({ edit: 2, editMaxAge: 900 })) === 900
  || ('it read ' + R.editMaxAgeSeconds(chat({ edit: 2, editMaxAge: 900 })))));

add('CONTROL: a chat with no edit window has no age limit', withRules((R) =>
  R.editMaxAgeSeconds(chat({ edit: 2 })) === null
  || ('it read ' + R.editMaxAgeSeconds(chat({ edit: 2 })))));

// --- the message -------------------------------------------------------------

add('your own message can be edited', withRules((R) =>
  R.isEditableMessage(chat({ edit: 2 }), own(), NOW) === true || 'it was refused'));

add("CONTROL: somebody else's message cannot be edited", withRules((R) =>
  R.isEditableMessage(chat({ edit: 2 }), own({ isSender: false }), NOW) === false
  || 'it was allowed'));

add('a deleted message cannot be edited', withRules((R) =>
  R.isEditableMessage(chat({ edit: 2 }), own({ isDeleted: true }), NOW) === false
  || 'it was allowed'));

add('a hidden message cannot be edited', withRules((R) =>
  R.isEditableMessage(chat({ edit: 2 }), own({ isHidden: true }), NOW) === false
  || 'it was allowed'));

add('a message with an attachment cannot be edited', withRules((R) =>
  R.isEditableMessage(
    chat({ edit: 2 }), own({ attachments: [{ mimeType: 'image/png' }] }), NOW,
  ) === false || 'it was allowed'));

add('a message inside the edit window can be edited', withRules((R) =>
  R.isEditableMessage(
    chat({ edit: 2, editMaxAge: 900 }),
    own({ timestamp: new Date(NOW - 600000).toISOString() }),
    NOW,
  ) === true || 'it was refused'));

add('CONTROL: a message past the edit window cannot be edited', withRules((R) =>
  R.isEditableMessage(
    chat({ edit: 2, editMaxAge: 900 }),
    own({ timestamp: new Date(NOW - 1000000).toISOString() }),
    NOW,
  ) === false || 'it was allowed'));

add('CONTROL: a chat with no edit window has no age limit', withRules((R) =>
  R.isEditableMessage(
    chat({ edit: 2 }),
    own({ timestamp: new Date(NOW - 100000000).toISOString() }),
    NOW,
  ) === true || 'an old message was refused'));

add('CONTROL: a message with no timestamp cannot be edited', withRules((R) =>
  R.isEditableMessage(
    chat({ edit: 2, editMaxAge: 900 }), own({ timestamp: null }), NOW,
  ) === false || 'it was allowed'));

add('a read-only chat may not be edited', withRules((R) =>
  R.isEditableMessage(
    { id: 'c1', isReadOnly: true, capabilities: { edit: 2 } }, own(), NOW,
  ) === false || 'it was allowed'));

// --- the messages that only exist on this device -----------------------------

// The optimistic bubble the app puts on screen before the send round trip
// comes back is one of our own messages, it passes every other rule, and it
// is the newest thing in the chat - so the up arrow landed on it and Enter
// then asked Beeper to edit an id it has never heard of. A message that
// Beeper has not confirmed is not editable.
add('a message that has not been sent yet cannot be edited', withRules((R) =>
  R.isEditableMessage(chat({ edit: 2 }), own({ sendStatus: 'pending' }), NOW) === false
  || 'it was allowed'));

add('a message whose send failed cannot be edited', withRules((R) =>
  R.isEditableMessage(chat({ edit: 2 }), own({ sendStatus: 'failed' }), NOW) === false
  || 'it was allowed'));

add('CONTROL: a message that was sent can be edited', withRules((R) =>
  R.isEditableMessage(chat({ edit: 2 }), own({ sendStatus: 'sent' }), NOW) === true
  || 'it was refused'));

// --- the list ----------------------------------------------------------------

add('the editable list is oldest first', withRules((R) => {
  const list = R.editableMessages(chat({ edit: 2 }), [
    own({ id: 'm3', timestamp: new Date(NOW - 3000).toISOString() }),
    own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
    own({ id: 'm2', timestamp: new Date(NOW - 6000).toISOString() }),
  ], NOW);
  return (list.length === 3 && list[0].id === 'm1' && list[2].id === 'm3')
    || ('got ' + list.map((m) => m.id).join(','));
}));

add('CONTROL: the editable list skips everything that cannot be edited', withRules((R) => {
  const list = R.editableMessages(chat({ edit: 2 }), [
    own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
    own({ id: 'm2', isSender: false, timestamp: new Date(NOW - 8000).toISOString() }),
    own({ id: 'm3', attachments: [{}], timestamp: new Date(NOW - 7000).toISOString() }),
    own({ id: 'm4', isDeleted: true, timestamp: new Date(NOW - 6000).toISOString() }),
    own({ id: 'm5', timestamp: new Date(NOW - 5000).toISOString() }),
  ], NOW);
  return (list.length === 2 && list[0].id === 'm1' && list[1].id === 'm5')
    || ('got ' + list.map((m) => m.id).join(','));
}));

add('the same chat and the same messages always give the same list', withRules((R) => {
  const messages = [
    own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
    own({ id: 'm2', timestamp: new Date(NOW - 8000).toISOString() }),
  ];
  const a = R.editableMessages(chat({ edit: 2 }), messages, NOW).map((m) => m.id);
  const b = R.editableMessages(chat({ edit: 2 }), messages, NOW).map((m) => m.id);
  return (a.length === 2 && a.join(',') === b.join(',')) || 'the list changed between calls';
}));

// --- the reason, not just the answer ------------------------------------------
//
// The up arrow was silent in the chats where nothing could be edited, and a
// silent arrow is the same thing as a broken one. The arrow now explains
// itself, and the explanation is written from these codes.
//
// The codes are the contract: the answer and the reason cannot disagree,
// because the answer IS the reason being null.

add('a message past the edit window is refused as too old', withRules((R) =>
  R.messageEditRefusal(
    chat({ edit: 2, editMaxAge: 900 }),
    own({ timestamp: new Date(NOW - 1000000).toISOString() }),
    NOW,
  ) === 'too-old' || 'it was not refused as too old'));

add('a message with an attachment is refused for the attachment', withRules((R) =>
  R.messageEditRefusal(
    chat({ edit: 2 }), own({ attachments: [{ mimeType: 'image/png' }] }), NOW,
  ) === 'has-attachment' || 'it was not refused for the attachment'));

add("somebody else's message is refused as not yours", withRules((R) =>
  R.messageEditRefusal(chat({ edit: 2 }), own({ isSender: false }), NOW) === 'not-mine'
  || 'it was not refused as not yours'));

add('a chat that cannot edit refuses every message', withRules((R) =>
  R.messageEditRefusal(chat({ attachments: {} }), own(), NOW) === 'chat-cannot-edit'
  || 'it was not refused as chat-cannot-edit'));

add('a deleted message is refused as deleted', withRules((R) =>
  R.messageEditRefusal(chat({ edit: 2 }), own({ isDeleted: true }), NOW) === 'deleted'
  || 'it was not refused as deleted'));

add('a message that has not been sent is refused as not confirmed', withRules((R) =>
  R.messageEditRefusal(chat({ edit: 2 }), own({ sendStatus: 'pending' }), NOW)
  === 'not-confirmed' || 'it was not refused as not-confirmed'));

add('CONTROL: the answer and the reason cannot disagree', withRules((R) => {
  // Every kind of message, every kind of chat. For each one, the answer has
  // to be exactly "the reason is null".
  const chats = [
    chat({ edit: 2 }),
    chat({ edit: 2, editMaxAge: 900 }),
    chat({ edit: 2, editMaxAge: 86400 }),
    chat({ attachments: {} }),
    { id: 'c1', isReadOnly: true, capabilities: { edit: 2 } },
  ];
  const messages = [
    own(),
    own({ isSender: false }),
    own({ isDeleted: true }),
    own({ isHidden: true }),
    own({ attachments: [{}] }),
    own({ sendStatus: 'pending' }),
    own({ timestamp: new Date(NOW - 100000000).toISOString() }),
    own({ timestamp: new Date(NOW - 1000).toISOString() }),
    own({ timestamp: null }),
  ];
  for (const c of chats) {
    for (const m of messages) {
      const reason = R.messageEditRefusal(c, m, NOW);
      const answer = R.isEditableMessage(c, m, NOW);
      if (answer !== (reason === null)) {
        return `the answer was ${answer} but the reason was ${reason}`;
      }
    }
  }
  return true;
}));

// --- the explanation ----------------------------------------------------------

add('CONTROL: a chat with something editable has nothing to explain', withRules((R) =>
  R.chatEditRefusal(chat({ edit: 2 }), [own()], NOW) === null
  || 'it explained something'));

add('a chat that cannot edit is explained as such', withRules((R) => {
  const refusal = R.chatEditRefusal(chat({ attachments: {} }), [own()], NOW);
  return (refusal && refusal.code === 'chat-cannot-edit')
  || 'it said ' + (refusal && refusal.code);
}));

add('a chat you have never written in is explained as such', withRules((R) => {
  const refusal = R.chatEditRefusal(
    chat({ edit: 2 }), [own({ isSender: false })], NOW,
  );
  return (refusal && refusal.code === 'no-own-messages')
  || 'it said ' + (refusal && refusal.code);
}));

add('the explanation names the message it is about', withRules((R) => {
  const refusal = R.chatEditRefusal(
    chat({ edit: 2, editMaxAge: 900 }),
    [own({ id: 'm1', timestamp: new Date(NOW - 1000000).toISOString() })],
    NOW,
  );
  return (refusal && refusal.message && refusal.message.id === 'm1')
  || 'it named no message';
}));

// The measured case: Corinne's Signal chat, where eight of the ten messages
// are too old and two have attachments. The reason that explains the chat is
// the one that applies to the most of your messages.
add('the reason that explains the chat is the one that applies to most of your messages',
  withRules((R) => {
    const messages = [];
    for (let i = 0; i < 8; i++) {
      messages.push(own({
        id: 'old' + i,
        timestamp: new Date(NOW - 94 * 3600 * 1000).toISOString(),
      }));
    }
    for (let i = 0; i < 2; i++) {
      messages.push(own({
        id: 'att' + i,
        attachments: [{ mimeType: 'image/png' }],
        timestamp: new Date(NOW - 94 * 3600 * 1000).toISOString(),
      }));
    }
    const refusal = R.chatEditRefusal(chat({ edit: 2, editMaxAge: 86400 }), messages, NOW);
    return (refusal && refusal.code === 'too-old')
    || 'it said ' + (refusal && refusal.code);
  }));

add('CONTROL: a tie in the reasons goes to the newest message', withRules((R) => {
  // One message too old, one with an attachment, the attachment is newer.
  const messages = [
    own({ id: 'old', timestamp: new Date(NOW - 1000000).toISOString() }),
    own({ id: 'att', attachments: [{}], timestamp: new Date(NOW - 2000).toISOString() }),
  ];
  const refusal = R.chatEditRefusal(chat({ edit: 2, editMaxAge: 900 }), messages, NOW);
  return (refusal && refusal.code === 'has-attachment' && refusal.message.id === 'att')
  || ('it said ' + (refusal && refusal.code) + ' about ' + (refusal && refusal.message && refusal.message.id));
}));

add('the explanation carries the chat\'s own edit window', withRules((R) => {
  const refusal = R.chatEditRefusal(
    chat({ edit: 2, editMaxAge: 86400 }),
    [own({ timestamp: new Date(NOW - 100000000).toISOString() })],
    NOW,
  );
  return (refusal && refusal.maxAgeSeconds === 86400)
  || 'it carried ' + (refusal && refusal.maxAgeSeconds);
}));

// --- the window, written the way a person says it -----------------------------

add('a twenty-four hour window is written as 24 hours', withRules((R) =>
  R.editWindowLabel(chat({ edit: 2, editMaxAge: 86400 })) === '24 hours'
  || 'it said ' + R.editWindowLabel(chat({ edit: 2, editMaxAge: 86400 }))));

add('a fifteen minute window is written as 15 minutes', withRules((R) =>
  R.editWindowLabel(chat({ edit: 2, editMaxAge: 900 })) === '15 minutes'
  || 'it said ' + R.editWindowLabel(chat({ edit: 2, editMaxAge: 900 }))));

add('a one hour window is written as 1 hour', withRules((R) =>
  R.editWindowLabel(chat({ edit: 2, editMaxAge: 3600 })) === '1 hour'
  || 'it said ' + R.editWindowLabel(chat({ edit: 2, editMaxAge: 3600 }))));

add('CONTROL: a chat with no window has nothing to say about one', withRules((R) =>
  R.editWindowLabel(chat({ edit: 2 })) === ''
  || 'it said ' + R.editWindowLabel(chat({ edit: 2 }))));

// --- your own messages -------------------------------------------------------

add('your own messages are the ones the arrow walks past', withRules((R) => {
  const list = R.ownMessages([
    own({ id: 'm2', timestamp: new Date(NOW - 2000).toISOString() }),
    own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
    own({ id: 'theirs', isSender: false, timestamp: new Date(NOW - 3000).toISOString() }),
    own({ id: 'gone', isDeleted: true, timestamp: new Date(NOW - 4000).toISOString() }),
  ]);
  return (list.length === 2 && list[0].id === 'm1' && list[1].id === 'm2')
  || ('got ' + list.map((m) => m.id).join(','));
}));

// --- the report --------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
