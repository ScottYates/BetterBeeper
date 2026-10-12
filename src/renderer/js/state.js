/** Minimal shared state + event bus for the renderer. */

class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.#handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.#handlers.get(event) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[state:${event}]`, err);
      }
    }
  }
}

export const bus = new Emitter();

export const state = {
  accounts: [],
  /** chatID -> chat summary (with preview) */
  chats: new Map(),
  /** chatID -> Message[] (ascending by time) */
  messages: new Map(),
  activeChatID: null,
  replyTo: null,
  attachments: [],
  settings: {},
  discovery: null,
  liveStatus: 'idle',
  filter: 'all',
  /** Which view the main pane is showing: 'chat' or 'calls' */
  view: 'chat',
  searchQuery: '',
  searchScope: 'all',
  /** messageID currently being edited, per chat */
  editing: null,
  /** accountID -> 'me', for reaction "is mine" styling */
  selfUserIDs: new Set(),
  /**
   * chatIDs with a background job in flight right now.
   *
   * Drives the refresh button's busy state. A Set rather than a flag per chat
   * because the queue runs several at once and the header only cares about the
   * one being looked at.
   */
  syncingChats: new Set(),
};

export function accountFor(chatOrMessage) {
  const accountID = chatOrMessage?.accountID;
  if (!accountID) return null;
  return state.accounts.find((a) => a.accountID === accountID) || null;
}

export function selfUserIDFor(accountID) {
  const account = state.accounts.find((a) => a.accountID === accountID);
  return account?.user?.id || null;
}

export function chatList() {
  return [...state.chats.values()];
}

/**
 * Beeper keeps a personal scratchpad chat pinned above the list, labelled
 * just "Note". There is no dedicated flag in the API, but it is structurally
 * unambiguous: a single chat whose every participant is you.
 */
export function isNoteToSelf(chat) {
  if (!chat || chat.type !== 'single') return false;
  const participants = chat.participants?.items || [];
  return participants.length > 0 && participants.every((p) => p.isSelf);
}

/** Short display label Beeper uses for the pinned note chat. */
export function noteLabel(chat) {
  if (!chat) return 'Note';
  const title = String(chat.title || '').trim();
  if (/^signal note to self$/i.test(title)) return 'Note to self';
  return title.replace(/^note to self$/i, 'Note') || 'Note';
}

/** Network identity for the small badge drawn on each avatar. */
const NETWORK_META = {
  Beeper: { abbr: 'B', color: '#4a7dff' },
  Facebook: { abbr: 'f', color: '#1877f2' },
  Signal: { abbr: 'S', color: '#3a76f0' },
  WhatsApp: { abbr: 'W', color: '#25d366' },
  Instagram: { abbr: 'IG', color: '#e1306c' },
  Discord: { abbr: 'D', color: '#5865f2' },
  Telegram: { abbr: 'T', color: '#2aabee' },
  'Google Voice': { abbr: 'G', color: '#34a853' },
  SMS: { abbr: 'S', color: '#4caf50' },
  Gmail: { abbr: 'M', color: '#ea4335' },
  iMessage: { abbr: 'i', color: '#34c759' },
  'X / Twitter': { abbr: 'X', color: '#e7e9ea' },
};

/**
 * Resolve any chat or message to a human network name. Messages carry only an
 * `accountID`, so the account list is the bridge between a bubble and the
 * network it actually arrived on.
 */
export function networkNameFor(source) {
  if (!source) return '';
  if (source.network) return source.network;
  if (source.accountID) {
    const account = state.accounts.find((a) => a.accountID === source.accountID);
    if (account?.network) return account.network;
  }
  return source.accountID || '';
}

export function networkMeta(source) {
  const raw = String(networkNameFor(source)).trim();
  if (!raw) return { name: 'Beeper', abbr: 'B', color: '#4a7dff' };
  if (NETWORK_META[raw]) return { name: raw, ...NETWORK_META[raw] };

  // Beeper reports decorated names such as "Beeper (Matrix)" and
  // "Facebook/Messenger". Try each component before falling back.
  const stripped = raw.replace(/\s*\(.*?\)\s*$/, '').trim();
  for (const candidate of [stripped, ...stripped.split('/')]) {
    const key = candidate.trim();
    if (key && NETWORK_META[key]) return { name: key, ...NETWORK_META[key] };
  }

  // Bridges we do not know yet still get a stable, recognisable badge.
  const abbr = (stripped || raw).slice(0, 2);
  return { name: stripped || raw, abbr, color: 'hsl(220 16% 40%)' };
}

/**
 * Insert or replace a message, keeping the array sorted and de-duplicated.
 *
 * Beeper's send endpoint returns a temporary `pendingMessageID`; the real
 * message arrives later over the WebSocket with its permanent ID. Without
 * reconciliation the thread would show the same text twice, so an incoming
 * confirmed message from us absorbs a matching placeholder.
 */
export function upsertMessage(chatID, message) {
  if (!message?.id) return;
  const list = state.messages.get(chatID) || [];
  applyMessage(list, message);
  sortForDisplay(list);
  publish(chatID, message);
  state.messages.set(chatID, list);
}

/**
 * Insert or replace a whole page at once.
 *
 * A page is the unit everything actually arrives in - opening a chat, scrolling
 * back, a live frame - and feeding it in one message at a time is quadratic:
 * every `upsertMessage` re-sorts the list, rescans it, and emits
 * `messages:changed`, which re-signatures the whole thread and re-renders it.
 * Opening a chat therefore did 200 rebuilds to show 200 rows, and measured
 * 2.9 seconds for a store read that takes 45ms.
 *
 * One emit, one sort, one render - the same rows, none of the repeated work.
 */
export function upsertMessages(chatID, messages) {
  const list = [...(state.messages.get(chatID) || [])];
  let last = null;
  for (const message of messages || []) {
    if (!message?.id) continue;
    applyMessage(list, message);
    last = message;
  }
  if (!last) return;
  sortForDisplay(list);
  state.messages.set(chatID, list);
  publish(chatID, last);
}

/** Insert or replace one message in an existing list, in place. */
function applyMessage(list, message) {
  const idx = list.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    const merged = { ...list[idx], ...message };
    // A message that carries no status of its own came from Beeper rather than
    // from an optimistic insert here, so its arrival *is* the confirmation the
    // send was waiting for. Merging cannot drop a key the incoming message does
    // not have, so without this the flag survives - and nothing else in the app
    // ever clears it, leaving the bubble on "sending" for good.
    if (message.sendStatus === undefined) delete merged.sendStatus;
    list[idx] = merged;
    return;
  }
  absorbPendingPlaceholder(list, message);
  list.push(message);
}

/** Oldest first, ties broken by sortKey so equal timestamps keep a stable order. */
function sortForDisplay(list) {
  list.sort((a, b) => {
    const at = new Date(a.timestamp || 0).getTime();
    const bt = new Date(b.timestamp || 0).getTime();
    if (at !== bt) return at - bt;
    return String(a.sortKey || '').localeCompare(String(b.sortKey || ''));
  });
}

/**
 * Announce a change. The sidebar preview falls back to the message list only
 * when Beeper's newest message is one the user deleted here, so that is the
 * only case where an arriving message changes what a sidebar row says. Bumping
 * on every message would throw away the row reuse this exists for.
 */
function publish(chatID, message) {
  if (isMessageDeleted(state.chats.get(chatID)?.preview?.id)) bumpLocal();
  bus.emit('messages:changed', { chatID, message });
}

const PLACEHOLDER_TTL_MS = 3 * 60 * 1000;
// An attachment-only send has no text to match on, so it gets a much shorter
// window - otherwise an unrelated media message arriving minutes later could
// swallow the placeholder.
const PLACEHOLDER_TTL_MS_NO_TEXT = 60 * 1000;

/**
 * Settle the optimistic bubble this message confirms.
 *
 * Beeper's send endpoint answers with a `pendingMessageID` and the confirmed
 * message later arrives over the WebSocket under an unrelated id, so the two can
 * only be tied together by what was sent - there is no transaction id in the
 * echo to match on. A bubble that nothing reconciles stays on "sending"
 * permanently, so a confirmation that claims no text match still settles the
 * oldest send it can rather than leaving it spinning.
 *
 * Returns true when a placeholder was absorbed.
 */
function absorbPendingPlaceholder(list, incoming) {
  if (!incoming.isSender) return false;
  // A pending message is one of our own optimistic inserts, not something
  // Beeper confirmed. Without this, typing a second message with the same text
  // as the first swallowed the first bubble the moment it was inserted, and the
  // two sends shared one placeholder.
  if (incoming.sendStatus === 'pending') return false;
  const incomingAt = new Date(incoming.timestamp || Date.now()).getTime();

  // Oldest first. With several sends in flight the confirmations arrive in the
  // order the messages were sent, so the first one to land belongs to the
  // oldest bubble still waiting. Scanning from the other end let the first
  // confirmation swallow the newest placeholder and strand its own.
  let oldestInWindow = -1;
  for (let i = 0; i < list.length; i += 1) {
    const existing = list[i];
    if (existing.sendStatus !== 'pending') continue;

    // Both sides are normalised: an attachment-only send leaves the text empty
    // on the placeholder *and* on the confirmed message, so comparing raw
    // values used to stop the whole match dead and leave the bubble stuck.
    const existingText = existing.text || '';
    const incomingText = incoming.text || '';
    const at = new Date(existing.timestamp || 0).getTime();
    const window = existingText ? PLACEHOLDER_TTL_MS : PLACEHOLDER_TTL_MS_NO_TEXT;
    if (Math.abs(incomingAt - at) > window) continue;

    if (existingText === incomingText) {
      list.splice(i, 1);
      return true;
    }
    // Remembered, not taken. An exact match is proof; this is only for a
    // message Beeper stored differently from the bytes that were sent.
    if (oldestInWindow < 0) oldestInWindow = i;
  }

  if (oldestInWindow >= 0) {
    list.splice(oldestInWindow, 1);
    return true;
  }
  return false;
}

/**
 * Point an existing message at a different id.
 *
 * The optimistic bubble has to be inserted *before* the send round trip so it can
 * absorb an echo that arrives over the WebSocket first. But only the response
 * tells us the id Beeper will use, so once it lands we re-key the bubble to that
 * id and the authoritative message merges into it instead of appearing beside it.
 *
 * A no-op when the placeholder is already gone, which is precisely the good case:
 * the echo arrived first and absorbed it.
 */
export function rekeyMessage(chatID, fromID, toID) {
  const list = state.messages.get(chatID);
  if (!list || !toID || fromID === toID) return false;
  const idx = list.findIndex((m) => m.id === fromID);
  if (idx < 0) return false;
  list[idx] = { ...list[idx], id: toID };
  state.messages.set(chatID, list);
  bus.emit('messages:changed', { chatID, message: list[idx] });
  return true;
}

/**
 * Mark one of our own sends as failed.
 *
 * Deliberately not `upsertMessage`: that inserts when the id is unknown, and a
 * confirmation that arrived before the failure left is exactly the case where
 * the id is unknown - the bubble is gone because the message went out, and
 * re-inserting it puts the same text in the thread a second time.
 *
 * Returns whether the bubble was still there to fail.
 */
export function markSendFailed(chatID, messageID) {
  const list = state.messages.get(chatID);
  const idx = (list || []).findIndex((m) => m.id === messageID);
  if (idx < 0) return false;
  list[idx] = { ...list[idx], sendStatus: 'failed' };
  state.messages.set(chatID, list);
  bus.emit('messages:changed', { chatID, message: list[idx] });
  return true;
}

export function removeMessage(chatID, messageID) {
  const list = state.messages.get(chatID);
  if (!list) return;
  const next = list.filter((m) => m.id !== messageID);
  state.messages.set(chatID, next);
  bus.emit('messages:changed', { chatID, removed: messageID });
}

export function upsertChat(chat) {
  if (!chat?.id) return;
  const existing = state.chats.get(chat.id);
  state.chats.set(chat.id, existing ? { ...existing, ...chat } : chat);
}

// ---------------------------------------------------------------------------
// Pins
//
// Beeper's Desktop API advertises `isPinned` on PATCH /v1/chats/{id} and then
// ignores it: the call returns 200 with the previous value, and a fresh GET
// afterwards confirms nothing changed. Verified against 4.3.160 on Signal,
// Google Voice and Matrix accounts, while `isMuted` and `isLowPriority` on the
// same endpoint do apply. So the user's choice is recorded here instead.
//
// It is recorded as an override rather than a plain set of pinned ids, because
// Beeper does report some chats as pinned on its own (the note-to-self rows).
// A set of ids could add one of those but never remove it; an override carries
// the unpin too, and means the two sources cannot fight once Beeper starts
// honouring isPinned for real.
// ---------------------------------------------------------------------------

/**
 * A counter for everything the sidebar draws that is NOT part of a chat object.
 *
 * Pins, archives, hidden and deleted messages all live outside `state.chats`,
 * but they change what a row shows. The sidebar reuses row elements between
 * renders (see renderChats) and decides whether a row needs rebuilding from a
 * signature of what it draws, so anything that changes a row without changing
 * the chat has to be in that signature - or a hidden message would leave its
 * text sitting in the preview line.
 *
 * Bumped on those changes only. Not on every message: a row whose preview is
 * not locally deleted does not read the message list at all, and bumping per
 * message would throw away the reuse this exists for.
 */
let localVersion = 0;

/** The current value. Any change to local-only state moves it on. */
export function localStateVersion() {
  return localVersion;
}

function bumpLocal() {
  localVersion++;
}

/** chatID -> the user's explicit choice, true or false. */
const pinOverrides = new Map();

export function loadPins(map) {
  pinOverrides.clear();
  if (map && typeof map === 'object') {
    for (const [id, value] of Object.entries(map)) {
      if (typeof value === 'boolean') pinOverrides.set(id, value);
    }
  }
  bumpLocal();
}

export function pinMap() {
  return Object.fromEntries(pinOverrides);
}

export function isPinned(chat) {
  if (!chat) return false;
  const override = pinOverrides.get(chat.id);
  if (override !== undefined) return override;
  // Beeper pins the note-to-self chats above everything else, and reports
  // isPinned for them, so that is the default. Reading it through this one
  // predicate is what lets an explicit unpin take a note chat back down with
  // the ordinary chats: the override is checked first, so it still wins.
  return Boolean(chat.isPinned) || isNoteToSelf(chat);
}

export function setPinned(chatID, pinned) {
  if (!chatID) return false;
  pinOverrides.set(chatID, Boolean(pinned));
  bumpLocal();
  return pinOverrides.get(chatID);
}

// ---------------------------------------------------------------------------
// Archive overrides
//
// Beeper honours `isArchived` on PATCH /v1/chats/{id} for almost everything -
// verified working on ordinary chats and on the Signal note-to-self chat - but
// it silently ignores it for its own built-in "Note to self" chat on
// beeper.com. The call answers ok, and a fresh GET a second later still says
// isArchived is false.
//
// That makes the optimistic update a lie: the next chat event merges Beeper's
// value back in and the row returns to the inbox, so archiving looks like it
// did nothing. When the server disagrees with the request the choice is
// recorded here instead, and the list filters on the resolved value.
//
// Only `true` is ever stored, and restoring deletes the entry. That keeps the
// map to the chats where the workaround is actually required, so an archive
// made in another Beeper client still shows up normally here.
// ---------------------------------------------------------------------------

/** chatID -> archived in this app even though Beeper says otherwise. */
const archivedOverrides = new Set();

export function loadArchived(ids) {
  archivedOverrides.clear();
  if (Array.isArray(ids)) {
    for (const id of ids) if (typeof id === 'string' && id) archivedOverrides.add(id);
  }
  bumpLocal();
}

export function archivedList() {
  return [...archivedOverrides];
}

export function isArchived(chat) {
  if (!chat) return false;
  if (archivedOverrides.has(chat.id)) return true;
  return Boolean(chat.isArchived);
}

export function setArchivedOverride(chatID, archived) {
  if (!chatID) return false;
  if (archived) archivedOverrides.add(chatID);
  else archivedOverrides.delete(chatID);
  bumpLocal();
  return archivedOverrides.has(chatID);
}

// ---------------------------------------------------------------------------
// Per-message local visibility
//
// Two separate choices, and the difference matters:
//
//   hidden  - folded away behind an arrow. Still there, still in Beeper, still
//             in the chat for everyone else. A way to get a long message out
//             of the way without losing it.
//   deleted - gone from this app's thread, not drawn at all. There is no restore
//             anywhere in the UI, so the choice is final here. Beeper is never
//             told, so no other device and no other person in the chat is
//             affected.
//
// Neither is sent anywhere. They are keyed by messageID alone because Beeper
// message IDs are unique per message, not per chat, so there is no need to
// carry the chatID along and risk the two disagreeing.
// ---------------------------------------------------------------------------

const hiddenMessages = new Set();
const deletedMessages = new Set();

export function loadHiddenMessages(ids) {
  hiddenMessages.clear();
  if (Array.isArray(ids)) {
    for (const id of ids) if (typeof id === 'string' && id) hiddenMessages.add(id);
  }
  bumpLocal();
}

export function loadDeletedMessages(ids) {
  deletedMessages.clear();
  if (Array.isArray(ids)) {
    for (const id of ids) if (typeof id === 'string' && id) deletedMessages.add(id);
  }
  bumpLocal();
}

export function hiddenList() {
  return [...hiddenMessages];
}

export function deletedList() {
  return [...deletedMessages];
}

/**
 * Forget every message deleted on this device, so they all come back.
 *
 * The escape hatch for the one-way delete: with no per-message restore, this is
 * the only way to get a message back once it is gone from the thread. It does
 * not touch Beeper, which still has every one of them.
 */
export function clearDeletedMessages() {
  const count = deletedMessages.size;
  deletedMessages.clear();
  bumpLocal();
  return count;
}

export function isMessageHidden(messageID) {
  return Boolean(messageID) && hiddenMessages.has(messageID);
}

export function isMessageDeleted(messageID) {
  return Boolean(messageID) && deletedMessages.has(messageID);
}

export function setMessageHidden(messageID, hidden) {
  if (!messageID) return false;
  if (hidden) hiddenMessages.add(messageID);
  else hiddenMessages.delete(messageID);
  bumpLocal();
  return hiddenMessages.has(messageID);
}

export function setMessageDeleted(messageID, deleted) {
  if (!messageID) return false;
  if (deleted) {
    deletedMessages.add(messageID);
    // A message that is deleted here is not also sitting there folded up.
    hiddenMessages.delete(messageID);
  } else {
    deletedMessages.delete(messageID);
  }
  bumpLocal();
  return deletedMessages.has(messageID);
}

/** One message rendered as a preview line. */
function previewLineFor(message) {
  if (message.isDeleted) return 'Message deleted';
  if (message.text) return message.text;
  if (message.attachments?.length) return `📎 ${message.attachments[0].fileName || 'Attachment'}`;
  if (message.type && message.type !== 'TEXT') return message.type.toLowerCase();
  return '';
}

/**
 * The newest message in a chat that the thread actually draws.
 *
 * Same rule as renderableMessages, and it has to be the same rule: a preview
 * pointing at something the user cannot see is the sidebar describing a
 * conversation that is not on screen.
 */
function newestVisiblePreviewText(chatID) {
  const list = state.messages.get(chatID) || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message.isHidden || isMessageDeleted(message.id)) continue;
    const line = previewLineFor(message);
    if (line) return line;
  }
  return '';
}

/**
 * The inbox preview line.
 *
 * Beeper's `preview` is the newest message *it* has, which is not the newest
 * message the user has: deleting on this device is local, so Beeper goes on
 * treating the message the user removed as the latest, and the sidebar kept
 * showing its text. With a run of deleted messages the preview looked pinned
 * to something that was not in the thread, and shifted again on every incoming
 * message - which reads as the inbox preview never settling.
 */
export function chatPreviewText(chat) {
  const preview = chat?.preview;
  if (!preview) return '';
  if (isMessageDeleted(preview.id)) {
    const loaded = state.messages.get(chat.id) || [];
    const visible = newestVisiblePreviewText(chat.id);
    if (visible) return visible;
    // Nothing to show only counts as an answer if we have the history to know
    // it. Most rows in the inbox have no messages loaded at all, and blanking
    // those would be worse than the preview being a little out of date.
    if (loaded.length) return '';
  }
  return previewLineFor(preview);
}
