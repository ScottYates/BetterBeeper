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

import { api, call } from './api.js';

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
  // The named constants, not their numbers: FILTER_ACCEPT is 1 and
  // FILTER_REJECT is 2, and swapping them silently rejects every node.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Our own marks, and anything that is not text the reader reads.
      if (parent.closest(`mark.${HIT_CLASS}, script, style, textarea`)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
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

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 250;

/**
 * Everything the module needs from the thread, handed in rather than
 * imported, so the dependency between the two runs one way only.
 */
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

/**
 * Close the row, take the marks out, and give the cursor back.
 *
 * The marks belong to the conversation that was open, so they go when the
 * search does.
 */
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

  const local = await call(
    () => api.history.searchInChat(chatID, query, { limit: 500 }),
    { context: 'conversation search', fallback: [] },
  );
  const remote = isSingleWord(query)
    ? await call(
        () => api.messages.search({ query, chatIDs: [chatID], limit: 20 }),
        { context: 'message search', fallback: { items: [] } },
      )
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
  const marks = [...root.querySelectorAll(`mark.${HIT_CLASS}`)];
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
