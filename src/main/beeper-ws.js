'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { TIMING } = require('./config');
const { toWebSocketUrl } = require('./auth');

/**
 * Live event stream from Beeper Desktop.
 *
 * Protocol (from GET /v1/info -> ws_events, then the server's ready frame):
 *   client -> {"type":"subscriptions.set","requestID","chatIDs":[],"app":{"state":true}}
 *   server -> ready | subscriptions.updated | chat.upserted | chat.deleted
 *            | message.upserted | message.deleted | app.state.updated
 *            | verification.updated | verification.removed | error
 *
 * `ws` is used rather than Node's global WebSocket because the latter cannot
 * attach an Authorization header.
 */
class BeeperEvents extends EventEmitter {
  constructor({ getToken, getWsUrl }) {
    super();
    this.getToken = getToken;
    this.getWsUrl = getWsUrl;
    this.ws = null;
    this.status = 'idle';
    this.subscribedChatIDs = new Set();
    this.attempt = 0;
    this.closedByUs = false;
    this.retryTimer = null;
    this.recentFrames = [];
    this.readyChatIDs = [];
    this.lastSubscriptionAck = null;
    this.lastProtocolError = null;
  }

  #setStatus(status, detail) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', { status, detail });
  }

  connect() {
    this.closedByUs = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const token = this.getToken();
    if (!token) {
      this.#setStatus('unauthenticated', 'Connect to Beeper to receive live messages.');
      return;
    }

    const url = this.getWsUrl();
    this.#setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      this.#setStatus('error', err.message);
      this.#scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.#setStatus('connected');
      this.#sendSubscriptions();
    });

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.#handleFrame(frame);
    });

    ws.on('error', (err) => {
      this.#setStatus('error', err.message);
    });

    ws.on('close', (code, reasonBuf) => {
      this.ws = null;
      const reason = reasonBuf?.toString?.() || '';
      if (this.closedByUs) {
        this.#setStatus('idle');
        return;
      }
      // 4001/4003-style auth rejections should not spin the retry loop.
      this.#setStatus('disconnected', reason || `socket closed (${code})`);
      this.#scheduleRetry();
    });
  }

  #handleFrame(frame) {
    // Small ring buffer so the UI can show what the socket is actually doing.
    this.recentFrames.push({ type: frame?.type, chatID: frame?.chatID, ids: frame?.ids?.length, at: Date.now() });
    if (this.recentFrames.length > 50) this.recentFrames.shift();

    switch (frame.type) {
      case 'ready':
        this.attempt = 0;
        this.readyChatIDs = frame.chatIDs || [];
        this.#setStatus('ready');
        this.emit('ready', frame);
        break;
      case 'subscriptions.updated':
        this.lastSubscriptionAck = frame;
        this.emit('subscriptions', frame);
        break;
      case 'error':
        this.lastProtocolError = frame;
        this.emit('protocol-error', frame);
        break;
      default:
        // chat.upserted / chat.deleted / message.upserted / message.deleted
        // app.state.updated / verification.*
        this.emit(frame.type, frame);
        this.emit('event', frame);
    }
  }

  /** Diagnostic snapshot of the socket, surfaced over IPC. */
  debugState() {
    return {
      status: this.status,
      url: this.getWsUrl(),
      readyChatIDs: this.readyChatIDs || [],
      subscribed: [...this.subscribedChatIDs],
      lastSubscriptionAck: this.lastSubscriptionAck || null,
      lastProtocolError: this.lastProtocolError || null,
      recentFrames: this.recentFrames.slice(-20),
    };
  }

  #sendSubscriptions() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'subscriptions.set',
        requestID: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatIDs: [...this.subscribedChatIDs],
        app: { state: true },
      }),
    );
  }

  /**
   * Beeper streams message.upserted for chats we are subscribed to. We
   * subscribe to the open chat plus every chat in the visible list, capped to
   * keep the frame small.
   */
  setSubscriptions(chatIDs) {
    const next = new Set((chatIDs || []).filter(Boolean).slice(0, 100));
    const same =
      next.size === this.subscribedChatIDs.size &&
      [...next].every((id) => this.subscribedChatIDs.has(id));
    if (same) return;
    this.subscribedChatIDs = next;
    this.#sendSubscriptions();
  }

  #scheduleRetry() {
    if (this.retryTimer) return;
    const delay = Math.min(
      TIMING.wsRetryMinMs * 2 ** this.attempt,
      TIMING.wsRetryMaxMs,
    );
    this.attempt += 1;
    this.#setStatus('reconnecting', `Retrying in ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closedByUs) this.connect();
    }, delay);
  }

  disconnect() {
    this.closedByUs = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.#setStatus('idle');
  }
}

module.exports = { BeeperEvents };
