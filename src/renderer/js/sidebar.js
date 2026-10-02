/** Sidebar: network badges, chat list, filters, and unified search. */

import { $, el, clear, listTime, initials, hueFor, debounce, renderRichText, escapeHtml } from './util.js';
import { api, call, callOk, FAILED } from './api.js';
import {
  state,
  bus,
  chatList,
  chatPreviewText,
  upsertChat,
  isNoteToSelf,
  noteLabel,
  networkMeta,
} from './state.js';
import { toast, openLightbox } from './ui.js';
import { networkIconMarkup, badgeBackground } from './network-icons.js';

let onSelectChat = () => {};
let onSelectView = () => {};
let searchToken = 0;
let searchMode = 'chats'; // 'chats' | 'messages'
let searchResults = { chats: [], messages: [] };

export function initSidebar(handlers) {
  onSelectChat = handlers.onSelectChat || onSelectChat;
  onSelectView = handlers.onSelectView || onSelectView;

  $('#filter-row').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    // A chip is a filter, so it always lands you back in a chat list view.
    state.view = 'chat';
    state.filter = chip.dataset.filter;
    onSelectView('chat');
    renderViewChrome();
    renderChats();
  });

  const input = $('#search-input');
  const run = debounce(() => {
    state.searchQuery = input.value.trim();
    runSearch();
  }, 320);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      state.searchQuery = '';
      runSearch();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  });

  $('#search-scope').addEventListener('change', (event) => {
    state.searchScope = event.target.value;
    runSearch();
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-external]');
    if (link) {
      event.preventDefault();
      api.shell.openExternal(link.dataset.external);
    }
  });

  bus.on('chats:changed', () => {
    if (!state.searchQuery) renderChats();
  });
}

export function focusSearch() {
  const input = $('#search-input');
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// The "Inbox" view switcher
// ---------------------------------------------------------------------------

/**
 * The views the header menu offers, in the order Beeper lists them.
 *
 * All three are filters over the same chat list. Beeper also lists a "Voice
 * calls" entry above the chats, but Beeper's Desktop API has no calls endpoint.
 * The v1 spec is chats, messages, contacts, assets, search, bridges, login and
 * setup, and nothing call-related, so there is nothing to put behind it.
 */
export const VIEWS = [
  { id: 'inbox', label: 'Inbox', filter: 'all' },
  { id: 'unread', label: 'Unread', filter: 'unread' },
  { id: 'archive', label: 'Archive', filter: 'archive' },
];

/** The view the header should currently be showing. */
export function currentView() {
  if (state.filter === 'unread') return 'unread';
  if (state.filter === 'archive') return 'archive';
  return 'inbox';
}

/** Keeps the header label, the filter chips and the list in agreement. */
export function renderViewChrome() {
  const active = currentView();
  const label = $('#inbox-label');
  if (label) label.textContent = VIEWS.find((v) => v.id === active)?.label || 'Inbox';
  const match = VIEWS.find((v) => v.id === active);
  for (const chip of document.querySelectorAll('#filter-row .chip')) {
    chip.classList.toggle('is-active', Boolean(match) && chip.dataset.filter === match.filter);
  }
}

/** Switch to a view by id. */
export function setView(id) {
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  state.filter = view.filter;
  state.view = 'chat';
  onSelectView('chat');
  renderViewChrome();
}

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------

export function renderChats() {
  const list = $('#chat-list');
  if (state.searchQuery) return; // search view owns the pane

  clear(list);

  const all = chatList().filter((chat) => {
    if (chat.mergedIntoChatID) return false; // hidden inside a merged chat
    switch (state.filter) {
      case 'unread':
        return (chat.unreadCount || 0) > 0;
      case 'archive':
        return chat.isArchived;
      case 'primary':
        return !chat.isArchived && !chat.isLowPriority;
      default:
        return !chat.isArchived;
    }
  });

  // Beeper pins the personal note chat above everything else.
  const notes = all.filter(isNoteToSelf);
  const rest = all.filter((chat) => !isNoteToSelf(chat));

  if (!all.length) {
    list.append(
      el('div', {
        class: 'empty-note',
        text: state.chats.size ? 'Nothing in this view.' : 'No chats loaded yet.',
      }),
    );
    return;
  }

  // Beeper's order: the personal note chats, then the rest. All of these are
  // ordinary rows - the pinning is position, not size.
  for (const note of notes) list.append(noteItem(note));

  // Pinned first, then most recent activity.
  rest.sort((a, b) => {
    if (Boolean(b.isPinned) !== Boolean(a.isPinned)) return b.isPinned ? 1 : -1;
    return new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime();
  });

  for (const chat of rest) list.append(chatItem(chat));
}

/**
 * A note-to-self chat.
 *
 * Beeper pins these above the rest of the list; pinning is about *position*,
 * not prominence, so this is an ordinary `.chat-item` row in every respect -
 * same size, same padding, same preview line. The only differences are the
 * pin flag that explains why it is at the top, and an avatar that opens the
 * chat rather than the image viewer (it is your own profile picture, not a
 * photo in a conversation).
 */
function noteItem(chat) {
  const isActive = chat.id === state.activeChatID;
  return el(
    'div',
    {
      class: `chat-item is-note${isActive ? ' is-active' : ''}`,
      role: 'listitem',
      dataset: { chatId: chat.id, note: '1' },
      onClick: () => onSelectChat(chat.id),
    },
    el(
      'div',
      { class: 'avatar-wrap' },
      avatarNode(chat, chat.title, '', { lightbox: false }),
      networkBadge(chat),
    ),
    el(
      'div',
      { class: 'chat-item-body' },
      el(
        'div',
        { class: 'chat-item-top' },
        el('div', { class: 'chat-item-title', text: noteLabel(chat) }),
        el('div', { class: 'chat-item-time', text: listTime(chat.lastActivity) }),
      ),
      el(
        'div',
        { class: 'chat-item-bottom' },
        el('div', { class: 'chat-flags', text: '📌' }),
        el('div', { class: 'chat-item-preview', text: chatPreviewText(chat) }),
        chat.unreadCount > 0
          ? el('div', { class: 'chat-unread', text: chat.unreadCount > 99 ? '99+' : String(chat.unreadCount) })
          : null,
      ),
    ),
    rowArchiveButton(chat),
  );
}

/**
 * The network badge on an avatar: a brand glyph when we have artwork for the
 * network, otherwise the monogram. Both sit on the same brand-coloured disc so
 * the list reads the same either way, except for self-coloured marks like
 * Google Voice, which supply their own disc so the artwork stays visible.
 */
export function networkBadge(source, { size = 11 } = {}) {
  const meta = networkMeta(source);
  const icon = networkIconMarkup(meta.name, { size });
  return el('span', {
    // `is-mono` widens the badge into a pill; a glyph keeps the true circle.
    class: `net-badge${icon ? '' : ' is-mono'}`,
    style: { background: badgeBackground(meta.name) || meta.color },
    title: meta.name,
    dataset: { net: meta.name },
    ...(icon ? { html: icon } : { text: meta.abbr }),
  });
}

/**
 * Hover action revealed on every row. The click stops propagating so archiving
 * from the list does not also open the chat you are archiving.
 */
function rowArchiveButton(chat) {
  const restoring = Boolean(chat.isArchived);
  const label = restoring ? 'Move back to inbox' : 'Archive chat';

  return el('button', {
    class: 'row-action',
    type: 'button',
    'aria-label': label,
    dataset: { tip: label },
    text: restoring ? '📥' : '🗄',
    onClick: (event) => {
      event.stopPropagation();
      archiveFromList(chat);
    },
  });
}

async function archiveFromList(chat) {
  const restoring = Boolean(chat.isArchived);
  const result = await callOk(() => api.chats.archive(chat.id, !restoring), {
    context: restoring ? 'unarchive' : 'archive',
  });
  if (result === FAILED) return;

  state.chats.set(chat.id, { ...chat, isArchived: !restoring });
  toast(restoring ? 'Moved back to inbox' : 'Chat archived', 'success', 1800);

  // Archiving the chat you are reading closes it, same as the header button.
  if (state.activeChatID === chat.id) bus.emit('chat:close');
  else renderChats();
}

function chatItem(chat) {
  const isActive = chat.id === state.activeChatID;
  const preview = chatPreviewText(chat);
  const flags = [];

  if (chat.isMuted) flags.push('🔕');
  if (chat.draft?.text) flags.push('✏️');

  return el(
    'div',
    {
      class: `chat-item${isActive ? ' is-active' : ''}`,
      role: 'listitem',
      dataset: { chatId: chat.id },
      onClick: () => onSelectChat(chat.id),
    },
    el(
      'div',
      { class: 'avatar-wrap' },
      avatarNode(chat, chat.title),
      networkBadge(chat),
    ),
    el(
      'div',
      { class: 'chat-item-body' },
      el(
        'div',
        { class: 'chat-item-top' },
        el('div', { class: 'chat-item-title', text: chat.title || 'Untitled chat' }),
        el('div', { class: 'chat-item-time', text: listTime(chat.lastActivity) }),
      ),
      el(
        'div',
        { class: 'chat-item-bottom' },
        flags.length ? el('div', { class: 'chat-flags', text: flags.join(' ') }) : null,
        el('div', {
          class: 'chat-item-preview',
          text: chat.draft?.text ? `Draft: ${chat.draft.text}` : preview,
        }),
        chat.unreadCount > 0
          ? el('div', { class: 'chat-unread', text: chat.unreadCount > 99 ? '99+' : String(chat.unreadCount) })
          : null,
      ),
    ),
    rowArchiveButton(chat),
  );
}

/**
 * An avatar for a chat, contact or message.
 *
 * `lightbox: false` leaves the click to the row. A note-to-self row needs that:
 * its avatar is your own profile picture, so opening the full-screen image
 * viewer for it is wrong - clicking the row should just open the note.
 */
export function avatarNode(source, name, size = '', { lightbox = true } = {}) {
  const label = name || source?.title || '?';
  const imgURL = source?.imgURL;
  const hue = hueFor(source?.id || label);
  const node = el('div', {
    class: `avatar ${size}`.trim(),
    style: { background: `hsl(${hue} 45% 32%)` },
    text: initials(label),
  });

  if (imgURL) {
    call(() => api.assets.resolve({ srcURL: imgURL, id: imgURL }), {
      context: 'avatar',
      fallback: null,
    })
      .then((data) => data?.url || null)
      .then((url) => {
        if (!url) return;
        const img = el('img', {
          src: url,
          alt: '',
          ...(lightbox
            ? {
                onClick: (e) => {
                  e.stopPropagation();
                  openLightbox(url);
                },
              }
            : {}),
        });
        clear(node);
        node.append(img);
      });
  }
  return node;
}

export function renderAccountBadges() {
  const wrap = $('#account-badges');
  clear(wrap);
  for (const account of state.accounts) {
    wrap.append(
      el('span', {
        class: 'network-badge',
        title: `${account.user?.fullName || account.accountID} · ${account.status}`,
        text: (account.network || account.bridge?.id || account.accountID).slice(0, 10),
      }),
    );
  }
}

export function setLiveStatus(status) {
  const node = $('#live-status');
  const labels = {
    ready: 'live',
    connected: 'live',
    connecting: 'connecting…',
    reconnecting: 'reconnecting…',
    disconnected: 'offline',
    error: 'connection error',
    unauthenticated: 'signed out',
    idle: 'offline',
  };
  node.dataset.state = status;
  node.textContent = labels[status] || status;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function runSearch() {
  const list = $('#chat-list');
  const token = ++searchToken;

  if (!state.searchQuery) {
    searchMode = 'chats';
    searchResults = { chats: [], messages: [] };
    renderChats();
    return;
  }

  const query = state.searchQuery;
  const wantMessages = state.searchScope !== 'chats';
  const wantChats = state.searchScope !== 'messages';

  clear(list);
  list.append(el('div', { class: 'search-loading', text: 'Searching…' }));

  const [chats, messages] = await Promise.all([
    wantChats
      ? call(() => api.chats.search({ query, limit: 50 }), { context: 'chat search', fallback: null })
      : null,
    wantMessages
      // 20 is the ceiling Beeper accepts for message search; asking for more is a 400.
      ? call(() => api.messages.search({ query, limit: 20 }), { context: 'message search', fallback: null })
      : null,
  ]);

  if (token !== searchToken) return; // a newer search superseded this one

  searchResults = { chats: chats?.items || [], messages: messages?.items || [] };
  searchMode = wantMessages ? 'messages' : 'chats';

  if (wantChats) for (const chat of searchResults.chats) upsertChat(chat);
  renderSearchResults(query);
}

function renderSearchResults(query) {
  const list = $('#chat-list');
  clear(list);

  const { chats, messages } = searchResults;

  list.append(
    el('div', {
      class: 'search-summary',
      text: `${chats.length} chat${chats.length === 1 ? '' : 's'}${
        searchMode === 'messages' ? ` · ${messages.length} message${messages.length === 1 ? '' : 's'}` : ''
      } for “${query}”`,
    }),
  );

  if (chats.length) {
    list.append(el('div', { class: 'search-summary', text: 'Chats' }));
    for (const chat of chats) list.append(chatItem(chat));
  }

  if (searchMode === 'messages' && messages.length) {
    list.append(el('div', { class: 'search-summary', text: 'Messages' }));
    for (const message of messages) list.append(messageHit(message));
  }

  if (!chats.length && !messages.length) {
    list.append(
      el('div', {
        class: 'empty-note',
        text: 'No matches. Beeper only searches message history it has indexed for your bridges.',
      }),
    );
  }
}

function messageHit(message) {
  const chat = state.chats.get(message.chatID);
  const text = message.text || message.type || 'message';
  return el(
    'div',
    {
      class: 'result-item',
      onClick: () => onSelectChat(message.chatID, { focusMessageID: message.id }),
    },
    avatarNode(chat, chat?.title || message.senderName || '?', 'sm'),
    el(
      'div',
      { class: 'result-item-body message-hit' },
      el('div', { class: 'result-item-sub', text: `${chat?.title || 'Chat'} · ${message.senderName || 'Unknown'}` }),
      el('div', {
        class: 'result-item-title',
        html: highlight(text.slice(0, 140), state.searchQuery),
      }),
    ),
  );
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const pattern = query
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (!pattern) return safe;
  try {
    return safe.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
  } catch {
    return safe;
  }
}
