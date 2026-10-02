'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Assistant engine for the AI panel.
 *
 * The model is *not* baked in. The user supplies an endpoint in Settings:
 *   - "OpenAI-compatible" covers OpenAI, OpenRouter, Groq, Together, Ollama,
 *     LM Studio, vLLM, and most gateways via baseUrl + apiKey + model.
 *   - "Anthropic" covers api.anthropic.com.
 *
 * The model is given Beeper's MCP tools and runs a bounded tool-calling loop.
 * Every tool invocation is surfaced to the UI so the user can see exactly what
 * the assistant is reading or sending on their behalf.
 */

const MAX_ROUNDS = 8;

class AssistantError extends Error {
  constructor(message, { code = 'assistant_error' } = {}) {
    super(message);
    this.name = 'AssistantError';
    this.code = code;
  }
}

const SYSTEM_PROMPT = `You are the assistant inside Beeper Desktop Chat, a native client for Beeper Desktop.

You have tools that give you access to the user's Beeper account: list and search chats, read and send messages, manage contacts, and so on.

Rules:
- Use tools to read real data. Never invent message contents, chat titles, or people.
- When the user asks you to send a message, show them exactly what you will send, then send it. Sending is a real action on a real account - confirm the recipient and wording unless the user has already been explicit.
- Cite chats by title so the user can find them.
- Keep replies short. This is a chat sidebar, not a document editor.`;

function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description || '').slice(0, 1000),
      parameters: sanitizeSchema(t.inputSchema),
    },
  }));
}

function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: (t.description || '').slice(0, 1000),
    input_schema: sanitizeSchema(t.inputSchema),
  }));
}

/** Strips JSON-Schema keywords some providers reject. */
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const allowed = [
    'type',
    'properties',
    'required',
    'items',
    'description',
    'enum',
    'default',
    'oneOf',
    'anyOf',
    'additionalProperties',
  ];
  const out = {};
  for (const key of allowed) if (schema[key] !== undefined) out[key] = schema[key];
  if (out.properties) {
    const props = {};
    for (const [k, v] of Object.entries(out.properties)) {
      props[k] = sanitizeSchema(v);
    }
    out.properties = props;
  }
  return out;
}

function joinUrl(base, suffix) {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith(suffix)) return trimmed;
  return trimmed + suffix;
}

/**
 * Runs one assistant turn, including the full tool-calling loop.
 * `onEvent` receives incremental updates so the UI can stream.
 */
async function runAssistantTurn({ config, history, tools, callTool, onEvent }) {
  const emit = onEvent || (() => {});
  const provider = config.provider || 'openai';

  if (!config.model) {
    throw new AssistantError('No model configured. Open Settings to add an AI endpoint.', {
      code: 'no_model',
    });
  }
  if (provider === 'openai' && !config.baseUrl) {
    throw new AssistantError('No API base URL configured.', { code: 'no_base_url' });
  }

  const messages = history.map((m) => ({ ...m }));
  let finalText = '';
  let rounds = 0;

  while (rounds < MAX_ROUNDS) {
    rounds += 1;

    if (provider === 'anthropic') {
      const turn = await callAnthropic({ config, messages, tools, emit });
      finalText = turn.text || finalText;
      if (!turn.toolCalls.length) break;

      messages.push({ role: 'assistant', content: turn.rawBlocks });
      for (const call of turn.toolCalls) {
        const result = await executeTool({ call, callTool, emit });
        messages.push({
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: call.id, content: result.text, is_error: result.isError },
          ],
        });
      }
      continue;
    }

    const turn = await callOpenAICompatible({ config, messages, tools, emit });
    finalText = turn.text || finalText;
    if (!turn.toolCalls.length) break;

    messages.push({
      role: 'assistant',
      content: turn.text || null,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    });

    for (const call of turn.toolCalls) {
      const result = await executeTool({ call, callTool, emit });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: result.text,
      });
    }
  }

  if (rounds >= MAX_ROUNDS) {
    emit({
      type: 'notice',
      text: `Stopped after ${MAX_ROUNDS} tool rounds. Ask me to continue if I was making progress.`,
    });
  }

  emit({ type: 'done', text: finalText });
  return { text: finalText, messages };
}

async function executeTool({ call, callTool, emit }) {
  emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
  let result;
  try {
    result = await callTool(call.name, call.args);
  } catch (err) {
    result = { isError: true, text: `Tool failed: ${err?.message || err}` };
  }
  emit({
    type: 'tool_result',
    id: call.id,
    name: call.name,
    text: result.text,
    isError: result.isError,
  });
  return result;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions (streaming)
// ---------------------------------------------------------------------------

async function callOpenAICompatible({ config, messages, tools, emit }) {
  const url = joinUrl(config.baseUrl, '/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const body = {
    model: config.model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    tools: toOpenAITools(tools),
    tool_choice: 'auto',
    stream: true,
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new AssistantError(`AI endpoint error ${res.status}: ${await res.text().catch(() => '')}`, {
      code: 'llm_http_error',
    });
  }
  if (!res.body) throw new AssistantError('AI endpoint returned no body.', { code: 'llm_no_body' });

  let text = '';
  // tool_calls arrive as deltas keyed by `index`; accumulate then parse at the end.
  const partialCalls = new Map();
  let finishReason = null;

  for await (const evt of parseSSE(res.body)) {
    if (evt === '[DONE]') break;
    let payload;
    try {
      payload = JSON.parse(evt);
    } catch {
      continue;
    }
    if (payload.error) {
      throw new AssistantError(payload.error.message || 'AI endpoint error.', { code: 'llm_error' });
    }
    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      emit({ type: 'text', delta: delta.content });
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const existing = partialCalls.get(idx) || { id: null, name: '', args: '' };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name += tc.function.name;
      if (tc.function?.arguments) existing.args += tc.function.arguments;
      partialCalls.set(idx, existing);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const toolCalls = [...partialCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, c]) => ({
      id: c.id || `call_${randomUUID()}`,
      name: c.name,
      args: safeParse(c.args),
    }))
    .filter((c) => c.name);

  if (toolCalls.length) emit({ type: 'tool_calls_planned', count: toolCalls.length, finishReason });
  return { text, toolCalls };
}

// ---------------------------------------------------------------------------
// Anthropic messages API (streaming)
// ---------------------------------------------------------------------------

async function callAnthropic({ config, messages, tools, emit }) {
  const base = config.baseUrl || 'https://api.anthropic.com';
  const url = joinUrl(base, '/v1/messages');
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (config.apiKey) headers['x-api-key'] = config.apiKey;

  const body = {
    model: config.model,
    max_tokens: config.maxTokens || 2048,
    system: SYSTEM_PROMPT,
    messages: messages.map((m) => normalizeAnthropicMessage(m)),
    tools: toAnthropicTools(tools),
    stream: true,
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new AssistantError(`Anthropic error ${res.status}: ${await res.text().catch(() => '')}`, {
      code: 'llm_http_error',
    });
  }
  if (!res.body) throw new AssistantError('Anthropic returned no body.', { code: 'llm_no_body' });

  let text = '';
  const blocks = new Map(); // index -> {type, id, name, json}
  let stopReason = null;

  for await (const evt of parseSSE(res.body)) {
    let payload;
    try {
      payload = JSON.parse(evt);
    } catch {
      continue;
    }
    if (payload.type === 'content_block_start') {
      const cb = payload.content_block || {};
      blocks.set(payload.index, {
        type: cb.type,
        id: cb.id,
        name: cb.name,
        json: '',
      });
    } else if (payload.type === 'content_block_delta') {
      const block = blocks.get(payload.index) || {};
      if (payload.delta?.type === 'text_delta') {
        text += payload.delta.text;
        emit({ type: 'text', delta: payload.delta.text });
      } else if (payload.delta?.type === 'input_json_delta') {
        block.json = (block.json || '') + (payload.delta.partial_json || '');
        blocks.set(payload.index, block);
      }
    } else if (payload.type === 'message_delta' && payload.delta?.stop_reason) {
      stopReason = payload.delta.stop_reason;
    }
  }

  const rawBlocks = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => {
      if (b.type === 'tool_use') {
        return { type: 'tool_use', id: b.id, name: b.name, input: safeParse(b.json) };
      }
      return { type: 'text', text: '' };
    })
    .filter((b, i) => b.type === 'tool_use' || (blocks.get([...blocks.keys()].sort((x, y) => x - y)[i]) || {}).type === 'text');

  const toolCalls = [...blocks.values()]
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id || `call_${randomUUID()}`, name: b.name, args: safeParse(b.json) }));

  if (toolCalls.length) emit({ type: 'tool_calls_planned', count: toolCalls.length, finishReason: stopReason });
  return { text, toolCalls, rawBlocks };
}

/** Flatten our stored history into Anthropic's alternating user/assistant shape. */
function normalizeAnthropicMessage(m) {
  if (m.role === 'user') {
    return { role: 'user', content: String(m.content ?? '') };
  }
  if (m.role === 'assistant') {
    if (typeof m.content === 'string') return { role: 'assistant', content: m.content };
    return m.content; // already structured (tool_use blocks)
  }
  // tool results are carried on the following user message in our stored shape
  return { role: 'user', content: JSON.stringify(m.content) };
}

// ---------------------------------------------------------------------------

/** Minimal SSE reader over a fetch body stream. */
async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    // Events are separated by a blank line; data lines may repeat.
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = rawEvent
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length) yield dataLines.join('\n');
    }
  }
  const tail = buffer
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart());
  if (tail.length) yield tail.join('\n');
}

function safeParse(json) {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

module.exports = { runAssistantTurn, AssistantError, SYSTEM_PROMPT };
