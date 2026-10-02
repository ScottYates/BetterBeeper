'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { BrowserWindow, shell } = require('electron');
const { OAUTH, TIMING } = require('./config');

const CLIENT_NAME = 'Beeper Desktop Chat';
const CLIENT_URI = 'https://developers.beeper.com/desktop-api/';

function base64url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function createCodeVerifier() {
  // 32 random bytes -> 43 chars, inside the RFC 7636 43..128 range.
  return base64url(crypto.randomBytes(32));
}

function createCodeChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function randomState() {
  return base64url(crypto.randomBytes(16));
}

/** Turns a http(s) base URL into the ws(s) equivalent. */
function toWebSocketUrl(httpUrl) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

class AuthError extends Error {
  constructor(message, { code = 'auth_failed', cause } = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * RFC 7591 dynamic client registration against the local Beeper server.
 * Beeper only supports public clients (token_endpoint_auth_method "none"),
 * which is exactly what a desktop app should use.
 */
async function registerClient(baseUrl, redirectUri) {
  const res = await fetch(new URL(OAUTH.registerPath, baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      client_uri: CLIENT_URI,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: OAUTH.scope,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AuthError(`Client registration failed (${res.status}): ${detail}`, { code: 'register_failed' });
  }
  return res.json();
}

/**
 * A throwaway loopback HTTP listener that catches the OAuth redirect.
 * Beeper's authorize endpoint is itself a localhost URL, so we bind an
 * ephemeral port and register exactly that redirect URI each run.
 */
function startCallbackServer() {
  return new Promise((resolve, reject) => {
    const received = { code: null, error: null, state: null };
    let settled = false;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      received.code = url.searchParams.get('code');
      received.error = url.searchParams.get('error');
      received.errorDescription = url.searchParams.get('error_description');
      received.state = url.searchParams.get('state');

      const body = received.error
        ? `<h1>Authorization failed</h1><p>${escapeHtml(
            received.errorDescription || received.error,
          )}</p><p>You can close this window.</p>`
        : '<h1>Connected</h1><p>Return to Beeper Desktop Chat. You can close this window.</p>';

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Beeper Desktop Chat</title>
        <body style="font:16px system-ui;padding:40px">${body}</body>`);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      resolve({
        redirectUri,
        /** Resolves once Beeper redirects back with an authorization code. */
        waitForResult(timeoutMs = TIMING.authTimeoutMs) {
          return new Promise((resolveWait, rejectWait) => {
            const started = Date.now();
            const tick = () => {
              if (received.code || received.error) {
                cleanup();
                server.close();
                resolveWait(received);
                return;
              }
              if (Date.now() - started > timeoutMs) {
                cleanup();
                server.close();
                rejectWait(new AuthError('Timed out waiting for authorization in Beeper.', {
                  code: 'auth_timeout',
                }));
                return;
              }
              timer = setTimeout(tick, 150);
            };
            let timer = setTimeout(tick, 150);
            const cleanup = () => clearTimeout(timer);
          });
        },
        close() {
          server.close();
        },
      });
    });
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

async function exchangeCode({ baseUrl, clientId, code, codeVerifier, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });

  const res = await fetch(new URL(OAUTH.tokenPath, baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AuthError(`Token exchange failed (${res.status}): ${detail}`, { code: 'token_failed' });
  }
  return res.json();
}

/**
 * Full interactive PKCE login. Opens Beeper's own approval page in a dedicated
 * window; the user clicks "Allow" there and we catch the redirect.
 */
async function authorize({ baseUrl, parentWindow }) {
  const callback = await startCallbackServer();
  try {
    const client = await registerClient(baseUrl, callback.redirectUri);
    const codeVerifier = createCodeVerifier();
    const state = randomState();

    const authorizeUrl = new URL(OAUTH.authorizePath, baseUrl);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', callback.redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', OAUTH.scope);
    authorizeUrl.searchParams.set('code_challenge', createCodeChallenge(codeVerifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);

    const authWindow = new BrowserWindow({
      width: 720,
      height: 760,
      parent: parentWindow ?? undefined,
      modal: parentWindow ? true : false,
      autoHideMenuBar: true,
      title: 'Authorize Beeper Desktop Chat',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    // External links in the approval page should open in the real browser.
    authWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    const waitForResult = callback.waitForResult(TIMING.authTimeoutMs);

    try {
      await authWindow.loadURL(authorizeUrl.toString());
    } catch (err) {
      callback.close();
      throw new AuthError(`Could not open the Beeper approval page: ${err.message}`, {
        code: 'authorize_failed',
        cause: err,
      });
    }

    // Racing against the window closing means a dismissed dialog fails fast
    // instead of waiting out the full authorization timeout.
    const dismissed = new Promise((_, reject) => {
      authWindow.on('closed', () =>
        reject(
          new AuthError('The authorization window was closed before you approved access.', {
            code: 'window_closed',
          }),
        ),
      );
    });

    const result = await Promise.race([waitForResult, dismissed]);

    if (result.error) {
      throw new AuthError(result.errorDescription || result.error, { code: 'access_denied' });
    }
    if (result.state !== state) {
      throw new AuthError('OAuth state mismatch - possible CSRF, aborting.', { code: 'state_mismatch' });
    }
    if (!result.code) {
      throw new AuthError('Beeper did not return an authorization code.', { code: 'no_code' });
    }

    const tokens = await exchangeCode({
      baseUrl,
      clientId: client.client_id,
      code: result.code,
      codeVerifier,
      redirectUri: callback.redirectUri,
    });

    return {
      accessToken: tokens.access_token,
      tokenType: tokens.token_type || 'Bearer',
      scope: tokens.scope || OAUTH.scope,
      obtainedAt: Date.now(),
      expiresIn: typeof tokens.expires_in === 'number' ? tokens.expires_in : null,
    };
  } finally {
    // The auth window deliberately stays open showing Beeper's
    // "connected" confirmation; the user closes it.
    try {
      callback.close();
    } catch {
      /* already closed */
    }
  }
}

/** Manual escape hatch: validate a token the user pasted from Beeper settings. */
async function verifyManualToken({ baseUrl, accessToken }) {
  const res = await fetch(new URL(OAUTH.userinfoPath, baseUrl), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new AuthError(`Beeper rejected that token (${res.status}).`, { code: 'invalid_token' });
  }
  const info = await res.json().catch(() => ({}));
  return {
    accessToken,
    tokenType: 'Bearer',
    scope: OAUTH.scope,
    obtainedAt: Date.now(),
    expiresIn: null,
    identity: info,
  };
}

async function revoke({ baseUrl, accessToken }) {
  try {
    const res = await fetch(new URL(OAUTH.revokePath, baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: accessToken }),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

module.exports = {
  AuthError,
  authorize,
  verifyManualToken,
  revoke,
  toWebSocketUrl,
  base64url,
};
