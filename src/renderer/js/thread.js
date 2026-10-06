/** Message thread: history, composer, replies, reactions, attachments, live updates. */

import {
  $,
  el,
  clear,
  renderRichText,
  messageTime,
  fullTime,
  dayLabel,
  parseTs,
  fileSize,
  debounce,
  escapeHtml,
} from './util.js';
import { api, call, callOk, FAILED } from './api.js';
import { mediaKind } from './media-kind.js';
import {
  state,
  bus,
  selfUserIDFor,
  upsertMessage,
  rekeyMessage,
  removeMessage,
  isNoteToSelf,
  networkNameFor,
  isPinned,
  setPinned,
  pinMap,
  isArchived,
  isMessageHidden,
  isMessageDeleted,
  setMessageHidden,
  setMessageDeleted,
  hiddenList,
  deletedList,
} from './state.js';
import {
  toast,
  confirmDialog,
  openEmojiPicker,
  openPopover,
  openLightbox,
  imageMenu,
  saveAttachment,
} from './ui.js';
import { setArchived } from './chat-actions.js';
import { avatarNode, renderChats, networkBadge } from './sidebar.js';

let currentChat = null;
let hasMore = false;
let loadingOlder = false;
let atBottom = true;
// Timestamp until which scroll events are treated as our own re-pinning rather
// than the user's. See the scroll handler in initThread().
let settleUntil = 0;
// "chatID/messageID" -> when marking it read last failed. Retried after a
// while, because the bridge may recover, but not on every single re-render.
const failedMarks = new Map();
const MARK_RETRY_AFTER = 60_000;
let pendingAttachments = [];
// Distinguishes two optimistic bubbles created in the same millisecond.
let txnSeq = 0;
let focusMessageID = null;
let lastThreadSignature = null;
const renderedNodes = new Map();

/**
 * React to the backfill queue.
 *
 * Without this the first time you open a chat is a dead end: the store is
 * empty, history.open returns nothing, the thread draws "No messages here yet",
 * and the thousands of messages then arriving in the main process are never
 * told about - so the chat stays empty until you open it a second time.
 */
function onHistoryProgress(payload) {
  if (!payload?.chatID) return;

  if (payload.state === 'recovered') {
    toast('The local history could not be read and has been reset.', 'error', 4000);
    return;
  }

  // Only the open chat needs drawing; the rest will be right when they open.
  if (payload.state !== 'done' || payload.chatID !== state.activeChatID) return;

  call(() => api.history.open(payload.chatID), { context: 'history', fallback: null }).then((page) => {
    if (!page || state.activeChatID !== payload.chatID) return;
    // Same rule as opening the chat: what is behind this page in the store,
    // not whether the backfill just finished.
    hasMore = Boolean(page.hasMore);
    for (const message of page.messages || []) upsertMessage(payload.chatID, message);
    // Rebuilds only if something actually changed, so a tail refresh of an
    // already-complete chat costs nothing.
    onMessageUpserted();
  });
}

export function initThread() {
  const composer = $('#composer');

  window.beeper?.on?.historyProgress?.(onHistoryProgress);

  composer.addEventListener('input', () => {
    updateReplyPreview();
  });

  composer.addEventListener('keydown', (event) => {
    const sendOnEnter = state.settings.sendOnEnter !== false;
    if (event.key === 'Enter' && !event.shiftKey && (sendOnEnter || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendCurrent();
    }
  });

  // Listens on the document rather than the textarea. A paste very often lands
  // with focus in the message list, or nowhere in particular, because clicking
  // a chat and then reaching for the keyboard is the normal way to write a
  // message. Anchored to the composer, the paste fired at the document and the
  // composer never heard about it.
  document.addEventListener('paste', (event) => {
    // Only the chat composer claims an image. Anywhere else - the
    // search box, the token field - a paste is left alone.
    const target = event.target;
    if (target?.closest?.('#search-input, #manual-token')) return;
    if (!currentChat) return;
    // A screenshot arrives as a clipboard *file* with no text beside it, so the
    // textarea has nothing to insert and the paste would look like nothing
    // happened. Only claim the event when an image really is there: swallowing
    // a normal text paste would be far worse than not supporting image paste.
    if (!hasImageItem(event.clipboardData)) return;
    event.preventDefault();
    attachPastedImages(event.clipboardData);
  });

  // Right-click any image in the thread to copy it as a pasteable picture
  // rather than a link. Delegated, so it covers attachments and images inside
  // message text alike, and survives every re-render of the list.
  $('#message-list').addEventListener('contextmenu', (event) => {
    const img = event.target.closest?.('img');
    if (!img || !img.src) return;
    if (!imageMenu(img, img.src, { pointer: { x: event.clientX, y: event.clientY } })) return;
    event.preventDefault();
    event.stopPropagation();
  });

  $('#btn-send').addEventListener('click', sendCurrent);
  $('#btn-attach').addEventListener('click', pickAttachments);
  $('#btn-attach-image').addEventListener('click', pickAttachments);
  $('#btn-emoji').addEventListener('click', (event) => {
    const input = $('#composer');
    openEmojiPicker(event.currentTarget, (emoji) => {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
      input.focus();
      input.setSelectionRange(start + emoji.length, start + emoji.length);
      updateReplyPreview();
    });
  });
  $('#btn-cancel-reply').addEventListener('click', () => {
    state.replyTo = null;
    updateReplyPreview();
  });

  $('#btn-mute').addEventListener('click', () => patchChat({ isMuted: !(currentChat?.isMuted ?? false) }));
  $('#btn-pin').addEventListener('click', togglePin);
  $('#btn-archive').addEventListener('click', archiveActive);
  $('#btn-unread').addEventListener('click', markActiveUnread);

  // Track "is the user at the bottom" synchronously, so a re-render that
  // happens mid-scroll cannot yank the view back down. Only the history
  // fetch is debounced.
  const messageList = $('#message-list');
  const maybeLoadOlder = debounce(() => {
    if (messageList.scrollTop < 200 && hasMore && !loadingOlder) loadOlder();
  }, 140);

  messageList.addEventListener('scroll', () => {
    // While scrollToBottom() is settling, the scroll events it causes are its
    // own, not the user's - and Chrome's scroll anchoring fires them too when
    // images above the viewport grow. Reading those as "the user scrolled up"
    // would cancel the re-pin mid-flight, which is exactly what left a newly
    // opened chat short of its newest message.
    if (Date.now() < settleUntil) return;
    atBottom =
      messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 120;
    maybeLoadOlder();
  });

  // Real input ends the settle window immediately, so the guard can never
  // swallow a genuine scroll or a key-driven scroll.
  for (const type of ['wheel', 'touchmove', 'touchstart', 'pointerdown', 'keydown']) {
    messageList.addEventListener(type, () => {
      settleUntil = 0;
    }, { capture: true, passive: true });
  }

  bus.on('messages:changed', ({ chatID }) => {
    if (chatID === state.activeChatID) onMessageUpserted();
  });
}

export function activeChat() {
  return currentChat;
}

// ---------------------------------------------------------------------------
// Opening a chat
// ---------------------------------------------------------------------------

export async function openChat(chatID, { focusMessageID: focusId } = {}) {
  focusMessageID = focusId || null;
  pendingAttachments = [];
  state.replyTo = null;
  state.editing = null;

  // A chat you have just opened always shows its newest message. `atBottom`
  // survives chat switches, so without this a chat opened after scrolling up
  // in another one would inherit that false and never scroll.
  atBottom = true;

  state.activeChatID = chatID;
  state.view = 'chat';
  currentChat = state.chats.get(chatID) || { id: chatID, title: 'Loading…' };

  $('#thread').hidden = false;
  $('#thread-empty').hidden = true;
  clear($('#message-list'));
  clear($('#attachment-chips'));
  renderedNodes.clear();
  renderAttachments();
  updateReplyPreview();
  renderHeader();
  renderChats();

  const listEl = $('#message-list');
  listEl.append(el('div', { class: 'search-loading', text: 'Loading messages…' }));

  // Read from the local store, not from Beeper. This returns before any
  // network call finishes, so a chat opens instantly and still opens when
  // Beeper is unreachable; the main process brings it up to date behind us.
  const page = await call(() => api.history.open(chatID), {
    context: 'history',
    fallback: { messages: [], complete: false, failed: true },
  });

  clear(listEl);
  renderedNodes.clear();

  if (page?.failed) {
    listEl.append(
      el('div', { class: 'empty-note', text: 'Could not load messages. Beeper may still be indexing this chat.' }),
    );
    return;
  }

  // Whether to offer scroll-back. This is what the store says is behind this
  // page, NOT whether the backfill has finished: a fully-synced chat can hold
  // thousands of messages past the opening page, and treating `complete` as
  // "there is nothing older" made all of them unreachable.
  hasMore = Boolean(page?.hasMore);
  const items = page?.messages || [];
  for (const message of items) {
    upsertMessage(chatID, message);
  }
  renderAll();

  // If the user came from search, scroll to the hit once rendered.
  if (focusMessageID) {
    scrollToMessage(focusMessageID);
  } else {
    scrollToBottom();
  }

  await markRead();

  // Re-apply the full chat record so pinned/muted/archived state is accurate.
  const full = await call(() => api.chats.get(chatID), { context: 'chat details' });
  if (full) {
    currentChat = { ...currentChat, ...full };
    renderHeader();
  }

  // The live socket only streams subscribed chats, and the open chat is not
  // always among the most recent ones, so re-subscribe now that it is active.
  bus.emit('chat:activated', chatID);
}

export function closeThread() {
  $('#thread').hidden = true;
  $('#thread-empty').hidden = false;
  state.activeChatID = null;
  state.view = 'chat';
  currentChat = null;
  renderedNodes.clear();
  lastThreadSignature = null;
  clear($('#message-list'));
  renderChats();
}

// ---------------------------------------------------------------------------
// Header & chat actions
// ---------------------------------------------------------------------------

function renderHeader() {
  const chat = currentChat;
  if (!chat) return;

  $('#thread-name').textContent = chat.title || 'Untitled chat';
  $('#thread-sub').textContent = chatSubtitle(chat);

  const avatarWrap = $('#thread-avatar');
  clear(avatarWrap);
  const fresh = el(
    'div',
    { class: 'avatar-wrap' },
    avatarNode(chat, chat.title, 'lg'),
    networkBadge(chat, { size: 12 }),
  );
  avatarWrap.replaceWith(fresh);
  fresh.id = 'thread-avatar';

  // Beeper relabels these actions to match the chat's current state.
  const mute = $('#btn-mute');
  mute.textContent = chat.isMuted ? '🔕' : '🔔';
  mute.dataset.tip = chat.isMuted ? 'Unmute notifications' : 'Mute notifications';
  mute.classList.toggle('is-on', Boolean(chat.isMuted));

  const pin = $('#btn-pin');
  pin.dataset.tip = isPinned(chat) ? 'Unpin from top' : 'Pin to top';
  pin.classList.toggle('is-on', isPinned(chat));

  const archive = $('#btn-archive');
  archive.dataset.tip = isArchived(chat) ? 'Move back to inbox' : 'Archive chat';
  archive.classList.toggle('is-on', isArchived(chat));

  const composer = $('#composer');
  if (composer) composer.placeholder = composerPlaceholder(chat);
}

/**
 * The composer's placeholder: who the message is going to.
 *
 * Just the name. It used to read "Message Beeper Updates on Beeper (Matrix)",
 * which repeated information already in the header two rows above and made
 * the single-line box long enough to look truncated on a narrow window. A note
 * chat has no addressee, so it keeps its own wording.
 */
export function composerPlaceholder(chat) {
  if (isNoteToSelf(chat)) return 'Write a note…';
  const title = String(chat?.title || '').trim();
  return title || 'Write a message…';
}

// ---------------------------------------------------------------------------
// Clipboard images
// ---------------------------------------------------------------------------

// Enough for a full-resolution screenshot, small enough that a stray 200 MB
// clipboard payload cannot wedge the upload.
const MAX_PASTE_BYTES = 25 * 1024 * 1024;
const MAX_PASTE_MB = MAX_PASTE_BYTES / 1048576;

const PASTE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/** Clipboard images arrive nameless, so give the upload one it can be labelled by. */
export function pasteImageName(mimeType, index) {
  return `pasted-image-${index + 1}.${PASTE_EXT[mimeType] || 'png'}`;
}

/**
 * Whether the clipboard holds an image at all. Called synchronously from the
 * paste handler, because preventDefault has to happen during the event - by the
 * time an async read has finished the browser has already inserted its default.
 */
export function hasImageItem(dataTransfer) {
  return imageItems(dataTransfer).length > 0;
}

function imageItems(dataTransfer) {
  return Array.from(dataTransfer?.items || []).filter(
    (item) => item.kind === 'file' && String(item.type || '').startsWith('image/'),
  );
}

/**
 * Read the pasted images out of a clipboard payload.
 *
 * Returns { images, rejected } rather than throwing or silently truncating: a
 * screenshot that is too big has to be *told* about, because from the user's
 * side nothing happened is indistinguishable from the paste not working.
 */
export async function pastedImages(dataTransfer) {
  const images = [];
  const rejected = [];

  for (const item of imageItems(dataTransfer)) {
    const file = item.getAsFile();
    if (!file) continue;
    const name = pasteImageName(file.type, images.length);
    if (file.size > MAX_PASTE_BYTES) {
      rejected.push({ fileName: name, bytes: file.size });
      continue;
    }
    images.push({
      data: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      fileName: name,
    });
  }

  return { images, rejected };
}

/**
 * A pasted screenshot is a picture, not a document, and a clip is neither.
 * Labelling either as a document is a small lie on the chip the sender is
 * looking at while deciding what they just attached.
 */
export function attachmentIcon(attachment) {
  const kind = mediaKind(attachment);
  if (kind === 'image') return '\u{1F5BC}';
  if (kind === 'video') return '\u{1F3AC}';
  return '\u{1F4CE}';
}

/** Beeper's "Seen at 11:11 AM" line above the composer. */
function renderSeenLine() {
  const line = $('#seen-line');
  if (!line) return;

  const messages = state.messages.get(state.activeChatID) || [];
  const lastSeen = [...messages].reverse().find((m) => m.isSender && seenAt(m.seen));
  const when = lastSeen ? seenAt(lastSeen.seen) : null;
  line.textContent = when ? `Seen at ${messageTime(when)}` : '';
}

/**
 * Beeper's `seen` field is polymorphic: a boolean, an ISO timestamp, or a map
 * of userID -> ISO timestamp (as returned by the Matrix bridges). Pull the
 * most recent concrete timestamp out of whichever shape arrived.
 */
function seenAt(seen) {
  if (!seen) return null;
  if (seen === true) return null;
  if (typeof seen === 'string') return seen;
  if (typeof seen === 'object') {
    const values = Object.values(seen).filter((v) => typeof v === 'string' && v);
    if (values.length) return values.sort().slice(-1)[0];
    for (const key of ['timestamp', 'seenAt', 'time', 'lastReadTimestamp']) {
      if (typeof seen[key] === 'string') return seen[key];
    }
  }
  return null;
}

function chatSubtitle(chat) {
  const parts = [];
  parts.push(chat.network || chat.accountID || 'Beeper');
  if (chat.type === 'group') {
    const total = chat.participants?.total;
    parts.push(total ? `${total} members` : 'Group');
  } else {
    const other = chat.participants?.items?.find((p) => !p.isSelf);
    if (other?.phoneNumber) parts.push(other.phoneNumber);
  }
  if (chat.isReadOnly) parts.push('read-only');
  if (chat.messageExpirySeconds) parts.push(`disappearing (${chat.messageExpirySeconds}s)`);
  return parts.filter(Boolean).join(' · ');
}

async function togglePin() {
  if (!currentChat) return;
  const chat = currentChat;
  const pinning = !isPinned(chat);

  // Record the choice locally first, so the button and the list move on the
  // click rather than after a round trip that Beeper may not honour anyway.
  setPinned(chat.id, pinning);
  renderHeader();
  renderChats();

  await api.settings.set({ pinnedChats: pinMap() }).catch(() => {});

  // Still tell Beeper, so that if isPinned ever starts working the two agree.
  // Its answer is deliberately not merged: the response carries the value from
  // before the change, so trusting it would undo the pin the user just made.
  await call(() => api.chats.patch(chat.id, { isPinned: pinning }), { context: 'pin' });

  toast(pinning ? 'Pinned to top' : 'Unpinned', 'success', 1600);
}

async function patchChat(patch) {
  if (!currentChat) return;
  const updated = await call(() => api.chats.patch(currentChat.id, patch), { context: 'chat update' });
  if (updated) {
    currentChat = { ...currentChat, ...updated };
    state.chats.set(currentChat.id, { ...state.chats.get(currentChat.id), ...updated });
    renderHeader();
    renderChats();
    toast('Chat updated', 'success', 1600);
  }
}

async function archiveActive() {
  if (!currentChat) return;
  // The header button is a toggle: its label promises "Move back to inbox" once
  // the chat is archived, so it has to actually unarchive.
  const archiving = !isArchived(currentChat);
  const result = await setArchived(currentChat, archiving);
  if (!result.ok) return;

  currentChat = { ...currentChat, isArchived: archiving };

  if (archiving) {
    toast(
      result.localOnly ? 'Archived in this app only - Beeper still lists it' : 'Chat archived',
      result.localOnly ? 'info' : 'success',
      result.localOnly ? 3600 : 1800,
    );
    closeThread();
  } else {
    toast('Moved back to inbox', 'success', 1800);
    renderHeader();
  }
  renderChats();
}

async function markActiveUnread() {
  if (!currentChat) return;
  await call(() => api.chats.markUnread(currentChat.id), { context: 'mark unread' });
  state.chats.set(currentChat.id, { ...currentChat, unreadCount: Math.max(1, currentChat.unreadCount || 0) });
  toast('Marked as unread', 'success', 1600);
  closeThread();
}

async function markRead() {
  const chat = currentChat;
  if (!chat) return;
  if (state.settings.markReadOnOpen === false) return;
  const messages = state.messages.get(chat.id) || [];
  const last = messages[messages.length - 1];
  if (!last?.isUnread) return;

  // markRead runs on every re-render, so a message Beeper refuses to mark read
  // (a 500 from a bridge, a deleted message) would otherwise retry forever and
  // bury the thread under identical error toasts.
  const key = `${chat.id}/${last.id}`;
  const failedAt = failedMarks.get(key);
  if (failedAt && Date.now() - failedAt < MARK_RETRY_AFTER) return;

  const result = await callOk(() => api.chats.markRead(chat.id, last.id), { context: 'mark read' });
  if (result === FAILED) {
    failedMarks.set(key, Date.now());
    return;
  }

  state.chats.set(chat.id, { ...state.chats.get(chat.id), unreadCount: 0 });
  renderChats();
}

// ---------------------------------------------------------------------------
// Rendering messages
// ---------------------------------------------------------------------------

function renderAll() {
  const listEl = $('#message-list');
  const stick = atBottom;
  clear(listEl);
  renderedNodes.clear();

  if (hasMore) {
    listEl.append(
      el('div', {
        class: 'search-loading',
        text: 'Scroll up for earlier messages',
      }),
    );
  }

  const messages = renderableMessages(state.activeChatID);
  if (!messages.length) {
    listEl.append(el('div', { class: 'empty-note', text: 'No messages here yet.' }));
    return;
  }

  let lastDay = null;
  let previous = null;
  // One claim per attachment per pass; see the note above imageCache.
  resetImageClaims();
  for (const message of messages) {
    const day = dayKey(message.timestamp);
    if (day !== lastDay) {
      listEl.append(el('div', { class: 'day-divider', text: dayLabel(message.timestamp) }));
      lastDay = day;
      previous = null;
    }
    const node = messageNode(message, previous);
    renderedNodes.set(message.id, node);
    listEl.append(node);
    previous = message;
  }

  renderSeenLine();
  if (stick) scrollToBottom();
}

/**
 * Everything about the thread that changes what is drawn, as one string.
 *
 * If this is unchanged, the next render would produce the same rows in the same
 * order, so the rebuild can be skipped. It has to cover every field messageNode
 * reads, or the thread quietly stops updating; erring towards including too
 * much only costs a rebuild, while leaving something out costs correctness.
 */
export function threadSignature(messages) {
  const parts = [
    state.activeChatID || '',
    currentChat?.type || '',
    state.editing || '',
    String(atBottom),
  ];
  for (const m of messages) {
    parts.push([
      m.id,
      m.isSender ? 1 : 0,
      m.accountID || '',
      m.senderID || '',
      m.senderName || '',
      m.isDeleted ? 1 : 0,
      m.sendStatus || '',
      m.text || '',
      m.type || '',
      m.timestamp || '',
      m.editedTimestamp || '',
      m.linkedMessageID || '',
      (m.attachments || [])
        .map((a) => `${a.id || a.fileName || ''}:${a.fileSize || 0}:${a.mimeType || ''}`)
        .join(','),
      (m.reactions || [])
        .map((r) => `${r.key ?? r.reactionKey}:${r.count ?? (r.userIDs || []).length}:${r.isSelf ? 1 : 0}`)
        .join(','),
      (m.links || []).map((l) => l.url || l.title || '').join(','),
      isMessageHidden(m.id) ? 'h' : '',
      isMessageDeleted(m.id) ? 'd' : '',
    ].join('~'));
  }
  return parts.join('|');
}

function onMessageUpserted() {
  // Deleting the last message in a chat is a real state to draw: the list has
  // to be cleared, not left showing what was just removed. So the empty case
  // falls through to the rebuild below, and only a closed thread is ignored.
  if (!state.activeChatID) return;
  const messages = renderableMessages(state.activeChatID);

  // Almost every incoming event changes nothing the thread shows. A typing
  // indicator, a read receipt or a presence update re-renders the same bubbles
  // in the same order, and a rebuild detaches every image in the list. An
  // animated GIF loses its playback the moment it leaves the document, so on a
  // busy chat the file was restarted several times a second and never appeared
  // to move - while an identical-looking rebuild was also thrown away.
  //
  // Reusing the <img> elements is not enough on its own: they still have to be
  // detached and reattached to be reused. Skipping the rebuild that changes
  // nothing is what actually keeps a GIF playing.
  //
  // Deleting a message changes the set itself, so a deleted message drops out of
  // the list and the signature changes with it. That is the rebuild this relies
  // on: there is no tombstone left behind to re-render.
  const signature = threadSignature(messages);
  if (signature === lastThreadSignature) return;
  lastThreadSignature = signature;

  const listEl = $('#message-list');
  const stick = atBottom;
  const rebuilt = [];
  // One claim per attachment per pass; see the note above imageCache.
  resetImageClaims();

  let previous = null;
  for (const message of messages) {
    const day = dayKey(message.timestamp);
    if (!previous || day !== dayKey(previous.timestamp)) {
      rebuilt.push(el('div', { class: 'day-divider', text: dayLabel(message.timestamp) }));
      previous = null;
    }
    rebuilt.push(messageNode(message, previous));
    previous = message;
  }

  clear(listEl);
  renderedNodes.clear();
  for (const node of rebuilt) {
    listEl.append(node);
    if (node.dataset?.messageId) renderedNodes.set(node.dataset.messageId, node);
  }
  // Every message here was deleted on this device. Say so, so an empty thread
  // reads as a choice rather than as a chat that failed to load.
  if (!rebuilt.length) {
    listEl.append(el('div', { class: 'empty-note', text: 'No messages here yet.' }));
  }

  renderSeenLine();
  if (stick) scrollToBottom();
  if (window.document.hasFocus() && window.document.visibilityState === 'visible') markRead();
}

function dayKey(value) {
  const date = parseTs(value);
  return date ? date.toDateString() : '';
}

export function messageNode(message, previous) {
  const isOut = Boolean(message.isSender);
  const selfID = selfUserIDFor(message.accountID);
  // In a 1:1 chat the avatar already identifies the other person, so Beeper
  // does not repeat the sender name above every bubble.
  const isSingle = currentChat?.type === 'single';
  const sameAuthor = previous && previous.senderID === message.senderID;

  const isFirst = !sameAuthor;
  const isLast = true; // recomputed implicitly on the next node

  const bubbleWrap = el('div', { class: 'msg-bubble-wrap' });

  if (!isOut && isFirst && !isSingle) {
    bubbleWrap.append(
      el('div', {
        class: 'msg-author',
        text: message.senderName || message.senderID || 'Unknown',
      }),
    );
  }

  if (state.editing === message.id) {
    bubbleWrap.append(editingNode(message));
  } else {
    if (message.linkedMessageID) bubbleWrap.append(replyQuoteNode(message));

    // Folded away on this device: the arrow opens it again.
    if (isMessageHidden(message.id)) {
      bubbleWrap.append(collapsedNode(message));
      return wrapMessageRow(message, isOut, isFirst, isLast, bubbleWrap);
    }

    const bubble = el('div', { class: 'msg-bubble' });

    if (message.attachments?.length) bubble.append(attachmentsNode(message));

    const inner = el('div', { class: 'bubble-inner' });

    if (!message.isDeleted && message.text) {
      inner.append(el('div', { class: 'bubble-text', html: renderRichText(message.text) }));
    } else if (message.isDeleted) {
      inner.append(el('div', { class: 'bubble-text muted', text: 'This message was deleted' }));
    } else if (!message.attachments?.length) {
      inner.append(
        el('div', { class: 'bubble-text muted', text: message.type ? `[${message.type.toLowerCase()}]` : '' }),
      );
    }

    // Beeper tucks the timestamp inside the bubble at the trailing edge.
    inner.append(
      el('span', {
        class: 'bubble-time',
        text: messageTime(message.timestamp),
        title: fullTime(message.timestamp),
      }),
    );
    bubble.append(inner);

    if (message.reactions?.length) bubble.append(reactionsNode(message, selfID));

    bubbleWrap.append(bubble);
  }

  if (message.editedTimestamp || (message.isSender && message.sendStatus) || message.links?.length) {
    bubbleWrap.append(metaNode(message));
  }

  return wrapMessageRow(message, isOut, isFirst, isLast, bubbleWrap);
}

/**
 * The outer row: avatar, bubble column, and the hover action buttons.
 *
 * The trash here is deliberately the *local* delete. Deleting on Beeper means
 * everyone else sees it go, which is too much to attach to a hover; that one
 * lives in the context menu, where it is asked for by name.
 */
function wrapMessageRow(message, isOut, isFirst, isLast, bubbleWrap) {
  const actions = el('div', { class: 'msg-hover-actions' });
  actions.append(
    el('button', {
      class: 'icon-btn tiny-btn',
      title: 'React',
      text: '😊',
      onClick: (event) => {
        event.stopPropagation();
        openEmojiPicker(event.currentTarget, (emoji) => toggleReaction(message, emoji));
      },
    }),
  );

  // A folded message already carries its own arrow back, so it does not get a
  // Hide button too - two controls for one state is how they drift apart.
  if (!isMessageHidden(message.id)) {
    actions.append(
      el('button', {
        class: 'icon-btn tiny-btn',
        title: 'Hide message',
        text: '👁',
        onClick: (event) => {
          event.stopPropagation();
          setLocalHidden(message, true);
        },
      }),
    );
  }

  // The trash on hover is the *local* delete, on every message. It only hides
  // the message in this app, and Clear list in settings brings them all back.
  // Deleting on Beeper, which everyone else sees, stays in the context menu
  // where it is a deliberate choice rather than a stray click.
  actions.append(
    el('button', {
      class: 'icon-btn tiny-btn',
      title: 'Delete on this device',
      text: '🗑',
      onClick: (event) => {
        event.stopPropagation();
        deleteOnThisDevice(message);
      },
    }),
  );

  actions.append(
    el('button', {
      class: 'icon-btn tiny-btn',
      title: 'More',
      text: '⋯',
      onClick: (event) => {
        event.stopPropagation();
        openMessageMenu(event.currentTarget, message);
      },
    }),
  );

  return el(
    'div',
    {
      class: `msg ${isOut ? 'is-out' : 'is-in'}${isFirst ? ' is-first' : ''}${isLast ? ' is-last' : ''}`,
      dataset: { messageId: message.id, chatId: message.chatID },
    },
    !isOut ? messageAvatar(message) : null,
    bubbleWrap,
    actions,
  );
}

/**
 * A folded-away message: one line with an arrow to open it again.
 *
 * The summary is the message's own first line rather than a word like
 * "hidden", so a folded thread still reads as a conversation.
 */
function collapsedNode(message) {
  const summary = messageSummary(message);
  const arrow = el('span', { class: 'msg-collapse-arrow', text: '▸' });

  const toggle = el(
    'button',
    {
      class: 'msg-collapsed',
      title: 'Show this message',
      'aria-expanded': 'false',
      onClick: (event) => {
        event.stopPropagation();
        setLocalHidden(message, false);
      },
    },
    arrow,
    el('span', { class: 'msg-collapsed-summary', text: summary }),
  );

  const shrink = el('button', {
    class: 'icon-btn tiny-btn msg-collapse-btn',
    title: 'Hide this message',
    text: '▴',
    onClick: (event) => {
      event.stopPropagation();
      setLocalHidden(message, true);
    },
  });

  return el('div', { class: 'msg-collapsed-wrap' }, toggle, shrink);
}

/** One readable line standing in for a whole message. */
export function messageSummary(message) {
  const text = String(message?.text || '').trim();
  if (text) return text.replace(/\s+/g, ' ').slice(0, 120);
  if (message?.attachments?.length) {
    const first = message.attachments[0];
    const isImage = first.type === 'img' || /^image\//i.test(first.mimeType || '');
    if (isImage) return 'Photo';
    return first.fileName || 'Attachment';
  }
  return message?.type ? `[${String(message.type).toLowerCase()}]` : 'Message';
}

/**
 * Sender avatar plus a network badge, but only when the message arrived on a
 * different network than the chat as a whole. In a single-network chat the
 * header already names it, and a badge on every bubble would just be noise.
 */
function messageAvatar(message) {
  const avatar = avatarNode({ id: message.senderID, imgURL: null }, message.senderName || '?', 'sm');
  const chatNet = networkNameFor(currentChat);
  const messageNet = networkNameFor(message);
  if (!messageNet || messageNet === chatNet) return avatar;

  return el(
    'div',
    { class: 'avatar-wrap' },
    avatar,
    networkBadge({ network: messageNet }, { size: 9 }),
  );
}

function metaNode(message) {
  const bits = [];
  if (message.editedTimestamp) bits.push(el('span', { class: 'muted', text: 'edited' }));

  if (message.isSender) {
    const status = message.sendStatus || 'sent';
    const label = { pending: '⏳ sending…', sent: '✓', failed: '✕ failed' }[status] || '✓';
    bits.push(el('span', { class: `msg-status-${status}`, text: label }));
  }

  if (message.links?.length) {
    bits.push(
      el('a', {
        href: '#',
        class: 'muted',
        text: '🔗',
        title: message.links.map((l) => l.url || l.title).join(', '),
        onClick: (event) => {
          event.preventDefault();
          const link = message.links.find((l) => l.url) || message.links[0];
          if (link?.url) api.shell.openExternal(link.url);
        },
      }),
    );
  }

  if (!bits.length) return document.createDocumentFragment();
  return el('div', { class: 'msg-meta' }, bits);
}

function replyQuoteNode(message) {
  const original = (state.messages.get(message.chatID) || []).find(
    (m) => m.id === message.linkedMessageID,
  );
  const text = original
    ? original.text || original.type || ''
    : 'Original message';
  const who = original?.senderName || '';
  return el('div', {
    class: 'reply-quote',
    text: who ? `${who}: ${String(text).slice(0, 90)}` : String(text).slice(0, 90),
    title: String(text).slice(0, 300),
  });
}

function reactionsNode(message, selfID) {
  const wrap = el('div', { class: 'msg-reactions' });
  for (const reaction of message.reactions || []) {
    const mine =
      reaction.isSelf ??
      (Array.isArray(reaction.userIDs) && selfID ? reaction.userIDs.includes(selfID) : false);
    wrap.append(
      el('div', {
        class: `reaction${mine ? ' is-mine' : ''}`,
        text: `${reaction.key ?? reaction.reactionKey ?? '?'} ${reaction.count ?? reaction.userIDs?.length ?? 1}`,
        title: (reaction.userIDs || []).join(', ') || reaction.key,
        onClick: () => toggleReaction(message, reaction.key ?? reaction.reactionKey),
      }),
    );
  }
  return wrap;
}

function attachmentsNode(message) {
  const wrap = el('div', { class: 'msg-attachments' });
  for (const attachment of message.attachments || []) {
    const kind = mediaKind(attachment);
    if (kind === 'image') wrap.append(imageElement(attachment));
    else if (kind === 'video') wrap.append(videoElement(attachment));
    else wrap.append(fileNode(attachment));
  }
  return wrap;
}

/**
 * A video plays in place, with its own controls.
 *
 * If it will not decode, it is swapped for the ordinary download row rather
 * than left sitting there as a dead black rectangle: a file that claims to be
 * a video but is not one should still be saveable, and should say what it is.
 */
function videoElement(attachment) {
  const video = el('video', {
    class: 'att-video',
    controls: true,
    preload: 'metadata',
    playsinline: true,
    title: attachment.fileName || 'video',
  });

  const fallback = () => {
    if (!video.isConnected) return;
    video.replaceWith(fileNode(attachment));
  };

  video.addEventListener('error', fallback);
  resolveSrc(attachment).then((url) => {
    if (url) video.src = url;
    else fallback();
  });
  return video;
}

/**
 * Anything that is not an image or a video.
 *
 * The whole row is the button, because this is the only way to get the file out
 * of Beeper and a small target hidden at the right-hand end is exactly the
 * thing nobody finds. The name is kept as text and never as markup: it comes
 * from whoever sent the message.
 */
function fileNode(attachment) {
  const name = attachment.fileName || 'Attachment';
  return el(
    'button',
    {
      class: 'att-file',
      type: 'button',
      title: `Save ${name}`,
      onClick: () => saveAttachment(attachment),
    },
    el('span', { class: 'att-glyph', text: '📎' }),
    el('span', { class: 'att-name', text: name }),
    el('span', { class: 'att-size', text: fileSize(attachment.fileSize) }),
    el('span', { class: 'att-save', text: '⬇' }),
  );
}

const srcCache = new Map();
function resolveSrc(attachment) {
  const key = attachment.id || attachment.srcURL;
  if (!key) return Promise.resolve(null);
  if (srcCache.has(key)) return srcCache.get(key);
  // `call` unwraps the IPC envelope, so the URL is read off the resolved data.
  const promise = call(() => api.assets.resolve(attachment), { context: 'attachment', fallback: null }).then(
    (data) => data?.url || null,
  );
  srcCache.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Image elements are kept across re-renders
//
// An animated GIF only stays animated if the <img> element that is playing it
// is the same element. A fresh element on the same file starts again at frame
// 0, and the thread is rebuilt from scratch on every incoming event - a typing
// indicator or a read receipt is enough. In a chat with any traffic at all
// that meant the file was restarted several times a second and the GIF never
// appeared to move.
//
// Moving an element within the document does not disturb it: the decoder keeps
// running and the phase is preserved. So the element is cached by attachment
// and reused, which is what stops the restart.
//
// A key may only be claimed once per pass, or an attachment that appears in
// two messages would be yanked out of the first one to serve the second.
// ---------------------------------------------------------------------------

const imgCache = new Map();
const claimedImages = new Set();
const IMG_CACHE_LIMIT = 240;

function resetImageClaims() {
  claimedImages.clear();
}

function imageElement(attachment) {
  const key = attachment.id || attachment.srcURL || attachment.fileName || '';
  const cached = key ? imgCache.get(key) : null;

  if (cached && !claimedImages.has(cached)) {
    claimedImages.add(cached);
    cached.alt = attachment.fileName || 'image';
    return cached;
  }

  const img = el('img', {
    class: 'att-image',
    alt: attachment.fileName || 'image',
    loading: 'lazy',
    onClick: (event) => {
      event.stopPropagation();
      openLightbox(event.currentTarget.src);
    },
  });

  if (key) {
    if (imgCache.size >= IMG_CACHE_LIMIT) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = imgCache.keys().next().value;
      if (oldest !== undefined) imgCache.delete(oldest);
    }
    imgCache.set(key, img);
    claimedImages.add(img);
  }

  resolveSrc(attachment).then((url) => {
    if (url && img.src !== url) img.src = url;
  });
  return img;
}

function editingNode(message) {
  const input = el('textarea', { rows: '2', style: { width: '100%' } });
  input.value = message.text || '';
  const save = async () => {
    const text = input.value.trim();
    state.editing = null;
    if (text && text !== message.text) {
      await call(() => api.messages.edit(message.chatID, message.id, text), { context: 'edit message' });
      upsertMessage(message.chatID, { ...message, text, editedTimestamp: new Date().toISOString() });
      toast('Message edited', 'success', 1500);
    } else {
      onMessageUpserted();
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      save();
    }
    if (event.key === 'Escape') {
      state.editing = null;
      onMessageUpserted();
    }
  });
  setTimeout(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, 0);
  return el('div', { class: 'msg-bubble' }, input);
}

/**
 * The context menu, for the things that are not one click.
 *
 * Delete and Hide are deliberately not here: they are on the message row's
 * hover actions now. What is left is the slower, rarer list - replying,
 * copying, editing, and the local-only delete that needs a second thought.
 */
/**
 * The context menu, for the things that are not one click.
 *
 * The trash on the message row is the local delete, which only hides the
 * message here. This Delete is the real one: it goes to Beeper, everyone else
 * sees it go, and on most networks it cannot be undone. So it stays in the
 * menu, where reaching it is a decision rather than a stray click, and only
 * appears on your own messages.
 */
export function messageMenuItems(anchor, message) {
  const canEdit = message.isSender && !message.isDeleted;
  return [
    { label: 'Reply', onSelect: () => setReplyTo(message) },
    { label: 'React', onSelect: () => openEmojiPicker(anchor, (e) => toggleReaction(message, e)) },
    { label: 'Copy text', onSelect: () => copyText(message.text || '') },
    canEdit ? { label: 'Edit', onSelect: () => { state.editing = message.id; onMessageUpserted(); } } : null,
    canEdit
      ? { label: 'Delete for everyone', danger: true, onSelect: () => deleteMessage(message) }
      : null,
    {
      label: 'Copy message ID',
      onSelect: () => copyText(message.id),
    },
  ].filter(Boolean);
}

function openMessageMenu(anchor, message) {
  openPopover(anchor, messageMenuItems(anchor, message));
}

/**
 * Fold a message away, or bring it back, and remember the choice.
 *
 * Purely local: Beeper is not told, so the message stays where it is for every
 * other device and for everyone else in the chat. The setting is written
 * straight through rather than on a debounce, because a fold is rare and a
 * fold that is lost on a crash is the one that annoys.
 */
async function setLocalHidden(message, hidden) {
  if (!message?.id) return;
  setMessageHidden(message.id, hidden);
  onMessageUpserted();
  const saved = await call(() => api.settings.set({ hiddenMessages: hiddenList() }), {
    context: 'remember hidden message',
  });
  if (saved === null) {
    // The fold is on screen but would not survive a restart; say so rather
    // than leaving the user to discover it later.
    toast('Hidden for now, but this could not be saved', 'error');
    return;
  }
  toast(hidden ? 'Message hidden' : 'Message shown', 'success', 1400);
}

/**
 * Take a message out of this app's thread, for good.
 *
 * One-way on purpose: there is no restore anywhere in the UI, so the choice is
 * gone once made. Beeper still has the message, so no other device and nobody
 * else in the chat is affected - but here it is simply not drawn, and the only
 * way to get it back is to clear this app's settings.
 */
async function deleteOnThisDevice(message) {
  if (!message?.id) return;
  setMessageDeleted(message.id, true);
  onMessageUpserted();
  const saved = await call(() => api.settings.set({ deletedMessages: deletedList() }), {
    context: 'remember deleted message',
  });
  if (saved === null) {
    // It left the thread, but a restart would bring it back. Say so rather than
    // letting the user believe a delete that did not happen.
    toast('Removed for now, but this could not be saved', 'error');
    return;
  }
  toast('Deleted on this device', 'success', 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'success', 1400);
  } catch {
    toast('Could not copy to clipboard', 'error');
  }
}

async function deleteMessage(message) {
  const ok = await confirmDialog({
    title: 'Delete message?',
    message: 'This removes the message on Beeper and on the network where supported.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const res = await call(() => api.messages.remove(message.chatID, message.id), {
    context: 'delete message',
  });
  if (res !== null) {
    removeMessage(message.chatID, message.id);
    toast('Message deleted', 'success', 1600);
  }
}

async function toggleReaction(message, key) {
  if (!key) return;
  const selfID = selfUserIDFor(message.accountID);
  const existing = (message.reactions || []).find((r) => (r.key ?? r.reactionKey) === key);
  const mine = existing?.isSelf ?? (existing?.userIDs || []).includes(selfID);

  const res = await call(
    () => (mine ? api.messages.unreact(message.chatID, message.id, key) : api.messages.react(message.chatID, message.id, key)),
    { context: 'reaction' },
  );
  if (res === null) return;

  // Let the authoritative message arrive over the event stream; nudge locally for snappiness.
  const reactions = [...(message.reactions || [])];
  if (mine) {
    const idx = reactions.findIndex((r) => (r.key ?? r.reactionKey) === key);
    if (idx >= 0) {
      const updated = { ...reactions[idx] };
      updated.count = Math.max(0, (updated.count ?? 1) - 1);
      updated.userIDs = (updated.userIDs || []).filter((id) => id !== selfID);
      if (!updated.count) reactions.splice(idx, 1);
      else reactions[idx] = updated;
    }
  } else {
    const idx = reactions.findIndex((r) => (r.key ?? r.reactionKey) === key);
    if (idx >= 0) {
      reactions[idx] = { ...reactions[idx], count: (reactions[idx].count ?? 1) + 1 };
    } else {
      reactions.push({ key, count: 1, userIDs: selfID ? [selfID] : [], isSelf: true });
    }
  }
  upsertMessage(message.chatID, { ...message, reactions });
}

// ---------------------------------------------------------------------------
// History pagination
// ---------------------------------------------------------------------------

/**
 * The messages worth drawing, oldest first.
 *
 * Beeper returns reactions as their *own* records: `type: "REACTION"`,
 * `isHidden: true`, carrying a `linkedMessageID` to the message they belong to.
 * The reaction itself is already shown as a chip on that message, from the
 * message's own `reactions` array - so drawing these records as rows duplicated
 * the message text and made a reacted-to message look like it had been sent
 * twice. The records stay in state (they are what the API sent) but are never
 * drawn as a bubble, and never used as a pagination cursor.
 *
 * Messages deleted on this device are dropped here too, which is what makes them
 * disappear for good. The record stays in `state.messages` - Beeper still has
 * it, and every other device still shows it - so this is a filter on what gets
 * drawn, not a deletion of the message we were sent.
 */
export function renderableMessages(chatID) {
  return (state.messages.get(chatID) || []).filter(
    (m) => !m.isHidden && !isMessageDeleted(m.id),
  );
}

async function loadOlder() {
  if (!hasMore || loadingOlder) return;
  const chatID = state.activeChatID;
  // The pagination cursor must be a real message, not a reaction record.
  const oldest = renderableMessages(chatID)[0];
  if (!oldest) return;

  loadingOlder = true;
  const listEl = $('#message-list');
  const previousHeight = listEl.scrollHeight;

  // Read from disk. No cursor round trip, so scrolling back stays instant
  // however far back it goes, and works with Beeper switched off.
  const page = await call(
    () => api.history.page(chatID, { before: oldest.id, limit: 50 }),
    { context: 'older messages' },
  );
  loadingOlder = false;
  if (!page || state.activeChatID !== chatID) return;

  hasMore = Boolean(page.hasMore);
  for (const message of page.messages || []) upsertMessage(chatID, message);

  onMessageUpserted();
  // Keep the viewport anchored to the message the user was looking at.
  listEl.scrollTop = listEl.scrollHeight - previousHeight;
}

function scrollToBottom() {
  const listEl = $('#message-list');
  atBottom = true;
  // Images, avatars and fonts decode after this frame and grow the list, and
  // Chrome's scroll anchoring shifts scrollTop to compensate. Hold the settle
  // window open long enough to outlast that; real input closes it at once.
  settleUntil = Date.now() + 1500;

  const pin = () => {
    listEl.scrollTop = listEl.scrollHeight;
  };

  pin();

  // Re-pin until the content height stops moving.
  let quiet = 0;
  let lastHeight = listEl.scrollHeight;
  const tick = () => {
    if (Date.now() >= settleUntil) return;
    pin();
    const height = listEl.scrollHeight;
    quiet = height === lastHeight ? quiet + 1 : 0;
    lastHeight = height;
    if (quiet < 4) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Anything still decoding pushes the newest message further down.
  for (const img of listEl.querySelectorAll('img')) {
    if (img.complete) continue;
    const once = () => {
      img.removeEventListener('load', once);
      img.removeEventListener('error', once);
      pin();
    };
    img.addEventListener('load', once);
    img.addEventListener('error', once);
  }
}

function scrollToMessage(messageID) {
  requestAnimationFrame(() => {
    const node = document.querySelector(`[data-message-id="${CSS.escape(messageID)}"]`);
    if (node) {
      node.scrollIntoView({ block: 'center' });
      node.animate(
        [{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'transparent' }],
        { duration: 1200 },
      );
    } else {
      scrollToBottom();
    }
  });
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function setReplyTo(message) {
  state.replyTo = { id: message.id, text: message.text || message.type || '' };
  updateReplyPreview();
  $('#composer').focus();
}

function updateReplyPreview() {
  const box = $('#reply-preview');
  if (!state.replyTo) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('#reply-preview-text').textContent = `Replying to: ${String(state.replyTo.text).slice(0, 120)}`;
}

async function pickAttachments() {
  const picked = await call(() => api.assets.pick(), { context: 'pick attachment', fallback: [] });
  if (!picked?.length) return;

  for (const file of picked) {
    try {
      const upload = await call(() => api.assets.upload(file.path), { context: 'upload', fallback: null });
      if (upload?.uploadID) {
        pendingAttachments.push({
          uploadID: upload.uploadID,
          mimeType: upload.mimeType,
          fileName: upload.fileName || file.name,
        });
        renderAttachments();
      }
    } catch (err) {
      toast(`Upload failed: ${err.message}`, 'error');
    }
  }
}

/**
 * Upload whatever images were pasted into the composer.
 *
 * The bytes go over as a Uint8Array rather than a path, because a pasted
 * screenshot has never been a file - there is nothing on disk to hand back.
 */
async function attachPastedImages(dataTransfer) {
  const { images, rejected } = await pastedImages(dataTransfer);

  for (const skip of rejected) {
    toast(
      `${skip.fileName} is ${(skip.bytes / 1048576).toFixed(1)} MB, over the ${MAX_PASTE_MB} MB paste limit`,
      'error',
    );
  }
  if (!images.length) return;

  let done = 0;
  for (const image of images) {
    try {
      const upload = await call(() => api.assets.uploadBytes(image), {
        context: 'upload pasted image',
        fallback: null,
      });
      if (upload?.uploadID) {
        pendingAttachments.push({
          uploadID: upload.uploadID,
          mimeType: upload.mimeType || image.mimeType,
          fileName: upload.fileName || image.fileName,
        });
        renderAttachments();
        done += 1;
      }
    } catch (err) {
      toast(`Upload failed: ${err.message}`, 'error');
    }
  }

  if (done) {
    toast(`Attached ${done} pasted image${done > 1 ? 's' : ''}`, 'success', 1500);
    $('#composer').focus();
  }
}

function renderAttachments() {
  const wrap = $('#attachment-chips');
  clear(wrap);
  pendingAttachments.forEach((attachment, index) => {
    wrap.append(
      el(
        'span',
        { class: 'att-chip' },
        el('span', { text: `${attachmentIcon(attachment)} ${attachment.fileName}` }),
        el('button', {
          text: '✕',
          title: 'Remove',
          onClick: () => {
            pendingAttachments.splice(index, 1);
            renderAttachments();
          },
        }),
      ),
    );
  });
}

async function sendCurrent() {
  const composer = $('#composer');
  const chat = currentChat;
  if (!chat) return;

  const text = composer.value.trim();
  if (!text && !pendingAttachments.length) return;
  if (chat.isReadOnly) {
    toast('This chat is read-only on Beeper', 'error');
    return;
  }

  composer.value = '';

  const replyToMessageID = state.replyTo?.id;
  state.replyTo = null;
  updateReplyPreview();

  // Beeper accepts a single attachment per send, so batch sequentially.
  const queue = pendingAttachments.length
    ? [
        { text: text || undefined, attachment: pendingAttachments[0] },
        ...pendingAttachments.slice(1).map((a) => ({ attachment: a })),
      ]
    : [{ text }];
  pendingAttachments = [];
  renderAttachments();

  for (const payload of queue) {
    const body = { ...payload };
    if (replyToMessageID && payload === queue[0]) body.replyToMessageID = replyToMessageID;

    // Show the message *before* the round trip, not after it.
    //
    // Beeper can deliver the authoritative copy over the WebSocket while we are
    // still awaiting the response - the Signal bridge does exactly this. A
    // placeholder inserted afterwards is too late to be absorbed, so the real
    // message landed beside it and the placeholder sat on "sending" forever.
    const txnID = `~txn:local:${Date.now()}:${(txnSeq += 1)}`;
    upsertMessage(chat.id, {
      id: txnID,
      chatID: chat.id,
      accountID: chat.accountID,
      senderID: selfUserIDFor(chat.accountID) || 'me',
      senderName: 'You',
      timestamp: new Date().toISOString(),
      sortKey: String(Date.now()),
      type: 'TEXT',
      text: payload.text || '',
      isSender: true,
      sendStatus: 'pending',
      attachments: [],
    });

    const res = await call(() => api.messages.send(chat.id, body), {
      context: 'send message',
      throwOnError: true,
    }).catch((err) => ({ __error: err }));

    if (res?.__error) {
      // Mark the bubble rather than leaving it spinning, and put the text back.
      upsertMessage(chat.id, { id: txnID, sendStatus: 'failed' });
      toast(`Could not send: ${res.__error.message}`, 'error', 5000);
      if (payload.text) {
        composer.value = payload.text;
      }
      break;
    }

    // Adopt the id Beeper will use, so the authoritative message merges into
    // this bubble. A no-op when the echo already absorbed the placeholder.
    if (res?.pendingMessageID) rekeyMessage(chat.id, txnID, res.pendingMessageID);
  }
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

/** Applies a `message.upserted` frame for the open chat. */
export function applyMessageEvent(frame) {
  const chatID = frame.chatID;
  if (chatID !== state.activeChatID) return;
  for (const entry of frame.entries || []) {
    if (!entry?.id) continue;
    const message = { ...entry, chatID };
    upsertMessage(chatID, message);
    // Write straight through to the local store. Without this the store only
    // learns about a message when some backfill happens to walk over it, and
    // the newest message in the app would be the one most likely to be missing
    // from its own history.
    api.history.upsert(chatID, message);
  }
}

export function currentChatID() {
  return state.activeChatID;
}
