'use strict';

const { ENDPOINTS, PAGE, TIMING } = require('./config');

class BeeperError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'BeeperError';
    this.status = status ?? 0;
    this.code = code ?? 'beeper_error';
    this.body = body;
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound() {
    return this.status === 404;
  }
}

/**
 * Thin, typed-ish wrapper over the Beeper Desktop REST API.
 *
 * The token is read through a callback on every request so that a re-login
 * takes effect immediately without rebuilding the client.
 */
class BeeperClient {
  constructor({ getToken, getBaseUrl }) {
    this.getToken = getToken;
    this.getBaseUrl = getBaseUrl;
  }

  get baseUrl() {
    return this.getBaseUrl();
  }

  get isAuthenticated() {
    return Boolean(this.getToken());
  }

  buildUrl(path, query) {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
          // Beeper accepts repeated params for array fields (accountIDs, chatIDs...).
          if (value.length) url.searchParams.set(key, value.join(','));
        } else if (typeof value === 'boolean') {
          url.searchParams.set(key, String(value));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url;
  }

  async request(method, path, { query, body, raw, timeoutMs = TIMING.requestTimeoutMs } = {}) {
    const token = this.getToken();
    if (!token && path !== ENDPOINTS.info) {
      throw new BeeperError('Not connected to Beeper yet.', { code: 'unauthenticated' });
    }

    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    let payload;
    if (raw) {
      payload = raw; // caller supplies its own content type (e.g. multipart)
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(this.buildUrl(path, query), {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new BeeperError('Beeper did not respond in time.', { code: 'timeout' });
      }
      throw new BeeperError(
        `Could not reach Beeper Desktop at ${this.baseUrl}. Is it running with the Desktop API enabled?`,
        { code: 'unreachable', cause: err.message },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return null;

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw new BeeperError(describeError(res.status, parsed), {
        status: res.status,
        code: `http_${res.status}`,
        body: parsed,
      });
    }
    return parsed;
  }

  // ---- discovery -------------------------------------------------------

  /** Unauthenticated. Tells us the live base URL, MCP endpoint and WS endpoint. */
  info() {
    return this.request('GET', ENDPOINTS.info);
  }

  // ---- accounts & contacts --------------------------------------------

  listAccounts() {
    return this.request('GET', ENDPOINTS.accounts);
  }

  listContacts(accountID, { query, cursor, direction, limit = PAGE.contacts } = {}) {
    return this.request('GET', ENDPOINTS.accountsContacts(accountID), {
      query: { query, cursor, direction, limit },
    });
  }

  // ---- chats -----------------------------------------------------------

  listChats({ cursor, direction, limit = PAGE.chats, accountIDs } = {}) {
    return this.request('GET', ENDPOINTS.chats, { query: { cursor, direction, limit, accountIDs } });
  }

  searchChats({
    query,
    inbox,
    unreadOnly,
    limit = PAGE.searchChats,
    type = 'any',
    scope = 'titles',
    accountIDs,
    includeMuted,
    cursor,
    direction,
  } = {}) {
    return this.request('GET', ENDPOINTS.chatsSearch, {
      query: {
        query,
        inbox,
        unreadOnly,
        limit,
        type,
        scope,
        accountIDs,
        includeMuted,
        cursor,
        direction,
      },
    });
  }

  getChat(chatID, { maxParticipantCount } = {}) {
    return this.request('GET', ENDPOINTS.chat(chatID), { query: { maxParticipantCount } });
  }

  patchChat(chatID, patch) {
    return this.request('PATCH', ENDPOINTS.chat(chatID), { body: patch });
  }

  archiveChat(chatID, archived = true) {
    return this.request('POST', ENDPOINTS.chatArchive(chatID), { body: { archived } });
  }

  markChatRead(chatID, messageID) {
    return this.request('POST', ENDPOINTS.chatRead(chatID), {
      body: messageID ? { messageID } : {},
    });
  }

  markChatUnread(chatID) {
    return this.request('POST', ENDPOINTS.chatUnread(chatID));
  }

  createChat({ accountID, type, participantIDs, title, messageText }) {
    return this.request('POST', ENDPOINTS.chats, {
      body: { accountID, type, participantIDs, title, messageText },
    });
  }

  /**
   * Walks `hasMore`/cursor pagination transparently. Yields individual items.
   * `oldestCursor` + direction=before is the documented "fetch older" pattern.
   */
  async *paginate(path, query = {}, { max = 200, key = 'items' } = {}) {
    let cursor;
    let direction;
    let count = 0;
    while (count < max) {
      const page = await this.request('GET', path, {
        query: { ...query, cursor, direction, limit: query.limit ?? PAGE.chats },
      });
      if (!page) return;
      const items = page[key] ?? [];
      for (const item of items) {
        yield item;
        count += 1;
        if (count >= max) return;
      }
      if (!page.hasMore) return;
      const next = page.oldestCursor;
      if (!next || next === cursor) return;
      cursor = next;
      direction = 'before';
    }
  }

  // ---- messages --------------------------------------------------------

  listMessages(chatID, { cursor, direction, limit = PAGE.messages } = {}) {
    return this.request('GET', ENDPOINTS.messages(chatID), { query: { cursor, direction, limit } });
  }

  sendMessage(chatID, { text, replyToMessageID, attachment } = {}) {
    const body = {};
    if (text) body.text = text;
    if (replyToMessageID) body.replyToMessageID = replyToMessageID;
    if (attachment) body.attachment = attachment;
    return this.request('POST', ENDPOINTS.messages(chatID), { body });
  }

  getMessage(chatID, messageID) {
    return this.request('GET', ENDPOINTS.message(chatID, messageID));
  }

  editMessage(chatID, messageID, text) {
    return this.request('PUT', ENDPOINTS.message(chatID, messageID), { body: { text } });
  }

  deleteMessage(chatID, messageID) {
    return this.request('DELETE', ENDPOINTS.message(chatID, messageID));
  }

  addReaction(chatID, messageID, reactionKey, transactionID) {
    return this.request('POST', ENDPOINTS.messageReactions(chatID, messageID), {
      body: { reactionKey, transactionID },
    });
  }

  removeReaction(chatID, messageID, reactionKey) {
    return this.request(
      'DELETE',
      ENDPOINTS.messageReaction(chatID, messageID, reactionKey),
    );
  }

  searchMessages({
    query,
    chatIDs,
    accountIDs,
    chatType,
    mediaTypes,
    sender,
    dateAfter,
    dateBefore,
    limit = PAGE.searchMessages,
    cursor,
    direction,
  } = {}) {
    return this.request('GET', ENDPOINTS.messagesSearch, {
      query: {
        query,
        chatIDs,
        accountIDs,
        chatType,
        mediaTypes,
        sender,
        dateAfter,
        dateBefore,
        limit,
        cursor,
        direction,
      },
    });
  }

  // ---- assets ----------------------------------------------------------

  /** Multipart upload. Returns { uploadID, srcURL, mimeType, fileName, ... }. */
  async uploadAsset(filePath) {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    return this.uploadAssetBytes(await fs.readFile(filePath), path.basename(filePath));
  }

  /**
   * Upload bytes that never touched the disk - a pasted screenshot, for one.
   * Both entry points share this so the multipart shape stays identical.
   */
  uploadAssetBytes(data, fileName, mimeType) {
    const form = new FormData();
    const blob = new Blob([data], mimeType ? { type: mimeType } : undefined);
    form.append('file', blob, fileName);
    return this.request('POST', ENDPOINTS.assetsUpload, { raw: form });
  }

  /** Resolve a remote asset (mxc:// ...) into a local file:// URL we can render. */
  downloadAsset({ url, fileName, mimeType, maxBytes }) {
    return this.request('POST', ENDPOINTS.assetsDownload, {
      body: { url, fileName, mimeType, maxBytes },
    });
  }
}

function describeError(status, parsed) {
  if (parsed && typeof parsed === 'object') {
    const message = parsed.message || parsed.error_description || parsed.error;
    if (message) return `Beeper error ${status}: ${message}`;
  }
  if (typeof parsed === 'string' && parsed.trim()) {
    return `Beeper error ${status}: ${parsed.slice(0, 200)}`;
  }
  const known = {
    400: 'Beeper rejected the request as invalid.',
    401: 'The Bearer token was rejected. Please reconnect.',
    403: 'This account or chat does not allow that action.',
    404: 'Not found in Beeper. It may have been deleted or the history not indexed yet.',
    409: 'Beeper reported a conflict.',
    422: 'Beeper could not process the request.',
    429: 'Rate limited by Beeper - slow down and retry shortly.',
    500: 'Beeper hit an internal error.',
    502: 'Beeper could not reach the network bridge for this chat.',
  };
  return known[status] || `Beeper request failed with status ${status}.`;
}

module.exports = { BeeperClient, BeeperError };
