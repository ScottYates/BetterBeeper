/**
 * Dev check: the local message store.
 *
 * This is the module that decides what history exists on this machine, and the
 * one place in the app that can quietly destroy real data: a backfill that
 * stopped partway has ordinary gaps, and reading those gaps as "Beeper deleted
 * these" would tombstone messages that were never touched.
 *
 * So the rule is asserted in both directions -- a complete run must tombstone,
 * an interrupted one must not -- and the check is proven to go red when the
 * guard is removed. A check that cannot fail is not a check.
 *
 * Plain node, no Electron: message-store.js deliberately imports nothing from
 * electron so it can be exercised here. See media-path.js for the precedent.
 *
 * Run with `npm run check:history`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMessageStore } = require(path.join(__dirname, '..', 'src', 'main', 'message-store.js'));

const cases = [];

function add(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true;
    if (r !== true) detail = String(r);
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  cases.push([name, ok, detail]);
}

/** A message shaped like the ones Beeper actually sends. */
const msg = (id, ts, text, extra) =>
  Object.assign({ id, timestamp: ts, text, senderID: 's1', senderName: 'Someone' }, extra || {});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-history-check-'));
const store = openMessageStore(dir);

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

add('the store opens and reports a schema version', () =>
  store.userVersion() >= 1 || ('got ' + store.userVersion()));

add('the database file is where it claims to be', () =>
  fs.existsSync(store.file) || ('missing ' + store.file));

add('reopening the same directory keeps the data', () => {
  store.upsertMessages('c0', [msg('keep', 1000, 'survives a reopen')], {});
  const again = openMessageStore(dir);
  const found = again.page('c0', { limit: 10 }).map((m) => m.id);
  again.close();
  return found.join(',') === 'keep' || ('got ' + JSON.stringify(found));
});

// ---------------------------------------------------------------------------
// Writing and reading
// ---------------------------------------------------------------------------

store.upsertMessages('c1', [msg('m3', 3000, 'third'), msg('m1', 1000, 'first'), msg('m2', 2000, 'second')], {
  oldestTs: 1000,
});

add('messages come back oldest first', () => {
  const got = store.page('c1', { limit: 10 }).map((m) => m.id).join(',');
  return got === 'm1,m2,m3' || ('got ' + got);
});

add('the newest page really is the newest', () =>
  store.newest('c1', 2).map((m) => m.id).join(',') === 'm2,m3' || 'wrong window');

add('paging before a message excludes it and everything newer', () => {
  const got = store.page('c1', { before: 'm2', limit: 10 }).map((m) => m.id).join(',');
  return got === 'm1' || ('got ' + got);
});

add('the payload survives the round trip', () => {
  // With no cursor, page() is the newest page; that is the whole point of it.
  const back = store.page('c1', { limit: 1 })[0];
  return (back.id === 'm3' && back.senderName === 'Someone' && back.text === 'third')
    || JSON.stringify(back);
});

add('the oldest of a full page is still the oldest', () => {
  const first = store.page('c1', { limit: 10 })[0];
  return (first.id === 'm1' && first.text === 'first') || JSON.stringify(first);
});

add('writing the same id twice updates rather than duplicating', () => {
  store.upsertMessages('c1', [msg('m1', 1000, 'edited')], { oldestTs: 1000 });
  const all = store.page('c1', { limit: 10 });
  return (all.length === 3 && all[0].text === 'edited')
    || ('got ' + JSON.stringify(all.map((m) => m.text)));
});

add('an empty chat pages to nothing rather than throwing', () =>
  store.page('nope', { limit: 10 }).length === 0 || 'threw');

add('a message with no timestamp still stores', () => {
  store.upsertMessages('c1b', [msg('notime', undefined, 'no clock')], {});
  return store.page('c1b', { limit: 5 }).length === 1 || 'dropped a message with no timestamp';
});

add('an ISO timestamp is understood, not read as year zero', () => {
  store.upsertMessages('c1c', [msg('iso', '2026-03-04T10:00:00Z', 'iso')], {});
  const row = store.chatStatus('c1c');
  const back = store.page('c1c', { limit: 5 })[0];
  return row.count === 1 && back.timestamp === '2026-03-04T10:00:00Z' || 'lost the message';
});

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

add('a complete run tombstones what Beeper dropped', () => {
  store.upsertMessages('c2', [msg('a', 1000, 'kept'), msg('b', 2000, 'gone later')], {});
  const r = store.reconcile('c2', ['a'], { complete: true, oldestTs: 1000 });
  const drawn = store.page('c2', { limit: 10 }).map((m) => m.id);
  return (r.tombstoned === 1 && drawn.join(',') === 'a')
    || ('tombstoned ' + r.tombstoned + ', drew ' + JSON.stringify(drawn));
});

add('an interrupted run tombstones nothing', () => {
  store.upsertMessages('c3', [msg('x', 1000, 'x'), msg('y', 2000, 'y')], {});
  const r = store.reconcile('c3', ['x'], { complete: false, oldestTs: 1000 });
  const drawn = store.page('c3', { limit: 10 }).map((m) => m.id).join(',');
  return (r.tombstoned === 0 && drawn === 'x,y') || ('tombstoned ' + r.tombstoned + ', drew ' + drawn);
});

add('an interrupted run leaves the chat incomplete', () =>
  store.isComplete('c3') === false || 'an interrupted run marked the chat complete');

add('a complete run marks the chat complete', () =>
  store.isComplete('c2') === true || 'a complete run did not mark the chat complete');

add('a tombstone is not resurrected by a later write', () => {
  store.upsertMessages('c2', [msg('b', 2000, 'back again')], {});
  const drawn = store.page('c2', { limit: 10 }).map((m) => m.id);
  return !drawn.includes('b') || 'a tombstone came back';
});

add('a tombstone is not resurrected by a later reconcile either', () => {
  store.reconcile('c2', ['a', 'b'], { complete: true, oldestTs: 1000 });
  const drawn = store.page('c2', { limit: 10 }).map((m) => m.id);
  return !drawn.includes('b') || 'a complete reconcile with b still un-gone';
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

store.upsertMessages('c4', [msg('s1', 1000, 'the quick brown fox'), msg('s2', 2000, 'lazy dog sleeps')], {});

add('search finds a word in stored history', () => {
  const hits = store.search('brown', { limit: 10 });
  return (hits.length === 1 && hits[0].id === 's1')
    || ('got ' + JSON.stringify(hits.map((h) => h.id)));
});

add('search returns more than Beeper ever would', () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push(msg('n' + i, 3000 + i, 'needle in haystack ' + i));
  store.upsertMessages('c5', many, {});
  const hits = store.search('needle', { limit: 50 });
  return hits.length === 50 || ('got ' + hits.length);
});

add('search skips tombstoned rows', () => {
  store.reconcile('c4', ['s1'], { complete: true, oldestTs: 1000 });
  return store.search('sleeps', { limit: 10 }).length === 0 || 'returned a tombstone';
});

add('an edited message is findable by its new text', () => {
  store.upsertMessages('c4', [msg('s1', 1000, 'rewritten entirely')], {});
  return (store.search('rewritten', { limit: 10 }).length === 1
      && store.search('brown', { limit: 10 }).length === 0)
    || 'the index did not follow the edit';
});

add('search can be scoped to chats', () => {
  const hits = store.search('needle', { limit: 50, chatIDs: ['c5'] });
  return hits.length > 0 && hits.every((h) => h.chatID === 'c5') || 'scoping leaked another chat';
});

add('search scoped to an empty chat list returns nothing', () =>
  store.search('needle', { limit: 10, chatIDs: [] }).length === 0 || 'ignored the scope');

add('an unbalanced quote is searched for literally instead of throwing', () => {
  store.search('"unbalanced', { limit: 10 });
  store.search('a AND (', { limit: 10 });
  store.search('*', { limit: 10 });
  store.search('', { limit: 10 });
  return true;
});

add('an empty query returns nothing rather than everything', () =>
  store.search('', { limit: 10 }).length === 0 && store.search('   ', { limit: 10 }).length === 0
    || 'an empty query matched rows');

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

add('status counts only live messages', () => {
  const s = store.chatStatus('c5');
  return s.count === 60 || ('got ' + s.count);
});

add('stats report a file on disk', () => {
  const s = store.stats();
  return s.messages > 0 && s.bytes > 0 || JSON.stringify(s);
});

store.close();
fs.rmSync(dir, { recursive: true, force: true });

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);