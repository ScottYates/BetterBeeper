/**
 * What every background job is doing.
 *
 * The sync that keeps a local copy of each chat runs in the main process,
 * which is right - it has to survive closing the window - and also means the
 * user has no way to see it. A chat with thousands of messages is hundreds of
 * pages, so "nothing is happening" and "it is working" look identical from out
 * here, and the only previous sign of any of it was a line of text inside the
 * History settings section that said "Fetching older messages...".
 *
 * So this panel is the whole of the background work in one place: what is
 * running, what is waiting, how far along each one is, and what the totals are
 * when nothing is.
 *
 * It reads from two sources on purpose. The events carry the live detail, but a
 * reload loses every one of them, so the state is also fetched once at startup
 * - otherwise a reloaded window would show an empty panel while work carried
 * on regardless.
 *
 * Progress is announced by the main process at most a few times a second, so
 * this renders on a timer of its own and never in the middle of a backfill.
 */

import { $, el } from './util.js';
import { api, call } from './api.js';
import { state, bus } from './state.js';

/** Jobs worth a row of their own. The rest are counted, not listed. */
const MAX_ROWS = 6;

/**
 * How long a single-page job has to last before it gets a row at all.
 *
 * Opening a chat queues a sync of it, and for a chat that is already up to date
 * that is one page over a bridge round trip. Listed anyway, it put an animated
 * bar in the sidebar for a moment and took a row away again, so moving between
 * chats made the panel twitch. Measured: six chat switches, six rows inserted
 * and six removed, bars rebuilt each time.
 *
 * This is the floor, not the whole rule - see worthShowing. A job can deserve a
 * row before this has passed, if it is doing enough work to see.
 */
const MIN_VISIBLE_MS = 700;

/** Jobs that have finished and are no longer worth showing. */
const DONE_STATES = new Set(['done', 'failed']);

const jobs = new Map();
/** chatID -> when we first heard of it, which is when its row clock starts. */
const seenAt = new Map();
let stats = null;
let expanded = true;
let collapsedAt = 0;

/**
 * Does this job deserve a row?
 *
 * Two ways to qualify, because "has it lasted long enough" is the wrong question
 * on its own. A bridge round trip is slower than any threshold worth picking -
 * measured here at well over 700ms for a single page - so age alone would still
 * flash the panel on every chat the user merely glanced at.
 *
 * The two kinds of work are told apart by `walked`, which the main process sets
 * only when it is paging backwards through history. Opening a chat fetches the
 * newest page and does not walk; a walk is the thing this panel exists to
 * report. Deciding by age alone was not enough, because a bridge round trip for
 * a single page measured well over any threshold worth picking - so every chat
 * the user glanced at still got a row, and the list under the totals changed on
 * every click.
 *
 * A failure always shows, however new: the one case where the user needs to be
 * told something happened is the case where something went wrong.
 *
 * Age is otherwise measured from the job's own last report where there is one,
 * because that is a floor on how long it has existed: a job cannot have reported
 * a minute ago if it was created this second. That matters on a reload, where
 * the panel is handed work that started long before this window existed and would
 * otherwise wait out the delay as if it had just begun.
 */
function worthShowing(job) {
  const since = seenAt.get(job.chatID);
  if (since === undefined) return false;
  if (job.walked || job.state === 'failed') return true;
  return Date.now() - since >= MIN_VISIBLE_MS;
}

/** Anything queued, running or backfilling. */
function activeJobs() {
  return [...jobs.values()].filter((job) => !DONE_STATES.has(job.state));
}

/** Of those, the ones worth drawing. */
function visibleActiveJobs() {
  return activeJobs().filter(worthShowing);
}

/**
 * The jobs worth listing.
 *
 * While something is running that is the active ones. When nothing is, the most
 * recent finishes stay.
 *
 * Failures are the exception in both halves. A sync that could not be done is
 * the one result the user has to be told about, and burying it until the queue
 * drains loses it exactly when there is most going on - a run of jobs where one
 * silently failed would look like a run where they all succeeded. So failures
 * are listed alongside whatever else is happening, and are the first thing kept
 * when the list has to be shortened.
 */
function listedJobs() {
  const active = visibleActiveJobs();
  const finished = [...jobs.values()]
    .filter((j) => DONE_STATES.has(j.state) && worthShowing(j))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const failed = finished.filter((j) => j.state === 'failed');

  if (active.length) return [...active, ...failed];
  return [...failed, ...finished.filter((j) => j.state !== 'failed')].slice(0, 2);
}

const STATE_WORDS = {
  queued: 'Waiting',
  started: 'Starting',
  backfilling: 'Fetching older messages',
  done: 'Up to date',
  failed: 'Could not sync',
};

function chatName(chatID) {
  return state.chats.get(chatID)?.title || 'Chat';
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a row says, given its job. Split out so a reused row can be updated. */
function detailFor(job) {
  if (job.state === 'failed') return job.error || 'failed';
  if (job.state === 'queued') {
    // A queued job has not started. Saying "working..." with a moving bar for
    // every one of them made a queue of 170 chats look like 170 simultaneous
    // downloads, when exactly one of them is running.
    return 'Queued';
  }
  const counts = [
    job.pages ? plural(job.pages, 'page', 'pages') : null,
    job.fetched ? plural(job.fetched, 'message', 'messages') : null,
  ].filter(Boolean);
  return counts.join(' · ') || STATE_WORDS[job.state] || 'working…';
}

function buildRow(job) {
  return el(
    'div',
    { class: 'job-row', dataset: { state: job.state, chatId: job.chatID } },
    el('span', { class: 'job-name', text: chatName(job.chatID) }),
    el('span', { class: 'job-detail', text: detailFor(job) }),
    // No total is known up front - Beeper does not say how far back a chat goes
    // - so a running bar is motion rather than a lie about completion.
    el('div', {
      class: `job-bar${DONE_STATES.has(job.state) ? ' is-done' : ''}`,
    }, el('i')),
  );
}

/**
 * Update a row that is already on screen, in place.
 *
 * The bar's <i> is deliberately not replaced. It carries a CSS animation, and
 * a new element restarts that animation from zero - so rebuilding the row, even
 * with identical content, made every bar lurch once per progress event.
 */
function updateRow(row, job) {
  if (row.dataset.state !== job.state) {
    row.dataset.state = job.state;
    row.classList.toggle('is-done', DONE_STATES.has(job.state));
  }
  const name = row.querySelector('.job-name');
  const detail = row.querySelector('.job-detail');
  const nextName = chatName(job.chatID);
  const nextDetail = detailFor(job);
  if (name.textContent !== nextName) name.textContent = nextName;
  if (detail.textContent !== nextDetail) detail.textContent = nextDetail;
}

/**
 * chatID -> the row element currently on screen, and the job it was last drawn
 * for. The same reasoning as the chat list, learned the hard way twice in one
 * session: this panel was written with clear() and a rebuild on every event,
 * and at four events a second with six rows it flickered badly enough to be the
 * most noticeable thing in the sidebar.
 */
const rowNodes = new Map();
let moreNode = null;

/** Redraw. Cheap enough to call on every progress event. */
export function renderJobs() {
  const panel = $('#jobs-panel');
  if (!panel) return;

  const active = visibleActiveJobs();
  const visible = listedJobs();
  panel.hidden = false;
  panel.dataset.state = active.length ? 'busy' : 'idle';

  const summary = $('#jobs-summary');
  if (active.length) {
    const running = active.filter((j) => j.state !== 'queued').length;
    summary.textContent = running
      ? `Syncing ${running}${active.length > running ? ` of ${active.length}` : ''}`
      : `Waiting on ${plural(active.length, 'chat', 'chats')}`;
  } else if (stats) {
    summary.textContent = `Chats synced · ${plural(stats.messages || 0, 'message', 'messages')}`;
  } else {
    summary.textContent = 'Chats synced';
  }

  panel.classList.toggle('is-collapsed', !expanded && Boolean(active.length));

  const list = $('#jobs-list');
  const shown = visible.slice(0, MAX_ROWS);

  shown.forEach((job, index) => {
    let entry = rowNodes.get(job.chatID);
    if (!entry) {
      entry = { node: buildRow(job) };
      rowNodes.set(job.chatID, entry);
    } else {
      updateRow(entry.node, job);
    }
    // Move only when it is not already in this position.
    if (list.children[index] !== entry.node) {
      list.insertBefore(entry.node, list.children[index] || null);
    }
  });

  // Anything after the shown rows is the overflow note, or a leftover row.
  const overflowIndex = shown.length;
  const hiddenCount = visible.length - MAX_ROWS;
  if (hiddenCount > 0) {
    if (!moreNode) moreNode = el('div', { class: 'job-more' });
    moreNode.textContent = `and ${hiddenCount} more`;
    if (list.children[overflowIndex] !== moreNode) {
      list.insertBefore(moreNode, list.children[overflowIndex] || null);
    }
    while (list.children.length > overflowIndex + 1) list.removeChild(list.lastChild);
  } else {
    if (moreNode && moreNode.parentNode === list) list.removeChild(moreNode);
    while (list.children.length > overflowIndex) list.removeChild(list.lastChild);
  }

  // Drop rows for jobs no longer on screen, or the cache grows for ever.
  const live = new Set(shown.map((j) => j.chatID));
  for (const id of [...rowNodes.keys()]) {
    if (!live.has(id)) rowNodes.delete(id);
  }

  scheduleReveal();
  prune();
}

/**
 * Forget the distant past.
 *
 * Both maps are keyed by chat, so they would otherwise hold every chat this
 * window has ever synced until it closes. Only recent work can ever be listed,
 * and a job that has fallen out of that can never come back - the main process
 * will not report it again.
 */
const RECENT_JOBS = 50;
function prune() {
  if (jobs.size > RECENT_JOBS) {
    const finished = [...jobs.values()]
      .filter((j) => DONE_STATES.has(j.state))
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (const job of finished) {
      if (jobs.size <= RECENT_JOBS) break;
      jobs.delete(job.chatID);
      seenAt.delete(job.chatID);
    }
  }
  for (const id of [...seenAt.keys()]) {
    if (!jobs.has(id)) seenAt.delete(id);
  }
}

/**
 * Come back to redraw when the oldest running job is finally old enough to show.
 *
 * Without this the delay above would be permanent for anything that started
 * just before the last render: a slow backfill would never get a row, because
 * the only thing that would have drawn it is the event that never comes - the
 * job is not done yet, and nothing else asks for a repaint.
 */
let revealTimer = null;
function scheduleReveal() {
  if (revealTimer !== null) return;
  let soonest = Infinity;
  for (const job of jobs.values()) {
    if (DONE_STATES.has(job.state)) continue;
    // Already worth a row on its own account; nothing to wait for.
    if (job.walked || job.state === 'failed') continue;
    const since = seenAt.get(job.chatID);
    if (since === undefined) continue;
    const remaining = MIN_VISIBLE_MS - (Date.now() - since);
    if (remaining > 0) soonest = Math.min(soonest, remaining);
  }
  if (!Number.isFinite(soonest)) return;
  revealTimer = setTimeout(() => {
    revealTimer = null;
    scheduleRender();
  }, Math.ceil(soonest) + 5);
}

/**
 * Coalesce renders into one per frame.
 *
 * Several jobs can report in the same frame, and a render that arrives four
 * times a second is a render the eye can see. Scheduling means however many
 * events land before the next paint, the panel is updated once - which is also
 * all the update is worth, since a progress event never changes more than a few
 * characters of text.
 */
let frame = null;
export function scheduleRender() {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    renderJobs();
  });
}

/**
 * Collapse by itself a few seconds after the work stops, so the panel does not
 * sit there claiming to be busy. Expanded again on any new job.
 */
function maybeAutoCollapse() {
  if (visibleActiveJobs().length) {
    collapsedAt = 0;
    expanded = true;
    return;
  }
  if (collapsedAt) return;
  collapsedAt = Date.now();
  setTimeout(() => {
    if (visibleActiveJobs().length || !collapsedAt) return;
    expanded = false;
    renderJobs();
  }, 4000);
}

function ingest(payload) {
  if (!payload?.chatID) return;
  const chatID = payload.chatID;
  const job = {
    chatID,
    pages: payload.pages || 0,
    fetched: payload.fetched || 0,
    updatedAt: Date.now(),
    ...payload,
  };
  // The job's own last report is a floor on how long it has existed, which is
  // what the row delay is measured from. See longEnough().
  if (!seenAt.has(chatID)) {
    seenAt.set(chatID, typeof payload.updatedAt === 'number' ? payload.updatedAt : Date.now());
  }
  jobs.set(chatID, job);

  if (DONE_STATES.has(job.state)) state.syncingChats.delete(chatID);
  else state.syncingChats.add(chatID);

  // The refresh button in the thread header shows this.
  bus.emit('jobs:changed', { chatID, state: job.state });
  maybeAutoCollapse();
  // Scheduled, not immediate: this runs on every progress event.
  scheduleRender();
}

export function initJobs() {
  const toggle = $('#jobs-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      collapsedAt = expanded ? 0 : Date.now();
      renderJobs();
    });
  }

  window.beeper?.on?.historyProgress?.(ingest);

  // A reload arrives after every progress event that came before it, so the
  // panel would start empty. One call puts the real state back.
  call(() => api.history.jobs(), { context: 'jobs', fallback: null }).then((res) => {
    if (!res) return;
    stats = res;
    for (const job of res.jobs || []) ingest(job);
    renderJobs();
  });

  renderJobs();
}

/** Called when the store's totals change, so the idle line stays honest. */
export function setJobStats(next) {
  stats = next;
  scheduleRender();
}
