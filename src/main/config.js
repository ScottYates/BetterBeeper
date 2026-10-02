'use strict';

/**
 * Runtime configuration for the Beeper Desktop integration.
 *
 * Beeper Desktop runs a local HTTP server. We discover the real endpoints at
 * startup via the unauthenticated GET /v1/info call, but keep sensible
 * fallbacks so the app can still render a useful "start Beeper" message if
 * discovery fails.
 */

const DEFAULT_BASE_URL = 'http://localhost:23373';

const ENDPOINTS = {
  info: '/v1/info',
  accounts: '/v1/accounts',
  accountsContacts: (accountID) => `/v1/accounts/${encodeURIComponent(accountID)}/contacts/list`,
  chats: '/v1/chats',
  chatsSearch: '/v1/chats/search',
  chat: (chatID) => `/v1/chats/${encodeURIComponent(chatID)}`,
  chatArchive: (chatID) => `/v1/chats/${encodeURIComponent(chatID)}/archive`,
  chatRead: (chatID) => `/v1/chats/${encodeURIComponent(chatID)}/read`,
  chatUnread: (chatID) => `/v1/chats/${encodeURIComponent(chatID)}/unread`,
  messages: (chatID) => `/v1/chats/${encodeURIComponent(chatID)}/messages`,
  message: (chatID, messageID) =>
    `/v1/chats/${encodeURIComponent(chatID)}/messages/${encodeURIComponent(messageID)}`,
  messageReactions: (chatID, messageID) =>
    `/v1/chats/${encodeURIComponent(chatID)}/messages/${encodeURIComponent(messageID)}/reactions`,
  messageReaction: (chatID, messageID, reactionKey) =>
    `/v1/chats/${encodeURIComponent(chatID)}/messages/${encodeURIComponent(messageID)}` +
    `/reactions/${encodeURIComponent(reactionKey)}`,
  messagesSearch: '/v1/messages/search',
  search: '/v1/search',
  assetsUpload: '/v1/assets/upload',
  assetsUploadBase64: '/v1/assets/upload/base64',
  assetsDownload: '/v1/assets/download',
  assetsServe: '/v1/assets/serve',
};

// OAuth 2.0 + PKCE (RFC 7636). Beeper's local server is a public client:
// token_endpoint_auth_method is "none" and only S256 challenges are offered.
const OAUTH = {
  scope: 'read write',
  registerPath: '/oauth/register',
  authorizePath: '/oauth/authorize',
  tokenPath: '/oauth/token',
  revokePath: '/oauth/revoke',
  userinfoPath: '/oauth/userinfo',
  introspectPath: '/oauth/introspect',
};

const TIMING = {
  // User has to click "approve" inside Beeper, so be generous.
  authTimeoutMs: 5 * 60 * 1000,
  requestTimeoutMs: 30 * 1000,
  // Base delay for the WebSocket reconnect backoff.
  wsRetryMinMs: 1000,
  wsRetryMaxMs: 30 * 1000,
};

const PAGE = {
  chats: 50,
  messages: 50,
  searchChats: 50,
  // Beeper rejects message searches asking for more than 20 results with a 400.
  searchMessages: 20,
  contacts: 50,
};

module.exports = { DEFAULT_BASE_URL, ENDPOINTS, OAUTH, TIMING, PAGE };
