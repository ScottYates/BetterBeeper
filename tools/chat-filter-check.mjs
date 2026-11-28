/**
 * Dev check: filtering the chat list by what is typed.
 *
 * The rule is small, and small rules are the ones that rot quietly: a filter
 * that matched a name the list does not draw, or one that was case
 * sensitive, would leave the list looking broken rather than looking wrong.
 *
 * The module has no DOM and no account, so it is driven directly here
 * instead of through a window.
 *
 * Run with `npm run check:chatfilter`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILTER = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'chat-filter.js')).href;

let filter = null;
let importError = '';
try {
  filter = await import(FILTER);
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

const withFilter = (fn) => {
  if (!filter) return () => importError || 'the module could not be loaded';
  return () => fn(filter);
};

const chat = (id, title, over) => Object.assign({ id, title }, over || {});

const CHATS = [
  chat('!benji', 'Benji'),
  chat('!ben', 'Ben & Co'),
  chat('!alex', 'Alex Smith'),
  chat('!team', 'Team chat'),
  chat('!untitled', ''),
];

add('the module can be read without a window', () =>
  (filter !== null) || ('the module could not be loaded: ' + importError));

add('a name that contains the text matches', withFilter((f) => {
  const got = f.filterChats(CHATS, 'ben').map((c) => c.id);
  return got.join(',') === '!benji,!ben' || got.join(',');
}));

add('the text is a substring, not the whole name', withFilter((f) => {
  // "enj" is in the middle of "Benji", and a filter that only matched from
  // the start would find nothing.
  const got = f.filterChats(CHATS, 'enj').map((c) => c.id);
  return got.join(',') === '!benji' || got.join(',');
}));

add('the comparison ignores case', withFilter((f) => {
  const got = f.filterChats(CHATS, 'BEN').map((c) => c.id);
  return got.join(',') === '!benji,!ben' || got.join(',');
}));

add('surrounding spaces do not stop it matching', withFilter((f) => {
  const got = f.filterChats(CHATS, '  ben  ').map((c) => c.id);
  return got.join(',') === '!benji,!ben' || got.join(',');
}));

add('a text that matches nothing matches nothing', withFilter((f) => {
  const got = f.filterChats(CHATS, 'zzz');
  return got.length === 0 || got.length + ' matched';
}));

add('an empty text keeps every chat', withFilter((f) => {
  const got = f.filterChats(CHATS, '');
  return got.length === CHATS.length || got.length + ' kept';
}));

add('a blank text keeps every chat', withFilter((f) => {
  const got = f.filterChats(CHATS, '   ');
  return got.length === CHATS.length || got.length + ' kept';
}));

add('the order is not touched', withFilter((f) => {
  // The list is filtered, not re-sorted: the pinned chats stay at the top
  // and the rest stay in the order they were given.
  const got = f.filterChats(CHATS, 'e').map((c) => c.id);
  return got.join(',') === '!benji,!ben,!alex,!team' || got.join(',');
}));

add('a chat with no name is matched by nothing', withFilter((f) => {
  // There is no name to match, so there is nothing to find it by.
  const got = f.filterChats(CHATS, 'untitled');
  return got.length === 0 || got.length + ' matched';
}));

add('a name is matched as it is drawn', withFilter((f) => {
  // Titles arrive escaped as well as plain, and the list draws the decoded
  // name. A filter that cannot find a name that is on screen looks broken.
  const escaped = [chat('!amp', 'Ben &amp; Co')];
  const got = f.filterChats(escaped, 'ben &');
  return got.length === 1 || got.length + ' matched';
}));

add('a missing chat does not match', withFilter((f) =>
  f.matchesFilter(null, 'ben') === false || 'a missing chat matched'));

add('a missing chat and a missing text do not throw', withFilter((f) =>
  f.matchesFilter(null, '') === true || 'a missing chat did not match an empty text'));

// ---------------------------------------------------------------------------
// The keystroke that starts the filter
// ---------------------------------------------------------------------------

const key = (over) => Object.assign({
  key: 'a', ctrlKey: false, metaKey: false, altKey: false,
  target: { tagName: 'BODY' },
}, over || {});

add('a letter starts a filter', withFilter((f) =>
  f.isFilterableKey(key()) === true || 'a letter was not accepted'));

add('a space starts a filter', withFilter((f) =>
  f.isFilterableKey(key({ key: ' ' })) === true || 'a space was not accepted'));

add('a number starts a filter', withFilter((f) =>
  f.isFilterableKey(key({ key: '7' })) === true || 'a number was not accepted'));

add('a key with a modifier does not start a filter', withFilter((f) =>
  (!f.isFilterableKey(key({ ctrlKey: true }))
    && !f.isFilterableKey(key({ metaKey: true }))
    && !f.isFilterableKey(key({ altKey: true })))
  || 'a shortcut was taken as a filter'));

add('a named key does not start a filter', withFilter((f) =>
  (!f.isFilterableKey(key({ key: 'Shift' }))
    && !f.isFilterableKey(key({ key: 'ArrowLeft' }))
    && !f.isFilterableKey(key({ key: 'F5' })))
  || 'a named key was taken as a filter'));

add('a keystroke in a field does not start a filter', withFilter((f) =>
  (!f.isFilterableKey(key({ target: { tagName: 'INPUT' } }))
    && !f.isFilterableKey(key({ target: { tagName: 'TEXTAREA' } }))
    && !f.isFilterableKey(key({ target: { tagName: 'SELECT' } })))
  || 'a keystroke in a field was taken as a filter'));

add('a keystroke in a contenteditable does not start a filter', withFilter((f) =>
  f.isFilterableKey(key({ target: { tagName: 'DIV', isContentEditable: true } })) === false
  || 'a contenteditable keystroke was taken as a filter'));

add('a missing event does not start a filter', withFilter((f) =>
  f.isFilterableKey(null) === false || 'a missing event was taken as a filter'));

// ---------------------------------------------------------------------------
// The wiring
//
// The keystroke is captured in main.js, which boots the app and cannot be
// loaded on its own, so these are read out of the source. They are here
// because the wiring is the part that can rot: a handler that starts the
// filter while a chat is open would swallow the first letter of every
// message.
// ---------------------------------------------------------------------------

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

add('the filter row is in the sidebar', () => {
  const html = read('src/renderer/index.html');
  return (html.includes('id="chat-filter-row"') && html.includes('id="chat-filter-input"'))
    || 'the filter row is not in index.html';
});

add('the sidebar can start, clear and report the filter', () => {
  const src = read('src/renderer/js/sidebar.js');
  const has = (name) => src.includes('export function ' + name + '(');
  return (has('startChatFilter') && has('clearChatFilter') && has('hasChatFilter'))
    || 'sidebar.js does not export the filter functions';
});

add('the list is narrowed by the filter', () => {
  const src = read('src/renderer/js/sidebar.js');
  return src.includes('filterChats(all, state.chatFilter)')
    || 'renderChats does not filter the list';
});

add('a keystroke starts the filter only with no chat open', () => {
  const src = read('src/renderer/js/main.js');
  const at = src.indexOf('startChatFilter(event.key)');
  if (at < 0) return 'nothing starts the filter';
  // The guard has to be above the call, or the first letter of every
  // message typed into an open chat would start a filter instead.
  const before = src.slice(Math.max(0, at - 900), at);
  return (before.includes('if (state.activeChatID) return;')
    && before.includes('isFilterableKey(event)'))
    || 'the filter is not guarded by the active chat and the key';
});

add('escape clears the filter before it closes the chat', () => {
  const src = read('src/renderer/js/main.js');
  const at = src.indexOf('hasChatFilter()');
  if (at < 0) return 'escape does not know about the filter';
  const after = src.slice(at, at + 220);
  return (after.includes('clearChatFilter()') && after.indexOf('clearChatFilter()') < after.indexOf('closeActiveChat()'))
    || 'escape does not clear the filter first';
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let failures = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}

console.log(`\n${cases.length - failures}/${cases.length} checks passed`);
process.exit(failures ? 1 : 0);
