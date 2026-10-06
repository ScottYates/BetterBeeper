'use strict';

const { EventEmitter } = require('node:events');

/**
 * MCP client for Beeper's built-in MCP server.
 *
 * The chat UI talks to the REST API + WebSocket directly (cheaper, typed, and
 * realtime). The MCP server is Beeper's agent-facing surface: it already
 * publishes a schema for every capability, which is why it exists as a client
 * at all.
 *
 * The assistant that used to drive these tools is gone. The connection is kept
 * because the app reports MCP status at startup and Settings can list the
 * catalogue, so Beeper's server is still worth being able to reach.
 *
 * Auth: per the Beeper docs, MCP authentication is bypassed when a valid
 * Bearer token is supplied, so we forward the same OAuth token.
 */
class McpClient extends EventEmitter {
  constructor({ getToken, getMcpUrl }) {
    super();
    this.getToken = getToken;
    this.getMcpUrl = getMcpUrl;
    this.client = null;
    this.transport = null;
    this.status = 'idle';
    this.tools = [];
  }

  #setStatus(status, detail) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', { status, detail });
  }

  async connect() {
    const token = this.getToken();
    if (!token) {
      this.#setStatus('unauthenticated', 'Connect to Beeper to reach its MCP server.');
      return { ok: false, error: 'Not connected to Beeper.' };
    }
    if (this.client) {
      // Already connected - make sure the tool catalogue is still populated.
      if (!this.tools.length) await this.refreshTools().catch(() => {});
      return { ok: true, tools: this.tools };
    }

    this.#setStatus('connecting');
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );

      this.client = new Client(
        { name: 'beeper-desktop-chat', version: '1.0.0' },
        { capabilities: {} },
      );

      this.transport = new StreamableHTTPClientTransport(new URL(this.getMcpUrl()), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json, text/event-stream',
          },
        },
      });

      this.client.onerror = (err) => this.#setStatus('error', err?.message || String(err));
      this.client.onclose = () => {
        this.client = null;
        this.transport = null;
        this.#setStatus('disconnected', 'MCP connection closed.');
      };

      await this.client.connect(this.transport);
      await this.refreshTools();
      this.#setStatus('connected', `${this.tools.length} tools available`);
      return { ok: true, tools: this.tools };
    } catch (err) {
      this.client = null;
      this.transport = null;
      this.#setStatus('error', err?.message || String(err));
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async refreshTools() {
    if (!this.client) return [];
    const res = await this.client.listTools();
    this.tools = (res.tools || []).map((t) => ({
      name: t.name,
      title: t.title || t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    this.#setStatus('connected', `${this.tools.length} tools available`);
    return this.tools;
  }

  async callTool(name, args = {}) {
    if (!this.client) {
      const ok = await this.connect();
      if (!ok.ok) throw new Error(ok.error);
    }
    const res = await this.client.callTool({ name, arguments: args });
    return normalizeToolResult(res);
  }

  async disconnect() {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.#setStatus('idle');
  }
}

/** Flattens MCP content blocks into a string the assistant can reason over. */
function normalizeToolResult(res) {
  const parts = [];
  const structured = res?.structuredContent;

  if (structured) {
    try {
      parts.push(JSON.stringify(structured, null, 2));
    } catch {
      /* fall through to content blocks */
    }
  }

  for (const block of res?.content || []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image omitted]');
    else if (block.type === 'resource') {
      parts.push(`[resource] ${block.resource?.uri || ''}\n${block.resource?.text || ''}`);
    }
  }

  if (!parts.length) parts.push(JSON.stringify(res ?? {}, null, 2));

  return {
    isError: Boolean(res?.isError),
    text: parts.join('\n\n'),
  };
}

module.exports = { McpClient, normalizeToolResult };
