/**
 * check:gifplayer - an animated GIF plays three times, then stops, and the
 * button over it does what it says.
 *
 * What this is for
 * ----------------
 * The GIF player draws the frames itself, because a GIF in an <img> cannot be
 * stopped. That is a lot of machinery to be wrong in quietly, so every
 * assertion here is made from the pixels that came out of the canvas.
 *
 * Nothing here asks the player whether it thinks it played. The picture is
 * sampled while it runs, the samples are compared, and the claims are about
 * what was on screen: that the picture moved, that it moved three times and
 * then stopped, that pausing froze it on the frame that was showing rather
 * than on the first one, and that pressing play started it again.
 *
 * The counters the player keeps are checked too, but only next to the
 * pixels: they say how many frames went past, and the pixels say the picture
 * really was changing.
 *
 * The instrument is checked against controls in the same run. A file with one
 * frame is not an animation, and a file that is not a GIF at all cannot be
 * played, so neither of them gets a player. Those are the cases that would
 * make the rest of the check pass for the wrong reason.
 *
 * Why the window is offscreen
 * ---------------------------
 * A hidden window is worse than useless here. The page reports
 * visibilityState 'hidden', its timers are clamped to one per second, and
 * every image is frozen, so a harness that hid its window would report that
 * animated GIFs do not animate. Offscreen rendering is not hidden: it simply
 * has no on-screen surface, so the browser still animates and still says
 * 'visible'. The page is asserted visible before anything is sampled, so a
 * run that cannot see properly fails loudly instead of quietly reaching the
 * wrong conclusion.
 *
 * Both fixtures are built at run time and no binary is committed. The GIF is
 * four frames of one colour each, held for 200ms, looping forever: four
 * different colours mean a sample says which frame was on screen, and a long
 * enough frame means a sample every 50ms cannot miss one.
 *
 * The files can be pointed somewhere else with --root=<dir>, which is how the
 * red proof runs the check against a copy of the tree that has been broken on
 * purpose. The tools always come from this repository, so the copy is being
 * checked by exactly the same code.
 *
 * Run with `npm run check:gifplayer`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const harnessGuard = require('./harness-guard');
const writer = require('./gif-writer');

const ROOT_ARG = process.argv.find((a) => a.startsWith('--root='));
const ROOT = ROOT_ARG ? path.resolve(ROOT_ARG.slice('--root='.length)) : path.join(__dirname, '..');

const FRAMES = 4;
const DELAY_CS = 20; // 200ms a frame
const LOOP_MS = FRAMES * DELAY_CS * 10;
const DEFAULT_LOOPS = 3;

// How long the picture is watched for. Three loops take 2.4 seconds, so this
// sees all of them and a good while after the picture has stopped.
const WATCH_MS = 3600;
const SAMPLE_MS = 50;

// How long the thread is watched for. Three loops of four 200ms frames take
// 2.4 seconds, so this sees the whole thing and a good while after it.
const THREAD_WATCH_MS = 3200;

const RED = '255,0,0';
const GREEN = '0,255,0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * The page script for the thread.
 *
 * It drives the real thread module with a stubbed bridge, exactly the way
 * the app does it, and then looks at what the thread drew. The attachment is
 * a GIF, so the thread has to hand it to the player and the reader has to be
 * able to reach the picture with the mouse.
 */
function threadScript(threadURL, playerURL, gifURL) {
  const harness = `
    (async () => {
      const T = await import(${JSON.stringify(threadURL)});
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const envelope = (data) => ({ ok: true, data });

      // How many times the chat has been opened. The second time it returns
      // the same message with different text and a different attachment
      // behind it, which is what makes the thread rebuild and the picture
      // come back out of the cache.
      let opens = 0;

      window.beeper = {
        app: { badge: async () => envelope(true) },
        assets: { resolve: async () => envelope({ url: ${JSON.stringify(gifURL)} }) },
        images: { copy: async () => envelope(true), openViewer: async () => envelope(true) },
        shell: { openExternal: async () => envelope(true) },
        chats: {
          get: async () => envelope({ id: 'h1', title: 'A chat' }),
          markRead: async () => envelope(true),
        },
        messages: { list: async () => envelope({ items: [], hasMore: false }) },
        settings: { get: async () => envelope({}), set: async () => envelope({}) },
        events: { subscribe: async () => envelope({ subscribed: 0 }) },
        history: {
          open: async () => {
            opens += 1;
            const again = opens > 1;
            return envelope({
              messages: [{
                id: 'm-gif',
                chatID: 'h1',
                timestamp: 1700000000000,
                text: again ? 'here it is again' : 'here it is',
                senderID: 's',
                senderName: 'Someone',
                isSender: false,
                attachments: [{
                  id: 'att-gif',
                  fileName: 'funny.gif',
                  fileSize: again ? 8192 : 4096,
                  mimeType: 'image/gif',
                }],
              }],
              complete: true,
              hasMore: false,
            });
          },
          page: async () => envelope({ messages: [], hasMore: false, complete: true }),
          upsert: async () => envelope({ written: 1 }),
          search: async () => envelope([]),
          status: async () => envelope({ messages: 0, chats: 0, bytes: 0, mediaBytes: 0 }),
        },
      };

      T.initThread();
      await T.openChat('h1');

      // Sample the canvas from the moment the chat opens. The player starts
      // as soon as the file has loaded, and three loops take 2.4 seconds, so
      // the sampling has to start early or it only ever sees the stopped
      // picture.
      const samples = [];
      const started = performance.now();
      while (performance.now() - started < ${THREAD_WATCH_MS}) {
        const el = document.querySelector('canvas.att-gif-canvas');
        if (el && el.width > 1) {
          const ctx = el.getContext('2d', { willReadFrequently: true });
          const data = ctx.getImageData(
            Math.floor(el.width / 2),
            Math.floor(el.height / 2),
            1,
            1
          ).data;
          samples.push({
            at: Math.round(performance.now() - started),
            colour: [data[0], data[1], data[2]].join(','),
          });
        }
        await sleep(${SAMPLE_MS});
      }

      const out = { samples: samples.length };
      let changes = 0;
      let last = null;
      let lastAt = 0;
      const distinct = new Set();
      for (const sample of samples) {
        distinct.add(sample.colour);
        if (last !== null && sample.colour !== last) {
          changes += 1;
          lastAt = sample.at;
        }
        last = sample.colour;
      }
      out.threadChanges = changes;
      out.threadDistinct = [...distinct];
      out.threadLastChangeAt = lastAt;

      const wrap = document.querySelector('.att-gif-wrap');
      out.hasWrap = Boolean(wrap);
      const canvas = wrap ? wrap.querySelector('canvas.att-gif-canvas') : null;
      const button = wrap ? wrap.querySelector('.att-gif-toggle') : null;
      const img = wrap ? wrap.querySelector('img') : null;
      out.hasCanvas = Boolean(canvas);
      out.hasButton = Boolean(button);
      // The browser must not still be playing the file underneath the canvas.
      out.hasImage = Boolean(img);
      out.wrapperMarked = Boolean(wrap && wrap.classList.contains('is-playing'));
      // Once the player has taken over the <img> is gone, so the address of
      // the file is read off the canvas.
      out.srcURL = canvas ? (canvas.__srcURL || '') : '';
      out.canvasSize = canvas ? [canvas.width, canvas.height] : null;
      out.pageVisibility = document.visibilityState;

      if (button) {
        const style = getComputedStyle(button);
        out.buttonOpacity = style.opacity;
        out.buttonPointerEvents = style.pointerEvents;
        out.buttonLabel = button.getAttribute('aria-label');
      }

      // Right-clicking the picture has to offer the same menu as right
      // clicking any other picture: it is a canvas now, not an <img>.
      if (canvas) {
        canvas.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }));
        await sleep(300);
        out.menuShown = Boolean(document.querySelector('.msg-menu'));
      }

      // ---- and the picture survives a rebuild with a new attachment ----
      //
      // The picture is cached so a rebuild does not restart it, and a cached
      // picture is reused rather than made again. The attachment behind it
      // has to be the one that is on screen now, because the right-click
      // menu is built from it: a canvas still carrying the attachment it was
      // first drawn with would offer to save the wrong file.
      await T.openChat('h1');
      await sleep(300);
      const rebuilt = document.querySelector('canvas.att-gif-canvas');
      out.rebuiltAttachmentSize = rebuilt && rebuilt.__attachment
        ? rebuilt.__attachment.fileSize
        : null;
      out.rebuiltIsPlaying = Boolean(
        rebuilt && rebuilt.closest('.att-gif-wrap')?.classList.contains('is-playing')
      );

      return JSON.stringify(out);
    })()
  `;
  return harness;
}

/**
 * The page script.
 *
 * It builds the same three elements the thread builds - a wrapper, a canvas
 * and a button - and then drives the real player module over them. The
 * samples are taken from the canvas, so what is compared is what a reader
 * would have seen.
 */
function pageScript(playerURL, gifURL, stillURL, notAGifURL) {
  // Named and closed like the other check harnesses on purpose: check:syntax
  // finds this page script by the "const harness = " marker and parses it on
  // its own, so a backtick in a comment or an unbalanced paren in here is
  // caught without ever opening a window. That extractor takes the first
  // match, so this comment must not quote the marker in backticks either.
  const harness = `
    (async () => {
      const { GifPlayer } = await import(${JSON.stringify(playerURL)});
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const build = () => {
        const wrap = document.createElement('div');
        wrap.className = 'att-gif-wrap is-playing';
        const canvas = document.createElement('canvas');
        canvas.className = 'att-gif-canvas';
        const button = document.createElement('button');
        button.className = 'att-gif-toggle';
        button.type = 'button';
        button.innerHTML = '<span></span>';
        wrap.append(canvas, button);
        document.body.append(wrap);
        return { wrap, canvas, button };
      };

      // The colour at the middle of the canvas: which frame is on screen.
      const pixel = (canvas) => {
        const ctx = canvas.getContext('2d');
        const x = Math.floor(canvas.width / 2);
        const y = Math.floor(canvas.height / 2);
        const data = ctx.getImageData(x, y, 1, 1).data;
        return [data[0], data[1], data[2]].join(',');
      };

      // Watch the picture for a while and say what it did.
      const watch = async (canvas, ms) => {
        const samples = [];
        const started = performance.now();
        while (performance.now() - started < ms) {
          samples.push({ at: Math.round(performance.now() - started), colour: pixel(canvas) });
          await sleep(${SAMPLE_MS});
        }
        return samples;
      };

      const changesOf = (samples) => {
        let changes = 0;
        let last = null;
        let lastAt = 0;
        for (const sample of samples) {
          if (last !== null && sample.colour !== last) {
            changes += 1;
            lastAt = sample.at;
          }
          last = sample.colour;
        }
        return { changes, lastAt, distinct: [...new Set(samples.map((s) => s.colour))] };
      };

      const out = {};

      // ---- the animation itself ----
      const { wrap, canvas, button } = build();
      const player = new GifPlayer({ canvas, button, url: ${JSON.stringify(gifURL)} });
      out.animated = await player.load();
      out.frameCount = player.frameCount;

      const buttonState = () => ({
        title: button.title,
        label: button.getAttribute('aria-label'),
        glyph: button.firstElementChild ? button.firstElementChild.textContent : '',
        opacity: getComputedStyle(button).opacity,
        pointerEvents: getComputedStyle(button).pointerEvents,
      });

      out.buttonAtStart = buttonState();

      player.start();
      player.play();
      await sleep(50);

      const run = await watch(canvas, ${WATCH_MS});
      const runStats = changesOf(run);
      out.runChanges = runStats.changes;
      out.runDistinct = runStats.distinct;
      out.runLastChangeAt = runStats.lastAt;
      out.framesDrawn = player.framesDrawn;
      out.loops = player.loops;
      out.playing = player.playing;
      out.buttonAfterRun = buttonState();

      // ---- pausing freezes the frame that was showing ----
      // Play again, wait for the second frame to be on screen, and stop it
      // there. If pausing rewound to the first frame this would be red.
      player.play();
      let guard = 0;
      while (pixel(canvas) !== ${JSON.stringify(GREEN)} && guard < 200) {
        await sleep(20);
        guard += 1;
      }
      const beforePause = pixel(canvas);
      player.pause();
      const frozen = pixel(canvas);
      await sleep(600);
      out.beforePause = beforePause;
      out.frozen = frozen;
      out.afterWait = pixel(canvas);
      out.buttonPaused = buttonState();

      // ---- and play starts it again ----
      player.play();
      const resumed = await watch(canvas, 700);
      out.resumedChanges = changesOf(resumed).changes;
      player.pause();

      // ---- the controls: a file with one frame is not an animation ----
      const still = build();
      const stillPlayer = new GifPlayer({
        canvas: still.canvas,
        button: still.button,
        url: ${JSON.stringify(stillURL)},
      });
      out.stillAnimated = await stillPlayer.load();

      // ---- and a file that is not a GIF cannot be played at all ----
      const notAGif = build();
      const notAGifPlayer = new GifPlayer({
        canvas: notAGif.canvas,
        button: notAGif.button,
        url: ${JSON.stringify(notAGifURL)},
      });
      try {
        out.notAGifAnimated = await notAGifPlayer.load();
      } catch (err) {
        out.notAGifAnimated = 'threw: ' + String(err && err.message);
      }

      // ---- the button is only there on hover ----
      // The element the mouse has to be over, and where it has to land.
      const rect = wrap.getBoundingClientRect();
      out.hoverTarget = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      out.opacityBeforeHover = getComputedStyle(button).opacity;
      out.pointerEventsBeforeHover = getComputedStyle(button).pointerEvents;

      return JSON.stringify(out);
    })()
  `;
  return harness;
}

/**
 * The thread's own markup, with the app's scripts stripped out.
 *
 * The point of the thread part of this check is that the thread draws what
 * it draws, so the page has to be the real page. The scripts are stripped so
 * nothing tries to boot the app around the check.
 *
 * The app itself starts hidden and is revealed once it has connected, so the
 * harness has to reveal it too. An app that is hidden has no layout: every
 * picture in it is zero by zero, a lazy picture in a zero sized box is never
 * loaded, and an intersection observer watching one says the picture is not
 * on screen. The thread would be drawn perfectly and nothing would move.
 */
function buildThreadHarness(dir) {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const stylesheet = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'styles.css')).href;
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/href="styles\.css"/g, `href="${stylesheet}"`)
    .replace(/(href|src)="\.\//g, '$1="../src/renderer/')
    .replace(/(<div id="app" class="app") hidden(>)/, '$1$2');
  const harnessPath = path.join(dir, 'thread-harness.html');
  fs.writeFileSync(harnessPath, stripped, 'utf8');
  return harnessPath;
}

async function main() {
  const { app, BrowserWindow, session } = require('electron');

  // An isolated profile, so the test can never read a cached copy of anything.
  app.setPath('userData', path.join(os.tmpdir(), 'bb-gif-player-check-profile'));

  const dir = path.join(os.tmpdir(), 'bb-gif-player-check');
  fs.mkdirSync(dir, { recursive: true });

  // The animation: four frames of one colour each, 200ms a frame.
  const gifPath = path.join(dir, 'animation.gif');
  writer.writeFixture(
    gifPath,
    writer.COLOURS.slice(0, FRAMES).map((colour) => ({ colour, delayCs: DELAY_CS })),
    { width: 8, height: 8 }
  );

  // The control: one frame, so there is nothing to play.
  const stillPath = path.join(dir, 'still.gif');
  writer.writeFixture(stillPath, [{ colour: writer.COLOURS[0], delayCs: DELAY_CS }], { width: 8, height: 8 });

  // The other control: not a GIF at all.
  const notAGifPath = path.join(dir, 'notagif.gif');
  fs.writeFileSync(notAGifPath, Buffer.from('this is not an image of any kind'));

  const playerURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'gif-player.js')).href;

  await app.whenReady();
  // The cache has to go, or a stylesheet from an earlier run is served from
  // it and a change to the stylesheet is not seen. The red proof breaks the
  // stylesheet on purpose, and it has to notice.
  await session.defaultSession.clearCache();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:gifplayer' });

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  // A real file:// page, so it can load a file:// image and the app's own
  // stylesheet, both of which a data: URL harness could not do.
  await win.loadFile(path.join(ROOT, 'tools', 'gif-player-harness.html'));

  // An offscreen window paints nothing until something asks for a frame, so
  // wait for the first one before capturing. Skipping this is how capturePage
  // hands back an empty image and every frame comparison below reads as blank.
  await new Promise((resolve) => {
    win.webContents.once('paint', () => resolve());
    // Never hang the whole suite if the paint never arrives.
    setTimeout(resolve, 2000);
  });

  const { add, cases } = reporter();
  const visibility = await win.webContents.executeJavaScript('document.visibilityState', true);
  add('the page is visible, so the browser is allowed to animate images', () => {
    // Without this the samples below are meaningless: a hidden page freezes
    // every image and would make this check report a bug that is not there.
    return visibility === 'visible' || ('visibilityState is ' + visibility);
  });

  const raw = await win.webContents.executeJavaScript(
    pageScript(
      playerURL,
      pathToFileURL(gifPath).href,
      pathToFileURL(stillPath).href,
      pathToFileURL(notAGifPath).href
    ),
    true
  );
  const out = JSON.parse(raw);

  add('the fixture is recognised as an animation', () => {
    return out.animated === true || ('the player said ' + out.animated);
  });

  add('the player found every frame in the file', () => {
    return out.frameCount === FRAMES || ('found ' + out.frameCount + ' frames');
  });

  add('the picture changes while it plays', () => {
    return out.runChanges > 0 || ('the picture never changed: ' + JSON.stringify(out.runDistinct));
  });

  add('every frame of the file is shown', () => {
    return out.runDistinct.length === FRAMES
      || ('saw ' + out.runDistinct.length + ' different frames');
  });

  add('it plays three times over, not once and not five', () => {
    // Three loops of four frames is eleven changes: the first frame is the
    // start, and every frame after it is a change. A little slack either way,
    // because a sample can land just after a frame boundary.
    return (out.runChanges >= 9 && out.runChanges <= 13)
      || ('saw ' + out.runChanges + ' changes');
  });

  add('it stops by itself once the three loops are done', () => {
    // The last change has to be around when the third loop ends, and the
    // picture must be still for the rest of the watch.
    const expected = LOOP_MS * 3;
    const late = out.runLastChangeAt > expected + 600;
    const early = out.runLastChangeAt < expected - 700;
    if (late) return ('the last change was at ' + out.runLastChangeAt + 'ms, expected about ' + expected + 'ms');
    if (early) return ('the last change was at ' + out.runLastChangeAt + 'ms, expected about ' + expected + 'ms');
    return out.playing === false || ('the player still says it is playing');
  });

  add('the player counted three loops and twelve frames', () => {
    return (out.loops === 3 && out.framesDrawn === FRAMES * 3)
      || ('loops=' + out.loops + ' frames=' + out.framesDrawn);
  });

  add('the button offers to play it again once it has stopped', () => {
    return (out.buttonAfterRun.title === 'Play animation' && out.buttonAfterRun.glyph !== out.buttonAtStart.glyph)
      || ('the button says ' + JSON.stringify(out.buttonAfterRun));
  });

  add('pausing freezes the frame that was showing, not the first one', () => {
    // Three things at once, because any one of them on its own can pass by
    // luck. The second frame has to have been on screen, the picture has to
    // stop on that frame, and it has to still be on that frame a moment
    // later - a pause that does nothing would still be caught by the last
    // one, because the picture would have moved on.
    if (out.beforePause !== GREEN) return ('the second frame was never on screen: ' + out.beforePause);
    if (out.frozen !== GREEN) return ('it froze on ' + out.frozen);
    return out.afterWait === GREEN
      || ('it moved on to ' + out.afterWait + ' while it was supposed to be stopped');
  });

  add('a paused picture stays exactly where it was', () => {
    return out.afterWait === out.frozen
      || ('it moved from ' + out.frozen + ' to ' + out.afterWait);
  });

  add('the button says it will play it again while it is paused', () => {
    return out.buttonPaused.title === 'Play animation'
      || ('the button says ' + JSON.stringify(out.buttonPaused));
  });

  add('pressing play starts it again', () => {
    return out.resumedChanges > 0 || ('the picture never changed again');
  });

  add('a file with one frame is not an animation', () => {
    return out.stillAnimated === false || ('the player said ' + out.stillAnimated);
  });

  add('a file that is not a GIF cannot be played', () => {
    return out.notAGifAnimated === false || typeof out.notAGifAnimated === 'string'
      || ('the player said ' + out.notAGifAnimated);
  });

  add('the button is invisible until the picture is hovered', () => {
    return (Number(out.opacityBeforeHover) === 0 && out.pointerEventsBeforeHover === 'none')
      || ('opacity=' + out.opacityBeforeHover + ' pointer-events=' + out.pointerEventsBeforeHover);
  });

  // The real hover, over CDP, so the rule is proved rather than read.
  try {
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: out.hoverTarget.x,
      y: out.hoverTarget.y,
    });
    await sleep(300);
    const hovered = JSON.parse(await win.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('.att-gif-toggle');
        const style = getComputedStyle(button);
        return JSON.stringify({ opacity: style.opacity, pointerEvents: style.pointerEvents });
      })()`,
      true
    ));
    add('hovering the picture brings the button out', () => {
      return (Number(hovered.opacity) > 0.9 && hovered.pointerEvents !== 'none')
        || ('opacity=' + hovered.opacity + ' pointer-events=' + hovered.pointerEvents);
    });
    // Detached before the window goes. A window that is destroyed with the
    // debugger still attached takes the whole process down with it, and then
    // the results of the run are lost.
    win.webContents.debugger.detach();
  } catch (err) {
    add('hovering the picture brings the button out', () => {
      return 'the mouse could not be moved: ' + err.message;
    });
  }

  // ---- the thread draws it ----
  //
  // The player on its own is half the feature. The other half is the thread
  // handing a GIF to it, and a reader being able to reach the picture with
  // the mouse. So the real thread module is driven with a stubbed bridge, and
  // what it drew is looked at.
  const threadHarness = buildThreadHarness(dir);
  const threadWin = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  // What the page says, and what happens to it. A renderer that goes away
  // takes the answer with it, so the check has to hear about it rather than
  // read an empty page and wonder.
  threadWin.webContents.on('render-process-gone', (event, details) => {
    console.log('  the thread page went away:', details && details.reason);
  });
  threadWin.webContents.on('console-message', (...args) => {
    const detail = args[1] && typeof args[1] === 'object' ? args[1] : null;
    const message = detail ? detail.message : args[2];
    const level = detail ? detail.level : args[1];
    if (level >= 2 && message) console.log('  the page says:', message);
  });
  await threadWin.loadFile(threadHarness);
  await new Promise((resolve) => {
    threadWin.webContents.once('paint', () => resolve());
    setTimeout(resolve, 2000);
  });

  const threadOut = JSON.parse(await threadWin.webContents.executeJavaScript(
    threadScript(
      pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'thread.js')).href,
      pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'gif-player.js')).href,
      pathToFileURL(gifPath).href
    ),
    true
  ));

  add('the thread resolves the attachment to a URL', () => {
    return String(threadOut.srcURL || '').endsWith('animation.gif')
      || ('the picture src is ' + threadOut.srcURL);
  });

  add('the thread draws a GIF as a wrapper with a canvas', () => {
    return (threadOut.hasWrap === true && threadOut.hasCanvas === true)
      || ('wrapper=' + threadOut.hasWrap + ' canvas=' + threadOut.hasCanvas);
  });

  add('the thread puts a button over it', () => {
    return threadOut.hasButton === true || 'there is no button';
  });

  add('the thread hands the picture to the player', () => {
    return threadOut.wrapperMarked === true || 'the wrapper is not marked as playing';
  });

  add('the browser is not left playing the file underneath the canvas', () => {
    return threadOut.hasImage === false || 'the <img> is still in the wrapper';
  });

  add('the picture the thread drew is moving', () => {
    // Every frame of the file has to turn up. The empty canvas before the
    // first frame is not a frame, so the colours that count are the ones the
    // file actually has.
    const seen = threadOut.threadDistinct || [];
    const wanted = writer.COLOURS.slice(0, FRAMES).map((c) => c.join(','));
    const missing = wanted.filter((colour) => !seen.includes(colour));
    return (threadOut.threadChanges > 0 && missing.length === 0)
      || ('saw ' + threadOut.threadChanges + ' changes, missing ' + missing.join(','));
  });

  add('and it stops by itself once the three loops are done', () => {
    const expected = LOOP_MS * 3;
    const late = threadOut.threadLastChangeAt > expected + 700;
    const early = threadOut.threadLastChangeAt < expected - 800;
    if (late) return ('the last change was at ' + threadOut.threadLastChangeAt + 'ms, expected about ' + expected + 'ms');
    if (early) return ('the last change was at ' + threadOut.threadLastChangeAt + 'ms, expected about ' + expected + 'ms');
    return true;
  });

  add('the canvas is the size of the GIF', () => {
    const size = threadOut.canvasSize || [0, 0];
    return (size[0] === 8 && size[1] === 8) || ('it is ' + size.join('x'));
  });

  add('the button over a GIF is hidden until the picture is hovered', () => {
    return (Number(threadOut.buttonOpacity) === 0 && threadOut.buttonPointerEvents === 'none')
      || ('opacity=' + threadOut.buttonOpacity + ' pointer-events=' + threadOut.buttonPointerEvents);
  });

  add('right-clicking a GIF offers the picture menu', () => {
    return threadOut.menuShown === true || 'no menu appeared';
  });

  add('the canvas carries the attachment that is on screen now', () => {
    // The chat was opened a second time with a different attachment behind
    // the same message. The picture came back out of the cache, so the
    // attachment the canvas carries has to have been refreshed with it.
    return threadOut.rebuiltAttachmentSize === 8192
      || ('the canvas still carries the attachment of size ' + threadOut.rebuiltAttachmentSize);
  });

  add('the picture is still playing after the rebuild', () => {
    // A rebuild that threw the picture away would leave an ordinary <img>
    // behind, playing forever, which is the thing this feature exists to
    // stop.
    return threadOut.rebuiltIsPlaying === true || 'the rebuilt picture is not being played';
  });

  // The windows are NOT destroyed here.
  //
  // Destroying a window whose renderer is still busy tears the renderer down
  // underneath a callback that is on its way into V8, and the whole process
  // dies with "Invoke in DisallowJavascriptExecutionScope" before it can
  // report what it found. In the thread phase the renderer really is busy: an
  // animated GIF is still running in it. The cost was not a red check but a
  // silent one: the results were printed and then lost, so the run looked
  // like it had passed everything and had failed at the same time.
  //
  // Exiting through Electron instead unwinds the windows in Electron's own
  // order, which is what the other window checks in this repository do.
  app.exit(0);

  // The results are printed before the process is ended, and the exit code
  // says whether they were all good. Printing afterwards loses the tail of
  // the output when it is going down a pipe, because the pipe is closed
  // first - and a check whose output is cut short cannot be read by
  // anything that is watching it.
  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('failed:', err && (err.stack || err.message));
  process.exit(1);
});
