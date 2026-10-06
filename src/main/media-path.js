'use strict';

/**
 * Turning a renderer-facing image URL into bytes we can put on the clipboard.
 *
 * The renderer runs with contextIsolation and no Node, so it can only hand us a
 * URL and let the main process work out what that URL actually points at. Two
 * things make that worth isolating here:
 *
 *  - the scheme allowlist is a security boundary. Anything that is not a local
 *    file or a data URL must never be read, or a remote URL handed in by a
 *    message could turn "copy this image" into "fetch this URL".
 *  - the beeper-file path is reconstructed by hand, because the app writes
 *    beeper-file://local/C:/Users/... and node's own file helpers cannot parse
 *    a non-standard scheme.
 *
 * Kept free of Electron imports so it can be unit tested with plain node.
 */

const { fileURLToPath } = require('node:url');

/** Schemes the renderer may ask us to read. Everything else is refused. */
const COPYABLE_SCHEMES = /^(beeper-file|file|data):/i;

/** True when this URL is one the renderer is allowed to have copied. */
function isCopyableUrl(srcURL) {
  return typeof srcURL === 'string' && COPYABLE_SCHEMES.test(srcURL);
}

/**
 * beeper-file://local/C:/Users/scott/photo.png -> C:\Users\scott\photo.png
 *
 * Mirrors the protocol handler in main.js, including its tolerance for callers
 * that drop the fixed "local" host.
 */
function beeperFilePath(srcURL) {
  let url;
  try {
    url = new URL(srcURL);
  } catch {
    return null;
  }

  let filePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!filePath && url.hostname && url.hostname !== 'local') {
    filePath = decodeURIComponent(url.hostname + url.pathname);
  }
  if (!filePath) return null;
  if (process.platform === 'win32') filePath = filePath.replace(/\//g, '\\');
  return filePath;
}

/** The filesystem path behind a beeper-file: or file: URL, or null. */
function localPathFrom(srcURL) {
  if (/^beeper-file:/i.test(srcURL)) return beeperFilePath(srcURL);
  if (/^file:/i.test(srcURL)) {
    try {
      return fileURLToPath(srcURL);
    } catch {
      return null;
    }
  }
  return null;
}

/** Decode a data: URL into a Buffer, base64 or percent-encoded. */
function dataUrlBuffer(srcURL) {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(srcURL);
  if (!match) return null;
  try {
    return match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  } catch {
    return null;
  }
}

/** Longest name we will suggest. Comfortably inside every filesystem limit. */
const MAX_NAME_LENGTH = 180;

/**
 * Turn a filename that arrived inside a message into one that is safe to
 * suggest in a save dialog.
 *
 * This is a security boundary, not a tidy-up. `fileName` is chosen by whoever
 * sent the message, and it is handed to `defaultPath` - so an attacker could
 * send `..\..\..\Windows\System32\drivers\etc\hosts` and have the dialog start
 * somewhere else entirely, or send an absolute path and have the user believe
 * they are saving into their Downloads folder when they are not.
 *
 * So the result is always a bare filename in whatever directory the user
 * actually picks, with no separators, no control characters, no reserved
 * Windows device name, and nothing Windows itself would reject.
 */
function safeFileName(raw, fallback = 'attachment') {
  const text = typeof raw === 'string' ? raw : '';

  // Split first: this is what removes directories, including the "..\..\" case
  // that survives naive character filtering.
  const base = text.split(/[\\/]/).pop() || '';

  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '') // control characters
    .replace(/[<>:"|?*]/g, '_') // reserved on Windows
    .replace(/[. ]+$/, '') // Windows silently drops these, so do not offer them
    .trim();

  // A bare "CON" is a device, not a filename, and Windows refuses it - and so
  // it refuses "con.txt", because the reserved word is the stem either way.
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) return fallback;

  return cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(0, MAX_NAME_LENGTH) : cleaned;
}

/**
 * Beeper is inconsistent about local media locations: message attachments come
 * back as `file:///C:/...` URLs, while chat avatars are bare filesystem paths
 * such as `C:\Users\...`. Both mean "a file on this machine".
 *
 * They are rewritten to `beeper-file://local/<path>`. The fixed `local` host
 * keeps the drive letter inside the path segment, so a Windows drive can never
 * be mistaken for a URL hostname.
 *
 * Anything already usable over http or data is passed straight through.
 */
function localMediaUrl(raw) {
  if (!raw) return null;
  const value = String(raw);

  // Anything already carrying a scheme the renderer can load is left alone.
  // beeper-file: matters most: it is what this function itself produces, so a
  // value that already has one must not be rewritten or reported as unknown.
  // http(s) and data: were already passed through. Deliberately not a general
  // "has a scheme" test, because "C:\Users" also looks like one and is a path.
  if (/^(https?|data|beeper-file):/i.test(value)) return value;

  let filePath = null;
  if (/^file:\/\//i.test(value)) {
    filePath = decodeURIComponentSafe(value.replace(/^file:\/\/\/?/i, ''));
  } else if (/^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')) {
    filePath = value;
  } else if (value.startsWith('/')) {
    filePath = value;
  }
  if (!filePath) return null;

  return `beeper-file://local/${filePath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

/** Passes anything already usable (http/data) through untouched. */
function toRendererUrl(raw) {
  return localMediaUrl(raw) ?? String(raw);
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

module.exports = {
  isCopyableUrl,
  beeperFilePath,
  localPathFrom,
  dataUrlBuffer,
  safeFileName,
  localMediaUrl,
  toRendererUrl,
};
