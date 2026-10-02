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

  const idx = list.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...message };
  } else {
    absorbPendingPlaceholder(list, message);
    list.push(message);
  }

  list.sort((a, b) => {
    const at = new Date(a.timestamp || 0).getTime();
    const bt = new Date(b.timestamp || 0).getTime();
    if (at !== bt) return at - bt;
    return String(a.sortKey || '').localeCompare(String(b.sortKey || ''));
  });
  state.messages.set(chatID, list);
  bus.emit('messages:changed', { chatID, message });
}

const PLACEHOLDER_TTL_MS = 3 * 60 * 1000;
// An attachment-only send has no text to match on, so it gets a much shorter
// window - otherwise an unrelated media message arriving minutes later could
// swallow the placeholder.
const PLACEHOLDER_TTL_MS_NO_TEXT = 60 * 1000;

function absorbPendingPlaceholder(list, incoming) {
  if (!incoming.isSender) return;
  const incomingAt = new Date(incoming.timestamp || Date.now()).getTime();

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const existing = list[i];
    if (existing.sendStatus !== 'pending') continue;

    // Both sides are normalised: an attachment-only send leaves the text empty
    // on the placeholder *and* on the confirmed message, so comparing raw
    // values used to stop the whole match dead and leave the bubble stuck.
    const existingText = existing.text || '';
    const incomingText = incoming.text || '';
    if (existingText !== incomingText) continue;

    const at = new Date(existing.timestamp || 0).getTime();
    const window = existingText ? PLACEHOLDER_TTL_MS : PLACEHOLDER_TTL_MS_NO_TEXT;
    if (Math.abs(incomingAt - at) > window) continue;

    list.splice(i, 1);
    return;
  }
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

/** chatID -> the user's explicit choice, true or false. */
const pinOverrides = new Map();

export function loadPins(map) {
  pinOverrides.clear();
  if (map && typeof map === 'object') {
    for (const [id, value] of Object.entries(map)) {
      if (typeof value === 'boolean') pinOverrides.set(id, value);
    }
  }
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
  return archivedOverrides.has(chatID);
}

export function chatPreviewText(chat) {
  const preview = chat?.preview;
  if (!preview) return '';
  if (preview.isDeleted) return 'Message deleted';
  if (preview.text) return preview.text;
  if (preview.attachments?.length) return `📎 ${preview.attachments[0].fileName || 'Attachment'}`;
  if (preview.type && preview.type !== 'TEXT') return preview.type.toLowerCase();
  return '';
}
