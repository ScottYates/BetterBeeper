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

// --- the report --------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
