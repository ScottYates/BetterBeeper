/** Assistant panel: streams turns and surfaces every MCP tool invocation. */

import { $, el, clear, autoGrow, escapeHtml } from './util.js';
import { api, call } from './api.js';
import { state, bus } from './state.js';
import { toast, openModal } from './ui.js';

let history = []; // OpenAI-style messages
let busy = false;
let mcpStatus = 'idle';
let tools = [];

export function initAssistant() {
  const input = $('#assistant-input');
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      ask(input.value.trim());
      input.value = '';
      autoGrow(input);
    }
  });

  $('#btn-assistant-send').addEventListener('click', () => {
    ask(input.value.trim());
    input.value = '';
    autoGrow(input);
  });

  bus.on('mcp:status', ({ status, detail }) => {
    mcpStatus = status;
    updateMcpStatus(detail);
  });

  bus.on('assistant:event', handleAssistantEvent);

  renderWelcome();
}

export function toggleAssistant(force) {
  const pane = $('#assistant-pane');
  const app = $('#app');
  const show = force === undefined ? pane.hidden : force;
  pane.hidden = !show;
  app.classList.toggle('with-assistant', show);
  $('#btn-assistant').classList.toggle('is-on', show);
  if (show) {
    ensureTools();
    $('#assistant-input').focus();
  }
}

function updateMcpStatus(detail) {
  const node = $('#mcp-status');
  const labels = {
    connected: tools.length ? `MCP · ${tools.length} tools` : 'MCP connected',
    connecting: 'Connecting to MCP…',
    error: `MCP error: ${detail || 'unknown'}`,
    unauthenticated: 'Connect to Beeper to use the assistant',
    disconnected: 'MCP disconnected',
    idle: 'MCP not connected',
  };
  node.textContent = labels[mcpStatus] || mcpStatus;
}

async function ensureTools() {
  if (tools.length) {
    updateMcpStatus();
    return tools;
  }
  const res = await call(() => api.assistant.tools(), { context: 'mcp tools', fallback: [] });
  if (Array.isArray(res)) {
    tools = res;
    mcpStatus = 'connected';
  } else {
    mcpStatus = 'error';
  }
  updateMcpStatus();
  return tools;
}

function renderWelcome() {
  const log = $('#assistant-log');
  clear(log);

  if (!state.settings?.model) {
    log.append(
      el(
        'div',
        { class: 'assistant-empty' },
        el('h4', { text: 'Connect an AI model' }),
        el('p', {
          class: 'muted',
          text: 'The assistant uses Beeper’s own MCP server for tools. You just need to point it at a model endpoint.',
        }),
        el('button', {
          class: 'btn btn-primary btn-sm',
          text: 'Open settings',
          onClick: () => window.dispatchEvent(new CustomEvent('open-settings')),
        }),
      ),
    );
    return;
  }

  log.append(
    el(
      'div',
      { class: 'assistant-empty' },
      el('h4', { text: 'Ask about your chats' }),
      el('p', {
        class: 'muted',
        text: 'I can search your messages, read conversations, and draft or send replies — every action I take is shown below.',
      }),
      el('div', { class: 'muted tiny', text: 'Try: “What did I miss in WhatsApp this week?”' }),
    ),
  );
}

export function resetAssistant() {
  history = [];
  renderWelcome();
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

async function ask(text) {
  if (!text || busy) return;
  if (!state.settings?.model) {
    toast('Configure an AI model in Settings first', 'error');
    return;
  }

  busy = true;
  $('#btn-assistant-send').disabled = true;
  clear($('#assistant-log'));

  history.push({ role: 'user', content: text });
  $('#assistant-log').append(el('div', { class: 'bubble user', text }));

  const assistantBubble = el('div', { class: 'bubble assistant' });
  const typing = el('span', { class: 'typing' }, el('span'), el('span'), el('span'));
  assistantBubble.append(typing);
  $('#assistant-log').append(assistantBubble);
  scrollAssistant();

  let buffer = '';
  const onEvent = (evt) => {
    if (evt.type === 'text') {
      buffer += evt.delta;
      if (typing.parentNode) typing.remove();
      assistantBubble.textContent = buffer;
      scrollAssistant();
    } else if (evt.type === 'tool_call') {
      if (typing.parentNode) typing.remove();
      insertToolCard(evt);
    } else if (evt.type === 'tool_result') {
      updateToolCard(evt);
    } else if (evt.type === 'notice') {
      insertNotice(evt.text);
    }
  };

  window.beeper.on.assistantEvent(onEvent);

  try {
    const res = await api.assistant.ask(history);
    if (res?.ok) {
      const final = res.data?.text || buffer;
      if (typing.parentNode) typing.remove();
      assistantBubble.textContent = final || '(no response)';
      history.push({ role: 'assistant', content: final });
    } else {
      if (typing.parentNode) typing.remove();
      const message = res?.error?.message || 'The assistant request failed.';
      assistantBubble.classList.add('error');
      assistantBubble.textContent = message;
      history.push({ role: 'assistant', content: message });
    }
  } catch (err) {
    if (typing.parentNode) typing.remove();
    assistantBubble.classList.add('error');
    assistantBubble.textContent = err.message;
  } finally {
    busy = false;
    $('#btn-assistant-send').disabled = false;
    scrollAssistant();
  }
}

function handleAssistantEvent(evt) {
  if (evt?.type === 'turn_start') {
    if (!$('#assistant-log').querySelector('.typing')) {
      /* the ask() flow owns the placeholder bubble */
    }
  }
}

function insertToolCard({ id, name, args }) {
  const card = el(
    'div',
    { class: 'tool-activity', dataset: { toolId: id } },
    el('div', { class: 'tool-name', text: `${name}…` }),
    el('div', { class: 'tool-args', text: formatArgs(args) }),
  );
  $('#assistant-log').append(card);
  scrollAssistant();
  return card;
}

function updateToolCard({ id, name, isError }) {
  const card = document.querySelector(`[data-tool-id="${CSS.escape(String(id))}"]`);
  if (!card) return;
  card.classList.toggle('is-error', Boolean(isError));
  card.querySelector('.tool-name').textContent = isError ? `${name} — failed` : `${name} ✓`;
}

function insertNotice(text) {
  $('#assistant-log').append(el('div', { class: 'tool-activity', text }));
  scrollAssistant();
}

function formatArgs(args) {
  if (!args || !Object.keys(args).length) return '';
  const entries = Object.entries(args).slice(0, 6);
  return entries.map(([k, v]) => `${k}: ${truncate(JSON.stringify(v))}`).join('\n');
}

function truncate(value) {
  const str = value === undefined ? '' : String(value);
  return str.length > 160 ? `${str.slice(0, 160)}…` : str;
}

function scrollAssistant() {
  const log = $('#assistant-log');
  log.scrollTop = log.scrollHeight;
}

export function showToolsCatalog() {
  const body = el('div');
  if (!tools.length) {
    body.append(el('p', { class: 'muted', text: 'Loading MCP tools…' }));
  } else {
    body.append(
      el('p', { class: 'muted tiny', text: `${tools.length} tools exposed by Beeper’s MCP server:` }),
    );
    const list = el('div', { class: 'result-list' });
    for (const tool of tools) {
      list.append(
        el(
          'div',
          { class: 'result-item', style: { cursor: 'default' } },
          el(
            'div',
            { class: 'result-item-body' },
            el('div', { class: 'result-item-title', text: tool.name }),
            el('div', { class: 'result-item-sub', text: tool.description || '' }),
          ),
        ),
      );
    }
    body.append(list);
  }
  openModal({ title: 'Beeper MCP tools', body });
  ensureTools().then(() => {
    if (tools.length) showToolsCatalog();
  });
}
