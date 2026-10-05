/** Modals: start a new chat (contact search) and app settings. */

import { $, el, clear, debounce, escapeHtml, initials, hueFor, fullTime, renderRichText } from './util.js';
import { api, call } from './api.js';
import { state, bus, upsertChat, deletedList, clearDeletedMessages } from './state.js';
import { openModal, closeModal, toast } from './ui.js';
import { avatarNode } from './sidebar.js';
import { checkNow } from './updates.js';

/**
 * Text-size presets, as [zoom factor, label]. 1 is the size the UI was designed
 * at; the percentage is shown so the choice is unambiguous. The main process
 * clamps whatever lands here into 0.5-3.
 */
const TEXT_SCALES = [
  [0.9, 'Small (90%)'],
  [1, 'Default (100%)'],
  [1.15, 'Large (115%)'],
  [1.3, 'Larger (130%)'],
  [1.5, 'Largest (150%)'],
];

/**
 * Where a new build is ever published. GitHub resolves /releases/latest to the
 * newest tag, so this link cannot go stale the way a pinned version URL would.
 */
export const RELEASES_URL = 'https://github.com/ScottYates/BetterBeeper/releases/latest';

/**
 * The running version, for the About row in settings.
 *
 * Says "unknown" rather than falling back to a plausible-looking number: a
 * settings panel that quietly claims 1.0.0 when it has not loaded the real
 * version is worse than one that admits it does not know.
 */
export function versionLabel(version) {
  const value = String(version ?? state.appVersion ?? '').trim();
  return value ? `Better Beeper ${value}` : 'Better Beeper (version unknown)';
}

/** How many messages are hidden on this device, in words. */
function deletedCountText() {
  const n = deletedList().length;
  if (!n) return 'None';
  return `${n} hidden on this device`;
}

// ---------------------------------------------------------------------------
// New chat
// ---------------------------------------------------------------------------

export function openNewChat() {
  const results = el('div', { class: 'result-list' });
  const summary = el('div', { class: 'search-summary', text: 'Search your contacts to start a conversation.' });

  const search = el('input', {
    type: 'search',
    placeholder: 'Search contacts…',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  let selection = new Map(); // contactID -> contact

  const selectedBar = el('div', { class: 'search-summary' });
  const createBtn = el('button', {
    class: 'btn btn-primary',
    text: 'Start chat',
    disabled: true,
    onClick: createChat,
  });

  const accountSelect = el('select');
  for (const account of state.accounts) {
    accountSelect.append(
      el('option', {
        value: account.accountID,
        text: `${account.network || account.accountID} · ${account.user?.fullName || account.user?.username || ''}`,
      }),
    );
  }
  const connected = state.accounts.filter((a) => a.status === 'connected');
  if (connected.length) {
    accountSelect.value = connected[0].accountID;
  }

  const body = el(
    'div',
    {},
    el('div', { class: 'form-row' }, el('label', { text: 'Account' }), accountSelect),
    el('div', { class: 'form-row' }, search),
    summary,
    results,
    selectedBar,
  );

  openModal({
    title: 'New chat',
    body,
    footer: [el('button', { class: 'btn', text: 'Cancel', onClick: closeModal }), createBtn],
  });

  search.addEventListener(
    'input',
    debounce(async () => {
      const query = search.value.trim();
      if (!query) {
        summary.textContent = 'Search your contacts to start a conversation.';
        clear(results);
        return;
      }
      const accountID = accountSelect.value;
      if (!accountID) {
        summary.textContent = 'No account selected.';
        return;
      }
      summary.textContent = 'Searching…';
      const res = await call(() => api.contacts(accountID, { query, limit: 40 }), {
        context: 'contacts',
        fallback: null,
      });
      if (!res) {
        summary.textContent = 'Could not load contacts for that account.';
        return;
      }
      const items = res.items || [];
      summary.textContent = items.length
        ? `${items.length} contact${items.length === 1 ? '' : 's'}`
        : 'No contacts matched. Beeper can only search contacts it has synced for this bridge.';

      clear(results);
      for (const contact of items) {
        const contactID = contact.id || contact.userID;
        if (!contactID) continue;
        const node = el(
          'div',
          {
            class: `result-item${selection.has(contactID) ? ' is-selected' : ''}`,
            dataset: { contactId: contactID },
            onClick: () => {
              if (selection.has(contactID)) selection.delete(contactID);
              else selection.set(contactID, contact);
              node.classList.toggle('is-selected', selection.has(contactID));
              node.querySelector('.result-check')?.remove();
              if (selection.has(contactID)) node.append(el('span', { class: 'result-check', text: '✓' }));
              updateSelected();
            },
          },
          avatarNode(contact, contact.fullName || contact.username || '?', 'sm'),
          el(
            'div',
            { class: 'result-item-body' },
            el('div', { class: 'result-item-title', text: contact.fullName || contact.username || contact.phoneNumber || contactID }),
            el('div', {
              class: 'result-item-sub',
              text: contact.username || contact.phoneNumber || contact.email || contactID,
            }),
          ),
        );
        results.append(node);
      }
    }, 300),
  );

  function updateSelected() {
    const count = selection.size;
    selectedBar.textContent = count ? `${count} selected` : '';
    createBtn.disabled = count === 0;
  }

  async function createChat() {
    const accountID = accountSelect.value;
    const contactIDs = [...selection.keys()];
    if (!accountID || !contactIDs.length) return;

    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';

    const single = contactIDs.length === 1;
    const res = await call(
      () =>
        api.chats.create({
          accountID,
          type: single ? 'single' : 'group',
          participantIDs: contactIDs,
          title: single ? undefined : contactIDs.map((id) => selection.get(id)?.fullName).filter(Boolean).join(', '),
        }),
      { context: 'create chat', throwOnError: true },
    ).catch((err) => ({ __error: err }));

    if (res?.__error) {
      toast(res.__error.message, 'error', 5000);
      createBtn.disabled = false;
      createBtn.textContent = 'Start chat';
      return;
    }

    const chatID = res?.id || res?.chatID;
    closeModal();
    toast('Chat created', 'success', 1800);
    if (chatID) {
      upsertChat(res);
      bus.emit('chats:changed');
      bus.emit('chat:open', chatID);
    }
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function openSettings() {
  const settings = (await call(() => api.settings.get(), { context: 'settings' })) || {};
  state.settings = { ...state.settings, ...settings };

  const provider = el('select');
  for (const [value, label] of [
    ['openai', 'OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama, LM Studio, vLLM…)'],
    ['anthropic', 'Anthropic'],
  ]) {
    provider.append(el('option', { value, text: label, selected: settings.provider === value }));
  }

  const baseUrl = el('input', {
    type: 'text',
    value: settings.baseUrl || '',
    placeholder: 'https://api.openai.com/v1',
    spellcheck: 'false',
  });
  const model = el('input', {
    type: 'text',
    value: settings.model || '',
    placeholder: 'gpt-4o-mini',
    spellcheck: 'false',
  });
  const apiKey = el('input', {
    type: 'password',
    value: '',
    placeholder: settings.hasApiKey ? '•••••••• (stored)' : 'sk-…',
    autocomplete: 'off',
  });
  const theme = el('select');
  for (const value of ['system', 'dark', 'light']) {
    theme.append(el('option', { value, text: value, selected: (settings.theme || 'system') === value }));
  }
  const sendOnEnter = el('input', { type: 'checkbox', checked: settings.sendOnEnter !== false });
  const markReadOnOpen = el('input', { type: 'checkbox', checked: settings.markReadOnOpen !== false });

  // Text size. The value is a page-zoom factor; 1 is the designed size. The
  // percentage is shown so the choice does not have to be guessed at.
  const savedScale = Number(settings.textScale);
  const currentScale = Number.isFinite(savedScale) && savedScale > 0 ? savedScale : 1;
  const textScale = el('select');
  for (const [value, label] of TEXT_SCALES) {
    textScale.append(el('option', { value: String(value), text: label, selected: Math.abs(currentScale - value) < 0.001 }));
  }
  // A stored factor that is not one of the presets (hand-edited, or clamped in
  // the main process) still has to show something sensible rather than snap
  // the dropdown to an unrelated value.
  if (!TEXT_SCALES.some(([value]) => Math.abs(currentScale - value) < 0.001)) {
    textScale.append(el('option', {
      value: String(currentScale),
      text: `Custom (${Math.round(currentScale * 100)}%)`,
      selected: true,
    }));
  }

  const autoUpdates = el('input', { type: 'checkbox', checked: settings.autoUpdates !== false });

  const notifyEnabled = el('input', { type: 'checkbox', checked: settings.notifyEnabled !== false });
  const notifyPreview = el('select');
  for (const [value, label] of [
    ['full', 'Sender and message text'],
    ['sender', 'Sender only'],
    ['none', 'Nothing — just "New message"'],
  ]) {
    notifyPreview.append(el('option', { value, text: label, selected: (settings.notifyPreview || 'full') === value }));
  }
  const notifyMutedChats = el('input', { type: 'checkbox', checked: settings.notifyMutedChats === true });
  const notifySound = el('input', { type: 'checkbox', checked: settings.notifySound !== false });
  const notifyWhenFocused = el('input', {
    type: 'checkbox',
    checked: settings.notifyWhenFocused === true,
  });

  // The sub-options are meaningless with notifications off, so dim them.
  const notifyOptions = el(
    'div',
    { class: 'notify-options' },
    el(
      'div',
      { class: 'form-row' },
      el('label', { text: 'Show in the notification' }),
      notifyPreview,
    ),
    el(
      'label',
      { class: 'form-row row-check', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      notifyMutedChats,
      el('span', { text: 'Also notify for muted chats' }),
    ),
    el(
      'label',
      { class: 'form-row row-check', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      notifySound,
      el('span', { text: 'Play a sound' }),
    ),
    el(
      'label',
      { class: 'form-row row-check', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      notifyWhenFocused,
      el('span', { text: 'Notify even while this window is focused' }),
    ),
  );

  const syncNotifyOptions = () => {
    notifyOptions.classList.toggle('is-disabled', !notifyEnabled.checked);
    for (const input of notifyOptions.querySelectorAll('input, select')) input.disabled = !notifyEnabled.checked;
  };
  notifyEnabled.addEventListener('change', syncNotifyOptions);
  syncNotifyOptions();

  const baseUrlField = el(
    'div',
    { class: 'form-row' },
    el('label', { text: 'Base URL' }),
    baseUrl,
    el('p', {
      class: 'hint',
      text: 'Base URL of an OpenAI-compatible API. Leave the default for OpenAI; for Ollama use http://localhost:11434/v1.',
    }),
  );
  const baseUrlHint = baseUrlField.querySelector('.hint');

  provider.addEventListener('change', () => {
    if (provider.value === 'anthropic') {
      baseUrl.value = 'https://api.anthropic.com';
      baseUrlHint.textContent = 'Leave as the default for Anthropic.';
    } else if (baseUrl.value.includes('anthropic')) {
      baseUrl.value = 'https://api.openai.com/v1';
      baseUrlHint.textContent = baseUrlHint.textContent.replace('Anthropic', 'OpenAI');
    }
  });

  const body = el(
    'div',
    {},
    // First on purpose. The modal body scrolls, and this section sat 240px below
    // the fold at a 115% text scale - which is the same as not existing: it was
    // in the DOM, every check that asked whether it was *there* passed, and
    // nobody could find it. The only way back after deleting a message on this
    // device has to be visible without scrolling.
    el('h4', { text: 'Messages', style: { marginBottom: '10px' } }),
    el(
      'div',
      { class: 'form-row' },
      el('label', { text: 'Deleted on this device' }),
      // There is no per-message restore any more, so this is the only way back.
      // It saves first and clears second: a failed save that had already wiped
      // the list would show the messages again for this session only, and then
      // silently put them back on the next start.
      (() => {
        const count = el('span', { class: 'muted tiny', text: deletedCountText() });
        const btn = el('button', {
          class: 'btn btn-sm',
          text: 'Clear list',
          disabled: deletedList().length === 0,
          onClick: async () => {
            btn.disabled = true;
            const saved = await call(() => api.settings.set({ deletedMessages: [] }), {
              context: 'clear deleted messages',
            });
            if (!saved) {
              btn.disabled = false;
              toast('Could not clear the deleted list', 'error');
              return;
            }
            state.settings = saved;
            const restored = clearDeletedMessages();
            count.textContent = deletedCountText();
            // The thread filters these messages out, so it has to redraw for
            // them to come back rather than just flipping a flag.
            bus.emit('messages:changed', { chatID: state.activeChatID });
            toast(
              `${restored} message${restored === 1 ? '' : 's'} shown again`,
              'success',
              2000,
            );
          },
        });
        return el('div', { class: 'clear-deleted-row' }, count, btn);
      })(),
      el('p', {
        class: 'hint',
        text: 'Deleting on this device removes a message from this app only; Beeper keeps it. Clearing the list makes those messages visible again.',
      }),
    ),

    el('h4', { text: 'Assistant', style: { margin: '20px 0 10px' } }),
    el('div', { class: 'form-row' }, el('label', { text: 'Provider' }), provider),
    baseUrlField,
    el(
      'div',
      { class: 'form-grid' },
      el('div', { class: 'form-row' }, el('label', { text: 'Model' }), model),
      el('div', { class: 'form-row' }, el('label', { text: 'API key' }), apiKey),
    ),
    el('p', {
      class: 'hint',
      style: { marginTop: '-6px', marginBottom: '16px' },
      text: 'The key is stored encrypted in your OS keychain and only ever used from the main process.',
    }),
    el('button', {
      class: 'btn btn-sm',
      text: 'Show available MCP tools',
      style: { marginBottom: '22px' },
      onClick: () => window.dispatchEvent(new CustomEvent('show-mcp-tools')),
    }),

    el('h4', { text: 'Behaviour', style: { marginBottom: '10px' } }),
    el(
      'div',
      { class: 'form-row' },
      el('label', { text: 'Theme' }),
      theme,
    ),
    el(
      'div',
      { class: 'form-row' },
      el('label', { text: 'Text size' }),
      textScale,
    ),
    el(
      'label',
      { class: 'form-row', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      sendOnEnter,
      el('span', { text: 'Press Enter to send (Shift+Enter for a new line)' }),
    ),
    el(
      'label',
      { class: 'form-row', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      markReadOnOpen,
      el('span', { text: 'Mark a chat as read when I open it' }),
    ),

    el('h4', { text: 'Notifications', style: { margin: '20px 0 10px' } }),
    el(
      'label',
      { class: 'form-row', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      notifyEnabled,
      el('span', { text: 'Show desktop notifications' }),
    ),
    notifyOptions,

    el('h4', { text: 'Connection', style: { margin: '20px 0 10px' } }),
    el('p', { class: 'muted tiny', id: 'settings-connection' }),
    el('button', {
      class: 'btn btn-sm',
      text: 'Disconnect from Beeper',
      style: { marginTop: '10px' },
      onClick: async () => {
        const res = await call(() => api.disconnect(), { context: 'disconnect' });
        if (res !== null) {
          closeModal();
          window.location.reload();
        }
      },
    }),

    el('h4', { text: 'About', style: { margin: '20px 0 10px' } }),
    el(
      'label',
      { class: 'form-row', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      autoUpdates,
      el('span', { text: 'Check for updates automatically' }),
    ),
    el('p', {
      class: 'muted tiny',
      style: { marginTop: '-6px' },
      text: 'Once a day. When one is found it asks before downloading anything.',
    }),
    el(
      'div',
      { class: 'form-row about-row' },
      el('span', { class: 'muted tiny', id: 'settings-version', text: versionLabel() }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Check for updates',
        style: { marginRight: '2px' },
        onClick: async (event) => {
          const btn = event.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Checking...';
          try {
            await checkNow();
          } finally {
            btn.disabled = false;
            btn.textContent = 'Check for updates';
          }
        },
      }),
      el('a', {
        class: 'about-link',
        href: RELEASES_URL,
        title: RELEASES_URL,
        text: 'Get the most recent release',
        // A real link, so it can be copied and middle-clicked, but opened
        // through the main process rather than navigating the app window.
        onClick: (event) => {
          event.preventDefault();
          api.shell.openExternal(RELEASES_URL);
        },
      }),
    ),
  );

  openModal({
    title: 'Settings',
    body,
    footer: [
      el('button', { class: 'btn', text: 'Cancel', onClick: closeModal }),
      el('button', {
        class: 'btn btn-primary',
        text: 'Save',
        onClick: async () => {
          const patch = {
            provider: provider.value,
            baseUrl: baseUrl.value.trim(),
            model: model.value.trim(),
            theme: theme.value,
            textScale: Number(textScale.value),
            sendOnEnter: sendOnEnter.checked,
            markReadOnOpen: markReadOnOpen.checked,
            notifyEnabled: notifyEnabled.checked,
            notifyPreview: notifyPreview.value,
            notifyMutedChats: notifyMutedChats.checked,
            notifySound: notifySound.checked,
            notifyWhenFocused: notifyWhenFocused.checked,
            autoUpdates: autoUpdates.checked,
          };
          if (apiKey.value.trim()) patch.apiKey = apiKey.value.trim();
          if (apiKey.value === '') delete patch.apiKey;

          const saved = await call(() => api.settings.set(patch), { context: 'save settings' });
          if (saved) {
            state.settings = saved;
            applyTheme(saved.theme);
            closeModal();
            toast('Settings saved', 'success', 1600);
            window.dispatchEvent(new CustomEvent('settings:changed'));
          }
        },
      }),
    ],
  });
}

export function applyTheme(theme) {
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  const resolved = theme === 'system' ? (prefersLight ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
}

// ---------------------------------------------------------------------------
// Message search (accessible from the sidebar search)
// ---------------------------------------------------------------------------

export async function openMessageSearch(query) {
  const body = el('div', { class: 'result-list' }, el('div', { class: 'search-loading', text: 'Searching…' }));
  openModal({ title: `Search: ${query}`, body });

  const res = await call(() => api.messages.search({ query, limit: 50 }), {
    context: 'message search',
    fallback: null,
  });
  clear(body);
  const items = res?.items || [];
  if (!items.length) {
    body.append(el('div', { class: 'empty-note', text: 'No matching messages found.' }));
    return;
  }
  for (const message of items) {
    const chat = state.chats.get(message.chatID);
    body.append(
      el(
        'div',
        {
          class: 'result-item',
          onClick: () => {
            closeModal();
            bus.emit('chat:open', message.chatID, { focusMessageID: message.id });
          },
        },
        avatarNode(chat, chat?.title || '?', 'sm'),
        el(
          'div',
          { class: 'result-item-body' },
          el('div', { class: 'result-item-sub', text: `${chat?.title || 'Chat'} · ${message.senderName || ''} · ${fullTime(message.timestamp)}` }),
          el('div', { class: 'result-item-title', html: renderRichText(String(message.text || '').slice(0, 160)) }),
        ),
      ),
    );
  }
}
