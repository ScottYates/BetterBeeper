'use strict';

/**
 * The app's own copy of the media its history refers to.
 *
 * Beeper's attachments point at files in Beeper's cache. That cache is not a
 * permanent record - it gets evicted - so a photo that was perfectly renderable
 * last month stops appearing, and the message that held it is left describing
 * something that is gone.
 *
 * Copying the bytes here is what makes the history genuinely self-contained.
 * They are stored content-addressed: the same photo sent twice occupies one
 * file, and a file sent again after Beeper dropped it is recognised rather
 * than duplicated.
 *
 * Two rules, both from the fact that a filename arrives inside a message and is
 * therefore chosen by whoever sent it:
 *
 *  - nothing on disk is ever named from the message. The name is a hash, so
 *    there is no path for a crafted filename to escape.
 *  - adopting a file never throws. A picture that will not copy must not be
 *    allowed to fail the message sync that carries it.
 *
 * No Electron imports, so it unit-tests under plain node.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/** Extensions worth keeping, so we do not store "blob" for everything. */
const KEEP_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'svg',
  'tif', 'tiff', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'mp3',
  'm4a', 'ogg', 'oga', 'wav', 'flac', 'pdf', 'txt', 'zip',
]);

function safeExt(fileName) {
  const match = /^[A-Za-z0-9]{1,8}$/.exec(String(fileName || '').slice(-9).replace(/^\./, ''));
  return match && KEEP_EXT.has(match[0].toLowerCase()) ? '.' + match[0].toLowerCase() : '';
}

function openMediaStore(userDataDir) {
  const root = path.join(userDataDir, 'history-media');
  let bytes = 0;

  const measure = () => {
    let total = 0;
    try {
      for (const shard of fs.readdirSync(root, { withFileTypes: true })) {
        if (!shard.isDirectory()) continue;
        const dir = path.join(root, shard.name);
        for (const name of fs.readdirSync(dir)) {
          try {
            total += fs.statSync(path.join(dir, name)).size;
          } catch {
            /* a file went away underneath us; it does not count */
          }
        }
      }
    } catch {
      /* no media yet */
    }
    bytes = total;
    return total;
  };

  return {
    root,

    /**
     * Copy a file in, unless its bytes are already here.
     *
     * Returns { hash, relativePath, bytes } or null. Never throws: a failure
     * here is a missing picture, not a lost message.
     */
    adopt(filePath, fileName) {
      try {
        const bytesIn = fs.readFileSync(filePath);
        const hash = crypto.createHash('sha256').update(bytesIn).digest('hex');
        const relative = path.join(hash.slice(0, 2), hash + safeExt(fileName));

        const target = path.join(root, relative);
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          // Write beside the target and rename, so an interrupted copy cannot
          // leave a half-written file that later reads as a corrupt picture.
          const staging = `${target}.part`;
          fs.writeFileSync(staging, bytesIn);
          fs.renameSync(staging, target);
          bytes += bytesIn.length;
        }

        return { hash, relativePath: relative, bytes: bytesIn.length };
      } catch {
        return null;
      }
    },

    has(hash) {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return false;
      try {
        return fs.readdirSync(path.join(root, hash.slice(0, 2))).includes(hash);
      } catch {
        return false;
      }
    },

    /** Absolute path for a stored hash, or null when it is not there. */
    pathFor(hash, ext = '') {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
      const suffix = safeExt('x' + ext);
      for (const candidate of suffix ? [hash + suffix, hash] : [hash]) {
        const full = path.join(root, hash.slice(0, 2), candidate);
        try {
          fs.accessSync(full, fs.constants.R_OK);
          return full;
        } catch {
          /* try the next spelling */
        }
      }
      return null;
    },

    /** A file:// URL the renderer can load through the beeper-file protocol. */
    urlFor(hash, ext = '') {
      const full = this.pathFor(hash, ext);
      if (!full) return null;
      return 'file:///' + full.replace(/\\/g, '/').replace(/^\/+/, '');
    },

    count() {
      let n = 0;
      try {
        for (const shard of fs.readdirSync(root, { withFileTypes: true })) {
          if (!shard.isDirectory()) continue;
          n += fs.readdirSync(path.join(root, shard.name)).length;
        }
      } catch {
        /* none */
      }
      return n;
    },

    totalBytes() {
      return measure();
    },
  };
}

module.exports = { openMediaStore, safeExt };