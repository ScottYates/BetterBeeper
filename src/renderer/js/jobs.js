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

/** Jobs that have finished and are no longer worth showing. */
const DONE_STATES = new Set(['done', 'failed']);

const jobs = new Map();
let stats = null;
let expanded = true;
let collapsedAt = 0;

/** Anything queued, running or backfilling. */
function activeJobs() {
  return [...jobs.values()].filter((job) => !DONE_STATES.has(job.state));
}

/**
 * The jobs worth listing.
 *
 * While something is running that is simply the active ones. When nothing is,
 * the most recent finishes stay - including the failures, which matter most
 * then. A job that failed was dropped from the panel entirely for a while, so
 * the one case where the user is told nothing happened is the case where
 * something did.
 */
function listedJobs() {
  const active = activeJobs();
  if (active.length) return active;
  return [...jobs.values()]
    .filter((j) => DONE_STATES.has(j.state))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 2);
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

  const active = activeJobs();
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
  if (activeJobs().length) {
    collapsedAt = 0;
    expanded = true;
    return;
  }
  if (collapsedAt) return;
  collapsedAt = Date.now();
  setTimeout(() => {
    if (activeJobs().length || !collapsedAt) return;
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
