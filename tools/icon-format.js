/**
 * The .ico container, in pure JavaScript.
 *
 * Why this is its own file
 * ------------------------
 * Building the container is arithmetic on a byte buffer, and reading it back
 * is arithmetic on a byte buffer. Neither needs Electron, a window or a
 * renderer, so neither belongs in the tool that draws the artwork. Keeping
 * them here means the check can read a .ico back with the same code that
 * wrote one, and both can be reasoned about without starting a browser.
 *
 * The format is small enough to describe in full
 * ----------------------------------------------
 * An .ico file is a six byte header, one sixteen byte directory entry per
 * size, and then the images themselves.
 *
 *   header
 *     u16  reserved, always 0
 *     u16  type, 1 for an icon
 *     u16  how many images follow
 *
 *   directory entry, one per image
 *     u8   width in pixels, 0 meaning 256
 *     u8   height in pixels, 0 meaning 256
 *     u8   colour count, 0 meaning truecolour
 *     u8   reserved
 *     u16  colour planes, always 1
 *     u16  bits per pixel, 32
 *     u32  how many bytes this image takes
 *     u32  where this image starts in the file
 *
 * An image is either a DIB (a bitmap with a colour mask in front of it, the
 * old way) or a PNG (Windows has understood those inside an .ico since
 * Vista). The small sizes are written as DIBs, because that is what the
 * older readers that still draw icons in the shell expect, and the 256 pixel
 * one is written as a PNG, because the same image as a DIB is four times
 * the size for no visible gain.
 */
const fs = require('node:fs');

const HEADER_BYTES = 6;
const ENTRY_BYTES = 16;

/** The PNG signature, the eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * One directory entry of a .ico, in the DIB form.
 *
 * The image is stored bottom-up in the file and twice as tall as it looks,
 * because the second half is the one bit transparency mask that old Windows
 * readers still expect to find there. The mask is all zeros: the alpha
 * channel does the work, and a mask that says "every pixel is opaque" would
 * put a black box around the rounded corners.
 *
 * The bitmap that comes back from Electron is in top-down order, while a DIB
 * stores its rows bottom-up: the first row in the file is the bottom row of
 * the picture. Writing it across as it comes produces an upside down icon,
 * so the rows go in reversed here.
 */
function dibEntry(bitmap, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (image plus mask)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression (BI_RGB)
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage

  const rowBytes = size * 4;
  const xor = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    bitmap.copy(xor, (size - 1 - y) * rowBytes, y * rowBytes, (y + 1) * rowBytes);
  }

  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size, 0);

  return Buffer.concat([header, xor, mask]);
}

/**
 * The .ico file itself.
 *
 * The images are sorted by size, smallest first, which is the order Windows
 * and the shell expect to walk through when it picks the best one for the
 * space it has.
 */
function buildIco(images) {
  const entries = images
    .map((img) => ({
      width: img.size >= 256 ? 0 : img.size,
      height: img.size >= 256 ? 0 : img.size,
      data: img.size === 256 ? img.png : dibEntry(img.bitmap, img.size),
    }))
    .sort((a, b) => a.width - b.width);

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 means icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(ENTRY_BYTES * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, i) => {
    const at = i * ENTRY_BYTES;
    directory.writeUInt8(entry.width, at);
    directory.writeUInt8(entry.height, at + 1);
    directory.writeUInt8(0, at + 2); // colour count: 0 means truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.data)]);
}

/**
 * Read an .ico back.
 *
 * This is the other half of buildIco: it goes over the bytes as they were
 * written and says what it finds, so a file can be checked without trusting
 * the code that produced it.
 */
function parseIco(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES) {
    return { ok: false, reason: 'the file is too short to be an icon' };
  }
  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  if (reserved !== 0) return { ok: false, reason: `reserved is ${reserved}, not 0` };
  if (type !== 1) return { ok: false, reason: `type is ${type}, not 1 (icon)` };
  if (count === 0) return { ok: false, reason: 'the icon holds no images' };
  if (buffer.length < HEADER_BYTES + ENTRY_BYTES * count) {
    return { ok: false, reason: 'the directory claims more images than the file holds' };
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = HEADER_BYTES + i * ENTRY_BYTES;
    const width = buffer.readUInt8(at);
    const height = buffer.readUInt8(at + 1);
    const bytesInRes = buffer.readUInt32LE(at + 8);
    const imageOffset = buffer.readUInt32LE(at + 12);
    const inside = imageOffset + bytesInRes <= buffer.length;
    entries.push({
      width: width === 0 ? 256 : width,
      height: height === 0 ? 256 : height,
      planes: buffer.readUInt16LE(at + 4),
      bitCount: buffer.readUInt16LE(at + 6),
      bytesInRes,
      imageOffset,
      inside,
      isPng: buffer
        .slice(imageOffset, imageOffset + 8)
        .equals(PNG_SIGNATURE),
      data: inside ? buffer.slice(imageOffset, imageOffset + bytesInRes) : Buffer.alloc(0),
    });
  }
  return { ok: true, type, count, entries };
}

/** The size of a PNG, read out of its header, or null when it is not a PNG. */
function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (!buffer.slice(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Read a file as bytes. */
function readFile(file) {
  return fs.readFileSync(file);
}

module.exports = {
  HEADER_BYTES,
  ENTRY_BYTES,
  PNG_SIGNATURE,
  buildIco,
  parseIco,
  pngSize,
  readFile,
  dibEntry,
};
