'use strict';

/**
 * The phone numbers of the people in a chat.
 *
 * The bridge does not send them.
 *
 * A chat's participants arrive as `{ id, fullName, imgURL, cannotMessage,
 * isAdmin, isPending, isNetworkBot, isSelf }` and nothing else. The bridge's
 * own schema has a `phoneNumber` on a user, but it is documented as "omit if
 * unknown", and for the people who matter it is unknown: measured against the
 * live account on 2026-11-23, not one of the 492 participants across 200
 * chats carried a number, and the bridge's own contact list is empty for the
 * Google Voice account, which is where most of those chats live.
 *
 * The number is not missing, it is in the wrong place. Beeper Desktop's own
 * store keeps it in `participant_identifiers`, keyed by the very id the
 * bridge hands out:
 *
 *   participant_id                                 identifier_type  identifier
 *   @YynP0amA7e30Yc3cN7-...:local-signal.localhost  phone            +15154916586
 *
 * and that id is exactly the `id` on the chat's participant, so the join is
 * exact rather than a guess by name. The same store is where Beeper Desktop
 * itself reads the number from; this is not a second source of truth, it is
 * the first one.
 *
 * Coverage, measured over 200 live chats: 478 of 492 participants get a
 * number (97%). Google Voice 462 of 462, Signal 8 of 8, Facebook 6 of 12.
 * The ones without a number are the people who do not have one: Beeper
 * accounts such as @eric:beeper.com, and Facebook contacts whose number was
 * never given to us.
 *
 * Read-only, and quiet about it. The store belongs to another program, so
 * every failure here - the file is not there, it is locked, Beeper Desktop
 * changed the schema - is reported as "no numbers" rather than as an error.
 * The people list is still a people list without them.
 *
 * No Electron imports, so it can be exercised under plain node the way
 * src/main/media-path.js and src/main/message-store.js are.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Where Beeper Desktop keeps its store, relative to the app data folder. */
const STORE_RELATIVE_PATH = path.join('BeeperTexts', 'index.db');

/** How long a read of the store is worth keeping. */
const CACHE_MS = 60_000;

/** How long to wait before trying again after the store could not be read. */
const RETRY_AFTER_MS = 10_000;

/** The last read, where it came from, and when it was taken. */
let cache = null;
/** The last failure, and when it happened. */
let failedAt = 0;

/**
 * The phone numbers, keyed by participant id.
 *
 * Returns a plain object so it can cross the IPC boundary without a Map
 * having to be turned into one on the way.
 */
function readPhoneNumbers({ appData, now = Date.now() } = {}) {
  const folder = appData || '';
  // The cache belongs to the store it was read from. A check that points at
  // a different folder must not be served the real account's numbers.
  if (cache && cache.folder === folder && now - cache.at < CACHE_MS) return cache.numbers;
  // A store that could not be read a moment ago is still just as unreadable.
  // Asking again on every click would only make the failure louder.
  if (failedAt && now - failedAt < RETRY_AFTER_MS) return {};

  const store = path.join(folder, STORE_RELATIVE_PATH);
  let db = null;
  try {
    if (!fs.existsSync(store)) throw new Error('the store is not there');
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(store, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT participant_id, identifier FROM participant_identifiers WHERE identifier_type = 'phone'"
      )
      .all();
    const numbers = {};
    for (const row of rows) {
      const id = typeof row?.participant_id === 'string' ? row.participant_id.trim() : '';
      const number = typeof row?.identifier === 'string' ? row.identifier.trim() : '';
      // A participant can have more than one number. The first one is kept,
      // because the list is about reaching the person, not about listing
      // every way to reach them.
      if (!id || !number || numbers[id]) continue;
      numbers[id] = number;
    }
    cache = { folder, numbers, at: now };
    failedAt = 0;
    return numbers;
  } catch {
    // Another program's database, read on purpose and never written to. If it
    // cannot be read, the people list simply has no numbers in it.
    failedAt = now;
    return {};
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a database that was never opened is not worth reporting */
    }
  }
}

/**
 * The numbers for the given participant ids.
 *
 * Only the ids asked for come back, so the renderer is handed what it needs
 * rather than the whole address book.
 */
function numbersFor(ids, options = {}) {
  const all = readPhoneNumbers(options);
  const wanted = Array.isArray(ids) ? ids : [];
  const out = {};
  for (const id of wanted) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key) continue;
    const number = all[key];
    if (number) out[key] = number;
  }
  return out;
}

/** Forget the cached read. For the check, and for a store that has changed. */
function clearCache() {
  cache = null;
  failedAt = 0;
}

module.exports = {
  STORE_RELATIVE_PATH,
  readPhoneNumbers,
  numbersFor,
  clearCache,
};
