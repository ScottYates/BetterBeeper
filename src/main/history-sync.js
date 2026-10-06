'use strict';

/**
 * Walking a chat's history backwards, once.
 *
 * Beeper hands back a page of at most 20 messages and a cursor. This turns
 * that into a complete local record, and the whole reason it lives in the main
 * process rather than the renderer is that the job has to survive the things
 * that kill renderer work: closing the window, reloading, clicking through four
 * chats in ten seconds.
 *
 * Two properties matter more than speed:
 *
 *  - **A complete chat is never re-walked.** Once a chat is known to be
 *    complete, opening it fetches only the newest page. Without this, every
 *    visit re-downloads the entire history, which is the exact behaviour this
 *    exists to remove.
 *
 *  - **A run that did not finish may not tombstone.** Gaps left by an
 *    interrupted run are ordinary, not evidence that Beeper deleted anything.
 *    Reconcile is only ever called with `complete` set when the walk actually
 *    reached the beginning.
 *
 * No Electron imports: the network and the dialogs are injected, so this is
 * testable with a fake fetcher and no server.
 */

/** Beeper serves 20 whatever we ask for, so ask for 20 and page often. */
const PAGE_LIMIT = 20;

/**
 * Stops one absurdly long chat from monopolising the queue. Reaching it means
 * the run is incomplete, which is safe: reconcile will not tombstone.
 */
const MAX_PAGES_PER_RUN = 500;

function createHistorySync({ store, media, fetchPage, adoptMedia, onProgress, maxPages = MAX_PAGES_PER_RUN } = {}) {
  const queue = [];
  const queued = new Set();
  let running = null;
  // Which chat the current run belongs to. `running` alone cannot answer that,
  // because it is cleared before the next run starts.
  let current = null;
  let stopped = false;

  const emit = (chatID, state, detail) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress({ chatID, state, ...detail });
      } catch {
        /* a progress listener must never break the sync */
      }
    }
  };

  /** The newest page only. Used for a chat already known to be complete. */
  async function refreshTail(chatID) {
    const page = await fetchPage(chatID, { limit: PAGE_LIMIT });
    const items = page?.items || [];
    if (items.length) {
      // Same reason as the walk: a photo arriving in a chat we have already
      // finished backfilling still has to get copied, or it is only as
      // permanent as Beeper's cache.
      if (typeof adoptMedia === 'function') {
        await adoptMedia(items);
      }
      store.upsertMessages(chatID, items, { oldestTs: oldestOf(items) });
    }
    store.setLastSynced(chatID, Date.now());
    return { fetched: items.length };
  }

  /**
   * Page backwards to the beginning, then reconcile once.
   *
   * `seen` is seeded with everything already stored, not just what this run
   * fetched. A resumed run must not mistake its own predecessor's messages for
   * deletions, which is the subtlest way this feature could lose data.
   */
  async function backfill(chatID) {
    const seen = new Set(store.knownIds(chatID));
    const start = store.oldestMessage(chatID);

    let cursor = start?.id ?? null;
    let direction = cursor ? 'before' : 'after';
    let oldestTs = start?.ts ?? null;
    let hasMore = true;
    let pages = 0;
    let fetched = 0;
    let stalled = false;

    while (hasMore && pages < maxPages) {
      const page = await fetchPage(chatID, { cursor, direction, limit: PAGE_LIMIT });
      const items = page?.items || [];
      pages++;

      if (items.length) {
        // Adopt the attachments before storing, so the path to our own copy
        // goes into the payload. Storing first would mean re-writing every
        // message that carried a picture a second time, which is exactly the
        // kind of cost this feature is meant to remove.
        if (typeof adoptMedia === 'function') {
          await adoptMedia(items);
        }
        for (const item of items) if (item?.id) seen.add(String(item.id));
        const ts = oldestOf(items);
        store.upsertMessages(chatID, items, { oldestTs: ts });
        fetched += items.length;
        oldestTs = oldestTs === null ? ts : Math.min(oldestTs, ts);
      }

      hasMore = Boolean(page?.hasMore);
      const next = page?.oldestCursor;
      if (hasMore && (!next || next === cursor)) {
        // Beeper repeating itself is not progress. Treat it as the end rather
        // than looping on the same page forever.
        hasMore = false;
        stalled = true;
      }
      cursor = next ?? cursor;
      direction = 'before';
      emit(chatID, 'backfilling', { pages, fetched });
    }

    // Only a walk that genuinely reached the beginning may tombstone, and a
    // capped run did not.
    const complete = !hasMore && !stalled && pages < maxPages;
    const result = store.reconcile(chatID, [...seen], { complete, oldestTs });
    store.setLastSynced(chatID, Date.now());
    return { ...result, pages, fetched, complete, stalled };
  }

  async function runOne(chatID) {
    try {
      // The rule that stops this feature being pointless: a complete chat gets
      // the newest page and nothing else, forever.
      const outcome = store.isComplete(chatID)
        ? await refreshTail(chatID)
        : await backfill(chatID);
      emit(chatID, 'done', outcome);
      return outcome;
    } catch (err) {
      // A failed run leaves the chat incomplete, which is exactly the state
      // that stops reconcile from tombstoning. Record it and move on rather
      // than retrying forever in a loop.
      emit(chatID, 'failed', { error: err.message });
      return { error: err.message };
    }
  }

  async function pump() {
    if (running || stopped) return running;
    const chatID = queue.shift();
    if (!chatID) return null;

    queued.delete(chatID);
    emit(chatID, 'started', {});
    current = chatID;
    running = runOne(chatID)
      .catch(() => null)
      .then((result) => {
        running = null;
        current = null;
        // Yield between chats so the queue never monopolises the process.
        setTimeout(pump, 0);
        return result;
      });
    return running;
  }

  return {
    /** Ask for a chat to be brought fully up to date. Idempotent. */
    request(chatID) {
      if (!chatID || stopped) return false;
      if (queued.has(chatID) || current === chatID) return false;
      queued.add(chatID);
      queue.push(chatID);
      pump();
      return true;
    },

    /** For tests and for shutdown: wait until the queue is empty. */
    async drain() {
      while (running || queue.length) {
        if (running) await running;
        else await pump();
      }
      return true;
    },

    status() {
      return {
        running: current,
        queued: [...queue],
        ...store.stats(),
      };
    },

    /** Stop starting new work. In-flight work finishes. */
    stop() {
      stopped = true;
      queue.length = 0;
      queued.clear();
    },
  };
}

/** The earliest timestamp in a page, in epoch millis. */
function oldestOf(items) {
  let oldest = null;
  for (const item of items) {
    const ts = typeof item?.timestamp === 'number' ? item.timestamp : Date.parse(item?.timestamp || '') || 0;
    if (oldest === null || ts < oldest) oldest = ts;
  }
  return oldest;
}

module.exports = { createHistorySync, PAGE_LIMIT, oldestOf };