'use strict';

/**
 * Working out where an attachment's bytes actually are.
 *
 * Beeper describes the same file in several shapes depending on where it came
 * from: a bare Windows path, a file:// URL, a beeper-file:// URL, a remote
 * asset id that only means anything to the bridge, or an https URL for media
 * hosted by a network. Saving has to cope with all of them, and it has to cope
 * with them in the right order - copying a local file is free, and only the
 * remote case is worth a network read.
 *
 * Split out of ipc.js rather than left as a closure inside it, because this is
 * the part that decides *what gets written where* and it is the part a check
 * can actually exercise. Everything Electron-specific (the dialog, the copy)
 * stays on the other side of the `download` callback.
 *
 * No Electron imports, so it runs under plain node.
 */

const fs = require('node:fs');

const mediaPath = require('./media-path');

/** True when this is a real file we can copy from right now. */
async function isReadableFile(filePath) {
  if (!filePath) return false;
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an attachment to bytes on this machine.
 *
 * `download(attachment)` is called at most once, and only when the attachment
 * is not already sitting on this disk. It should resolve to whatever Beeper's
 * bridge answered - typically a local path or a file:// URL.
 *
 * Returns {localPath} when the file can be copied, or {url} when it has to be
 * fetched over http. Throws when there is nothing to save at all, so the caller
 * reports a failure rather than writing an empty file.
 */
async function locateAttachment(attachment, download) {
  const direct = mediaPath.localPathFrom(mediaPath.localMediaUrl(attachment.srcURL || attachment.imgURL) || '');
  if (await isReadableFile(direct)) return { localPath: direct };

  const res = await download({
    url: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
  });

  const remote = String(res?.srcURL || '');
  const fetched = mediaPath.localPathFrom(mediaPath.toRendererUrl(remote));
  if (await isReadableFile(fetched)) return { localPath: fetched };
  if (/^https?:/i.test(remote)) return { url: remote };

  throw new Error('Beeper did not return anything that could be saved.');
}

module.exports = { locateAttachment, isReadableFile };