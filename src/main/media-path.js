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

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

/** Schemes the renderer may ask us to read. Everything else is refused. */
const COPYABLE_SCHEMES = /^(beeper-file|file|data):/i;

/** True when this URL is one the renderer is allowed to have copied. */
function isCopyableUrl(srcURL) {
  return typeof srcURL === 'string' && COPYABLE_SCHEMES.test(srcURL);
}

// ---------------------------------------------------------------------------
// Which files beeper-file: is allowed to read.
//
// The renderer cannot see this file system, and it asks for bytes by URL. That
// makes the scheme a capability: anything it will serve, the renderer can read.
// Left unbounded it is a read primitive for the whole disk - one crafted
// attribute in a message, or one string reaching an <img src>, and a file the
// user never shared is being read and drawn in the window.
//
// So the set of readable directories is decided here, in the main process, and
// the renderer never gets to widen it. Two directories actually hold chat
// media, and main.js registers them at startup:
//
//   <userData>/history-media          our own copies, content-addressed
//   <appData>/BeeperTexts             Beeper Desktop's own cache, which is
//                                     where attachments and avatars live until
//                                     we adopt them into the first one
//
// Everything else is refused, including paths inside the user profile that
// look reasonable.
// ---------------------------------------------------------------------------

/** Roots registered by the main process at startup. Empty means refuse all. */
let allowedRoots = [];

/**
 * Register a directory beeper-file: may read from.
 *
 * Both the plain and the symlink-resolved form are kept. Windows user profiles
 * are routinely junctions, so the path Electron hands us and the path the
 * filesystem reports can legitimately differ; checking against one of the two
 * and then requiring the same for the candidate's realpath keeps that from
 * either failing closed on ordinary files or passing through a link.
 */
function allowMediaRoot(root) {
  if (typeof root !== 'string' || !root) return;
  const resolved = path.resolve(root);
  if (!allowedRoots.includes(resolved)) allowedRoots.push(resolved);
  try {
    const real = fs.realpathSync.native(resolved);
    if (!allowedRoots.includes(real)) allowedRoots.push(real);
  } catch {
    // The directory does not exist yet. Beeper creates its cache lazily and we
    // register at startup, so this is ordinary, not an error.
  }
}

/** The registered roots, for diagnostics and for the checks to assert on. */
function allowedMediaRoots() {
  return allowedRoots.slice();
}

/** Windows paths compare case-insensitively; POSIX ones do not. */
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * True when `candidate` is `root` itself or sits inside it.
 *
 * The separator is the whole point. `root + candidate.startsWith(root)` accepts
 * C:\...\history-media-evil\secrets.txt for the root C:\...\history-media, so
 * the comparison has to be against a root that already ends in a separator.
 */
function withinRoot(candidate, root) {
  const c = fold(candidate);
  const r = fold(root.endsWith(path.sep) ? root : root + path.sep);
  return c === fold(root) || c.startsWith(r);
}

/**
 * True when a local path may be served over beeper-file:.
 *
 * Resolved before comparison, so `..` segments cannot walk out of a root, and
 * re-checked through realpath, so a link *inside* an allowed directory cannot
 * point out of it. A path that cannot be resolved is refused rather than
 * assumed safe.
 */
function isAllowedMediaPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  if (!allowedRoots.length) return false;

  const resolved = path.resolve(filePath);
  if (!allowedRoots.some((root) => withinRoot(resolved, root))) return false;

  let real;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    return false;
  }
  return allowedRoots.some((root) => withinRoot(real, root));
}

/**
 * Parse a Range header against a known file size.
 *
 * Returns { start, end } inclusive, or null when the request is not a range
 * this should answer with a partial response. `unsatisfiable` is true when the
 * range is well formed but lies past the end of the file, which is a 416 and
 * not a normal response.
 *
 * This exists because a media player does not read a video through once. It
 * buffers ahead by asking for byte ranges, and it seeks by asking for more, so
 * a handler that answers every request with the whole file hands the demuxer a
 * stream it cannot frame - and the video fails a few seconds in, with a decode
 * error, rather than at the start.
 */
function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  // "bytes=-500" means the final 500 bytes, not an empty range from 0.
  if (rawStart === '') {
    if (rawEnd === '' || size <= 0) return { unsatisfiable: true };
    const want = Number(rawEnd);
    if (!Number.isFinite(want) || want <= 0) return { unsatisfiable: true };
    const start = Math.max(0, size - want);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0) return { unsatisfiable: true };
  if (start >= size) return { unsatisfiable: true };

  let end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(end) || end < start) return { unsatisfiable: true };
  // A client may ask past the end; the spec says clamp rather than fail.
  end = Math.min(end, size - 1);
  return { start, end };
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
  parseRange,
  localPathFrom,
  dataUrlBuffer,
  safeFileName,
  localMediaUrl,
  toRendererUrl,
  allowMediaRoot,
  allowedMediaRoots,
  isAllowedMediaPath,
};
