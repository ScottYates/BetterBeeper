/**
 * Building GIF files to test against.
 *
 * The app has no GIF dependency and neither does this. A fixture is written
 * here, byte by byte, because the checks need to know exactly what the file
 * contains: how many frames it has, how long each one is held for, and
 * whether it loops. A fixture that is a blob cannot be reasoned about.
 *
 * The image data is written as "clear, literal, clear, literal, ...". Every
 * clear empties the LZW dictionary, so the code size never grows and every
 * code is the same width. That is not how a real encoder writes a file, but
 * it is a legal LZW stream, and it means the fixture is exactly as long as
 * it needs to be with no clever compression to get wrong.
 *
 * No Electron and no DOM, so it runs under plain node and can be checked on
 * its own.
 */
const fs = require('node:fs');

/**
 * Pack a list of codes into bytes, least significant bit first, which is the
 * order the GIF format uses.
 */
function packCodes(codes, codeSize) {
  const out = [];
  let current = 0;
  let bits = 0;
  for (const code of codes) {
    current |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(current & 0xff);
      current >>>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) out.push(current & 0xff);
  return Buffer.from(out);
}

/**
 * The LZW data for a run of palette indices, as a chain of sub-blocks.
 *
 * The sub-blocks are the format's own length-prefixed chunks: 255 bytes of
 * data with a length in front, then a zero byte to say the chain has ended.
 */
function lzwData(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const codeSize = minCodeSize + 1;
  const codes = [clear];
  for (const index of indices) {
    codes.push(index, clear);
  }
  codes.push(eoi);

  const packed = packCodes(codes, codeSize);
  const out = [];
  for (let i = 0; i < packed.length; i += 255) {
    const slice = packed.subarray(i, i + 255);
    out.push(slice.length, ...slice);
  }
  out.push(0x00);
  return Buffer.from(out);
}

/**
 * The graphic control extension: how long the frame is held, what happens to
 * the picture afterwards, and which palette entry means "nothing here".
 */
function graphicControl(delayCs, disposal, transparentIndex) {
  const packed = ((disposal & 0x07) << 2) | (transparentIndex === null ? 0 : 1);
  return Buffer.from([
    0x21, 0xf9, 0x04, packed,
    delayCs & 0xff, (delayCs >> 8) & 0xff,
    transparentIndex === null ? 0 : transparentIndex,
    0x00,
  ]);
}

/**
 * The NETSCAPE application extension, which is where a GIF says how many
 * times it loops. Zero means forever.
 */
function netscapeLoop(count) {
  return Buffer.from([
    0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32,
    0x2e, 0x30, 0x03, 0x01, count & 0xff, (count >> 8) & 0xff, 0x00,
  ]);
}

/**
 * One frame: a rectangle of palette indices at a place on the screen.
 *
 * The rectangle is usually the whole screen. A frame that covers only part of
 * it would have to be composited with the frame before it, and the checks
 * here are about timing and stopping, not about compositing.
 */
function frame(indices, delayCs, disposal = 1, transparentIndex = null) {
  const width = Math.round(Math.sqrt(indices.length));
  const height = Math.round(indices.length / width);
  const head = Buffer.from([
    0x2c,
    0x00, 0x00, // left
    0x00, 0x00, // top
    width & 0xff, (width >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
    0x00, // no local colour table
  ]);
  return Buffer.concat([
    graphicControl(delayCs, disposal, transparentIndex),
    head,
    Buffer.from([0x02]), // minimum code size: four colours
    lzwData(indices, 0x02),
  ]);
}

/** The logical screen descriptor and the global colour table. */
function screen(width, height, palette) {
  // The size field says how many entries the table has: 1 << (size + 1).
  const entries = Math.max(2, Math.pow(2, Math.ceil(Math.log2(palette.length / 3))));
  const size = Math.round(Math.log2(entries)) - 1;
  return Buffer.concat([
    Buffer.from([
      width & 0xff, (width >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
      0x80 | (size & 0x07), // a global colour table of that size
      0x00, // background colour index
      0x00, // pixel aspect ratio
    ]),
    palette,
  ]);
}

/**
 * A GIF made of frames, each one a single colour over the whole screen.
 *
 * Each frame is a different colour, so a check can tell which frame it is
 * looking at by reading one pixel. The colours are given as [r, g, b] triples
 * and the palette is built from them.
 *
 * @param {Array<{colour: number[], delayCs: number}>} frames
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} options.loopCount  zero loops forever
 * @returns {Buffer}
 */
function buildGif(frames, { width = 8, height = 8, loopCount = 0 } = {}) {
  const palette = [];
  const pixels = width * height;
  for (const entry of frames) {
    palette.push(entry.colour[0], entry.colour[1], entry.colour[2]);
  }
  // Four entries is the smallest table that holds a palette of four colours,
  // and the code size follows the table, so pad to a power of two.
  while (palette.length / 3 < Math.pow(2, Math.ceil(Math.log2(palette.length / 3)))) {
    palette.push(0, 0, 0);
  }
  while (palette.length / 3 < 2) palette.push(0, 0, 0);

  const blocks = frames.map((entry, index) =>
    frame(new Array(pixels).fill(index % (palette.length / 3)), entry.delayCs));

  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    screen(width, height, Buffer.from(palette)),
    netscapeLoop(loopCount),
    ...blocks,
    Buffer.from([0x3b]), // the trailer
  ]);
}

/** The four colours the fixtures use, in order. */
const COLOURS = [
  [255, 0, 0],   // red
  [0, 255, 0],   // green
  [0, 0, 255],   // blue
  [255, 255, 0], // yellow
];

/**
 * Write a fixture out and say where it went.
 *
 * The checks load the file over file://, which is the same shape as the
 * beeper-file:// URLs the thread renders.
 */
function writeFixture(filePath, frames, options = {}) {
  const bytes = buildGif(frames, options);
  fs.writeFileSync(filePath, bytes);
  return bytes.length;
}

module.exports = { buildGif, writeFixture, packCodes, lzwData, COLOURS };
