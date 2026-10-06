# Local message history

Date: 2026-10-05
Status: approved, ready for an implementation plan

## Problem

Better Beeper keeps every message it has ever seen in renderer memory and
nothing else. Two consequences, both visible in daily use:

1. Quitting the app discards the lot. Reopening a chat re-fetches from Beeper.
2. Scrolling back is slow and repetitive, because the only record of what was
   fetched is the running process.

Beeper makes this worse than it sounds. The message endpoint silently clamps
every page to 20 messages, whatever `limit` asks for. Measured against a real
chat on 2026-10-05: twelve pages, `limit: 50` requested, 20 returned each time,
240 unique messages, still reporting `hasMore`. Reaching 1,000 messages back
costs 50 round trips, repeated on every visit.

## Goals

- History survives a restart.
- Scrolling back reads from disk and does not touch the network.
- Opening a chat is instant and works while Beeper is unreachable.
- Full-text search covers everything stored, not Beeper's 20 results.
- Attachments are copied into the app's own storage, so old media keeps
  loading after Beeper evicts its cache.

## Non-goals

- Not a Beeper replacement. Beeper stays the source of truth for what exists.
- No change to local delete or hide. Both remain renderer-side view filters.
- No change to the renderer's in-memory model for the open chat.
- No offline sending or composing.

## Storage

One SQLite file at `userData/history.db`, owned by `src/main/message-store.js`.

`node:sqlite` is available in this runtime: verified on Electron 38.8.6
(Node 22.22.0), including FTS5. No native module, no rebuild, no packaging
risk. `src/main/media-path.js` is the existing precedent for a main-process
module kept free of Electron imports so it unit-tests under plain node.

```sql
CREATE TABLE chats (
  chatID          TEXT PRIMARY KEY,
  title           TEXT,
  lastSyncedAt    INTEGER,   -- when we last reached the newest message
  oldestSyncedTs  INTEGER,   -- how far back we have actually walked
  complete        INTEGER DEFAULT 0
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  chatID      TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  senderID    TEXT,
  senderName  TEXT,
  text        TEXT,
  payload     TEXT NOT NULL,  -- untouched Beeper JSON
  gone        INTEGER DEFAULT 0
);

CREATE INDEX messages_chat_ts ON messages(chatID, ts, id);

CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages');
```

`payload` keeps the whole Beeper object - attachments, reactions, `seen`,
`isSender`. The adjacent columns exist only to index and search them. This
means the store does not need to be taught about a new Beeper field to store
it correctly.

`messages_fts` is an external-content FTS5 table with SQLite triggers keeping
it in step with `messages`. Triggers rather than application code: an index
maintained by the same writer that maintains the table cannot silently drift,
and drift in a search index is the kind of bug that reports plausible wrong
answers rather than failing.

Run in WAL mode so reads do not block the backfill's writes.

## Media

`userData/media/<ab>/<sha256>.<ext>`, content addressed. The same photo sent
twice occupies one file. Names on disk are derived from the hash, never from
the message, so a hostile `fileName` cannot escape the directory.

Copy happens during backfill, after a page is committed. A failed copy is
recorded and retried on a later pass; it never fails the message sync.

## Consistency

Beeper decides what exists. The store only learns from it.

- Anything Beeper returns is upserted with `gone = 0`.
- Live WebSocket events upsert immediately, so the store stays current
  without polling.
- Anything we hold that Beeper no longer returns is tombstoned with
  `gone = 1`. Tombstoned, not deleted: it keeps search honest and stops a
  later backfill resurrecting it.

**Only a backfill that reached the true beginning may tombstone.** A run that
stopped partway, whether interrupted or cut by a cap, has gaps that are
ordinary rather than evidence of deletion. A chat is marked `complete` only
when `hasMore` goes false, and an incomplete run tombstones nothing.

This is the one rule in the design that can destroy real data if it is wrong,
and `check:history` asserts it in both directions.

Locally deleted messages keep their row. Local delete is a display filter, and
Clear list has to keep working, so the store must not mistake one for the
other.

## Backfill queue

`src/main/history-sync.js`. One chat at a time, queued as chats are opened.

Each job pages backwards from Beeper, writes each page in one transaction,
and records how far it got.

**A chat already marked `complete` is never re-walked.** Opening it fetches
only the newest page and merges. Without this, every visit re-downloads the
whole history, which is the behaviour being fixed.

The job pauses when Beeper is unreachable or the app is shutting down, and
resumes where it stopped on the next run. Progress is broadcast to the
renderer so Settings can show overall and per-chat state.

## Read path

`history:open(chatID)` returns the newest stored page immediately - 200
messages to start with, a constant the plan fixes rather than a number the
user is asked about - plus whether a backfill is pending or running. The
renderer renders that before any network call completes.

`history:page(chatID, {before, limit})` reads older messages from SQLite. No
network, no cursor. The existing "Scroll up for earlier messages" affordance
becomes a spinner only when the store has nothing older and the chat is not
yet fully synced.

## Search

FTS5 `MATCH` over `messages`, skipping `gone = 1`, grouped by chat with the
hit message and surrounding context. Works offline.

FTS5 raises on malformed queries such as an unbalanced quote, so the query is
validated and falls back to a quoted literal search rather than surfacing an
error for something the user typed innocently.

## Failure handling

| Situation | Behaviour |
| --- | --- |
| Beeper unreachable | Already-synced history reads normally. New messages do not arrive. |
| Corrupt database | Caught; file is set aside, a fresh one is created, and the app says so. No crash, and no pretending the history was always empty. |
| Schema change | `PRAGMA user_version`; this database outlives any one version of the app. |
| Media copy fails | Recorded, retried later, does not fail the message sync. |
| Search query malformed | Falls back to a literal quoted search. |

## Limits

Per-chat message ceiling and a total store size, both reported in Settings,
because "fully self-contained" is worth little if it quietly fills the disk.
Media is the part that actually grows.

## Testing

`check:history`, plain node, no Electron:

- round trip and ordering across writes
- an edit updates the message and the search index
- a delete tombstones and drops out of search
- **a complete run tombstones what Beeper dropped**
- **an interrupted run tombstones nothing**
- search never returns a tombstoned row
- FTS query fallback on malformed input

Proven to fail by reintroducing the interrupted-run tombstone bug.

Plus a renderer check that scroll-back reads history through the store rather
than calling Beeper, in the spirit of `check:api` catching a preload surface
that drifted from its mirror.

## Delivery

One feature, landed in phases, because the first phase is useful on its own and
the later ones are not blocked by it:

1. **Store and read path.** Schema, upsert, `history:open`, `history:page`, and
   the thread reading from disk. History now survives a restart and scroll-back
   is instant. No search, no media yet.
2. **Backfill queue.** Walking backwards from Beeper, once per chat, with the
   tombstone rules and progress reporting.
3. **Search.** FTS5 index, triggers, the search UI over it.
4. **Media.** Content-addressed copies during backfill, and the disk totals in
   Settings.

Phase 1 alone retires most of the complaint. Later phases are additive and
none of them change the schema in a way that needs a migration.

## Known limitations

- The renderer still holds the messages it has paged in for the open chat,
  exactly as today. The scroll-anchoring logic is delicate and the memory
  saving is not worth destabilising it.
- Backfill is bounded by which chats get opened. Nothing pulls history for
  chats that are never visited, by choice.