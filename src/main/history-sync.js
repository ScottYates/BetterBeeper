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

/**
 * How often a progress event may be emitted for one chat.
 *
 * A long chat is 500 pages, and the loop used to report every one. Each report
 * is an IPC broadcast to the renderer, so a single backfill could put 500
 * messages on the wire and have the UI wake for each - which is the opposite of
 * what "this runs in the background" is supposed to mean. The numbers still
 * count every page; only the announcements are coalesced.
 */
const PROGRESS_MIN_INTERVAL_MS = 250;

/** Pages between yields back to the event loop. */
const YIELD_EVERY_PAGES = 25;

/**
 * How many chats are walked at the same time.
 *
 * A walk is almost entirely waiting: each page is one HTTP GET to the Beeper
 * bridge, and everything else - hashing attachments, writing rows - is quick and
 * synchronous. Running one chat at a time therefore spent nearly all of its life
 * blocked on a socket, with the database and the rest of the app idle beside it.
 *
 * More than one at a time fills those waits with other chats' work. Three is
 * chosen deliberately rather than "as many as possible": the bridge is a local
 * endpoint on the same machine, so the win comes from latency and not from
 * bandwidth, and past a handful there is nothing left to overlap. A single
 * stuck request also holds one slot instead of blocking everything.
 */
const MAX_CONCURRENT = 3;

function createHistorySync({
  store, media, fetchPage, adoptMedia, onProgress,
  maxPages = MAX_PAGES_PER_RUN,
  concurrency = MAX_CONCURRENT,
} = {}) {
  const queue = [];
  const queued = new Set();
  /** chatIDs currently being walked. Several at once, up to `concurrency`. */
  const inFlight = new Set();
  let stopped = false;

  /**
   * chatID -> what that chat's job is doing, for the progress panel.
   *
   * Kept here rather than in the renderer because the renderer is not the only
   * thing asking: the panel has to survive a reload, and a reload knows
   * nothing about what happened before it.
   */
  const jobs = new Map();
  const lastEmit = new Map();
  /** Chats asked for again while their own run was still going. */
  const again = new Set();

  const emit = (chatID, state, detail) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress({ chatID, state, ...detail });
      } catch {
        /* a progress listener must never break the sync */
      }
    }
  };

  /**
   * Record what a chat's job is doing, and announce it at most every
   * PROGRESS_MIN_INTERVAL_MS. Forced for the states that are not a running
   * total - started and done must never be swallowed.
   */
  function note(chatID, patch, { force = false } = {}) {
    const existing = jobs.get(chatID) || { startedAt: Date.now(), pages: 0, fetched: 0 };
    jobs.set(chatID, { ...existing, ...patch, updatedAt: Date.now() });

    const now = Date.now();
    const last = lastEmit.get(chatID) || 0;
    if (!force && now - last < PROGRESS_MIN_INTERVAL_MS) return;
    lastEmit.set(chatID, now);
    emit(chatID, jobs.get(chatID).state, { ...jobs.get(chatID) });
  }

  /** Hand the event loop back, so a long walk never looks like a hang. */
  const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

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
      // What this page actually added, as opposed to repeated back at us.
      let fresh = 0;

      if (items.length) {
        // Adopt the attachments before storing, so the path to our own copy
        // goes into the payload. Storing first would mean re-writing every
        // message that carried a picture a second time, which is exactly the
        // kind of cost this feature is meant to remove.
        if (typeof adoptMedia === 'function') {
          await adoptMedia(items);
        }
        for (const item of items) {
          if (item?.id === undefined || item?.id === null) continue;
          const key = String(item.id);
          if (!seen.has(key)) fresh++;
          seen.add(key);
        }
        const ts = oldestOf(items);
        store.upsertMessages(chatID, items, { oldestTs: ts });
        fetched += items.length;
        oldestTs = oldestTs === null ? ts : Math.min(oldestTs, ts);
      }

      hasMore = Boolean(page?.hasMore);
      const next = page?.oldestCursor;
      if (!items.length) {
        // An empty page is the end, whatever `hasMore` says.
        //
        // Beeper reports hasMore for a chat whose older messages already
        // reached us by another route - the live stream, or a walk that has
        // already been there - so its backward cursor has nothing left to hand
        // over and the page comes back empty. That was read as a stall, which
        // leaves complete false, and an incomplete chat is walked in full every
        // single time it is opened. Measured on the real store: 60 chats holding
        // between 3 and 200 messages, none of them ever finishing, each one
        // re-walked on every visit.
        //
        // Nothing is lost by calling this the end: `seen` was seeded with every
        // message already held, so reconcile cannot tombstone anything.
        hasMore = false;
      } else if (!fresh) {
        // A page of messages we already hold is not progress, and Beeper will
        // go on serving it forever.
        //
        // This is the expensive one, and it is not hypothetical. Measured on the
        // real store: a chat holding a single message - one missed call - was
        // fetched 2,376 times, one message per page, behind a cursor that
        // changed every time so the repeat check below never fired. Every visit
        // burned the full 500-page cap.
        //
        // Stopping is certain to be right; calling it *complete* would not be.
        // "Beeper has nothing older" and "Beeper is looping" look identical
        // from here, and only the first one earns a permanent claim. So this
        // leaves the chat incomplete and it is re-checked in one cheap page next
        // time, rather than written off on evidence this weak.
        hasMore = false;
        stalled = true;
      } else if (hasMore && (!next || next === cursor)) {
        // Beeper repeating itself is not progress. Treat it as the end rather
        // than looping on the same page forever.
        hasMore = false;
        stalled = true;
      }
      cursor = next ?? cursor;
      direction = 'before';
      // walked: this is a walk through history, not the one page that looking at
      // a chat costs. The progress panel uses it to decide whether there is
      // anything worth telling the user - a chat merely opened does a single
      // tail page, and giving that a row made the sidebar change on every click.
      note(chatID, { state: 'backfilling', pages, fetched, walked: true });

      // Every so often, stop being a loop. A 500-page walk is minutes of
      // continuous work in the process that also owns the windows.
      if (pages % YIELD_EVERY_PAGES === 0) await breathe();
    }

    // Only a walk that genuinely reached the beginning may tombstone, and a
    // capped run did not.
    const complete = !hasMore && !stalled && pages < maxPages;
    const result = store.reconcile(chatID, [...seen], { complete, oldestTs });
    store.setLastSynced(chatID, Date.now());
    return { ...result, pages, fetched, complete, stalled, walked: true };
  }

  /**
   * What the user asked for when they pressed refresh on one chat.
   *
   * Both halves, deliberately. The tail is where anything new is, so a chat
   * that is already "complete" still gets the newest page - that is what
   * "refresh" means to someone looking at a chat. The walk then re-verifies
   * from the oldest message we hold, which costs one request when the chat is
   * genuinely finished and is the only thing that recovers a chat we wrongly
   * believed was complete.
   */
  async function resync(chatID) {
    const tail = await refreshTail(chatID);
    const walk = await backfill(chatID);
    return { ...tail, ...walk };
  }

  async function runOne(chatID, kind) {
    try {
      // The rule that stops this feature being pointless: a complete chat gets
      // the newest page and nothing else, forever - unless the user explicitly
      // asked for it to be checked.
      const outcome = kind === 'refresh'
        ? await resync(chatID)
        : store.isComplete(chatID)
          ? await refreshTail(chatID)
          : await backfill(chatID);
      note(chatID, { state: 'done', ...outcome, error: null }, { force: true });
      return outcome;
    } catch (err) {
      // A failed run leaves the chat incomplete, which is exactly the state
      // that stops reconcile from tombstoning. Record it and move on rather
      // than retrying forever in a loop.
      note(chatID, { state: 'failed', error: err.message }, { force: true });
      return { error: err.message };
    }
  }

  function enqueue(chatID, kind, front) {
    queued.add(chatID);
    if (front) queue.unshift({ chatID, kind });
    else queue.push({ chatID, kind });
    note(chatID, { state: 'queued', kind, pages: 0, fetched: 0 }, { force: true });
  }

  /**
 * Start as much queued work as there are slots for.
 *
 * Not async and not awaited by anyone: it starts walks and returns. Each walk
 * puts itself back on the front of the queue when it finishes, which calls this
 * again, so the pool keeps itself full without anything polling for it.
 */
function pump() {
  if (stopped) return;
  while (inFlight.size < concurrency && queue.length) {
    const { chatID, kind } = queue.shift();
    queued.delete(chatID);
    inFlight.add(chatID);
    note(chatID, { state: 'started', kind, pages: 0, fetched: 0 }, { force: true });
    runOne(chatID, kind)
      .catch(() => null)
      .then(() => {
        inFlight.delete(chatID);
        // A refresh asked for while this chat's own run was still going has not
        // been served yet. Serve it now rather than dropping it.
        if (again.delete(chatID)) enqueue(chatID, 'refresh', true);
        // Yield between chats so the queue never monopolises the process.
        setTimeout(pump, 0);
      });
  }
}

return {
    /** Ask for a chat to be brought fully up to date. Idempotent. */
    request(chatID) {
      if (!chatID || stopped) return false;
      if (queued.has(chatID) || inFlight.has(chatID)) return false;
      enqueue(chatID, 'sync', false);
      pump();
      return true;
    },

    /**
     * The user pressed refresh on one chat.
     *
     * Jumps the queue, because they are looking at it, and re-checks a chat
     * already believed complete. Returns false only when it is genuinely
     * already queued and not running - the button is then already doing what
     * they asked.
     */
    refresh(chatID) {
      if (!chatID || stopped) return false;
      if (inFlight.has(chatID)) {
        again.add(chatID);
        return true;
      }
      if (queued.has(chatID)) return false;
      enqueue(chatID, 'refresh', true);
      pump();
      return true;
    },

    /** For tests and for shutdown: wait until nothing is left to do. */
    async drain() {
      while (queue.length || inFlight.size) {
        pump();
        // Nothing to await directly any more - the walks are in flight rather
        // than one promise held here - so this waits on the timer instead.
        await breathe();
      }
      return true;
    },

    status() {
      return {
        // How many at once. The panel asks "is anything happening", which is a
        // question about the count and not about which chat.
        running: inFlight.size,
        // Which ones, for the question "is this particular chat being synced".
        runningChats: [...inFlight],
        queued: [...queue].map((entry) => entry.chatID),
        // Newest first, so the chat being worked on is the first row shown.
        jobs: [...jobs.entries()]
          .map(([chatID, job]) => ({ chatID, ...job }))
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        ...store.stats(),
      };
    },

    /** Stop starting new work. In-flight work finishes. */
    stop() {
      stopped = true;
      queue.length = 0;
      queued.clear();
      again.clear();
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