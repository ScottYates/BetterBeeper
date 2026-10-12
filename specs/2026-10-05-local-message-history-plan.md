# Local Message History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every message Better Beeper has seen on disk, so history survives a restart, scroll-back never touches the network, and search covers everything stored rather than Beeper's 20-result cap.

**Architecture:** A SQLite store in the main process owns message truth, backed by an FTS5 index maintained by triggers. A background queue walks each chat backwards from Beeper exactly once, filling the store. The renderer reads pages from the store and keeps its existing in-memory model for the open chat.

**Tech Stack:** Electron 38.8.6 (Node 22.22), `node:sqlite` (`DatabaseSync`) with FTS5 confirmed available, vanilla ES modules in the renderer, CommonJS in main, no new dependencies.

## Global Constraints

- Spec: `specs/2026-10-05-local-message-history-design.md`. Where this plan and the spec disagree, the spec wins and the plan is wrong.
- New main-process modules under `src/main/` that hold logic rather than Electron wiring must import **nothing from `electron`**, so they unit-test under plain node. `src/main/media-path.js` is the existing precedent.
- New renderer modules under `src/renderer/js/` are ES modules with named exports, matching `src/renderer/js/media-kind.js`.
- All documentation and code comments are ASCII. `npm run check:ascii` must stay green. Emoji are allowed in UI strings only.
- Every new fix gets a repeatable `npm run check:*` script, **proven to fail when the bug is reintroduced** before it is believed.
- IPC channels must be added to all three lists or `npm run check:api` fails: `src/main/ipc.js` (handler), `src/preload/preload.js` (contextBridge), `src/renderer/js/api.js` (mirror).
- Never disable `webSecurity`. The renderer keeps `contextIsolation: true` and `nodeIntegration: false`.
- Deletions are recoverable `rm --` only. Never `Remove-Item`, never permanent deletion.
- Commit messages go in a file used with `git commit -F`; add paths **explicitly**, never `git add -A`, and remove the message file before the next commit.
- Every push to `main` is followed by `npm run release` and `npm run check:released`.

---

### Task 1: Store skeleton, schema, and the harness

**Files:**
- Create: `src/main/message-store.js`
- Create: `tools/history-check.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `openMessageStore(userDataDir)` -> store; `store.close()`; `store.userVersion()`. Later tasks add methods to the same object.

- [ ] **Step 1: Write the failing test**

Create `tools/history-check.js` following `tools/media-check.js`: a `cases` array, an `add(name, fn)` helper that returns `true` or a detail string, and a non-zero exit on failure. Add:

```js
const store = openMessageStore(dir);
add('the store opens and reports a schema version', () =>
  store.userVersion() >= 1 || ('got ' + store.userVersion()));
add('the store closes cleanly', () => {
  store.close();
  return true;
});
add('reopening the same directory keeps the file', () => {
  const again = openMessageStore(dir);
  const v = again.userVersion();
  again.close();
  return v >= 1 || 'schema was not persisted';
});
```

`dir` is a fresh `fs.mkdtempSync(path.join(os.tmpdir(), 'bb-history-check-'))` created once at the top of the file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run check:history`
Expected: FAIL, because `src/main/message-store.js` does not exist yet. Register the script first:

```js
j.scripts['check:history'] = 'node tools/history-check.js';
```

- [ ] **Step 3: Write minimal implementation**

`src/main/message-store.js` exports `openMessageStore(userDataDir)`. It opens `path.join(userDataDir, 'history.db')` with `new DatabaseSync(file)`, sets `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, then runs the schema from the spec:

```sql
CREATE TABLE IF NOT EXISTS chats (
  chatID TEXT PRIMARY KEY, title TEXT, lastSyncedAt INTEGER,
  oldestSyncedTs INTEGER, complete INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chatID TEXT NOT NULL, ts INTEGER NOT NULL,
  senderID TEXT, senderName TEXT, text TEXT,
  payload TEXT NOT NULL, gone INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chatID, ts, id);
```

Set `PRAGMA user_version = 1`. `userVersion()` reads it back. Wrap the open so that a corrupt file is caught, renamed to `history.db.corrupt-<n>`, and a fresh one created -- the spec requires the app to survive this rather than crash.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run check:history`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/main/message-store.js tools/history-check.js package.json
git commit -m "feat(history): SQLite message store with schema and recovery"
```

---

### Task 2: Writing and reading messages

**Files:**
- Modify: `src/main/message-store.js`
- Modify: `tools/history-check.js`

**Interfaces:**
- Produces:
  - `store.upsertMessages(chatID, messages, { oldestTs })` -> count written
  - `store.page(chatID, { before, limit })` -> array of parsed payloads, oldest first, excluding `gone = 1`
  - `store.newest(chatID, limit)` -> same shape
  - `store.chatStatus(chatID)` -> `{ complete, oldestSyncedTs, lastSyncedAt, count }`
  - `store.setComplete(chatID, oldestTs)` / `store.setLastSynced(chatID)`

- [ ] **Step 1: Write the failing test**

```js
const msg = (id, ts, text) => ({ id, timestamp: ts, text, senderID: 's', senderName: 'Someone' });
store.upsertMessages('c1', [msg('m3', 3000, 'third'), msg('m1', 1000, 'first'), msg('m2', 2000, 'second')], { oldestTs: 1000 });

add('messages come back oldest first', () => {
  const got = store.page('c1', { limit: 10 }).map((m) => m.id).join(',');
  return got === 'm1,m2,m3' || ('got ' + got);
});
add('the newest page is the newest page', () =>
  store.newest('c1', 2).map((m) => m.id).join(',') === 'm2,m3' || 'wrong window');
add('paging before a message excludes it and everything newer', () =>
  store.page('c1', { before: 'm2', limit: 10 }).map((m) => m.id).join(',') === 'm1' || 'wrong page');
add('the raw payload survives the round trip', () => {
  const back = store.page('c1', { limit: 1 })[0];
  return back.senderName === 'Someone' && back.text === 'first' || JSON.stringify(back);
});
add('writing the same id twice updates rather than duplicating', () => {
  store.upsertMessages('c1', [msg('m1', 1000, 'edited')], { oldestTs: 1000 });
  const all = store.page('c1', { limit: 10 });
  return all.length === 3 && all[0].text === 'edited' || ('got ' + JSON.stringify(all.map((m) => m.text)));
});
add('an empty chat pages to nothing rather than throwing', () =>
  store.page('nope', { limit: 10 }).length === 0 || 'threw');
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL, `page is not a function`.

- [ ] **Step 3: Write minimal implementation**

`upsertMessages` runs one transaction: `INSERT INTO messages (...) VALUES (...) ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, senderID=excluded.senderID, senderName=excluded.senderName, text=excluded.text, payload=excluded.payload, gone=0`. `payload` is `JSON.stringify(message)`. Rows that Beeper marks deleted carry `isDeleted`; keep them but set `gone = 0` only when `isDeleted` is falsy -- a message already gone stays gone.

`page` and `newest` are the same query with opposite ordering and direction:

```sql
SELECT payload FROM messages
 WHERE chatID = ? AND gone = 0
   AND (? IS NULL OR (ts, id) < (SELECT ts, id FROM messages WHERE id = ?))
 ORDER BY ts DESC, id DESC LIMIT ?
```

then reversed in JS so callers always get oldest-first.

- [ ] **Step 4: Run it to verify it passes**

Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
git add src/main/message-store.js tools/history-check.js
git commit -m "feat(history): write and page messages out of SQLite"
```

---

### Task 3: The tombstone rule

This is the task that can destroy real history if it is wrong, and it is the
one that gets proven to fail.

**Files:**
- Modify: `src/main/message-store.js`
- Modify: `tools/history-check.js`

**Interfaces:**
- Produces: `store.reconcile(chatID, seenIds, { complete, oldestTs })` -> `{ tombstoned, written }`

- [ ] **Step 1: Write the failing test**

```js
add('a complete run tombstones what Beeper dropped', () => {
  store.upsertMessages('c2', [msg('a', 1000, 'kept'), msg('b', 2000, 'gone later')], {});
  const r = store.reconcile('c2', ['a'], { complete: true, oldestTs: 1000 });
  const drawn = store.page('c2', { limit: 10 }).map((m) => m.id);
  return (r.tombstoned === 1 && drawn.join(',') === 'a') || ('got ' + JSON.stringify(drawn));
});
add('an interrupted run tombstones nothing', () => {
  store.upsertMessages('c3', [msg('x', 1000, 'x'), msg('y', 2000, 'y')], {});
  const r = store.reconcile('c3', ['x'], { complete: false, oldestTs: 1000 });
  const drawn = store.page('c3', { limit: 10 }).map((m) => m.id).join(',');
  return (r.tombstoned === 0 && drawn === 'x,y') || ('got ' + JSON.stringify(drawn));
});
add('a tombstoned message is not resurrected by a later write', () => {
  store.upsertMessages('c2', [msg('b', 2000, 'back again')], {});
  const drawn = store.page('c2', { limit: 10 }).map((m) => m.id);
  return !drawn.includes('b') || 'a tombstone was overwritten';
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL, `reconcile is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// Only a run that reached the true beginning may tombstone. An interrupted run
// has ordinary gaps, and treating those as deletions would destroy history.
function reconcile(chatID, seenIds, { complete, oldestTs }) {
  const tombstoned = complete
    ? tombstoneMissing(chatID, new Set(seenIds))
    : 0;
  if (complete) setComplete(chatID, oldestTs);
  return { tombstoned, written: seenIds.length };
}
```

`tombstoneMissing` sets `gone = 1` for rows in that chat whose id is not in the seen set. It must **not** run for an incomplete pass, and it must **not** delete rows -- tombstones are what stop a later backfill resurrecting them.

The `upsertMessages` conflict clause must then leave `gone` alone rather than resetting it, or a later sync quietly un-deletes. Update Step 3 of Task 2's `ON CONFLICT` to omit `gone=0`.

- [ ] **Step 4: Prove the check fails on the bug**

Temporarily change `const tombstoned = complete ? ... : 0` to `const tombstoned = tombstoneMissing(...)`, run `npm run check:history`, and confirm **"an interrupted run tombstones nothing" FAILS**. Then restore the `complete ?` guard and confirm it passes again. Do not skip this; a green check that cannot go red is not a check.

- [ ] **Step 5: Run it to verify it passes**

Expected: PASS, 12/12.

- [ ] **Step 6: Commit**

```bash
git add src/main/message-store.js tools/history-check.js
git commit -m "feat(history): tombstone only what a complete backfill proved gone"
```

---

### Task 4: Full-text search

**Files:**
- Modify: `src/main/message-store.js`
- Modify: `tools/history-check.js`

**Interfaces:**
- Produces: `store.search(query, { limit, chatIDs })` -> `[{ chatID, id, text, ts, senderName }]`

- [ ] **Step 1: Write the failing test**

```js
store.upsertMessages('c4', [msg('s1', 1000, 'the quick brown fox'), msg('s2', 2000, 'lazy dog sleeps')], {});
add('search finds a word in stored history', () => {
  const hits = store.search('brown', { limit: 10 });
  return hits.length === 1 && hits[0].id === 's1' || ('got ' + JSON.stringify(hits.map((h) => h.id)));
});
add('search skips tombstoned rows', () => {
  store.reconcile('c4', ['s2'], { complete: true, oldestTs: 1000 });
  return store.search('sleeps', { limit: 10 }).length === 0 || 'returned a tombstone';
});
add('an edited message is findable by its new text', () => {
  store.upsertMessages('c4', [msg('s1', 1000, 'rewritten entirely')], {});
  return store.search('rewritten', { limit: 10 }).length === 1
    && store.search('brown', { limit: 10 }).length === 0
    || 'the index did not follow the edit';
});
add('a malformed query falls back instead of throwing', () => {
  store.search('"unbalanced', { limit: 10 });
  store.search('a AND (', { limit: 10 });
  return true;
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL, `search is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create the index and its triggers:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
```

Triggers, not application code: the same writer maintains both, so the index cannot drift. A search index that has drifted reports plausible wrong answers rather than failing.

Join `messages_fts` back to `messages` on rowid and filter `gone = 0`. Wrap the `MATCH` in try/catch and fall back to a quoted literal (`'"' + query.replace(/"/g, '""') + '"'`) so an unbalanced quote is searched for literally instead of raising.

- [ ] **Step 4: Run it to verify it passes**

Expected: PASS, 16/16.

- [ ] **Step 5: Commit**

```bash
git add src/main/message-store.js tools/history-check.js
git commit -m "feat(history): FTS5 search kept in step by triggers"
```

---

### Task 5: Content-addressed media store

**Files:**
- Create: `src/main/media-store.js`
- Modify: `tools/history-check.js`

**Interfaces:**
- Produces: `openMediaStore(userDataDir)` -> `{ adopt(filePath, fileName), has(hash), pathFor(hash, ext), totalBytes(), close() }`
- `adopt` returns `{ hash, relativePath }` or null on failure. It never throws.

- [ ] **Step 1: Write the failing test**

```js
const media = openMediaStore(dir);
const src = path.join(dir, 'clip.bin');
fs.writeFileSync(src, 'media bytes');
add('adopt copies the file under a hash name', () => {
  const r = media.adopt(src, 'holiday photo.jpg');
  return r && /^[0-9a-f]{64}$/.test(r.hash) || ('got ' + JSON.stringify(r));
});
add('the stored name never contains the message filename', () => {
  const r = media.adopt(src, '../../evil.jpg');
  return r && !r.relativePath.includes('..') && !r.relativePath.includes('evil')
    || ('got ' + JSON.stringify(r));
});
add('the same bytes are stored once', () => {
  const a = media.adopt(src, 'one.jpg');
  const b = media.adopt(src, 'two.jpg');
  return a.hash === b.hash || 'stored twice';
});
add('a missing source returns null rather than throwing', () =>
  media.adopt(path.join(dir, 'nope.bin'), 'x.jpg') === null || 'threw');
add('total bytes counts what was stored', () =>
  media.totalBytes() > 0 || 'reported zero');
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL, module not found.

- [ ] **Step 3: Write minimal implementation**

Hash the bytes with `crypto.createHash('sha256')`, write to `media/<hash.slice(0,2)>/<hash><ext>` where `ext` is sanitised by `mediaPath.safeFileName` on a `"blob" + ext` string -- never the raw message filename. Skip the copy if the file already exists. Return null on any error: a failed media copy must never fail the message sync it belongs to.

- [ ] **Step 4: Run it to verify it passes**

Expected: PASS, 21/21.

- [ ] **Step 5: Commit**

```bash
git add src/main/media-store.js tools/history-check.js
git commit -m "feat(history): content-addressed media store"
```

---

### Task 6: The backfill queue

**Files:**
- Create: `src/main/history-sync.js`
- Modify: `tools/history-check.js`

**Interfaces:**
- Consumes: a store with `upsertMessages` / `reconcile` / `setComplete` / `setLastSynced` / `chatStatus`, and a `fetchPage(chatID, { cursor, direction, limit })` -> `{ items, hasMore, oldestCursor }`.
- Produces: `createHistorySync({ store, media, fetchPage, onProgress })` -> `{ request(chatID), status(), stop() }`

- [ ] **Step 1: Write the failing test**

Drive it with a fake `fetchPage` that yields a fixed number of pages, so no network and no Electron:

```js
const sync = createHistorySync({
  store, media,
  fetchPage: async (chatID, { cursor }) => { /* 3 pages of 20, then hasMore false */ },
  onProgress: () => {},
});
```

Assert: after `request('c5')` and draining, `store.chatStatus('c5').complete === true`; every page landed exactly once; a second `request('c5')` fetches **one** page, not the whole history; a fetch that throws leaves the chat `complete: false` and tombstones nothing.

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL, module not found.

- [ ] **Step 3: Write minimal implementation**

One job at a time. `request(chatID)` enqueues if not already queued or running. The pump takes the next chatID and:

1. If `chatStatus(chatID).complete` is true, fetch only the newest page, upsert, `setLastSynced`, and stop. **Never re-walk a complete chat** -- that is the behaviour being fixed.
2. Otherwise page backwards from `oldestSyncedTs`, writing each page in one transaction, collecting ids for `reconcile`.
3. Call `reconcile(chatID, seenIds, { complete: hasMore === false, oldestTs })` only after the loop ends, so an interrupted run cannot tombstone.
4. On a thrown fetch, stop and leave `complete` false. Record the failure, move on. Do not spin.

`onProgress({ chatID, done, total, state })` fires on state changes so the renderer can show it.

- [ ] **Step 4: Run it to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/history-sync.js tools/history-check.js
git commit -m "feat(history): backfill queue that walks each chat once"
```

---

### Task 7: IPC surface

**Files:**
- Modify: `src/main/ipc.js`
- Modify: `src/preload/preload.js`
- Modify: `src/renderer/js/api.js`

**Interfaces:**
- Produces channels: `history:open(chatID)` -> `{ messages, complete, syncing }`; `history:page(chatID, { before, limit })` -> `{ messages, hasMore }`; `history:search(query, opts)` -> hits; `history:status()` -> `{ chats, complete, syncing, messages, mediaBytes }`.

- [ ] **Step 1: Add the handlers, then let check:api prove the omission**

Add all four to `ipc.js`, `preload.js` under a `history` group, and `api.js`. Then temporarily add only three to preload and run `npm run check:api` -- expect FAIL. Restore and expect PASS. `check:api` exists precisely to catch this drift; use it rather than trusting review.

- [ ] **Step 2: Run it to verify it passes**

Expected: PASS, 119/119.

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc.js src/preload/preload.js src/renderer/js/api.js
git commit -m "feat(history): IPC surface for local history"
```

---

### Task 8: The thread reads from disk

**Files:**
- Modify: `src/renderer/js/thread.js`
- Create: `tools/history-harness.html`

**Interfaces:**
- Consumes: `api.history.open/page/search/status` from Task 7.
- Produces: no new exports; changes what `openChat` and `loadOlder` call.

- [ ] **Step 1: Write the failing test**

In a harness that imports `thread.js` with a stubbed `window.beeper`, assert that opening a chat issues **no** `messages:list` call, and that `loadOlder` issues no network call when the store has older messages. Count calls to each stub.

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL, `messages:list` was called.

- [ ] **Step 3: Write minimal implementation**

`openChat` calls `api.history.open(chatID)` and upserts the returned messages. `loadOlder` calls `api.history.page(chatID, { before: oldest.id, limit: 50 })` and upserts. Keep the existing "Scroll up for earlier messages" element, shown only when the store reports `hasMore`. WebSocket events continue to upsert through `onMessageUpserted`, which now also writes through to the store via a new `history:upsert` channel.

**Do not touch** the scroll-anchoring logic, `settleUntil`, `atBottom`, or `renderAll`'s node claiming. That code is delicate and is not what this feature is for.

- [ ] **Step 4: Run it to verify it passes**

Expected: PASS. Then run `npm run check:actions`, `check:gifrebuild`, `check:visibility`, `check:composer`, `check:layout` -- all must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/js/thread.js tools/history-harness.html tools/history-render-check.js package.json
git commit -m "feat(history): thread reads history from the local store"
```

---

### Task 9: Search UI

**Files:**
- Modify: `src/renderer/js/modals.js` (or the existing search surface)
- Create: `tools/history-search-check.js`

- [ ] **Step 1: Write the failing test**

Assert the search view renders local hits grouped by chat, shows more than 20, and renders a local hit while Beeper is unreachable.

- [ ] **Step 2: Verify it fails, implement, verify it passes**

`api.history.search` replaces the Beeper call for local scope. Keep remote search available as a scope option.

- [ ] **Step 3: Run the full suite**

Run every `check:*` script. All must pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/js/modals.js tools/history-search-check.js package.json
git commit -m "feat(history): search covers everything stored locally"
```

---

### Task 10: Progress and disk totals in Settings

**Files:**
- Modify: `src/renderer/js/modals.js`
- Modify: `tools/history-check.js`

- [ ] **Step 1: Test, implement, verify**

Assert Settings shows backfill progress and a media byte total, and that the numbers are measured rather than hard-coded. Follow the `check:visibility` precedent: assert the row is inside the visible area of the modal, not merely present in the DOM. That check exists because a button once shipped 240px below the fold and an earlier version of its own test passed anyway.

- [ ] **Step 2: Run the full suite, then commit**

```bash
git add src/renderer/js/modals.js tools/history-check.js
git commit -m "feat(history): show backfill progress and disk use"
```

---

### Task 11: Live verification and release

**Files:** none.

- [ ] **Step 1: Build and install**

Run: `npm run dist`. Then confirm `node tools/install-update.js --check` reports the installed copy matches the build.

- [ ] **Step 2: Verify against the running app with CDP**

Launch with `--remote-debugging-port=9222`. Assert, in the installed app:

- opening a chat makes **no** `messages:list` call
- quitting and relaunching still shows the chat with its history
- a search for a word from an old message returns it
- with Beeper stopped, an already-synced chat still opens
- `userData/history.db` exists and `history.db.media/` holds real files

Take a screenshot into `docs/` -- which is gitignored and never published -- to confirm the search and the progress row render.

- [ ] **Step 3: Run every check, then release**

Run all `check:*`. Then `npm run release` and `npm run check:released`.

Verify the bump is correct: the commit type drives it, so a `feat:` gives a minor bump.