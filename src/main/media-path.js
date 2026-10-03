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

module.exports = {
  isCopyableUrl,
  beeperFilePath,
  localPathFrom,
  dataUrlBuffer,
};
