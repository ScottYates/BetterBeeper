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

/**
 * Extensions worth keeping on the filename, so the folder is readable rather
 * than 256 extension-less hashes.
 */
const KEEP_EXT = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif',
  'svg', 'tif', 'tiff', 'ico', 'apng',
  'mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'wmv', 'asf', 'flv', 'ogv',
  'mpg', 'mpeg', 'm2v', 'm2ts', 'mts', 'ts', '3gp', '3g2', 'vob', 'divx', 'rm',
  'rmvb', 'mxf',
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'aiff',
  'pdf', 'txt', 'md', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'csv', 'json', 'xml', 'html', 'htm', 'log',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  'exe', 'msi', 'apk', 'dmg', 'iso', 'bin',
]);

/**
 * Whether an attachment is worth copying here.
 *
 * Everything is. The bytes never reach the database either way - the store
 * keeps message records, and each attachment keeps a hash pointing at a file on
 * disk - so the only question left is whether this machine has a copy at all.
 *
 * It should. A video that has scrolled past will not play from a cache
 * Beeper is free to evict, and a document wanted again next month will not
 * still be sitting in a temp folder. Keeping every attachment beside the
 * database is the whole promise, so this is the one place it lives.
 */
function shouldStore(attachment) {
  return Boolean(attachment);
}

/**
 * The extension to keep on a stored file, or "" when it is not worth keeping.
 *
 * Matches the final dotted segment only. Testing the whole tail of the name
 * instead meant "clip.mp4" never matched, and every file in the folder was
 * written as a bare hash with no extension - which also made the folder
 * impossible to audit by looking at it.
 */
function safeExt(fileName) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(fileName || '').trim());
  return match && KEEP_EXT.has(match[1].toLowerCase()) ? '.' + match[1].toLowerCase() : '';
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
     * here is a missing attachment, not a lost message.
     *
     * `attachment` is the whole attachment rather than just its name, so that
     * one place decides what is worth keeping. A bare name is still accepted.
     */
    adopt(filePath, attachment) {
      try {
        const name = typeof attachment === 'string' ? attachment : attachment?.fileName;
        // A missing name only costs us the extension, not the file.
        if (!shouldStore(attachment ?? name)) return null;

        const bytesIn = fs.readFileSync(filePath);
        const hash = crypto.createHash('sha256').update(bytesIn).digest('hex');

        // Dedup on the content, not on the spelling. The same photo sent twice
        // often arrives under two names, and storing it twice because the
        // extension differed would quietly double the folder.
        const already = this.pathFor(hash);
        if (already) {
          return { hash, relativePath: path.relative(root, already), bytes: bytesIn.length };
        }

        const relative = path.join(hash.slice(0, 2), hash + safeExt(name));
        const target = path.join(root, relative);
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          // Write beside the target and rename, so an interrupted copy cannot
          // leave a half-written file that later reads as a corrupt attachment.
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
      const full = this.pathFor(hash);
      return Boolean(full);
    },

    /**
     * Absolute path for a stored hash, or null when it is not there.
     *
     * The extension is not part of a file's identity, so the caller does not
     * have to know how this one happens to be spelled on disk.
     */
    pathFor(hash) {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
      const dir = path.join(root, hash.slice(0, 2));
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name === hash) return path.join(dir, name);
          // The tail has to be an extension we would actually have written, so
          // a leftover ".part" or a stray ".bak" is never taken for the file.
          const tail = name.slice(hash.length);
          if (name.startsWith(hash) && tail && safeExt(tail) === tail) return path.join(dir, name);
        }
      } catch {
        /* not adopted */
      }
      return null;
    },

    /** A file:// URL the renderer can load through the beeper-file protocol. */
    urlFor(hash) {
      const full = this.pathFor(hash);
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

module.exports = { openMediaStore, safeExt, shouldStore };