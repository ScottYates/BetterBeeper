# Search inside a conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search the conversation that is open, highlight the matches in it, and step through them, without touching the existing sidebar search.

**Architecture:** The local SQLite store gains a chat-scoped substring scan, because its FTS5 index matches whole words and a search box is expected to find a fragment. A new renderer module owns the matching rule, the merge with Beeper's own search, the step order and the DOM highlighter; the thread imports it and hands it its own functions, so the dependency runs one way only. The thread header gains a magnifier button that reveals a search row, and the thread re-applies the highlights after every render because it rebuilds itself whenever a message arrives.

**Tech Stack:** Electron 38.8.6 (Node 22.22), `node:sqlite` (`DatabaseSync`), vanilla ES modules in the renderer, CommonJS in main, no new dependencies.

## Global Constraints

- Spec: `specs/2026-11-02-thread-search-design.md`. Where this plan and the spec disagree, the spec wins and the plan is wrong.
- The sidebar search is untouched: no change to `#search-input`, `#search-scope`, `#search-row`, `src/renderer/js/sidebar.js` or `state.searchQuery`. `check:sidebar` must stay green without edits.
- New main-process logic under `src/main/` that is not Electron wiring must import **nothing from `electron`**, so it unit-tests under plain node. `src/main/media-path.js` is the existing precedent.
- New renderer modules under `src/renderer/js/` are ES modules with named exports, matching `src/renderer/js/notification-click.js`.
- All documentation and code comments are ASCII. `npm run check:ascii` must stay green. Emoji are allowed in UI strings only.
- Every new behaviour gets a repeatable `npm run check:*` script, **proven to fail when the behaviour is broken** before it is believed.
- Check helpers compare strictly against `true`. A helper that coerces with `!!` cannot tell a pass from a failure reason, and a suite that has been green over a feature nobody exercised is worse than no suite.
- Every new assertion has a control case that reproduces the old behaviour.
- IPC channels must be added to all three lists or `npm run check:api` fails: `src/main/ipc.js` (handler), `src/preload/preload.js` (contextBridge), `src/renderer/js/api.js` (mirror).
- Never disable `webSecurity`. The renderer keeps `contextIsolation: true` and `nodeIntegration: false`.
- Commit messages go in a file used with `git commit -F`; add paths **explicitly**, never `git add -A`, and remove the message file before the next commit.
- `npm run check:syntax` runs before any new JavaScript is executed. A file that does not parse raises a modal "JavaScript error occurred in the main process" dialog under `electron`, which looks like the app under test crashing.
- Every push to `main` is followed by `npm run release` and `npm run check:released`.
- Live checks only ever touch the "Note to self" chat, and never drive the running instance of the app.

---

### Task 1: The store can search one chat by substring

The local FTS index matches whole words, so `batt` does not find `battery`. The store gains a second search that scans one chat's rows for a fragment, and the sidebar keeps using the FTS one it has.

**Files:**
- Modify: `src/main/message-store.js` (add `searchInChat` to the store object, and a `likePattern` helper beside `ftsQuery`)
- Modify: `src/main/ipc.js` (add the `history:searchInChat` handler beside `history:search`)
- Modify: `src/preload/preload.js` (add `searchInChat` to the `history` block)
- Modify: `src/renderer/js/api.js` (add `searchInChat` to the `history` block)
- Test: `tools/history-check.js`

**Interfaces:**
- Consumes: nothing. The store already holds the messages.
- Produces:
  - `store.searchInChat(chatID, query, { limit = 500 })` -> `Array<{ chatID, id, text, ts, senderID, senderName }>`, oldest first, tombstones excluded, never touching another chat.
  - IPC channel `history:searchInChat(chatID, query, opts)`.
  - `window.beeper.history.searchInChat(chatID, query, opts)`.
  - `api.history.searchInChat(chatID, query, opts)`.

- [ ] **Step 1: Write the failing test**

Add to `tools/history-check.js`, in the Search section after the existing `search can be scoped to chats` case. `msg` is the existing fixture helper in that file: `msg(id, ts, text)`.

```js
// The FTS index matches whole words, so "batt" finds nothing in "battery".
// A search box is expected to find the fragment, so the chat-scoped scan
// exists for that.
add('a chat search finds a fragment of a word', () => {
  store.upsertMessages('c-frag', [msg('f1', 6000, 'the battery is flat')], {});
  const hits = store.searchInChat('c-frag', 'batt', { limit: 10 });
  return hits.length === 1 || ('got ' + hits.length + ' hits');
});

add('and it finds the whole word too', () => {
  const hits = store.searchInChat('c-frag', 'battery', { limit: 10 });
  return hits.length === 1 || ('got ' + hits.length + ' hits');
});

add('a chat search does not reach into another chat', () => {
  store.upsertMessages('c-frag-other', [msg('f2', 6001, 'another battery')], {});
  const hits = store.searchInChat('c-frag', 'batt', { limit: 50 });
  return (hits.length === 1 && hits[0].chatID === 'c-frag')
    || ('got ' + JSON.stringify(hits.map((h) => h.chatID)));
});

add('a chat search matches every term of a multi-word query', () => {
  store.upsertMessages('c-frag', [msg('f3', 6002, 'flat battery again')], {});
  const both = store.searchInChat('c-frag', 'flat batt', { limit: 10 });
  const one = store.searchInChat('c-frag', 'flat missing', { limit: 10 });
  return (both.length === 1 && one.length === 0)
    || ('both ' + both.length + ', one ' + one.length);
});

add('a chat search does not treat a wildcard as a wildcard', () => {
  store.upsertMessages('c-frag', [msg('f4', 6003, 'plain text')], {});
  const hits = store.searchInChat('c-frag', '%', { limit: 10 });
  return hits.length === 0 || ('a percent sign matched ' + hits.length + ' rows');
});

add('a chat search skips tombstoned rows', () => {
  // Its own chat, so an earlier case's tombstoning cannot decide this one.
  store.upsertMessages('c-tomb', [msg('tb1', 8000, 'battery here')], {});
  store.reconcile('c-tomb', [], { complete: true, oldestTs: 8000 });
  const hits = store.searchInChat('c-tomb', 'batt', { limit: 10 });
  return hits.length === 0 || 'returned a tombstone';
});

add('an empty chat search returns nothing rather than everything', () =>
  (store.searchInChat('c-frag', '', { limit: 10 }).length === 0
    && store.searchInChat('c-frag', '   ', { limit: 10 }).length === 0)
  || 'an empty query matched rows');

add('a chat search returns its hits oldest first', () => {
  store.upsertMessages('c-order', [
    msg('o2', 7000, 'order marker'),
    msg('o1', 6000, 'order marker'),
  ], {});
  const hits = store.searchInChat('c-order', 'order', { limit: 10 });
  return (hits.length === 2 && hits[0].ts < hits[1].ts)
    || ('got ' + JSON.stringify(hits.map((h) => h.ts)));
});

add('CONTROL: a chat search with no chat named returns nothing', () =>
  store.searchInChat('', 'batt', { limit: 10 }).length === 0 || 'ignored the chat');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run check:history`
Expected: FAIL, with `store.searchInChat is not a function` on the first new case.

- [ ] **Step 3: Write the minimal implementation**

In `src/main/message-store.js`, beside `ftsQuery`, add:

```js
/**
 * A LIKE pattern for a literal substring.
 *
 * The wildcards are escaped because a user typing "%" is looking for a percent
 * sign, not asking for every row. The escape character is a backslash, which
 * SQLite takes literally in a string literal.
 */
function likePattern(text) {
  return '%' + String(text).replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
}
```

Inside the store object, beside `search`, add:

```js
    /**
     * Every stored message in one chat that contains the text.
     *
     * The FTS index matches whole words, so "batt" does not find "battery".
     * A search box is expected to find a fragment, so this scans the chat's
     * rows instead. One chat is thousands of messages at most and
     * (chatID, ts, id) is indexed, so the scan is quick.
     *
     * Every whitespace-separated term must be found. LIKE is
     * case-insensitive for ASCII, which is what a search box is expected to
     * do, and case-sensitive beyond it.
     */
    searchInChat(chatID, query, { limit = 500 } = {}) {
      const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean);
      if (!chatID || !terms.length) return [];

      const clause = terms.map(() => "text LIKE ? ESCAPE '\\'").join(' AND ');
      const params = terms.map((term) => likePattern(term));

      // Newest first in the query, then reversed, so the cap keeps the most
      // recent matches rather than the oldest ones. A chat can hold more
      // matches than the cap allows, and the recent ones are the ones being
      // looked for.
      const rows = db.prepare(`
        SELECT chatID, id, text, ts, senderID, senderName
          FROM messages
         WHERE chatID = ? AND gone = 0 AND ${clause}
         ORDER BY ts DESC, id DESC
         LIMIT ?
      `).all(chatID, ...params, limit);

      return rows.reverse().map((row) => ({
        chatID: row.chatID,
        id: row.id,
        text: row.text,
        ts: row.ts,
        senderID: row.senderID,
        senderName: row.senderName,
      }));
    },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run check:history`
Expected: PASS, with every existing case still green.

- [ ] **Step 5: Wire the channel through the three lists**

`src/main/ipc.js`, beside the `history:search` handler:

```js
  ipcMain.handle('history:searchInChat', handle(async (chatID, query, opts) =>
    ok(historyStore.searchInChat(chatID, query, opts || {}))));
```

`src/preload/preload.js`, in the `history` block:

```js
    searchInChat: (chatID, query, opts) => invoke('history:searchInChat', chatID, query, opts),
```

`src/renderer/js/api.js`, in the `history` block:

```js
    searchInChat: (chatID, query, opts) => window.beeper.history.searchInChat(chatID, query, opts),
```

- [ ] **Step 6: Run the API surface check**

Run: `npm run check:api`
Expected: PASS. A channel added to one list and not the others fails here.

- [ ] **Step 7: Commit**

Write the message to `tools/.task1-commit.log` and run:

```bash
git add src/main/message-store.js src/main/ipc.js src/preload/preload.js src/renderer/js/api.js tools/history-check.js
git commit -F tools/.task1-commit.log
```

The subject is `feat: the local store can search one chat by substring`.

---

### Task 2: The search rules, in a module of their own

The matching rule, the merge with Beeper's hits, the step order and the highlighter all live in one renderer module with no Electron and no thread.js import, so they can be driven directly by a check.

**Files:**
- Create: `src/renderer/js/thread-search.js`
- Create: `tools/thread-search-check.js`
- Modify: `package.json` (add the `check:threadsearch` script)

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/renderer/js/thread-search.js`:
  - `termsOf(query)` -> `string[]`, the lowercased terms of a query.
  - `matchesQuery(text, query)` -> `boolean`, true when every term is in the text.
  - `isSingleWord(query)` -> `boolean`, true when the query is one word, which is all Beeper's search answers.
  - `toMillis(value)` -> `number`, epoch millis from any of Beeper's timestamp shapes.
  - `normaliseHit(hit, source)` -> `{ chatID, id, text, ts, senderID, senderName, source }`.
  - `mergeHits(localHits, remoteHits)` -> `Array<hit>`, de-duplicated by id, oldest first.
  - `nextIndex(current, total, step)` -> `number`, the index to step to, wrapping at both ends, `-1` when there is nothing to step to.
  - `highlightIn(root, query)` -> `number`, the number of matches wrapped in a `mark.ts-hit`.
  - `clearHighlights(root)` -> `number`, the number of marks removed.

- [ ] **Step 1: Write the failing test**

Create `tools/thread-search-check.js`. It is an Electron check with a hidden window, following `tools/notification-click-check.js`: the page is generated from the real `src/renderer/index.html`, the API boundary is stubbed, and the module under test is imported by its real path.

```js
/**
 * Dev check: searching inside the conversation that is open.
 *
 * The rules are driven directly, so a rule that is wrong fails here rather
 * than in a thread nobody opened. Every case has a control that reproduces
 * the behaviour it replaced.
 *
 * The DOM is generated from the real index.html, so the check cannot drift
 * from the app, and the API boundary is stubbed so no account and no network
 * are needed.
 *
 * Run with `npm run check:threadsearch`.
 */
```

The harness collects cases with an `add` helper that compares strictly against `true`, and wraps its body in `try { await body(); } catch` so one throw does not hide the cases collected so far. The harness page is this shape:

```js
  const harness = String.raw`
    (async () => {
      const cases = [];
      const add = async (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = await fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };
      const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60));

      try {
        await body();
      } catch (e) {
        cases.push(['the harness ran to the end', false, e && (e.stack || e.message)]);
      }
      return JSON.stringify(cases);

      async function body() {
        const TS = await import(${JSON.stringify(js('thread-search.js'))});
        // ... the cases, below ...
      }
    })()
  `;
```

The cases:

```js
// The matching rule.
await add('a fragment of a word matches', () =>
  TS.matchesQuery('the battery is flat', 'batt') === true || 'the fragment did not match');
await add('the whole word matches too', () =>
  TS.matchesQuery('the battery is flat', 'battery') === true || 'the word did not match');
await add('a word that is not there does not match', () =>
  TS.matchesQuery('the battery is flat', 'batteryx') === false || 'it matched anyway');
await add('every term of a multi-word query must be found', () =>
  (TS.matchesQuery('the battery is flat', 'flat batt') === true
    && TS.matchesQuery('the battery is flat', 'flat missing') === false)
  || 'the terms were not all required');
await add('an empty query matches nothing', () =>
  TS.matchesQuery('anything', '') === false || 'an empty query matched');
await add('a single word query is one word', () =>
  (TS.isSingleWord('battery') === true && TS.isSingleWord('flat battery') === false)
  || 'the word count was wrong');

// The merge.
await add('two sources are merged into one list', () => {
  const merged = TS.mergeHits(
    [{ chatID: 'c1', id: 'a', text: 'x', ts: 1000 }],
    [{ chatID: 'c1', id: 'b', text: 'y', timestamp: 2000 }],
  );
  return (merged.length === 2 && merged[0].id === 'a' && merged[1].id === 'b')
    || ('got ' + JSON.stringify(merged.map((h) => h.id)));
});
await add('a message both sides know about appears once', () => {
  const merged = TS.mergeHits(
    [{ chatID: 'c1', id: 'a', text: 'x', ts: 1000 }],
    [{ chatID: 'c1', id: 'a', text: 'x', timestamp: 1000 }],
  );
  return merged.length === 1 || ('got ' + merged.length);
});
await add('the local copy wins, so a known message is not fetched again', () => {
  const merged = TS.mergeHits(
    [{ chatID: 'c1', id: 'a', text: 'x', ts: 1000 }],
    [{ chatID: 'c1', id: 'a', text: 'x', timestamp: 1000 }],
  );
  return merged[0].source === 'local' || ('the source is ' + merged[0].source);
});
await add('hits are ordered oldest first, so stepping forward walks down the thread', () => {
  const merged = TS.mergeHits(
    [{ chatID: 'c1', id: 'new', text: 'x', ts: 5000 }],
    [{ chatID: 'c1', id: 'old', text: 'y', timestamp: '2024-01-01T00:00:00Z' }],
  );
  return merged[0].id === 'old' || ('the first is ' + merged[0].id);
});
await add('CONTROL: a hit with no id is dropped rather than drawn', () => {
  const merged = TS.mergeHits([{ chatID: 'c1', text: 'x', ts: 1000 }], []);
  return merged.length === 0 || ('got ' + merged.length);
});

// The step order.
await add('stepping forward from nothing lands on the first hit', () =>
  TS.nextIndex(-1, 5, 1) === 0 || ('got ' + TS.nextIndex(-1, 5, 1)));
await add('stepping forward advances', () =>
  TS.nextIndex(0, 5, 1) === 1 || ('got ' + TS.nextIndex(0, 5, 1)));
await add('stepping back from nothing lands on the last hit', () =>
  TS.nextIndex(-1, 5, -1) === 4 || ('got ' + TS.nextIndex(-1, 5, -1)));
await add('stepping past the end wraps to the first', () =>
  TS.nextIndex(4, 5, 1) === 0 || ('got ' + TS.nextIndex(4, 5, 1)));
await add('stepping back past the start wraps to the last', () =>
  TS.nextIndex(0, 5, -1) === 4 || ('got ' + TS.nextIndex(0, 5, -1)));
await add('CONTROL: with no hits there is nowhere to step to', () =>
  TS.nextIndex(-1, 0, 1) === -1 || ('got ' + TS.nextIndex(-1, 0, 1)));

// The highlighter, against real markup.
await add('a match in the thread is marked', () => {
  const root = document.getElementById('message-list');
  root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
  const count = TS.highlightIn(root, 'batt');
  return (count === 1 && root.querySelectorAll('mark.ts-hit').length === 1)
    || ('marked ' + count);
});
await add('the mark holds the matched text', () => {
  const root = document.getElementById('message-list');
  root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
  TS.highlightIn(root, 'batt');
  return root.querySelector('mark.ts-hit').textContent === 'batt'
    || ('the mark reads ' + root.querySelector('mark.ts-hit').textContent);
});
await add('a match inside markup is still found', () => {
  const root = document.getElementById('message-list');
  root.innerHTML = '<div class="msg"><div class="msg-text">a <strong>batt</strong>ery here</div></div>';
  const count = TS.highlightIn(root, 'batt');
  return count === 1 || ('marked ' + count);
});
await add('CONTROL: the words around a match are left alone', () => {
  const root = document.getElementById('message-list');
  root.innerHTML = '<div class="msg"><div class="msg-text">plain words</div></div>';
  const count = TS.highlightIn(root, 'strong');
  return count === 0 || ('marked ' + count);
});
await add('every match is marked, not only the first', () => {
  const root = document.getElementById('message-list');
  root.innerHTML = '<div class="msg"><div class="msg-text">batt and batt and batt</div></div>';
  const count = TS.highlightIn(root, 'batt');
  return count === 3 || ('marked ' + count);
});
await add('clearing removes every mark and keeps the text', () => {
  const root = document.getElementById('message-list');
  root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
  TS.highlightIn(root, 'batt');
  const cleared = TS.clearHighlights(root);
  return (cleared === 1
    && root.querySelectorAll('mark.ts-hit').length === 0
    && root.textContent.includes('the battery is flat'))
    || ('cleared ' + cleared);
});
await add('CONTROL: a mark that was not ours is left alone', () => {
  const root = document.getElementById('message-list');
  root.innerHTML = '<div class="msg"><div class="msg-text">a <mark>real</mark> mark</div></div>';
  TS.clearHighlights(root);
  return root.querySelectorAll('mark').length === 1 || 'it removed a mark it did not make';
});
```

Register the script in `package.json`, beside the other `check:` scripts:

```js
    "check:threadsearch": "electron tools/thread-search-check.js",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run check:syntax` then `npm run check:threadsearch`
Expected: FAIL, because `src/renderer/js/thread-search.js` does not exist yet.

- [ ] **Step 3: Write the module**

Create `src/renderer/js/thread-search.js`:

```js
/**
 * Searching inside the conversation that is open.
 *
 * The rules live here rather than in the thread so they can be driven
 * directly by a check. Nothing in this file imports the thread, and the
 * thread imports this file, so the dependency runs one way only.
 *
 * The matching rule is a substring, not a whole word: a search box is
 * expected to find a fragment. The local store's FTS index cannot do that,
 * which is why the store gained a chat-scoped scan beside it.
 */

/** The lowercased terms of a query. An empty query has no terms. */
export function termsOf(query) {
  return String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when the text contains every term of the query, ignoring case. */
export function matchesQuery(text, query) {
  const terms = termsOf(query);
  if (!terms.length) return false;
  const haystack = String(text ?? '').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * True when the query is a single word.
 *
 * Beeper's own search answers a multi-word query like a phrase, so it
 * returns nothing for "flat battery" where the local store finds both.
 * Asking it for one word only is what makes the two agree.
 */
export function isSingleWord(query) {
  return termsOf(query).length === 1;
}

/** Epoch millis from any of the timestamp shapes Beeper sends. */
export function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value instanceof Date) return value.getTime();
  return 0;
}

/**
 * One hit, in the shape both sources can be compared in.
 *
 * The local store calls the timestamp `ts` and Beeper calls it `timestamp`,
 * and Beeper's is a string half the time. The source is kept because a hit
 * that only Beeper knows about has to be fetched before it can be drawn.
 */
export function normaliseHit(hit, source) {
  return {
    chatID: hit?.chatID ?? null,
    id: String(hit?.id ?? ''),
    text: String(hit?.text ?? ''),
    ts: toMillis(hit?.ts ?? hit?.timestamp),
    senderID: hit?.senderID ?? null,
    senderName: hit?.senderName ?? null,
    source,
  };
}

/**
 * Both sources in one list, oldest first.
 *
 * De-duplicated by message id, because a message both sides know about is
 * one message and must be drawn once. The local copy wins, because a hit the
 * store already holds needs no fetching.
 */
export function mergeHits(localHits, remoteHits) {
  const seen = new Set();
  const out = [];
  const sources = [
    ...(localHits || []).map((hit) => [hit, 'local']),
    ...(remoteHits || []).map((hit) => [hit, 'remote']),
  ];
  for (const [hit, source] of sources) {
    const normalised = normaliseHit(hit, source);
    if (!normalised.id || seen.has(normalised.id)) continue;
    seen.add(normalised.id);
    out.push(normalised);
  }
  out.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return out;
}

/**
 * The index to step to.
 *
 * Wrapping at both ends, because a search that stops at the last hit makes
 * the user press the key again to find out there is nothing more.
 */
export function nextIndex(current, total, step) {
  if (!total) return -1;
  if (current < 0) return step < 0 ? total - 1 : 0;
  const next = current + (step < 0 ? -1 : 1);
  if (next < 0) return total - 1;
  if (next >= total) return 0;
  return next;
}

/** The class every mark this module makes carries. */
const HIT_CLASS = 'ts-hit';

/**
 * Wrap every match of the query in a mark.
 *
 * The thread draws message text as rich HTML, because Beeper sends markup,
 * so the match is found in the DOM rather than in the raw string: a term
 * inside a tag is not a match, and a term split across tags still is.
 */
export function highlightIn(root, query) {
  clearHighlights(root);
  const terms = termsOf(query);
  if (!root || !terms.length) return 0;

  let count = 0;
  for (const node of textNodesUnder(root)) {
    count += markTextNode(node, terms);
  }
  return count;
}

/**
 * Remove the marks this module made.
 *
 * Only marks carrying its own class are touched, because a message may
 * arrive from Beeper carrying a real `mark` of its own.
 */
export function clearHighlights(root) {
  if (!root) return 0;
  const marks = [...root.querySelectorAll(`mark.${HIT_CLASS}`)];
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    const doc = root.ownerDocument || document;
    parent.replaceChild(doc.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  return marks.length;
}

/** The text nodes under a root that could hold a match. */
function textNodesUnder(root) {
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return 1; // FILTER_REJECT
      const parent = node.parentElement;
      if (!parent) return 1;
      // Our own marks, and anything that is not text the reader reads.
      if (parent.closest(`mark.${HIT_CLASS}, script, style, textarea`)) return 1;
      return 2; // FILTER_ACCEPT
    },
  });
  const out = [];
  let node = walker.nextNode();
  while (node) {
    out.push(node);
    node = walker.nextNode();
  }
  return out;
}

/**
 * Wrap the matches in one text node.
 *
 * The node is replaced by a fragment of text and marks, so every match in
 * it is found in one pass and the text around them is kept exactly.
 */
function markTextNode(node, terms) {
  const doc = node.ownerDocument || document;
  const value = node.nodeValue;
  const lower = value.toLowerCase();
  const fragment = doc.createDocumentFragment();
  let cursor = 0;
  let count = 0;

  while (cursor < value.length) {
    let index = -1;
    let matched = '';
    for (const term of terms) {
      const at = lower.indexOf(term, cursor);
      if (at >= 0 && (index < 0 || at < index)) {
        index = at;
        matched = term;
      }
    }
    if (index < 0) break;
    if (index > cursor) fragment.append(doc.createTextNode(value.slice(cursor, index)));
    const mark = doc.createElement('mark');
    mark.className = HIT_CLASS;
    mark.textContent = value.slice(index, index + matched.length);
    fragment.append(mark);
    count += 1;
    cursor = index + matched.length;
  }

  if (!count) return 0;
  if (cursor < value.length) fragment.append(doc.createTextNode(value.slice(cursor)));
  node.parentNode.replaceChild(fragment, node);
  return count;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run check:syntax` then `npm run check:threadsearch`
Expected: PASS, every case green.

- [ ] **Step 5: Prove the check can fail**

Temporarily change `matchesQuery` in the module so it returns `true` for every query, run `npm run check:threadsearch`, and confirm the matching cases go red. Restore the line and confirm the suite is green again. A check that has never been seen to fail is not evidence.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/js/thread-search.js tools/thread-search-check.js package.json
git commit -F tools/.task2-commit.log
```

The subject is `feat: the search rules in a module of their own`.

---

### Task 3: Beeper can hand over a single message

A hit that only Beeper knows about cannot be shown as a bubble until the app can ask for that one message. The client already has `getMessage`; it is not exposed to the renderer.

**Files:**
- Modify: `src/main/ipc.js`
- Modify: `src/preload/preload.js`
- Modify: `src/renderer/js/api.js`
- Test: `tools/thread-search-check.js`

**Interfaces:**
- Consumes: `client.getMessage(chatID, messageID)`, which already exists in `src/main/beeper-client.js`.
- Produces:
  - IPC channel `messages:get(chatID, messageID)` -> the message object.
  - `window.beeper.messages.get(chatID, messageID)`.
  - `api.messages.get(chatID, messageID)`.

- [ ] **Step 1: Write the failing test**

Add to `tools/thread-search-check.js`, in the Node part after the harness cases, where the source of all three sides can be read. The channel name is a string on both sides of the bridge, and a typo on one side only would leave both checks green while the feature does nothing, so the two names are read out of the source and compared:

```js
  // The channel name is a string on both sides of the bridge. A typo on one
  // side only leaves both source checks green while the fetch does nothing,
  // so the two names are read out of the source and compared.
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'api.js'), 'utf8');

  const preloadChannel = (preloadSrc.match(/get: \(chatID, messageID\) => invoke\('([^']+)'/) || [])[1];
  const ipcChannel = (ipcSrc.match(/ipcMain\.handle\('([^']+)', handle\(async \(chatID, messageID\)/) || [])[1];

  const sourceCases = [
    ['the preload can ask for one message',
      /get: \(chatID, messageID\) => invoke\('messages:get'/.test(preloadSrc)],
    ['the main process has a handler for it',
      /ipcMain\.handle\('messages:get'/.test(ipcSrc)],
    ['and the two sides are talking about the same channel',
      Boolean(preloadChannel) && preloadChannel === ipcChannel,
      `the preload listens on "${preloadChannel}", the main process handles "${ipcChannel}"`],
    ['the renderer can ask for one message',
      /get: \(chatID, messageID\) => window\.beeper\.messages\.get\(/.test(apiSrc)],
  ].map(([name, ok, detail]) => [name, ok, detail || '']);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run check:threadsearch`
Expected: FAIL, because the channel does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

`src/main/ipc.js`, beside the other `messages:` handlers:

```js
  ipcMain.handle('messages:get', handle(async (chatID, messageID) => {
    if (!chatID || !messageID) return ok(null);
    return ok(await client.getMessage(chatID, messageID));
  }));
```

`src/preload/preload.js`, in the `messages` block:

```js
    get: (chatID, messageID) => invoke('messages:get', chatID, messageID),
```

`src/renderer/js/api.js`, in the `messages` block:

```js
    get: (chatID, messageID) => window.beeper.messages.get(chatID, messageID),
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run check:threadsearch` then `npm run check:api`
Expected: PASS. `check:api` fails if the channel is in one list and not the others.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.js src/preload/preload.js src/renderer/js/api.js tools/thread-search-check.js
git commit -F tools/.task3-commit.log
```

The subject is `feat: the renderer can ask Beeper for a single message`.

---

### Task 4: The search box in the thread

The header button, the row under it, the counter, and the stepping. The results come from the local store, which Task 1 delivered.

**Files:**
- Modify: `src/renderer/index.html` (the button in the thread header, the row under the header)
- Modify: `src/renderer/styles.css` (the row, the counter, the marks)
- Modify: `src/renderer/js/thread.js` (wire the row, re-apply the highlights after a render, close it when the chat changes)
- Modify: `src/renderer/js/main.js` (the Escape guard)
- Modify: `src/renderer/js/thread-search.js` (the interface)
- Test: `tools/thread-search-check.js`

**Interfaces:**
- Consumes: `api.history.searchInChat(chatID, query, opts)` from Task 1, and the module from Task 2.
- Produces, from `src/renderer/js/thread-search.js`:
  - `initThreadSearch(deps)` -> `void`, where `deps` is `{ getChatID, renderAll, focusComposer, scrollToMessage }`.
  - `openThreadSearch()` -> `void`, opens the row and focuses the input.
  - `closeThreadSearch()` -> `void`, clears the highlights and returns the cursor to the composer.
  - `applyThreadSearchHighlights()` -> `number`, re-applies the highlights to the thread, called after every render.
  - `isThreadSearchOpen()` -> `boolean`.
  - `threadSearchState()` -> `{ query, hits, index, open }`, for the check to read.

- [ ] **Step 1: Write the failing test**

Add to `tools/thread-search-check.js`. The harness stubs `window.beeper.history.open` so that opening a chat draws real bubbles, and stubs `window.beeper.history.searchInChat` so the search has an answer with no account and no network:

```js
        const envelope = (data) => ({ ok: true, data });
        const bubble = (id, ts, text, sender) => ({
          id, chatID: 'c-note', accountID: 'a1', senderID: sender,
          senderName: sender === 'a1' ? 'Me' : 'Them', text,
          timestamp: ts, isSender: sender === 'a1', type: 'TEXT',
        });

        window.beeper = {
          on: () => {},
          chats: {
            list: async () => envelope([]),
            get: async () => envelope(null),
            patch: async () => envelope({}),
            markRead: async () => envelope(true),
            markUnread: async () => envelope(true),
            archive: async () => envelope(true),
            create: async () => envelope({}),
          },
          messages: {
            list: async () => envelope({ items: [], hasMore: false }),
            search: async () => envelope({ items: [] }),
            get: async () => envelope(null),
          },
          history: {
            open: async () => envelope({
              messages: [
                bubble('m1', 1000, 'the battery is flat', 'a2'),
                bubble('m2', 2000, 'nothing to see here', 'a2'),
                bubble('m3', 3000, 'batt batt batt', 'a1'),
              ],
              complete: true,
              hasMore: false,
            }),
            page: async () => envelope({ messages: [], hasMore: false, complete: true }),
            upsert: async () => envelope({ written: 1 }),
            search: async () => envelope([]),
            searchInChat: async () => envelope([
              { chatID: 'c-note', id: 'm1', text: 'the battery is flat', ts: 1000 },
              { chatID: 'c-note', id: 'm3', text: 'batt batt batt', ts: 3000 },
            ]),
            status: async () => envelope({ messages: 0, chats: 0, bytes: 0 }),
            refresh: async () => envelope({ queued: true }),
            jobs: async () => envelope({ jobs: [] }),
          },
        };
```

The cases drive the real wiring, so a wiring that stopped searching shows up here rather than in a source match:

```js
        const S = await import(${JSON.stringify(js('state.js'))});
        const T = await import(${JSON.stringify(js('thread.js'))});
        T.initThread();
        S.state.chats.set('c-note', {
          id: 'c-note', title: 'A conversation', type: 'single',
          participants: { items: [{ isSelf: true }, { isSelf: false }] },
        });
        await T.openChat('c-note');
        await settle(120);

        await add('the header has a search button', () =>
          Boolean(document.getElementById('btn-thread-search')) || 'there is no button');

        await add('the search row is hidden until the button is used', () =>
          document.getElementById('thread-search-row').hidden === true || 'the row was already open');

        await add('the button opens the row', () => {
          document.getElementById('btn-thread-search').click();
          return document.getElementById('thread-search-row').hidden === false || 'the row stayed shut';
        });

        await add('typing in the row searches the open chat', async () => {
          const field = document.getElementById('thread-search-input');
          field.value = 'batt';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await settle(400);
          return TS.threadSearchState().query === 'batt' || 'the query never arrived';
        });

        await add('and the counter says how many there are', () =>
          /of\s*\d+/.test(document.getElementById('thread-search-count').textContent)
          || ('the counter reads ' + document.getElementById('thread-search-count').textContent));

        await add('and the matches are marked in the thread', () =>
          document.querySelectorAll('#message-list mark.ts-hit').length > 0 || 'nothing was marked');

        await add('Enter steps to the next match', async () => {
          const before = TS.threadSearchState().index;
          document.getElementById('thread-search-input')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await settle(150);
          const after = TS.threadSearchState().index;
          return (after !== before) || ('the index stayed at ' + after);
        });

        await add('Shift+Enter steps back', async () => {
          const before = TS.threadSearchState().index;
          document.getElementById('thread-search-input')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
          await settle(150);
          const after = TS.threadSearchState().index;
          return (after !== before) || ('the index stayed at ' + after);
        });

        await add('clearing the query removes every mark', async () => {
          const field = document.getElementById('thread-search-input');
          field.value = '';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await settle(400);
          return document.querySelectorAll('#message-list mark.ts-hit').length === 0
            || 'a mark was left behind';
        });

        await add('Escape closes the row', async () => {
          document.getElementById('btn-thread-search').click();
          const field = document.getElementById('thread-search-input');
          field.value = 'batt';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await settle(400);
          field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await settle(150);
          return document.getElementById('thread-search-row').hidden === true || 'the row stayed open';
        });

        await add('CONTROL: the sidebar search is not this search', () =>
          document.getElementById('search-input') !== document.getElementById('thread-search-input')
          || 'the two searches share an input');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run check:threadsearch`
Expected: FAIL, because the button and the row do not exist yet.

- [ ] **Step 3: Add the markup**

`src/renderer/index.html`, in the thread header's action buttons, next to `#btn-refresh`:

```html
            <button
              id="btn-thread-search"
              class="icon-btn"
              data-tip="Search this conversation"
              aria-label="Search this conversation"
            >
              &#8981;
            </button>
```

And directly after the thread header's closing `</header>`, before `<div id="message-list">`:

```html
          <div class="thread-search-row" id="thread-search-row" hidden>
            <input
              id="thread-search-input"
              type="search"
              placeholder="Search this conversation"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search this conversation"
            />
            <span class="thread-search-count" id="thread-search-count"></span>
            <button id="thread-search-prev" class="icon-btn tiny-btn" data-tip="Previous match" aria-label="Previous match">&#9650;</button>
            <button id="thread-search-next" class="icon-btn tiny-btn" data-tip="Next match" aria-label="Next match">&#9660;</button>
            <button id="thread-search-close" class="icon-btn tiny-btn" data-tip="Close" aria-label="Close search">&#10005;</button>
            <span class="thread-search-note" id="thread-search-note"></span>
          </div>
```

The entities above are the glyphs the app already uses for the same controls:
U+2315 for the magnifier, which is the same character the sidebar's search
button uses, U+25B2 and U+25BC for the arrows, and U+2715 for the close. They
are written as entities here because this file is ASCII; the markup itself may
use the literal characters.

- [ ] **Step 4: Add the styles**

`src/renderer/styles.css`, beside the `.search-row` rules:

```css
/* The conversation's own search sits under the thread header, in the same
   shape as the sidebar's, so the app has one search idiom rather than two. */
.thread-search-row {
  display: flex; gap: 6px; align-items: center;
  padding: 0 14px 10px;
}
.thread-search-row input { flex: 1; min-width: 0; }
.thread-search-count { font-size: 12.5px; color: var(--text-dim); white-space: nowrap; }
.thread-search-note { font-size: 12.5px; color: var(--text-faint); }
.thread-search-note:empty { display: none; }

/* A match in the thread. The current one is the one the user is on. */
mark.ts-hit {
  background: var(--accent-soft);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}
mark.ts-hit.is-current {
  background: var(--accent);
  color: var(--bg);
}
```

- [ ] **Step 5: Write the interface in the module**

In `src/renderer/js/thread-search.js`, add the state and the wiring. The module needs the API, so add this import at the top of the file:

```js
import { api } from './api.js';
```

Then:

```js
// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 250;

/** Everything the module needs from the thread, handed in rather than imported. */
let deps = {
  getChatID: () => null,
  renderAll: () => {},
  focusComposer: () => {},
  scrollToMessage: () => {},
};

let activeQuery = '';
let hits = [];
let currentIndex = -1;
let isOpen = false;
/** Bumped by every search, so a slow one cannot overwrite a newer one. */
let searchToken = 0;
let debounceTimer = null;

function row() { return document.getElementById('thread-search-row'); }
function input() { return document.getElementById('thread-search-input'); }
function counter() { return document.getElementById('thread-search-count'); }
function note() { return document.getElementById('thread-search-note'); }
function messageList() { return document.getElementById('message-list'); }

/** Wire the row to the app. The thread hands its own functions in. */
export function initThreadSearch(handles) {
  deps = { ...deps, ...(handles || {}) };

  const button = document.getElementById('btn-thread-search');
  if (button) button.addEventListener('click', openThreadSearch);

  const close = document.getElementById('thread-search-close');
  if (close) close.addEventListener('click', closeThreadSearch);

  const prev = document.getElementById('thread-search-prev');
  if (prev) prev.addEventListener('click', () => step(-1));

  const next = document.getElementById('thread-search-next');
  if (next) next.addEventListener('click', () => step(1));

  const box = input();
  if (box) {
    box.addEventListener('input', onInput);
    box.addEventListener('keydown', onKeyDown);
  }
}

/** Open the row and put the cursor in it. */
export function openThreadSearch() {
  const box = row();
  if (!box) return;
  isOpen = true;
  box.hidden = false;
  const field = input();
  if (field) field.focus();
}

/** Close the row, take the marks out, and give the cursor back. */
export function closeThreadSearch() {
  const box = row();
  if (box) box.hidden = true;
  isOpen = false;
  activeQuery = '';
  hits = [];
  currentIndex = -1;
  searchToken += 1;
  const field = input();
  if (field) field.value = '';
  if (counter()) counter().textContent = '';
  if (note()) note().textContent = '';
  clearHighlights(messageList());
  deps.focusComposer();
}

export function isThreadSearchOpen() {
  return isOpen;
}

/** What the check reads to see what the search is doing. */
export function threadSearchState() {
  return { query: activeQuery, hits: [...hits], index: currentIndex, open: isOpen };
}

function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, DEBOUNCE_MS);
}

function onKeyDown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeThreadSearch();
  }
}

/**
 * Run the search and draw the answer.
 *
 * The local store answers for everything this device holds. Beeper's own
 * search is asked as well, but only for a single word, because a multi-word
 * query there behaves like a phrase and would return nothing.
 */
async function runSearch() {
  const query = String(input()?.value || '').trim();
  activeQuery = query;
  const token = ++searchToken;

  if (!query) {
    hits = [];
    currentIndex = -1;
    if (counter()) counter().textContent = '';
    if (note()) note().textContent = '';
    clearHighlights(messageList());
    return;
  }

  const chatID = deps.getChatID();
  if (!chatID) return;
  if (counter()) counter().textContent = 'Searching...';

  const local = await callApi(() => api.history.searchInChat(chatID, query, { limit: 500 }), []);
  const remote = isSingleWord(query)
    ? await callApi(() => api.messages.search({ query, chatIDs: [chatID], limit: 20 }), { items: [] })
    : { items: [] };

  if (token !== searchToken) return; // a newer search superseded this one

  // Beeper's hits are re-tested against the same rule the local search uses,
  // so the counter can never count a match that is not highlighted.
  const remoteHits = (remote.items || []).filter((hit) => matchesQuery(hit.text, query));
  hits = mergeHits(local, remoteHits);
  currentIndex = hits.length ? 0 : -1;

  if (counter()) {
    counter().textContent = hits.length ? `1 of ${hits.length}` : 'No matches';
  }
  applyThreadSearchHighlights();
  if (hits.length) goTo(0);
}

/** Call the API without letting a failure take the search down with it. */
async function callApi(fn, fallback) {
  try {
    const result = await fn();
    return result ?? fallback;
  } catch {
    return fallback;
  }
}

/** Step to the next or previous hit, wrapping at both ends. */
function step(direction) {
  if (!hits.length) return;
  currentIndex = nextIndex(currentIndex, hits.length, direction);
  goTo(currentIndex);
}

/** Scroll to the current hit and mark it as the current one. */
function goTo(index) {
  const hit = hits[index];
  if (!hit) return;
  if (counter()) counter().textContent = `${index + 1} of ${hits.length}`;
  deps.scrollToMessage(hit.id);
  markCurrent(index);
}

/** Put the current marker on the right mark. */
function markCurrent(index) {
  const root = messageList();
  if (!root) return;
  const marks = [...root.querySelectorAll('mark.ts-hit')];
  for (const mark of marks) mark.classList.remove('is-current');
  const hit = hits[index];
  if (!hit) return;
  const mark = marks.find(
    (node) => node.closest('[data-message-id]')?.getAttribute('data-message-id') === hit.id,
  );
  if (mark) mark.classList.add('is-current');
}

/**
 * Re-apply the highlights to the thread.
 *
 * The thread rebuilds itself whenever a message arrives, so the marks have
 * to be put back after every render. Without this, the first message that
 * arrived during a search would wipe every mark on screen.
 */
export function applyThreadSearchHighlights() {
  const root = messageList();
  if (!root) return 0;
  if (!activeQuery) return 0;
  const count = highlightIn(root, activeQuery);
  markCurrent(currentIndex);
  return count;
}
```

- [ ] **Step 6: Wire it into the thread**

`src/renderer/js/thread.js`, at the top, add the import:

```js
import { initThreadSearch, applyThreadSearchHighlights, closeThreadSearch } from './thread-search.js';
```

In `initThread`, after the refresh button is wired, add:

```js
  // The conversation's own search. The thread hands the module its own
  // functions rather than the module importing the thread, so the dependency
  // runs one way only and both can be checked.
  initThreadSearch({
    getChatID: () => state.activeChatID,
    renderAll: () => renderAll(),
    focusComposer: () => focusComposer(),
    scrollToMessage: (id) => scrollToMessage(id),
  });
```

In `renderAll`, after the messages are appended and before the scroll, add:

```js
  // The thread rebuilds itself, so the search marks have to be put back.
  applyThreadSearchHighlights();
```

In `openChat`, in the block that runs when the chat changes, add:

```js
    // The marks belong to the conversation that was open.
    closeThreadSearch();
```

- [ ] **Step 7: Keep Escape from closing the conversation**

`src/renderer/js/main.js`, in the capture-phase Escape handler, add a guard beside the one for the sidebar's search box:

```js
      // Escape in the search box clears the search; it must not close the chat.
      if (event.target?.id === 'search-input') return;
      // Escape in the conversation's own search closes that row and nothing
      // else. This handler runs in the capture phase, so it sees the key
      // before the search row's own handler does: without this guard, one
      // Escape would close the row and the conversation behind it.
      if (event.target?.id === 'thread-search-input') return;
```

- [ ] **Step 8: Run the check**

Run: `npm run check:syntax` then `npm run check:threadsearch`
Expected: PASS.

- [ ] **Step 9: Run the whole suite**

Run: `npm run check:all`
Expected: PASS, 45 suites. `check:sidebar` must be untouched and still green.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/index.html src/renderer/styles.css src/renderer/js/thread.js src/renderer/js/main.js src/renderer/js/thread-search.js tools/thread-search-check.js
git commit -F tools/.task4-commit.log
```

The subject is `feat: search inside the conversation that is open`.

---

### Task 5: Reaching the rest of the conversation

The local store only holds what has been synced, and the thread only draws the part of it that has been loaded. A hit outside the drawn window has to be brought into it, and a hit only Beeper knows about has to be fetched before it can be drawn at all.

**Files:**
- Modify: `src/renderer/js/thread.js` (a function that pages until a hit is inside the window)
- Modify: `src/renderer/js/thread-search.js` (use it, fetch the server-only hits, queue the refresh)
- Test: `tools/thread-search-check.js`

**Interfaces:**
- Consumes: `api.history.page(chatID, { before, limit })`, `api.messages.get(chatID, messageID)`, `api.history.upsert(chatID, message)` and `api.history.refresh(chatID)`.
- Produces:
  - `loadHistoryUntil(targetTs, maxPages)` in `src/renderer/js/thread.js` -> `Promise<boolean>`, true when the window now reaches that timestamp.
  - `fetchRemoteHit(hit)` in `src/renderer/js/thread-search.js` -> `Promise<boolean>`.
  - `queueHistoryRefresh(chatID)` in `src/renderer/js/thread-search.js` -> `Promise<void>`.

- [ ] **Step 1: Write the failing test**

Add to `tools/thread-search-check.js`. The harness stubs `window.beeper.messages.get` to answer with one message, and collects the refresh calls:

```js
        const refreshCalls = [];
        window.beeper.history.refresh = async (id) => { refreshCalls.push(id); return envelope({ queued: true }); };
        window.beeper.messages.get = async (chatID, messageID) => envelope({
          id: messageID, chatID, accountID: 'a2', senderID: 'a2', senderName: 'Them',
          text: 'a message only Beeper had', timestamp: 1500, isSender: false, type: 'TEXT',
        });
```

The cases:

```js
        await add('a hit only Beeper knows about is fetched and drawn', async () => {
          const fetched = await TS.fetchRemoteHit({
            chatID: 'c-note', id: 'remote-1', ts: 1500, source: 'remote',
          });
          if (fetched !== true) return 'the hit was not fetched';
          await settle(150);
          const list = document.getElementById('message-list');
          return list.querySelector('[data-message-id="remote-1"]') !== null
            || 'the message was not drawn';
        });

        await add('CONTROL: a hit the store already holds is not fetched again', async () => {
          const fetched = await TS.fetchRemoteHit({
            chatID: 'c-note', id: 'm1', ts: 1000, source: 'local',
          });
          return fetched === false || 'a known hit was fetched anyway';
        });

        await add('a search that finds something Beeper has and this device has not queues a refresh', async () => {
          refreshCalls.length = 0;
          await TS.queueHistoryRefresh('c-note');
          await settle(120);
          return refreshCalls.includes('c-note')
            || ('the refresh was not queued for ' + JSON.stringify(refreshCalls));
        });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run check:threadsearch`
Expected: FAIL, because `fetchRemoteHit` and `queueHistoryRefresh` do not exist yet.

- [ ] **Step 3: Add the paging to the thread**

In `src/renderer/js/thread.js`, beside `loadOlder`, add:

```js
/**
 * Page backwards until the window reaches a timestamp.
 *
 * A search can find a message that is in the store but not on screen, and
 * scrolling to it means drawing it first. The scroll position is not
 * preserved across these pages, because the user asked to be put on the
 * message rather than left where they were.
 *
 * The cap is a guard, not a policy: a chat with a very old hit needs more
 * pages than one with a recent hit, and a loop that never ends is worse than
 * a hit that is not reached.
 */
export async function loadHistoryUntil(targetTs, maxPages = 20) {
  const chatID = state.activeChatID;
  if (!chatID) return false;

  for (let page = 0; page < maxPages; page += 1) {
    const oldest = renderableMessages(chatID)[0];
    if (!oldest) return false;
    // The oldest drawn message is already older than the hit, so the window
    // reaches it.
    if (millisOf(oldest.timestamp) <= Number(targetTs)) return true;

    const result = await call(
      () => api.history.page(chatID, { before: oldest.id, limit: 50 }),
      { context: 'older messages' },
    );
    if (!result || state.activeChatID !== chatID) return false;
    const items = result.messages || [];
    if (!items.length) return false;

    upsertMessages(chatID, items);
    hasMore = Boolean(result.hasMore);
  }
  return false;
}

/** Epoch millis from a timestamp in any of Beeper's shapes. */
function millisOf(value) {
  const parsed = parseTs(value);
  return parsed ? parsed.getTime() : 0;
}
```

- [ ] **Step 4: Fetch the hits only Beeper knows about**

In `src/renderer/js/thread-search.js`, add the import the renderer state needs at the top of the file:

```js
import { upsertMessages } from './state.js';
```

Then add:

```js
/**
 * Fetch a hit the local store does not have and draw it.
 *
 * A hit that only Beeper knows about cannot be drawn until the message
 * itself is fetched, so it is fetched, put in the renderer, and written to
 * the store so the next search finds it locally.
 *
 * Returns false for a hit the store already holds, and for one that cannot
 * be fetched, so the step is skipped rather than stalling on it.
 */
export async function fetchRemoteHit(hit) {
  if (!hit?.id || hit.source !== 'remote') return false;
  const chatID = hit.chatID || deps.getChatID();
  if (!chatID) return false;

  const message = await callApi(() => api.messages.get(chatID, hit.id), null);
  if (!message?.id) return false;

  upsertMessages(chatID, [message]);
  await callApi(() => api.history.upsert(chatID, message), null);
  deps.renderAll();
  return true;
}

/**
 * Queue a refresh of the chat's history.
 *
 * A search that finds a hit this device has never seen is telling the app
 * that its copy of the conversation is incomplete. The refresh walks the
 * chat back from the oldest message held, so the missing context arrives on
 * its own and later searches find those hits locally.
 */
export async function queueHistoryRefresh(chatID) {
  const id = chatID || deps.getChatID();
  if (!id) return;
  await callApi(() => api.history.refresh(id), null);
}
```

- [ ] **Step 5: Use them when a hit is stepped to**

In `src/renderer/js/thread-search.js`, change `goTo` so a hit that is not on screen is brought into it first:

```js
/** Scroll to the current hit and mark it as the current one. */
async function goTo(index) {
  const hit = hits[index];
  if (!hit) return;
  if (counter()) counter().textContent = `${index + 1} of ${hits.length}`;

  // A hit that is not on screen is brought into the window first: a hit only
  // Beeper knows about has to be fetched, and a hit the store has but the
  // thread has not drawn has to be paged in.
  const node = document.querySelector(`[data-message-id="${CSS.escape(hit.id)}"]`);
  if (!node && hit.source === 'remote') {
    await fetchRemoteHit(hit);
  } else if (!node) {
    await deps.loadHistoryUntil(hit.ts);
    deps.renderAll();
  }

  deps.scrollToMessage(hit.id);
  markCurrent(index);
}
```

`step` calls `goTo` without awaiting it, which is deliberate: the counter must move at once, and the scroll follows when the message is there. Make `step` async and await it, so a slow fetch cannot leave two steps racing:

```js
/** Step to the next or previous hit, wrapping at both ends. */
async function step(direction) {
  if (!hits.length) return;
  currentIndex = nextIndex(currentIndex, hits.length, direction);
  await goTo(currentIndex);
}
```

Add `loadHistoryUntil` to the default deps:

```js
let deps = {
  getChatID: () => null,
  renderAll: () => {},
  focusComposer: () => {},
  scrollToMessage: () => {},
  loadHistoryUntil: async () => false,
};
```

And in `src/renderer/js/thread.js`, in the `initThreadSearch` call, add it:

```js
    loadHistoryUntil: (ts) => loadHistoryUntil(ts),
```

- [ ] **Step 6: Queue the refresh when Beeper knows of hits the device does not**

In `runSearch`, after the merge, add:

```js
  // Beeper knows of something this device has never seen. The chat's own
  // copy is incomplete, so the refresh is queued to bring the rest home.
  if (remoteHits.length) queueHistoryRefresh(chatID);
```

- [ ] **Step 7: Run the check and the suite**

Run: `npm run check:syntax` then `npm run check:threadsearch` then `npm run check:all`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/js/thread.js src/renderer/js/thread-search.js tools/thread-search-check.js
git commit -F tools/.task5-commit.log
```

The subject is `feat: reach the rest of the conversation when searching`.

---

### Task 6: A red proof, the documentation, and the release

**Files:**
- Create: `tools/thread-search-redproof.js`
- Modify: `README.md`
- Modify: `HANDOFF-betterbeeper.md`

**Interfaces:**
- Consumes: everything the earlier tasks produced.
- Produces: a red proof that the suite can fail, and the documentation for the release.

- [ ] **Step 1: Write the red proof**

`tools/thread-search-redproof.js` follows `tools/notification-click-redproof.js`: it copies the module to a scratch file, mutates it in a way that breaks one rule, runs the check against the mutated copy, and reports whether the check caught it. The mutations to cover:

| Mutation | What it breaks |
| --- | --- |
| `matchesQuery` returns `true` for any query | the matching rule |
| `mergeHits` drops the de-duplication | one message drawn twice |
| `mergeHits` sorts newest first | the step order |
| `nextIndex` stops at the end instead of wrapping | stepping past the end |
| `highlightIn` marks only the first match | every match marked |
| `clearHighlights` removes every `mark` | a mark that was not ours |

Each mutation must make the suite go red. One neutral rewrite, which changes the code without changing the behaviour, must leave it green, so the proof is not just detecting that the file changed.

Run: `node tools/thread-search-redproof.js`
Expected: every mutation caught, the neutral rewrite tolerated.

- [ ] **Step 2: Update the README**

Add the search to the feature list, in the same voice as the entries around it. Say what it does, not how it is built: searching inside the conversation that is open, highlighting the matches and stepping through them with Enter and Shift+Enter.

- [ ] **Step 3: Update the handoff**

`HANDOFF-betterbeeper.md` is the working handoff and is read before the next session. Update the "Last updated" paragraph, the commit list, the version paragraph and the work list to describe this release. The file is the map of the tree, so it must name the new files: `src/renderer/js/thread-search.js`, `tools/thread-search-check.js` and `tools/thread-search-redproof.js`.

- [ ] **Step 4: Run every check**

Run: `npm run check:all` then `npm run check:ascii` then `npm run check:syntax`
Expected: PASS.

- [ ] **Step 5: Commit the documentation**

```bash
git add README.md HANDOFF-betterbeeper.md tools/thread-search-redproof.js
git commit -F tools/.task6-commit.log
```

The subject is `docs: describe searching inside a conversation`.

- [ ] **Step 6: Point the handoff at the version before it is cut**

The handoff names a version that does not exist yet, because the release bumps `package.json` and the handoff has to say what the release will contain. Write the version the release will produce, which `tools/release.js` derives from the commit subjects since the last tag: a `feat:` commit means a minor bump, so **v1.26.0**.

```bash
git add HANDOFF-betterbeeper.md
git commit -F tools/.handoff-commit.log
```

The subject is `docs: point the handoff at v1.26.0 before it is cut`.

- [ ] **Step 7: Release**

Run: `npm run release`
Expected: the version is bumped, the release commit is made and pushed, the installer is built, the asset is published and its hash is verified.

Then run: `npm run check:released`
Expected: PASS. `main` must not be ahead of the newest tag.

- [ ] **Step 8: Confirm the tree is clean**

Run: `git status --short` and `git log --oneline -5`
Expected: an empty status and the release commit on top.
