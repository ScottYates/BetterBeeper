/**
 * Dev check: does an animated GIF actually animate when it is shown in a
 * message? The short answer this check has to keep true is "yes", and the
 * evidence has to be a real one, because a GIF that decodes to its first
 * frame and then never advances is pixel identical on screen to a GIF that
 * works. Nothing about "the image loaded" tells the two apart.
 *
 * So nothing here asks whether the image loaded. Every assertion is made from
 * pixels that were genuinely on screen: the fixture is shown as a real
 * <img class="att-image"> in a real window, the window is captured repeatedly,
 * and the captures are compared. A GIF that animates yields more than one
 * distinct capture over the window; a GIF frozen on one frame yields one.
 *
 * The instrument is checked against a control in the same run. A single frame
 * PNG is shown the same way, over the same window, and has to come back
 * identical every time. That is what stops the whole check passing
 * vacuously: a capture that is blank, or aimed at the wrong pixels, fails the
 * PNG case, so a green result means the window really was showing two
 * different frames of the GIF.
 *
 * Why the window is visible, and why capturePage. Two dead ends are worth
 * recording, because both give the wrong answer rather than an error:
 *
 *  - Canvas sampling is a false negative. The obvious technique is drawImage
 *    into a canvas and read the pixels back, since drawImage picks up
 *    whichever frame is showing. On this build it does not: a 268x167 GIF
 *    with 316 frames drew as one identical constant every time, with
 *    willReadFrequently both on and off, while that same image was visibly
 *    rotating in the window. So the samples are read off the compositor with
 *    webContents.capturePage, which is the only source here that reflects
 *    what is really on screen.
 *  - A hidden window animates nothing. With show false the page reports
 *    visibilityState hidden, its timers are clamped to one per second, and
 *    every image is frozen. A harness that hid its window would report that
 *    animated GIFs do not animate. The page is therefore shown, raised and
 *    asserted visible before anything is sampled, so a run that cannot see
 *    properly fails loudly instead of quietly reaching the wrong conclusion.
 *    The cost is a window appearing on the developer's screen for a second.
 *
 * Both fixtures are built at run time and no binary is committed. The PNG is
 * a 2x2 raster made here and handed to the image as a data URL. The GIF is
 * the 87 bytes of GIF89a below, laid out by hand: a 2x2 logical screen, a two
 * entry global colour table of pure red and pure blue, a NETSCAPE2.0 looping
 * extension, and two image descriptors differing only in their LZW payload,
 * one all index 0 and one all index 1. Each frame is held for 100ms by its
 * graphic control extension, so the file repeats every 200ms. It is written
 * to a temp file and loaded over file://, the same shape as the beeper-file://
 * attachment URLs the thread renders.
 *
 * The loop extension is not decoration. The first version of this fixture
 * left it out and decoded as two frames under GDI+ while Chromium played it
 * exactly once and then froze on the last frame, which reads as precisely the
 * bug this check is meant to detect. The check parses the bytes before it
 * opens a window and asserts the frame count, the delays, the colour table
 * and the loop count, so a fixture that stops being animated fails here
 * rather than quietly proving nothing about the renderer.
 *
 * Sampling is a series rather than a pair of captures on purpose. With a
 * 200ms cycle, two captures a fixed moment apart can land back on the frame
 * they started from, which is how "the GIF did not change" comes to mean "the
 * timer fired unluckily". The series stops as soon as two distinct frames
 * turn up, so a working GIF finishes in a few captures and only a broken one
 * spends the whole budget.
 *
 * The harness page links the real src/renderer/styles.css, so the fixture is
 * styled by the same .att-image rule the thread uses, and only the fixture's
 * own rectangle is captured, so the stylesheet's pulse and blink animations
 * elsewhere on the page cannot be mistaken for the GIF moving.
 *
 * Run with `npm run check:gif`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

// 2x2, colour table red and blue, NETSCAPE2.0 loop forever, two frames of
// 100ms each, 87 bytes. Parsed and asserted by the fixture checks below
// before anything is loaded, so the fixture cannot quietly stop animating.
const GIF_B64 =
  'R0lGODlhAgACAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQECgAAACwAAAAAAgACAAACA4ShAAAh+QQECgAAACwAAAAAAgACAAACA4yjAAA7';

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

// Shown at this size on screen. The source is 2x2, so it is scaled up with
// pixelated rendering: every captured pixel is then exactly one of the two
// frame colours, with no interpolation to argue about.
const DISPLAY_PX = 32;
const GIF_MAX_CAPTURES = 12;
const PNG_CAPTURES = 8;
const SETTLE_MS = 250;
const LOAD_TIMEOUT_MS = 8000;

// A colour no frame of the GIF uses, so a control pixel can never be mistaken
// for one of the GIF's frames.
const PNG_RGB = [120, 140, 160];

// Captured pixels are not bit exact copies of the source colours on this
// machine: a flat 2x2 capture of rgb(0,0,255) comes back as (1,1,231) and
// rgb(120,140,160) as (109,127,145), a uniform scale of about 0.91 across
// every channel, alpha 255 throughout. The cause is in the capture colour
// path, not in the fixture. So the control is asserted on relative
// closeness and on channel order, which a capture of the wrong thing, the
// page background, or a blank frame cannot satisfy.
const COLOUR_TOLERANCE = 0.2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Walk a GIF block by block and report what is really inside it.
 *
 * Counting marker bytes is not good enough: 0x2C is a perfectly ordinary value
 * to find inside compressed data, and image data is a chain of sub-blocks
 * whose lengths have to be followed. This skips sub-blocks by length, so the
 * frames it returns are the frames the format defines.
 */
function parseGif(buf) {
  if (buf.length < 13) return { error: 'shorter than a header' };
  const out = {
    signature: buf.toString('latin1', 0, 6),
    width: buf.readUInt16LE(6),
    height: buf.readUInt16LE(8),
    palette: [],
    frames: [],
    apps: [],
    trailer: buf[buf.length - 1] === 0x3b,
  };

  let p = 13;
  const screen = buf[10];
  if (screen & 0x80) {
    const entries = 1 << ((screen & 0x07) + 1);
    for (let i = 0; i < entries; i += 1) {
      out.palette.push([buf[p], buf[p + 1], buf[p + 2]]);
      p += 3;
    }
  }

  let pending = null;
  while (p < buf.length) {
    const marker = buf[p];
    if (marker === 0x3b) break; // trailer, done
    if (marker === 0x21) {
      // Extension: a label, then a chain of length-prefixed sub-blocks.
      const label = buf[p + 1];
      let q = p + 2;
      if (label === 0xf9 && buf[q] === 4) {
        // packed, delay low, delay high, transparent index, terminator
        pending = {
          disposal: (buf[q + 1] >> 2) & 0x07,
          delayCs: buf[q + 2] + buf[q + 3] * 256,
        };
      }
      if (label === 0xff) {
        // Application extension: identifier, then its sub-blocks.
        const size = buf[q];
        const id = buf.toString('latin1', q + 1, q + 1 + size);
        const subStart = q + 1 + size;
        out.apps.push({ id, subStart, subSize: buf[subStart] });
        // 0x01 is the loop sub-block: 1 byte id, then the 16 bit loop count.
        if (buf[subStart] === 0x03 && buf[subStart + 1] === 0x01) {
          out.loopCount = buf[subStart + 2] + buf[subStart + 3] * 256;
        }
      }
      while (q < buf.length && buf[q] !== 0) q += buf[q] + 1;
      p = q + 1;
      continue;
    }
    if (marker === 0x2c) {
      // 0x2C, left, top, width, height, packed
      const packed = buf[p + 9];
      let q = p + 10;
      if (packed & 0x80) q += 3 * (1 << ((packed & 0x07) + 1)); // local colour table
      const frame = {
        left: buf.readUInt16LE(p + 1),
        top: buf.readUInt16LE(p + 3),
        width: buf.readUInt16LE(p + 5),
        height: buf.readUInt16LE(p + 7),
        minCodeSize: buf[q],
        delayCs: pending ? pending.delayCs : 0,
        pixels: '',
      };
      q += 1;
      while (q < buf.length && buf[q] !== 0) {
        const len = buf[q];
        frame.pixels += buf.toString('hex', q + 1, q + 1 + len);
        q += 1 + len;
      }
      out.frames.push(frame);
      pending = null;
      p = q + 1;
      continue;
    }
    break; // not a block this format uses
  }
  return out;
}

const sameRGB = (a, b) => a.length === 3 && b.length === 3 && a.every((v, i) => v === b[i]);
const rgb = (s) => s.r + ',' + s.g + ',' + s.b;
const distinct = (list) => [...new Set(list.map((s) => s.hash))];

/** Every case is a name and a function returning true, or a string explaining. */
function reporter() {
  const cases = [];
  return {
    cases,
    add(name, fn) {
      let ok = false;
      let detail = '';
      try {
        const r = fn();
        ok = r === true;
        if (r !== true) detail = String(r);
      } catch (e) {
        ok = false;
        detail = e.message;
      }
      cases.push([name, ok, detail]);
    },
  };
}

/**
 * What the fixture bytes actually are, checked before a window is opened.
 * If this failed, the captures below would faithfully report a still image,
 * so it is reported separately and first.
 */
function fixtureCases(gifPath) {
  const { add, cases } = reporter();

  const bytes = Buffer.from(GIF_B64, 'base64');
  const gif = parseGif(bytes);
  const hex = (c) => c.map((v) => v.toString(16).padStart(2, '0')).join('');

  add('the fixture is a 2x2 GIF89a ending in a trailer', () => {
    return (gif.signature === 'GIF89a' && gif.width === 2 && gif.height === 2 && gif.trailer)
      || ('got ' + gif.signature + ' ' + gif.width + 'x' + gif.height + ' trailer=' + gif.trailer);
  });

  add('the fixture really holds two frames', () => {
    return gif.frames.length === 2 || ('parsed ' + gif.frames.length + ' frame(s)');
  });

  add('both frames cover the whole 2x2 screen', () => {
    const bad = gif.frames.filter((f) => f.width !== 2 || f.height !== 2 || f.left !== 0 || f.top !== 0);
    return bad.length === 0 || ('odd frames: ' + JSON.stringify(bad));
  });

  add('each frame is held for 100ms, so the file repeats every 200ms', () => {
    const bad = gif.frames.filter((f) => f.delayCs !== 10);
    return bad.length === 0
      || ('delays: ' + gif.frames.map((f) => f.delayCs).join(',') + ' (centiseconds)');
  });

  add('the two frames carry different pixel data', () => {
    const payloads = gif.frames.map((f) => f.pixels);
    if (payloads.length < 2) return 'not enough frames to compare';
    return payloads[0] !== payloads[1] || ('both frames decode from ' + JSON.stringify(payloads[0]));
  });

  add('the colour table is exactly the red and blue the check looks for', () => {
    const pal = gif.palette;
    return (pal.length === 2 && sameRGB(pal[0], RED) && sameRGB(pal[1], BLUE))
      || ('got ' + JSON.stringify(pal.map(hex)));
  });

  add('the fixture loops forever, not once', () => {
    // Without this the browser plays the file a single time and freezes on
    // the last frame, which is indistinguishable on screen from the bug
    // this check exists to catch.
    const loopApp = (gif.apps || []).some((a) => /^NETSCAPE2\.0$/.test(a.id));
    if (!loopApp) return 'no NETSCAPE2.0 application extension, so the file plays once';
    return gif.loopCount === 0
      || ('loop count is ' + gif.loopCount + ', expected 0 for forever');
  });

  add('the fixture was written where the page can load it', () => {
    const onDisk = fs.statSync(gifPath).size;
    return onDisk === bytes.length || ('wrote ' + onDisk + ' bytes, expected ' + bytes.length);
  });

  return cases;
}

/**
 * The page script that puts one fixture on screen the way the thread does,
 * and hands back where it landed and how it is styled.
 *
 * It is shaped like attachmentsNode in src/renderer/js/thread.js: a bare
 * <img class="att-image"> with lazy loading and nothing on it that could
 * freeze, restart or replace the image. The extra inline styles only pin the
 * element to a known rectangle so the capture has something exact to aim at;
 * they set no property that affects whether the image animates.
 */
function placeScript(src) {
  // Named and closed like the other check harnesses on purpose: check:syntax
  // finds this page script by the "const harness = " marker and parses it on
  // its own, so a backtick in a comment or an unbalanced paren in here is
  // caught without ever opening a window. That extractor takes the first
  // match, so this comment must not quote the marker in backticks either.
  const harness = `
    (async () => {
      const src = ${JSON.stringify(src)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      for (const old of document.querySelectorAll('img[data-gif-check]')) old.remove();

      const img = new Image();
      img.className = 'att-image';
      img.alt = 'gif-check fixture';
      img.loading = 'lazy';
      img.setAttribute('data-gif-check', '1');
      img.style.cssText = 'position:fixed;left:0;top:0;margin:0;z-index:2147483647;'
        + 'width:${DISPLAY_PX}px;height:${DISPLAY_PX}px;image-rendering:pixelated';
      document.body.append(img);
      img.src = src;

      const decoded = (img.complete && img.naturalWidth > 0)
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', () => reject(new Error('the fixture failed to load')), { once: true });
          });
      // A load that never arrives must report itself rather than sit until
      // the harness guard gives up on the whole check.
      await Promise.race([
        decoded,
        sleep(${LOAD_TIMEOUT_MS}).then(() => { throw new Error('the fixture never loaded'); }),
      ]);
      // A freshly decoded image may need a moment before it starts cycling.
      await sleep(${SETTLE_MS});

      const r = img.getBoundingClientRect();
      const cs = getComputedStyle(img);
      return JSON.stringify({
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        natural: { width: img.naturalWidth, height: img.naturalHeight },
        style: {
          display: cs.display, cursor: cs.cursor, maxWidth: cs.maxWidth,
          visibility: cs.visibility, opacity: cs.opacity, animationName: cs.animationName,
        },
        visibilityState: document.visibilityState,
      });
    })()
  `;
  return harness;
}

/** One capture, reduced to the numbers the assertions need. */
function summarise(nativeImage) {
  const bitmap = nativeImage.toBitmap(); // BGRA, one 4 byte entry per pixel
  const size = nativeImage.getSize();
  let b = 0;
  let g = 0;
  let r = 0;
  let n = 0;
  let hash = 2166136261;
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    b += bitmap[i];
    g += bitmap[i + 1];
    r += bitmap[i + 2];
    n += 1;
    hash = Math.imul(hash ^ bitmap[i], 16777619) >>> 0;
    hash = Math.imul(hash ^ bitmap[i + 1], 16777619) >>> 0;
    hash = Math.imul(hash ^ bitmap[i + 2], 16777619) >>> 0;
  }
  return { w: size.width, h: size.height, r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), hash };
}

/**
 * Capture the fixture's rectangle on a jittered cadence.
 *
 * The gaps are not a round number on purpose. A fixed gap can be a near
 * multiple of the GIF's 200ms cycle and then every sample lands on the same
 * frame, which is a false "it does not animate". Varying the gap keeps the
 * sample phases from lining up, and stopAfterTwo ends the series the moment
 * two different frames turn up so a working GIF does not pay the whole budget.
 */
async function captureSeries(win, rect, { count, stopAfterTwo }) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(summarise(await win.webContents.capturePage(rect)));
    if (stopAfterTwo && distinct(out).length > 1) break;
    if (i < count - 1) await sleep(110 + (i % 3) * 17);
  }
  return out;
}

/**
 * A single frame raster, made at run time rather than shipped as a file. A PNG
 * cannot animate, which is exactly what makes it the control.
 */
function makePngDataUrl() {
  const { nativeImage } = require('electron');
  const size = 2;
  const bmp = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    bmp[i * 4] = PNG_RGB[2]; // nativeImage bitmaps are BGRA
    bmp[i * 4 + 1] = PNG_RGB[1];
    bmp[i * 4 + 2] = PNG_RGB[0];
    bmp[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBuffer(bmp, { width: size, height: size }).toDataURL();
}

async function main() {
  const { app, BrowserWindow } = require('electron');

  // An isolated profile, so the test can never read a cached copy of anything.
  app.setPath('userData', path.join(os.tmpdir(), 'bb-gif-check-profile'));

  const gifPath = path.join(os.tmpdir(), 'bb-gif-check-fixture.gif');
  fs.writeFileSync(gifPath, Buffer.from(GIF_B64, 'base64'));
  const gifURL = pathToFileURL(gifPath).href;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:gif' });

  // Shown, because a page the browser considers hidden runs no image animation
  // and clamps its timers to one per second. Raised and focused so it is not
  // judged occluded by whatever window the developer is looking at.
  const win = new BrowserWindow({ show: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setPosition(20, 20);

  // A real file:// page, so it can load a file:// image and the app's own
  // stylesheet, both of which a data: URL harness could not do.
  await win.loadFile(path.join(__dirname, 'gif-harness.html'));
  win.show();
  win.focus();
  win.moveTop();

  const { add, cases } = reporter();

  const shown = JSON.parse(await win.webContents.executeJavaScript(placeScript(gifURL), true));
  const visibility = await win.webContents.executeJavaScript('document.visibilityState', true);

  add('the page is visible, so the browser is allowed to animate images', () => {
    // Without this the captures below are meaningless: a hidden page freezes
    // every image and would make this check report a bug that is not there.
    return (visibility === 'visible' && shown.visibilityState === 'visible')
      || ('visibilityState is ' + visibility + '/' + shown.visibilityState);
  });

  add('the fixture image is styled by the app stylesheet', () => {
    // cursor and display are set by the .att-image rule and nothing else, so
    // they are proof the real rule is applied rather than the browser default
    // for a bare img.
    return (shown.style.cursor === 'zoom-in' && shown.style.display === 'block')
      || ('computed ' + JSON.stringify(shown.style));
  });

  add('the fixture image is a real laid out rectangle to capture', () => {
    const r = shown.rect;
    const ok = r && r.width >= DISPLAY_PX && r.height >= DISPLAY_PX
      && shown.natural.width === 2 && shown.natural.height === 2;
    return ok || ('rect ' + JSON.stringify(r) + ' natural ' + JSON.stringify(shown.natural));
  });

  const gifSeries = await captureSeries(win, shown.rect, { count: GIF_MAX_CAPTURES, stopAfterTwo: true });

  add('an animated GIF shows more than one frame on screen', () => {
    const seen = distinct(gifSeries);
    return seen.length > 1
      || ('one frame in all ' + gifSeries.length + ' captures: ' + JSON.stringify(gifSeries.map(rgb)));
  });

  add('the frames it showed are the two the GIF contains', () => {
    // The red frame and the blue frame both have to appear, not merely any
    // change, so a capture that drifted or flickered cannot pass this.
    const seen = distinct(gifSeries).map((h) => gifSeries.find((s) => s.hash === h));
    const reds = seen.filter((s) => s.r > s.b + 60);
    const blues = seen.filter((s) => s.b > s.r + 60);
    return (reds.length > 0 && blues.length > 0)
      || ('red frames: ' + reds.length + ' blue frames: ' + blues.length
          + ' distinct: ' + JSON.stringify(seen.map(rgb)));
  });

  // The control. Same window, same rectangle, same capture path, a file that
  // cannot animate. If this moves, the instrument is lying.
  const pngPlaced = JSON.parse(
    await win.webContents.executeJavaScript(placeScript(makePngDataUrl()), true),
  );
  const pngSeries = await captureSeries(win, pngPlaced.rect, { count: PNG_CAPTURES, stopAfterTwo: false });

  add('a single frame PNG shows exactly one frame over the same window', () => {
    const seen = distinct(pngSeries);
    return seen.length === 1
      || ('PNG changed, which a single frame file cannot do: ' + JSON.stringify(pngSeries.map(rgb)));
  });

  add('the PNG captures are the colour that was drawn', () => {
    // This is also the proof that the capture really is looking at the image:
    // if the rectangle were aimed at the page behind it, or the capture were
    // blank, these would not be the drawn colour to within a scale factor.
    if (pngSeries.length === 0) return 'no PNG captures';
    const p = pngSeries[0];
    const close = [p.r, p.g, p.b].map((v, i) => Math.abs(v - PNG_RGB[i]) <= PNG_RGB[i] * COLOUR_TOLERANCE);
    const ordered = p.r < p.g && p.g < p.b;
    return (close.every(Boolean) && ordered)
      || ('captured rgb ' + rgb(p) + ' want rgb ' + PNG_RGB.join(',') + ' within '
          + Math.round(COLOUR_TOLERANCE * 100) + '% and in that order');
  });

  app.exit(0);
  return fixtureCases(gifPath).concat(cases);
}

main()
  .then((cases) => {
    let failed = 0;
    for (const [name, ok, detail] of cases) {
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
    }
    console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('failed:', err.message);
    process.exit(1);
  });
