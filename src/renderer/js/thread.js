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
} from './state.js';
import { toast, confirmDialog, openEmojiPicker, openPopover, openLightbox } from './ui.js';
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
const renderedNodes = new Map();

export function initThread() {
  const composer = $('#composer');

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

  // Latest page.
  const page = await call(() => api.messages.list(chatID, { limit: 50 }), {
    context: 'messages',
  });

  clear(listEl);
  renderedNodes.clear();

  if (!page) {
    listEl.append(
      el('div', { class: 'empty-note', text: 'Could not load messages. Beeper may still be indexing this chat.' }),
    );
    return;
  }

  hasMore = Boolean(page.hasMore);
  const items = page.items || [];
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

function onMessageUpserted() {
  const messages = renderableMessages(state.activeChatID);
  if (!messages.length) return;

  const listEl = $('#message-list');
  const stick = atBottom;
  const rebuilt = [];

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

  renderSeenLine();
  if (stick) scrollToBottom();
  if (window.document.hasFocus() && window.document.visibilityState === 'visible') markRead();
}

function dayKey(value) {
  const date = parseTs(value);
  return date ? date.toDateString() : '';
}

function messageNode(message, previous) {
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

  const hoverActions = el('div', { class: 'msg-hover-actions' });
  hoverActions.append(
    el('button', {
      class: 'icon-btn tiny-btn',
      title: 'React',
      text: '😊',
      onClick: (event) => {
        event.stopPropagation();
        openEmojiPicker(event.currentTarget, (emoji) => toggleReaction(message, emoji));
      },
    }),
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
    hoverActions,
  );
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
    const isImage = attachment.type === 'img' || /^image\//i.test(attachment.mimeType || '');
    if (isImage) {
      const img = el('img', {
        class: 'att-image',
        alt: attachment.fileName || 'image',
        loading: 'lazy',
        onClick: (event) => {
          event.stopPropagation();
          openLightbox(event.currentTarget.src);
        },
      });
      resolveSrc(attachment).then((url) => {
        if (url) img.src = url;
      });
      wrap.append(img);
    } else {
      const node = el(
        'a',
        {
          class: 'att-file',
          href: '#',
          onClick: async (event) => {
            event.preventDefault();
            const url = await resolveSrc(attachment);
            if (url) api.shell.openExternal(url);
          },
        },
        el('span', { text: '📎' }),
        el('span', { class: 'att-name', text: attachment.fileName || 'Attachment' }),
        el('span', { class: 'muted tiny', text: fileSize(attachment.fileSize) }),
      );
      wrap.append(node);
    }
  }
  return wrap;
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

function openMessageMenu(anchor, message) {
  const canEdit = message.isSender && !message.isDeleted;
  const canDelete = message.isSender && !message.isDeleted;
  openPopover(anchor, [
    { label: 'Reply', onSelect: () => setReplyTo(message) },
    { label: 'React', onSelect: () => openEmojiPicker(anchor, (e) => toggleReaction(message, e)) },
    { label: 'Copy text', onSelect: () => copyText(message.text || '') },
    canEdit ? { label: 'Edit', onSelect: () => { state.editing = message.id; onMessageUpserted(); } } : null,
    canDelete
      ? { label: 'Delete', danger: true, onSelect: () => deleteMessage(message) }
      : null,
    {
      label: 'Copy message ID',
      onSelect: () => copyText(message.id),
    },
  ]);
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
 */
function renderableMessages(chatID) {
  return (state.messages.get(chatID) || []).filter((m) => !m.isHidden);
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

  const page = await call(
    () => api.messages.list(chatID, { cursor: oldest.id, direction: 'before', limit: 50 }),
    { context: 'older messages' },
  );
  loadingOlder = false;
  if (!page || state.activeChatID !== chatID) return;

  hasMore = Boolean(page.hasMore);
  for (const message of page.items || []) upsertMessage(chatID, message);

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

function renderAttachments() {
  const wrap = $('#attachment-chips');
  clear(wrap);
  pendingAttachments.forEach((attachment, index) => {
    wrap.append(
      el(
        'span',
        { class: 'att-chip' },
        el('span', { text: `📎 ${attachment.fileName}` }),
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
    if (entry?.id) upsertMessage(chatID, { ...entry, chatID });
  }
}

export function currentChatID() {
  return state.activeChatID;
}
