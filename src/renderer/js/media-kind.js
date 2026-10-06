/**
 * Deciding what an attachment is, so the thread can draw it the right way.
 *
 * Beeper is inconsistent about this. An attachment may arrive with a mime type,
 * with only a filename, or with Beeper's own `type: "img"` shorthand and no mime
 * type at all - and chat attachments very often carry the useless
 * `application/octet-stream` rather than anything specific. So a specific mime
 * type wins, the extension is the fallback, and a generic mime type is treated
 * as no information at all rather than as a claim.
 *
 * Anything still unrecognised is deliberately a plain file. Guessing wrong
 * renders a broken image box or a player that never plays, both of which are
 * worse than an honest row that offers to save the file.
 *
 * No DOM and no imports, so it can be exercised by a check without a browser.
 */

/**
 * Extensions worth playing or showing inline when Beeper gave us nothing else.
 * Deliberately generous: a wrong entry costs one decode attempt and falls back
 * to the download row, while a missing entry costs the feature entirely.
 */
const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif',
  'svg', 'tif', 'tiff', 'ico', 'apng',
]);

const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'wmv', 'asf', 'flv', 'ogv',
  'mpg', 'mpeg', 'm2v', 'm2ts', 'mts', 'ts', '3gp', '3g2', 'vob', 'divx', 'rm',
  'rmvb', 'mxf',
]);

/**
 * The lowercased extension of an attachment's filename, or "" if it has none.
 *
 * A stem is required, so ".mp4" is treated as having no extension rather than
 * as one - the same rule Python's splitext applies, and the only sensible one:
 * a name starting with a dot is a dotfile, and on Windows ".mp4" is not even a
 * legal filename.
 */
export function mediaExtension(attachment) {
  const name = String(attachment?.fileName || attachment?.name || '').trim();
  const match = /^.+\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

/**
 * "image", "video", or "file".
 *
 * The order matters: a real mime type beats everything, then Beeper's own
 * shorthand, then the extension. Checking the mime prefix before the
 * `application/` fallback is what keeps `application/octet-stream` from
 * shadowing a perfectly good `.mp4` extension.
 */
export function mediaKind(attachment) {
  if (!attachment || typeof attachment !== 'object') return 'file';

  const mime = String(attachment.mimeType || attachment.mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';

  const type = String(attachment.type || '').trim().toLowerCase();
  if (type === 'img' || type === 'image') return 'image';
  if (type === 'video') return 'video';

  const ext = mediaExtension(attachment);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';

  return 'file';
}

/** True for exactly the two kinds that are shown inline rather than saved. */
export function isPlayable(attachment) {
  const kind = mediaKind(attachment);
  return kind === 'image' || kind === 'video';
}