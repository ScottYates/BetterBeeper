/** App bootstrap and cross-module wiring. */

import { $, el } from './util.js';
import { api, call, onApiError } from './api.js';
import { state, bus, upsertChat, chatList, loadPins } from './state.js';
import { toast, closePopover, initTooltips, openPopover } from './ui.js';
import {
  initSidebar, renderChats, renderAccountBadges, setLiveStatus, focusSearch, avatarNode,
  setView, currentView, renderViewChrome, VIEWS,
} from './sidebar.js';
import { initThread, openChat, applyMessageEvent, closeThread } from './thread.js';
import { initAssistant, toggleAssistant, showToolsCatalog } from './assistant.js';
import { openNewChat, openSettings, applyTheme } from './modals.js';
import { initLayout } from './layout.js';

let bootstrapped = false;

// ---------------------------------------------------------------------------
// Connect screen
// ---------------------------------------------------------------------------

function setConnectState(stateName, label) {
  const pill = $('#connect-status');
  pill.dataset.state = stateName;
  pill.querySelector('.label').textContent = label;
}

function showConnectScreen() {
  $('#connect-screen').hidden = false;
  $('#app').hidden = true;
  refreshConnectionStatus();
}

function showApp() {
  $('#connect-screen').hidden = true;
  $('#app').hidden = false;
  $('#version-label').textContent = `v${state.appVersion || '1.0.0'}`;
}

async function refreshConnectionStatus() {
  const res = await call(() => api.refreshDiscovery(), { context: 'discovery' });
  if (!res) {
    setConnectState('bad', 'Could not reach Beeper Desktop');
    return;
  }
  if (res.reachable) {
    const version = res.info?.app?.version;
    const mcp = res.info?.server?.mcp_enabled ? ' · MCP on' : '';
    setConnectState('ok', `Beeper ${version} detected${mcp}`);
    $('#btn-connect').disabled = false;
  } else {
    setConnectState('bad', res.error || 'Beeper Desktop is not reachable');
    $('#btn-connect').disabled = false;
  }
}

function wireConnectScreen() {
  $('#btn-connect').addEventListener('click', async () => {
    const btn = $('#btn-connect');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Waiting for approval in Beeper…';
    setConnectState('busy', 'Approve this app inside Beeper Desktop');

    const res = await call(() => api.connect(), { context: 'connect' });

    btn.disabled = false;
    btn.textContent = original;
    setConnectState(res ? 'ok' : 'bad', res ? 'Connected' : 'Connection failed');

    if (res) {
      await enterApp();
    } else {
      showError('Could not complete the connection. Check that Beeper is running and try again.');
    }
  });

  $('#btn-manual-toggle').addEventListener('click', () => {
    const box = $('#manual-token-box');
    box.hidden = !box.hidden;
    if (!box.hidden) $('#manual-token').focus();
  });

  $('#btn-manual').addEventListener('click', async () => {
    const token = $('#manual-token').value.trim();
    if (!token) {
      showError('Paste a token first.');
      return;
    }
    const btn = $('#btn-manual');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    const res = await call(() => api.manualConnect(token), { context: 'manual connect' });
    btn.disabled = false;
    btn.textContent = 'Use this token';

    if (res) {
      $('#manual-token').value = '';
      await enterApp();
    } else {
      showError('Beeper rejected that token.');
    }
  });
}

function showError(message) {
  const box = $('#connect-error');
  box.textContent = message;
  box.hidden = false;
}

// ---------------------------------------------------------------------------
// Entering the app
// ---------------------------------------------------------------------------

async function enterApp() {
  showApp();

  const accounts = (await call(() => api.accounts(), { context: 'accounts', fallback: [] })) || [];
  state.accounts = accounts;
  renderAccountBadges();

  await loadChats();

  // Open the first unread chat, or the most recent one.
  const firstUnread = chatList().find((c) => (c.unreadCount || 0) > 0);
  const target = firstUnread || chatList()[0];
  if (target) openChat(target.id);
}

async function loadChats() {
  const res = await call(() => api.chats.list({ limit: 100 }), { context: 'chats', fallback: null });
  if (!res) {
    renderChats();
    return;
  }
  for (const chat of res.items || []) upsertChat(chat);

  // Pull a second page so the sidebar has real history depth.
  if (res.hasMore && res.oldestCursor) {
    call(() => api.chats.list({ limit: 100, cursor: res.oldestCursor, direction: 'before' }), {
      context: 'chats page 2',
    }).then((page2) => {
      if (!page2) return;
      for (const chat of page2.items || []) upsertChat(chat);
      renderChats();
      subscribeVisibleChats();
    });
  }

  renderChats();
  subscribeVisibleChats();
}

/**
 * The live socket only streams chats we explicitly subscribe to, and there is
 * a server-side cost to large subscription sets. We therefore track the most
 * recent chats plus whatever is currently open - the open chat is never
 * guaranteed to be recent, so it must be added on every switch.
 */
function subscribeVisibleChats() {
  const ids = chatList().slice(0, 50).map((c) => c.id);
  if (state.activeChatID && !ids.includes(state.activeChatID)) ids.unshift(state.activeChatID);
  call(() => api.events.subscribe(ids), { context: 'subscribe' });
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

function wireEvents() {
  window.beeper.on.eventsStatus(({ status }) => {
    setLiveStatus(status);
    state.liveStatus = status;
  });

  window.beeper.on.eventsReady(() => {
    setLiveStatus('ready');
    // A reconnect may have missed messages; re-read the open chat.
    if (state.activeChatID) openChat(state.activeChatID);
    loadChats();
  });

  window.beeper.on.eventsFrame((frame) => {
    switch (frame?.type) {
      case 'message.upserted': {
        applyMessageEvent(frame);
        refreshChatSummary(frame.chatID);
        break;
      }
      case 'message.deleted': {
        bus.emit('messages:changed', { chatID: frame.chatID });
        break;
      }
      case 'chat.upserted':
      case 'chat.deleted': {
        refreshChatSummary(frame.chatID);
        break;
      }
      default:
        break;
    }
  });
}

async function refreshChatSummary(chatID) {
  if (!chatID) return;
  const fresh = await call(() => api.chats.get(chatID), { context: 'chat refresh', fallback: null });
  if (!fresh) return;
  const existing = state.chats.get(chatID);
  upsertChat({ ...existing, ...fresh });
  if (state.activeChatID === chatID) {
    bus.emit('chat:updated', fresh);
  }
  renderChats();
  subscribeVisibleChats();
}

// ---------------------------------------------------------------------------
// Keyboard & menus
// ---------------------------------------------------------------------------

function closeActiveChat() {
  if (!state.activeChatID) return;
  closeThread();
  renderChats();
}

function wireKeyboard() {
  // Escape runs in the capture phase on purpose. ui.js closes modals, popovers
  // and the image viewer on their own bubble-phase handlers, so by the time a
  // bubble listener looked, the modal was already gone and a single Escape
  // would close the modal *and* the chat behind it. Reading the state up front
  // keeps one Escape to one thing.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      if (!$('#modal-root').hidden) return;
      if (state.editing) return;
      // Escape in the search box clears the search; it must not close the chat.
      if (event.target?.id === 'search-input') return;
      if (!state.activeChatID) return;

      event.preventDefault();
      closeActiveChat();
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    closePopover();

    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

    if (event.key === 'Escape' && inField && event.target.id === 'search-input') {
      event.target.value = '';
      state.searchQuery = '';
      event.target.dispatchEvent(new Event('input'));
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
      event.preventDefault();
      focusSearch();
    }
  });

  window.beeper.on.menuNewChat(() => openNewChat());
  window.beeper.on.menuFocusSearch(() => focusSearch());
  window.beeper.on.menuToggleAssistant(() => toggleAssistant());

  bus.on('chat:open', (chatID, opts) => openChat(chatID, opts));
  bus.on('chat:activated', () => subscribeVisibleChats());
  bus.on('chat:close', () => closeActiveChat());
  window.addEventListener('open-settings', () => openSettings());
  window.addEventListener('show-mcp-tools', () => showToolsCatalog());
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  if (bootstrapped) return;
  bootstrapped = true;

  onApiError(({ context, message, code }) => {
    if (code === 'no_model') return; // surfaced inside the assistant panel
    toast(message || `Error during ${context}`, 'error', 4200);
  });

  wireConnectScreen();
  initTooltips();
  initSidebar({
    onSelectChat: (chatID, opts) => {
      if (opts?.focusMessageID) openChat(chatID, { focusMessageID: opts.focusMessageID });
      else openChat(chatID);
    },
    onSelectView: () => closeThread(),
  });
  initThread();
  initAssistant();
  wireEvents();
  wireKeyboard();

  $('#btn-new-chat').addEventListener('click', () => openNewChat());
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-assistant').addEventListener('click', () => toggleAssistant());

  // Beeper keeps search hidden until the magnifier is clicked.
  $('#btn-focus-search').addEventListener('click', () => {
    const row = $('#search-row');
    const open = row.classList.toggle('is-open');
    if (open) focusSearch();
    else {
      const input = $('#search-input');
      input.value = '';
      state.searchQuery = '';
      input.dispatchEvent(new Event('input'));
    }
  });

  $('#btn-filters').addEventListener('click', () => {
    const row = $('#filter-row');
    const open = row.classList.toggle('is-open');
    $('#btn-filters').classList.toggle('is-on', open);
    if (!open) return;
    // Cycling a filter only makes sense once the row is visible.
    const order = ['all', 'unread', 'primary', 'archive'];
    const next = order[(order.indexOf(state.filter) + 1) % order.length];
    const chip = document.querySelector(`#filter-row .chip[data-filter="${next}"]`);
    chip?.click();
  });

  // The "Inbox" header control, with its caret. It was a label and a
  // decorative caret for months, so it looked clickable and did nothing;
  // it is now a real menu.
  const viewSwitch = $('#view-switch');
  viewSwitch.addEventListener('click', () => {
    const active = currentView();
    openPopover(
      viewSwitch,
      VIEWS.map((v) => ({
        label: v.label,
        checked: v.id === active,
        onSelect: () => {
          setView(v.id);
          viewSwitch.setAttribute('aria-expanded', 'false');
          viewSwitch.classList.remove('is-on');
        },
      })),
      { width: 180 },
    );
    viewSwitch.setAttribute('aria-expanded', 'true');
    viewSwitch.classList.add('is-on');
  });
  renderViewChrome();

  const info = await call(() => api.bootstrap(), { context: 'startup', fallback: null });
  if (!info) {
    showConnectScreen();
    return;
  }

  state.discovery = info.discovery;
  state.settings = info.settings || {};
  state.appVersion = info.versions?.app;
  applyTheme(state.settings.theme);
  loadPins(state.settings.pinnedChats);

  // Restores the remembered conversation-list width; runs after settings load.
  initLayout();

  // Seed connection indicators from the main process; pushes only cover
  // changes that happen after the renderer starts listening.
  if (info.live?.events) {
    setLiveStatus(info.live.events);
    state.liveStatus = info.live.events;
  }
  if (info.live?.mcp) {
    bus.emit('mcp:status', { status: info.live.mcp });
  }

  if (info.authenticated) {
    const status = await call(() => api.authStatus(), { context: 'auth status', fallback: null });
    if (status?.valid) {
      await enterApp();
    } else {
      // A rejected or unreachable token should send the user back to the
      // connect screen with the reason, not into an empty app shell.
      showConnectScreen();
      if (status?.error) showError(`Beeper rejected the stored connection: ${status.error}`);
    }
  } else {
    showConnectScreen();
  }

  // Keep the connect screen honest if Beeper starts later.
  setInterval(() => {
    if (!$('#connect-screen').hidden) refreshConnectionStatus();
  }, 8000);
}

boot();
