'use strict';

/**
 * The local record of every message this machine has ever seen.
 *
 * Beeper serves a page at a time, clamps that page to 20 messages, and forgets
 * nothing -- but it only knows how to hand back what it still holds, and it
 * hands back the same page on every visit. Measured on 2026-10-05: twelve
 * pages of 20, 240 unique messages, still reporting hasMore. Reaching a
 * thousand messages back costs fifty round trips, every single time.
 *
 * This is the thing that makes history local and permanent. Beeper stays the
 * source of truth for what exists; this only ever learns from it.
 *
 * No Electron imports, deliberately, so the whole module unit-tests under
 * plain node the way src/main/media-path.js does.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

/** How many messages history:open serves. */
const OPEN_PAGE = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  chatID         TEXT PRIMARY KEY,
  title          TEXT,
  lastSyncedAt   INTEGER,
  oldestSyncedTs INTEGER,
  complete       INTEGER DEFAULT 0
);

-- Keyed on (chatID, id), not id alone. Beeper message ids are normally
  -- globally unique, but a cache keyed only on id silently loses a message if
  -- that ever stops being true: the second chat's row overwrites the first
  -- chat's, and one of them then renders short. Every read is already scoped
  -- by chatID, so the composite key costs nothing and cannot lose one.
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT NOT NULL,
  chatID     TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  senderID   TEXT,
  senderName TEXT,
  text       TEXT,
  payload    TEXT NOT NULL,
  gone       INTEGER DEFAULT 0,
  PRIMARY KEY (chatID, id)
);

CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chatID, ts, id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages');

-- Triggers, not application code. The same writer that maintains the table
-- maintains the index, so the two cannot drift apart. A search index that has
-- drifted answers plausibly and wrongly rather than failing loudly.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

/** Normalise the many timestamp shapes Beeper uses into epoch millis. */
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value instanceof Date) return value.getTime();
  return 0;
}

/**
 * FTS5 raises on a malformed query -- an unbalanced quote is enough. Rather
 * than surfacing an error for something the user typed innocently, fall back
 * to searching for the text literally.
 */
function ftsQuery(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  return '"' + text.replace(/"/g, '""') + '"';
}

/**
 * Open the store, creating or migrating it.
 *
 * A database that will not open is set aside rather than allowed to take the
 * app down with it. The caller is told, because silently starting from
 * nothing is indistinguishable from losing the history.
 */
function openMessageStore(userDataDir, { onRecover } = {}) {
  const file = path.join(userDataDir, 'history.db');

  let db;
  let recoveredFrom = null;
  try {
    db = new DatabaseSync(file);
    // Fail here rather than on first query, where the cause is far away.
    db.exec('SELECT count(*) FROM sqlite_master');
  } catch (err) {
    if (db) {
      try {
        db.close();
      } catch {
        /* already unusable */
      }
      db = null;
    }
    recoveredFrom = file;
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* nothing to salvage, or the rename is refused; a fresh file still works */
    }
    db = new DatabaseSync(file);
    if (typeof onRecover === 'function') {
      onRecover({ file, reason: err.message });
    }
  }

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (version < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  const store = {
    file,
    recoveredFrom,
    userVersion: () => SCHEMA_VERSION,

    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },

    /** Write a page of messages. One transaction, so a crash cannot half-write. */
    upsertMessages(chatID, messages, { oldestTs } = {}) {
      const list = Array.isArray(messages) ? messages : [];
      if (!chatID || !list.length) return 0;

      const put = db.prepare(`
        INSERT INTO messages (id, chatID, ts, senderID, senderName, text, payload, gone)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(chatID, id) DO UPDATE SET
          ts         = excluded.ts,
          senderID   = excluded.senderID,
          senderName = excluded.senderName,
          text       = excluded.text,
          payload    = excluded.payload
      `);

      const touch = db.prepare(`
        INSERT INTO chats (chatID, oldestSyncedTs) VALUES (?, ?)
        ON CONFLICT(chatID) DO UPDATE SET
          oldestSyncedTs = MIN(COALESCE(chats.oldestSyncedTs, excluded.oldestSyncedTs), excluded.oldestSyncedTs)
      `);

      db.exec('BEGIN');
      try {
        let written = 0;
        for (const message of list) {
          if (!message?.id) continue;
          put.run(
            String(message.id),
            chatID,
            toMillis(message.timestamp),
            message.senderID ?? null,
            message.senderName ?? null,
            message.text ?? '',
            JSON.stringify(message),
          );
          written++;
        }
        if (typeof oldestTs === 'number') touch.run(chatID, oldestTs);
        db.exec('COMMIT');
        return written;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /**
     * Older than `before`, oldest first. The ordering the thread draws in is
     * the only ordering it ever wants, so the reversal happens here rather
     * than at every call site.
     */
    page(chatID, { before, limit = OPEN_PAGE } = {}) {
      if (!before) return this.newest(chatID, limit);

      const rows = db.prepare(`
            SELECT m.payload FROM messages m
             WHERE m.chatID = ? AND m.gone = 0
               AND ( m.ts < (SELECT ts FROM messages WHERE chatID = ? AND id = ?)
                  OR (m.ts = (SELECT ts FROM messages WHERE chatID = ? AND id = ?) AND m.id < ?) )
             ORDER BY m.ts DESC, m.id DESC
             LIMIT ?
          `).all(chatID, chatID, before, chatID, before, before, limit);

      return rows.map((row) => safeParse(row.payload)).reverse();
    },

    newest(chatID, limit = OPEN_PAGE) {
      const rows = db.prepare(`
        SELECT payload FROM messages
         WHERE chatID = ? AND gone = 0
         ORDER BY ts DESC, id DESC
         LIMIT ?
      `).all(chatID, limit);
      return rows.map((row) => safeParse(row.payload)).reverse();
    },

    /**
     * Decide what Beeper no longer has.
     *
     * Only a run that reached the true beginning may tombstone. A run that
     * stopped partway -- interrupted, or cut short -- has gaps that are
     * entirely ordinary, and treating those gaps as deletions would quietly
     * destroy real history. Tombstoned rows are marked, never removed, so a
     * later backfill cannot resurrect them.
     */
    reconcile(chatID, seenIds, { complete = false, oldestTs } = {}) {
      const seen = new Set((seenIds || []).map(String));
      let tombstoned = 0;

      if (complete) {
        const rows = db.prepare('SELECT id FROM messages WHERE chatID = ? AND gone = 0').all(chatID);
        const gone = db.prepare('UPDATE messages SET gone = 1 WHERE chatID = ? AND id = ?');
        db.exec('BEGIN');
        try {
          for (const row of rows) {
            if (!seen.has(String(row.id))) {
              gone.run(chatID, row.id);
              tombstoned++;
            }
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        store.setComplete(chatID, oldestTs);
      }

      return { tombstoned, written: seen.size };
    },

    setComplete(chatID, oldestTs) {
      db.prepare(`
        INSERT INTO chats (chatID, oldestSyncedTs, complete) VALUES (?, ?, 1)
        ON CONFLICT(chatID) DO UPDATE SET
          complete = 1,
          oldestSyncedTs = COALESCE(excluded.oldestSyncedTs, chats.oldestSyncedTs)
      `).run(chatID, typeof oldestTs === 'number' ? oldestTs : null);
    },

    setLastSynced(chatID, ts) {
      db.prepare(`
        INSERT INTO chats (chatID, lastSyncedAt) VALUES (?, ?)
        ON CONFLICT(chatID) DO UPDATE SET lastSyncedAt = excluded.lastSyncedAt
      `).run(chatID, typeof ts === 'number' ? ts : Date.now());
    },

    setTitle(chatID, title) {
      db.prepare(`
        INSERT INTO chats (chatID, title) VALUES (?, ?)
        ON CONFLICT(chatID) DO UPDATE SET title = excluded.title
      `).run(chatID, title ?? null);
    },

    /** The name this machine last saw for a chat, or null. */
    chatTitle(chatID) {
      if (typeof chatID !== 'string' || !chatID) return null;
      const row = db.prepare('SELECT title FROM chats WHERE chatID = ?').get(chatID);
      return row?.title ?? null;
    },

    chatStatus(chatID) {
      const row = db.prepare(`
        SELECT complete, oldestSyncedTs, lastSyncedAt FROM chats WHERE chatID = ?
      `).get(chatID);
      const count = db.prepare('SELECT count(*) AS n FROM messages WHERE chatID = ? AND gone = 0')
        .get(chatID);
      return {
        complete: Boolean(row?.complete),
        oldestSyncedTs: row?.oldestSyncedTs ?? null,
        lastSyncedAt: row?.lastSyncedAt ?? null,
        count: count ? Number(count.n) : 0,
      };
    },

    isComplete(chatID) {
      return Boolean(
        db.prepare('SELECT complete FROM chats WHERE chatID = ?').get(chatID)?.complete,
      );
    },

    /** A page of stored messages in insertion order, for background sweeps. */
    afterRowid(rowid, limit = 200) {
      return db.prepare(`
        SELECT rowid, chatID, payload FROM messages
         WHERE rowid > ? ORDER BY rowid ASC LIMIT ?
      `).all(rowid ?? 0, limit).map((r) => ({
        rowid: Number(r.rowid),
        chatID: String(r.chatID),
        message: safeParse(r.payload),
      }));
    },

    /** Ids we already hold for a chat, used to seed a resumed backfill. */
    knownIds(chatID) {
      return db.prepare('SELECT id FROM messages WHERE chatID = ? AND gone = 0').all(chatID)
        .map((row) => String(row.id));
    },

    /** The oldest thing we hold for a chat, which is where a resume starts. */
    oldestMessage(chatID) {
      const row = db.prepare(`
        SELECT id, ts FROM messages WHERE chatID = ? AND gone = 0
         ORDER BY ts ASC, id ASC LIMIT 1
      `).get(chatID);
      return row ? { id: String(row.id), ts: Number(row.ts) } : null;
    },

    /**
     * Full-text over everything stored, skipping tombstones.
     *
     * Beeper's own search is server-side and capped at 20 results; this is
     * neither, and it works while Beeper is unreachable.
     */
    search(rawQuery, { limit = 50, chatIDs } = {}) {
      const match = ftsQuery(rawQuery);
      if (!match) return [];

      const wanted = Array.isArray(chatIDs) ? chatIDs.filter(Boolean) : null;
      const params = [match];
      let scope = '';
      if (wanted) {
        if (!wanted.length) return [];
        scope = ` AND m.chatID IN (${wanted.map(() => '?').join(',')})`;
        params.push(...wanted);
      }
      params.push(limit);

      const select = `
        SELECT m.chatID, m.id, m.text, m.ts, m.senderID, m.senderName, c.title AS chatTitle
          FROM messages_fts f
          JOIN messages m ON m.rowid = f.rowid
          LEFT JOIN chats c ON c.chatID = m.chatID
         WHERE messages_fts MATCH ? AND m.gone = 0${scope}
         ORDER BY m.ts DESC
         LIMIT ?
      `;

      let rows;
      try {
        rows = db.prepare(select).all(...params);
      } catch {
        // ftsQuery quotes everything, which should make this unreachable. If
        // FTS5 still refuses, fall back to a plain scan rather than returning
        // nothing: a slower answer beats no answer.
        rows = db.prepare(`
          SELECT m.chatID, m.id, m.text, m.ts, m.senderID, m.senderName, c.title AS chatTitle
            FROM messages m
            LEFT JOIN chats c ON c.chatID = m.chatID
           WHERE m.gone = 0 AND m.text LIKE ?${scope}
           ORDER BY m.ts DESC
           LIMIT ?
        `).all(`%${String(rawQuery).replace(/[%_]/g, '')}%`, ...(wanted || []), limit);
      }
      return rows.map((row) => ({
        chatID: row.chatID,
        id: row.id,
        text: row.text,
        ts: row.ts,
        senderID: row.senderID,
        senderName: row.senderName,
        // Beeper can name the chat even when this machine has never been told
        // its title, so an absent name here is normal rather than a failure.
        chatTitle: row.chatTitle || null,
      }));
    },

    stats() {
      const messages = db.prepare('SELECT count(*) AS n FROM messages WHERE gone = 0').get();
      const chats = db.prepare('SELECT count(*) AS n FROM chats').get();
      let bytes = 0;
      try {
        bytes = fs.statSync(file).size;
      } catch {
        bytes = 0;
      }
      return {
        messages: messages ? Number(messages.n) : 0,
        chats: chats ? Number(chats.n) : 0,
        bytes,
      };
    },
  };

  return store;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { id: '', text: String(text ?? ''), timestamp: 0 };
  }
}

module.exports = { openMessageStore, toMillis, ftsQuery, SCHEMA_VERSION, OPEN_PAGE };