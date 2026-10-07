/** Sidebar: network badges, chat list, filters, and unified search. */

import { $, el, clear, listTime, initials, hueFor, debounce, renderRichText, escapeHtml } from './util.js';
import { api, call } from './api.js';
import {
  state,
  bus,
  chatList,
  chatPreviewText,
  upsertChat,
  isNoteToSelf,
  noteLabel,
  networkMeta,
  isPinned,
  isArchived,
  localStateVersion,
} from './state.js';
import { toast, openLightbox } from './ui.js';
import { setArchived } from './chat-actions.js';
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

/**
 * chatID -> { node, signature } for the row currently on screen.
 *
 * The list used to be cleared and rebuilt on every render, and that is visible:
 * `clear(list)` destroys every avatar <img>, and avatarNode then repaints each
 * one from initials only once an assets:resolve round trip comes back. Every
 * avatar in the inbox therefore blinked out and back whenever anything
 * re-rendered the list - a chat event, or the inbox timer - which reads as the
 * icons flashing rather than as a repaint.
 *
 * It also cost one IPC call per chat with a picture, per render, on the
 * renderer's main thread.
 *
 * So rows are kept and only rebuilt when what they draw changes. The signature
 * covers every input to the row, including the local-only state (pins,
 * archives, hidden and deleted messages) that lives outside the chat object and
 * would otherwise leave a deleted message sitting in a preview line.
 */
const rows = new Map();

function rowSignature(chat, kind) {
  return [
    kind,
    localStateVersion(),
    chat.id === state.activeChatID ? 1 : 0,
    isUnread(chat) ? 1 : 0,
    chat.unreadCount || 0,
    chat.title || '',
    chat.imgURL || '',
    chat.network || '',
    chat.lastActivity || '',
    chat.draft?.text || '',
    rowFlags(chat).join(''),
    chatPreviewText(chat),
  ].join('|');
}

/** Move `node` into position `index`, doing nothing if it is already there. */
function place(list, node, index) {
  if (list.children[index] === node) return false;
  list.insertBefore(node, list.children[index] || null);
  return true;
}

export function renderChats() {
  const list = $('#chat-list');
  if (state.searchQuery) return; // search view owns the pane

  const all = chatList().filter((chat) => {
    if (chat.mergedIntoChatID) return false; // hidden inside a merged chat
    switch (state.filter) {
      case 'unread':
        return (chat.unreadCount || 0) > 0;
      case 'archive':
        return isArchived(chat);
      case 'primary':
        return !isArchived(chat) && !chat.isLowPriority;
      default:
        return !isArchived(chat);
    }
  });

  if (!all.length) {
    clear(list);
    rows.clear();
    list.append(
      el('div', {
        class: 'empty-note',
        text: state.chats.size ? 'Nothing in this view.' : 'No chats loaded yet.',
      }),
    );
    return;
  }

  // Beeper's order: pinned first, then most recent activity. The note-to-self
  // chats count as pinned, which is what puts them at the top by default and
  // what lets an explicit unpin send them back down with the ordinary chats.
  // `isPinned` also covers pins the user set in this app, not just the ones
  // Beeper reports.
  const ordered = all.slice();
  ordered.sort((a, b) => {
    if (isPinned(b) !== isPinned(a)) return isPinned(b) ? 1 : -1;
    return new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime();
  });

  const next = [];
  for (const chat of ordered) {
    const kind = isNoteToSelf(chat) ? 'note' : 'chat';
    const signature = rowSignature(chat, kind);
    const entry = rows.get(chat.id);
    if (entry && entry.signature === signature) {
      next.push(entry.node);
      continue;
    }
    const node = kind === 'note' ? noteItem(chat) : chatItem(chat);
    rows.set(chat.id, { node, signature });
    next.push(node);
  }

  next.forEach((node, i) => place(list, node, i));

  // Anything left over is a chat that left this view, or the empty-note.
  while (list.children.length > next.length) list.removeChild(list.lastChild);

  const live = new Set(next);
  for (const [id, entry] of [...rows]) {
    if (!live.has(entry.node)) rows.delete(id);
  }
}

/** The pin, mute and draft glyphs in a row's corner. */
function rowFlags(chat) {
  const flags = [];
  if (isPinned(chat)) flags.push('📌');
  if (chat.isMuted) flags.push('🔕');
  if (chat.draft?.text) flags.push('✏️');
  return flags;
}

/**
 * Does this row have something the user has not read yet?
 *
 * Beeper reports it as a count, so the count is the whole test. The row class
 * and the badge both read this one predicate on purpose: styling the row from
 * a second, separately-written condition is how you end up with a tinted bold
 * row next to a badge that says the chat is read, or the reverse. One source,
 * two consequences.
 */
function isUnread(chat) {
  return Number(chat?.unreadCount || 0) > 0;
}

/** The unread count pill, or nothing at all for a chat that is read. */
function unreadBadge(chat) {
  if (!isUnread(chat)) return null;
  const count = Number(chat.unreadCount);
  return el('div', { class: 'chat-unread', text: count > 99 ? '99+' : String(count) });
}

/**
 * A note-to-self chat.
 *
 * Beeper pins these above the rest of the list; pinning is about *position*,
 * not prominence, so this is an ordinary `.chat-item` row in every respect -
 * same size, same padding, same preview line. The only differences are the
 * label ("Note" rather than the contact name) and an avatar that opens the chat
 * rather than the image viewer, since it is your own profile picture and not a
 * photo in a conversation.
 *
 * The pin flag is deliberately *not* hard-coded here. It used to be, which is
 * what made unpinning a note chat look broken: the header button flipped to off
 * and the row kept its paperclip forever. Note chats are pinned by default
 * because isPinned() treats them that way, so the flag reads the same state the
 * sort does and an explicit unpin is visible and effective.
 */
function noteItem(chat) {
  const isActive = chat.id === state.activeChatID;
  const flags = rowFlags(chat);
  return el(
    'div',
    {
      class: `chat-item is-note${isActive ? ' is-active' : ''}${isUnread(chat) ? ' is-unread' : ''}`,
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
        flags.length ? el('div', { class: 'chat-flags', text: flags.join(' ') }) : null,
        el('div', { class: 'chat-item-preview', text: chatPreviewText(chat) }),
        unreadBadge(chat),
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
  const restoring = isArchived(chat);
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
  const restoring = isArchived(chat);
  const result = await setArchived(chat, !restoring);
  if (!result.ok) return;

  if (restoring) toast('Moved back to inbox', 'success', 1800);
  else if (result.localOnly) {
    toast('Archived in this app only - Beeper still lists it', 'info', 3600);
  } else toast('Chat archived', 'success', 1800);

  // Archiving the chat you are reading closes it, same as the header button.
  if (state.activeChatID === chat.id) bus.emit('chat:close');
  else renderChats();
}

function chatItem(chat) {
  const isActive = chat.id === state.activeChatID;
  const preview = chatPreviewText(chat);
  const flags = rowFlags(chat);
  return el(
    'div',
    {
      class: `chat-item${isActive ? ' is-active' : ''}${isUnread(chat) ? ' is-unread' : ''}`,
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
        unreadBadge(chat),
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

  const [chats, remote, local] = await Promise.all([
    wantChats
      ? call(() => api.chats.search({ query, limit: 50 }), { context: 'chat search', fallback: null })
      : null,
    wantMessages
      // 20 is the ceiling Beeper accepts for message search; asking for more is a 400.
      ? call(() => api.messages.search({ query, limit: 20 }), { context: 'message search', fallback: null })
      : null,
    wantMessages
      // The local store answers with everything it holds, which is neither
      // capped at 20 nor limited to what a bridge has indexed. It only knows
      // about chats that have been opened, so Beeper's answer is merged in
      // rather than replaced.
      ? call(() => api.history.search(query, { limit: 50 }), { context: 'local search', fallback: null })
      : null,
  ]);

  if (token !== searchToken) return; // a newer search superseded this one

  const merged = mergeMessageHits(remote?.items || [], local || []);
  searchResults = { chats: chats?.items || [], messages: merged };
  searchMode = wantMessages ? 'messages' : 'chats';

  if (wantChats) for (const chat of searchResults.chats) upsertChat(chat);
  renderSearchResults(query);
}

/**
 * Local first, because it reaches further back, then Beeper's for the chats the
 * store has never seen. Deduplicated by message id so a message both sides know
 * about appears once.
 */
function mergeMessageHits(remoteItems, localItems) {
  const seen = new Set();
  const out = [];
  for (const hit of [...localItems, ...remoteItems]) {
    const key = `${hit.chatID || ''}|${hit.id || ''}`;
    if (!hit.id || seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
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
        text: 'No matches. Beeper only searches history it has indexed, and the local store only knows chats you have opened.',
      }),
    );
  }
}

function messageHit(message) {
  const chat = state.chats.get(message.chatID);
  // The local store knows the chat's name even when this session never loaded
  // it, which is the whole reason that name is kept on disk. A hit from an
  // old chat is close to useless if it can only be identified by its sender.
  const chatName = chat?.title || message.chatTitle || '';
  const text = message.text || message.type || 'message';
  return el(
    'div',
    {
      class: 'result-item',
      onClick: () => onSelectChat(message.chatID, { focusMessageID: message.id }),
    },
    avatarNode(chat, chatName || message.senderName || '?', 'sm'),
    el(
      'div',
      { class: 'result-item-body message-hit' },
      el('div', { class: 'result-item-sub', text: `${chatName || 'Chat'} · ${message.senderName || 'Unknown'}` }),
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
