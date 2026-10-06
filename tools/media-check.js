/**
 * Dev check: what the thread does with each kind of attachment.
 *
 * Two claims are under test, and they pull in opposite directions. Anything
 * recognised as an image or a video is drawn in the thread. Anything else has to
 * be gettable some other way, and "some other way" is a save dialog - a row that
 * only opens an external handler is no use for a file this machine has no
 * handler for, which is most of what a chat actually carries.
 *
 * The old behaviour is worth stating plainly, because every rendering assertion
 * here fails against it: a video was drawn as a file row, and that row called
 * shell.openExternal, which refuses any URL that is not http(s) - so a local
 * attachment threw "Refusing to open non-http URL" and could not be got out of
 * Beeper at all.
 *
 * The filename half is a security check, not a formatting one. fileName is
 * chosen by whoever sent the message and is handed to a save dialog's
 * defaultPath, so it has to be reduced to a bare name or a message could steer
 * where the user thinks they are saving to.
 *
 * Run with `npm run check:media`.
 */
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;

const mediaPath = require(path.join(ROOT, 'src', 'main', 'media-path.js'));
const assetSource = require(path.join(ROOT, 'src', 'main', 'asset-source.js'));
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

// ---------------------------------------------------------------------------
// safeFileName, and the CSP: plain node, no Electron needed
// ---------------------------------------------------------------------------

const cases = [];

function add(name, fn) {
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
}

/** Only characters that can legally appear in a Windows filename. */
const SAFE = /^[A-Za-z0-9 ._\-()[\]+,@#&']{1,180}$/;

add('an ordinary filename survives untouched', () => {
  const got = mediaPath.safeFileName('Quarterly Report (final).pdf');
  return got === 'Quarterly Report (final).pdf' || ('got ' + JSON.stringify(got));
});

add('a windows traversal prefix is reduced to the bare name', () => {
  const got = mediaPath.safeFileName('..\\..\\..\\Windows\\System32\\evil.dll');
  return got === 'evil.dll' || ('got ' + JSON.stringify(got));
});

add('a unix traversal prefix is reduced to the bare name', () => {
  const got = mediaPath.safeFileName('../../etc/passwd');
  return got === 'passwd' || ('got ' + JSON.stringify(got));
});

add('an absolute path loses its drive and its directories', () => {
  const got = mediaPath.safeFileName('C:\\Users\\scott\\Documents\\notes.docx');
  return got === 'notes.docx' || ('got ' + JSON.stringify(got));
});

add('no separator ever survives', () => {
  return !/[\\/]/.test(mediaPath.safeFileName('sub/dir/file.txt'))
    && !/[\\/]/.test(mediaPath.safeFileName('a\\b\\c.txt'))
    || 'kept a separator';
});

add('reserved Windows characters are replaced', () => {
  const got = mediaPath.safeFileName('re:port*final?.xlsx');
  return SAFE.test(got) || ('got ' + JSON.stringify(got));
});

add('control characters are stripped', () => {
  const got = mediaPath.safeFileName('ev\u0000il\u001b\u007f.txt');
  return got === 'evil.txt' || ('got ' + JSON.stringify(got));
});

add('a reserved device name falls back', () => {
  return mediaPath.safeFileName('NUL') === 'attachment'
    && mediaPath.safeFileName('con.txt') === 'attachment'
    || 'kept a reserved device name';
});

add('trailing dots and spaces are trimmed', () => {
  const got = mediaPath.safeFileName('report.pdf...  ');
  return got === 'report.pdf' || ('got ' + JSON.stringify(got));
});

add('an empty or missing name falls back', () => {
  return mediaPath.safeFileName('') === 'attachment'
    && mediaPath.safeFileName(undefined) === 'attachment'
    && mediaPath.safeFileName(null) === 'attachment'
    && mediaPath.safeFileName('   ') === 'attachment'
    || 'produced nothing';
});

add('a non-string name falls back rather than throwing', () => {
  return mediaPath.safeFileName(42) === 'attachment'
    && mediaPath.safeFileName({}) === 'attachment'
    || 'accepted a non-string';
});

add('a very long name is capped', () => {
  const got = mediaPath.safeFileName('x'.repeat(4000) + '.pdf');
  return got.length <= 180 || ('length ' + got.length);
});

add('a crafted name cannot escape the chosen directory', () => {
  // The property that matters, stated directly: join the suggestion onto a
  // directory and the result is still inside it.
  const dir = path.join('C:', path.sep, 'Users', 'scott', 'Downloads');
  const dest = path.join(dir, 'target.bin');
  const joined = path.join(dir, mediaPath.safeFileName('..\\..\\elsewhere\\target.bin'));
  return path.dirname(joined) === path.dirname(dest) || ('would save into ' + joined);
});

// The window CSP has to allow beeper-file: under media-src, or a video resolves
// perfectly and then plays nothing, with no error anywhere to notice it by.
const cspMatch = /content="([^"]*default-src[^"]*)"/i.exec(fs.readFileSync(INDEX_HTML, 'utf8'));
const csp = cspMatch ? cspMatch[1] : '';
const mediaSrc = (/(^|;)\s*media-src\s+([^;]*)/i.exec(csp) || [])[2] || '';
add('the window CSP allows beeper-file: for media', () => {
  return /beeper-file:/i.test(mediaSrc)
    || (mediaSrc ? 'media-src is ' + JSON.stringify(mediaSrc) : 'no media-src directive found');
});

// ---------------------------------------------------------------------------
// Range requests.
//
// A media player does not read a video through once. It asks for byte ranges
// to buffer ahead and to seek, and the protocol handler has to answer them or
// the demuxer is handed a stream it cannot frame. The symptom is a video that
// plays a few seconds and then dies with a decode error - at a different point
// each time, which is what a streaming fault looks like rather than a corrupt
// file.
// ---------------------------------------------------------------------------

add('a byte range is answered with the right slice', () => {
  const r = mediaPath.parseRange('bytes=100-199', 1000);
  return (r && r.start === 100 && r.end === 199) || ('got ' + JSON.stringify(r));
});

add('an open-ended range runs to the end of the file', () => {
  const r = mediaPath.parseRange('bytes=500-', 1000);
  return (r && r.start === 500 && r.end === 999) || ('got ' + JSON.stringify(r));
});

add('a range past the end is clamped, not refused', () => {
  // A client asking for more than exists should get what there is.
  const r = mediaPath.parseRange('bytes=900-5000', 1000);
  return (r && r.start === 900 && r.end === 999) || ('got ' + JSON.stringify(r));
});

add('a suffix range means the last N bytes', () => {
  const r = mediaPath.parseRange('bytes=-300', 1000);
  return (r && r.start === 700 && r.end === 999) || ('got ' + JSON.stringify(r));
});

add('a suffix range larger than the file is the whole file', () => {
  const r = mediaPath.parseRange('bytes=-5000', 1000);
  return (r && r.start === 0 && r.end === 999) || ('got ' + JSON.stringify(r));
});

add('no range header means the whole file', () => {
  return mediaPath.parseRange(undefined, 1000) === null || 'invented a range';
});

add('a range starting past the end is unsatisfiable, not silently wrong', () => {
  const r = mediaPath.parseRange('bytes=2000-2100', 1000);
  return (r && r.unsatisfiable === true) || ('got ' + JSON.stringify(r));
});

add('a malformed range is ignored rather than obeyed', () => {
  for (const bad of ['bytes=abc-def', 'items=0-10', 'bytes=', 'bytes=-', '0-10', 'bytes=1-2-3']) {
    const r = mediaPath.parseRange(bad, 1000);
    if (r && !r.unsatisfiable) return 'accepted ' + JSON.stringify(bad) + ' as ' + JSON.stringify(r);
  }
  return true;
});

add('the protocol handler serves a real stream rather than net.fetch', () => {
  // net.fetch over a file:// URL is not a streaming response the media stack
  // can frame, which is what made long videos die mid-playback. The handler has
  // to build the response itself.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const handler = /protocol\.handle\('beeper-file'[\s\S]*?\n {2}\}\);/.exec(src);
  if (!handler) return 'the beeper-file handler was not found in main.js';
  // Comments in that handler explain why net.fetch was dropped, and explaining
  // a thing by naming it would otherwise read as still doing it.
  const body = handler[0].replace(/^\s*\/\/.*$/gm, '');
  if (/net\.fetch/.test(body)) return 'the handler still delegates to net.fetch';
  if (!/createReadStream/.test(body)) return 'the handler does not stream from disk';
  if (!/parseRange/.test(body)) return 'the handler ignores Range headers';
  if (!/Accept-Ranges/i.test(body)) return 'the handler never says it accepts ranges';
  if (!/\b206\b/.test(body)) return 'the handler never answers a partial request';
  return true;
});

// ---------------------------------------------------------------------------
// Where the bytes are. This is the half that decides what gets written, so it
// runs against real files in a real temp directory rather than being mocked.
// ---------------------------------------------------------------------------

const os = require('node:os');
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-media-check-'));

function fixture(name, contents) {
  const filePath = path.join(FIXTURES, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

async function locateCases() {
  const neverCalled = () => {
    throw new Error('the bridge was consulted for a file already on disk');
  };
  const toFileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

  await addAsync('a file already on this machine is copied from directly', async () => {
    const src = fixture('local.bin', 'BYTES-THAT-MUST-SURVIVE');
    const dest = path.join(FIXTURES, 'copy-target.bin');
    const found = await assetSource.locateAttachment({ srcURL: src }, neverCalled);
    if (found.localPath !== src) return 'located ' + JSON.stringify(found);

    await fs.promises.copyFile(found.localPath, dest);
    const written = await fs.promises.readFile(dest, 'utf8');
    return written === 'BYTES-THAT-MUST-SURVIVE' || ('wrote ' + JSON.stringify(written));
  });

  await addAsync('a file:// URL on this machine is copied from directly', async () => {
    const src = fixture('via-url.bin', 'VIA-FILE-URL');
    const found = await assetSource.locateAttachment({ srcURL: toFileUrl(src) }, neverCalled);
    return found.localPath === src || ('located ' + JSON.stringify(found));
  });

  await addAsync('a beeper-file URL on this machine is copied from directly', async () => {
    const src = fixture('via-beeper.bin', 'VIA-BEEPER-FILE');
    const found = await assetSource.locateAttachment(
      { srcURL: 'beeper-file://local/' + src.replace(/\\/g, '/').replace(/^\/+/, '') },
      neverCalled,
    );
    return found.localPath === src || ('located ' + JSON.stringify(found));
  });

  await addAsync('a path that is not there falls through to the bridge', async () => {
    let asked = 0;
    const real = fixture('behind-bridge.bin', 'FETCHED');
    const found = await assetSource.locateAttachment(
      { srcURL: path.join(FIXTURES, 'never-existed.bin'), id: 'asset-1' },
      async () => { asked++; return { srcURL: toFileUrl(real) }; },
    );
    if (asked !== 1) return 'consulted the bridge ' + asked + ' times';
    if (found.localPath !== real) return 'located ' + JSON.stringify(found);
    const written = await fs.promises.readFile(found.localPath, 'utf8');
    return written === 'FETCHED' || ('wrote ' + JSON.stringify(written));
  });

  await addAsync('an https source is fetched rather than treated as a path', async () => {
    const found = await assetSource.locateAttachment(
      { id: 'asset-2' },
      async () => ({ srcURL: 'https://media.example/clip.mp4' }),
    );
    return found.url === 'https://media.example/clip.mp4'
      && found.localPath === undefined
      || ('got ' + JSON.stringify(found));
  });

  await addAsync('a directory is not treated as a file', async () => {
    let asked = 0;
    const real = fixture('dir-target.bin', 'OK');
    const found = await assetSource.locateAttachment(
      { srcURL: FIXTURES, id: 'asset-3' },
      async () => { asked++; return { srcURL: toFileUrl(real) }; },
    );
    return (asked === 1 && found.localPath === real) || 'accepted a directory as the file';
  });

  await addAsync('a bridge answer with nothing usable is refused', async () => {
    try {
      await assetSource.locateAttachment({ id: 'asset-4' }, async () => ({ srcURL: '' }));
      return 'accepted an empty answer';
    } catch {
      return true;
    }
  });

  await addAsync('a bridge failure propagates rather than writing an empty file', async () => {
    try {
      await assetSource.locateAttachment({ id: 'asset-5' }, async () => {
        throw new Error('bridge is down');
      });
      return 'swallowed the failure';
    } catch (e) {
      return e.message === 'bridge is down' || ('got ' + e.message);
    }
  });

  await addAsync('an attachment with no source at all is refused', async () => {
    try {
      await assetSource.locateAttachment({}, async () => ({ srcURL: '' }));
      return 'accepted an empty attachment';
    } catch {
      return true;
    }
  });
}

// ---------------------------------------------------------------------------
// Classification and rendering: need a real DOM
// ---------------------------------------------------------------------------

async function renderChecks() {
  const { app, BrowserWindow } = require('electron');
  const os = require('node:os');

  // An isolated profile, so this can never execute a cached copy of thread.js.
  app.setPath('userData', path.join(os.tmpdir(), 'bb-media-check-profile'));

  // String.raw throughout: check:syntax parses this same raw text, so the two
  // have to agree on what a backslash means.
  const harness = String.raw`
    (async () => {
      const T = await import(${JSON.stringify(js('thread.js'))});
      const K = await import(${JSON.stringify(js('media-kind.js'))});

      const cases = [];
      // Sequential and awaited on purpose. Several of these drive a click or an
      // error event and then wait for the renderer to react, which an
      // un-awaited helper would race.
      const run = async (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = await fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      const settle = () => new Promise((r) => setTimeout(r, 40));

      // The bridge, stubbed so a click can be observed. This harness page has
      // no preload, so window.beeper is undefined and freely assignable here.
      const saved = [];
      const opened = [];
      let resolvedCount = 0;
      const stubResolve = (result) => {
        window.beeper.assets.resolve = async () => {
          resolvedCount++;
          return result;
        };
      };

      window.beeper = {
        assets: {
          resolve: async () => ({ ok: false, error: { message: 'no local file' } }),
          saveAs: async (a) => {
            saved.push(a);
            return { ok: true, data: { saved: true, name: a && a.fileName } };
          },
        },
        shell: {
          openExternal: async (u) => { opened.push(u); return { ok: true, data: true }; },
        },
      };

      const mount = document.getElementById('mount');

      const base = {
        chatID: 'chat-1',
        accountID: 'account-1',
        senderID: 'sender-1',
        senderName: 'Someone',
        text: '',
        timestamp: 1700000000000,
      };

      // Unique ids throughout. thread.js memoises resolved sources by attachment
      // id, so reusing one would let a later case inherit an earlier case's
      // stubbed answer and quietly stop testing what it claims to.
      let seq = 0;
      const draw = (attachment) => {
        mount.replaceChildren();
        const node = T.messageNode(
          Object.assign({}, base, {
            id: 'm' + (seq++),
            attachments: [attachment],
          }),
          null,
        );
        mount.append(node);
        return node;
      };

      // --- classification ---------------------------------------------------

      await run('an image mime type is an image', () => {
        const got = K.mediaKind({ mimeType: 'image/png' });
        return got === 'image' || ('got ' + got);
      });

      await run('a video mime type is a video', () => {
        const got = K.mediaKind({ mimeType: 'video/mp4' });
        return got === 'video' || ('got ' + got);
      });

      await run('a mime type with parameters still classifies', () => {
        const got = K.mediaKind({ mimeType: 'VIDEO/MP4; codecs=avc1' });
        return got === 'video' || ('got ' + got);
      });

      await run("Beeper's own img shorthand is still an image", () => {
        const got = K.mediaKind({ type: 'img' });
        return got === 'image' || ('got ' + got);
      });

      await run('octet-stream does not shadow a real extension', () => {
        // The common case: chat attachments arrive as application/octet-stream
        // whatever they really are, so that must not decide the answer alone.
        const got = K.mediaKind({ mimeType: 'application/octet-stream', fileName: 'clip.mp4' });
        return got === 'video' || ('got ' + got);
      });

      await run('an image extension classifies when the mime type says nothing', () => {
        const got = K.mediaKind({ fileName: 'holiday.JPEG' });
        return got === 'image' || ('got ' + got);
      });

      await run('a video extension classifies when the mime type says nothing', () => {
        const got = K.mediaKind({ fileName: 'holiday.mov' });
        return got === 'video' || ('got ' + got);
      });

      await run('a document is a file', () => {
        const got = K.mediaKind({ mimeType: 'application/pdf', fileName: 'a.pdf' });
        return got === 'file' || ('got ' + got);
      });

      await run('an archive is a file', () => {
        const got = K.mediaKind({ fileName: 'backup.zip' });
        return got === 'file' || ('got ' + got);
      });

      await run('audio is a file, not a video', () => {
        // Nothing here can play sound inline, so it belongs on the save row
        // rather than in a player that never starts.
        const got = K.mediaKind({ mimeType: 'audio/mpeg', fileName: 'song.mp3' });
        return got === 'file' || ('got ' + got);
      });

      await run('an attachment with no information at all is a file', () => {
        const got = [K.mediaKind({}), K.mediaKind(null), K.mediaKind(undefined)];
        return got.every((k) => k === 'file') || ('got ' + JSON.stringify(got));
      });

      await run('a dotfile is not mistaken for an extension', () => {
        const got = K.mediaKind({ fileName: '.mp4' });
        return got === 'file' || ('got ' + got);
      });

      // --- what gets drawn ---------------------------------------------------

      await run('an image still draws as an image', () => {
        const node = draw({ id: 'i1', fileName: 'a.png', mimeType: 'image/png' });
        return node.querySelectorAll('img.att-image').length === 1 || 'no image drawn';
      });

      await run('a video draws as a video element', () => {
        const node = draw({ id: 'v1', fileName: 'a.mp4', mimeType: 'video/mp4' });
        return node.querySelectorAll('video.att-video').length === 1 || 'no video element drawn';
      });

      await run('the video has its own controls', () => {
        // Without controls there is no way to play it, so this is the whole
        // feature rather than a detail of it.
        const node = draw({ id: 'v2', fileName: 'a.mp4', mimeType: 'video/mp4' });
        const v = node.querySelector('video.att-video');
        return Boolean(v) && v.hasAttribute('controls') || 'no controls attribute';
      });

      await run('the video is capped by the real stylesheet', () => {
        const node = draw({ id: 'v3', fileName: 'a.mp4', mimeType: 'video/mp4' });
        const v = node.querySelector('video.att-video');
        if (!v) return 'no video element';
        // Give it a width it would otherwise use, so the cap is what decides.
        v.setAttribute('width', '900');
        const got = Math.round(v.getBoundingClientRect().width);
        return (got > 0 && got <= 340) || ('rendered ' + got + 'px wide');
      });

      await run('an octet-stream mp4 draws as a video, not a file row', () => {
        const node = draw({ id: 'v4', fileName: 'clip.mp4', mimeType: 'application/octet-stream' });
        return node.querySelectorAll('video.att-video').length === 1
          && node.querySelectorAll('.att-file').length === 0
          || 'fell through to a file row';
      });

      await run('a pdf draws as a file row, not a video', () => {
        const node = draw({ id: 'p1', fileName: 'a.pdf', mimeType: 'application/pdf' });
        return node.querySelectorAll('.att-file').length === 1
          && node.querySelectorAll('video').length === 0
          || 'got the wrong control';
      });

      await run('the file row is a real button', () => {
        // An anchor dressed as a row is not reachable by keyboard, and a row
        // whose only action is a save is worth reaching.
        const node = draw({ id: 'p2', fileName: 'a.pdf', mimeType: 'application/pdf' });
        const row = node.querySelector('.att-file');
        return Boolean(row) && row.tagName === 'BUTTON' || ('drew a ' + (row && row.tagName));
      });

      await run('the file row shows the name and the size', () => {
        const node = draw({ id: 'p3', fileName: 'report.pdf', mimeType: 'application/pdf', fileSize: 2048 });
        const row = node.querySelector('.att-file');
        const text = row ? row.textContent : '';
        return (text.indexOf('report.pdf') >= 0 && text.indexOf('2.0 KB') >= 0)
          || ('got ' + JSON.stringify(text));
      });

      await run('a filename is never rendered as markup', () => {
        // The name is chosen by whoever sent the message.
        const node = draw({ id: 'p4', fileName: '<img src=x onerror=alert(1)>.pdf' });
        return node.querySelector('.att-file img') === null || 'the filename became an element';
      });

      await run('an unnamed attachment still has something to click', () => {
        const node = draw({ id: 'p5', mimeType: 'application/pdf' });
        const row = node.querySelector('.att-file');
        return Boolean(row) && row.tagName === 'BUTTON' || 'no row drawn';
      });

      // --- what clicking actually does ---------------------------------------

      await run('clicking the file row asks the main process to save it', async () => {
        const before = saved.length;
        const node = draw({ id: 'p6', fileName: 'report.pdf', mimeType: 'application/pdf' });
        node.querySelector('.att-file').click();
        await settle();
        const calls = saved.length - before;
        return (calls === 1 && saved[saved.length - 1].fileName === 'report.pdf')
          || ('saveAs called ' + calls + ' times');
      });

      await run('clicking the file row never opens an external handler', async () => {
        // This is what the row used to do, and shell.openExternal refuses
        // anything that is not http(s), so a local file row threw and could
        // not be saved at all.
        const before = opened.length;
        const node = draw({ id: 'p7', fileName: 'report.pdf', mimeType: 'application/pdf' });
        node.querySelector('.att-file').click();
        await settle();
        return opened.length === before || ('opened ' + (opened.length - before));
      });

      await run('drawing a file row does not pull the file through the bridge', async () => {
        // resolve is what downloads an attachment. A row that is only ever
        // going to be saved must not fetch the whole file just to be drawn.
        stubResolve({ ok: false, error: { message: 'x' } });
        const before = resolvedCount;
        draw({ id: 'p8', fileName: 'big.zip', mimeType: 'application/zip' });
        await settle();
        return resolvedCount === before || ('resolved ' + (resolvedCount - before) + ' times while drawing');
      });

      // --- a video that will not play -----------------------------------------

      await run('a video that fails to load falls back to the save row', async () => {
        stubResolve({ ok: true, data: { url: 'beeper-file://local/C:/definitely-not-here.mp4' } });
        const node = draw({ id: 'v5', fileName: 'broken.mp4', mimeType: 'video/mp4' });
        const video = node.querySelector('video.att-video');
        if (!video) return 'no video element';
        // Drive the real failure path rather than trusting an attribute.
        video.dispatchEvent(new Event('error'));
        await settle();
        return (node.querySelectorAll('.att-file').length === 1
          && node.querySelectorAll('video').length === 0)
          || ('left ' + node.querySelectorAll('video').length + ' videos and '
            + node.querySelectorAll('.att-file').length + ' rows');
      });

      await run('a video that cannot be resolved at all falls back too', async () => {
        stubResolve({ ok: false, error: { message: 'gone' } });
        const node = draw({ id: 'v6', fileName: 'gone.mp4', mimeType: 'video/mp4' });
        await settle();
        return (node.querySelectorAll('.att-file').length === 1
          && node.querySelectorAll('video').length === 0)
          || 'left a dead video element in the thread';
      });

      // --- the composer chip agrees with the thread ---------------------------

      await run('the attachment chip labels a video as a video', () => {
        const video = T.attachmentIcon({ mimeType: 'video/mp4' });
        const image = T.attachmentIcon({ mimeType: 'image/png' });
        const doc = T.attachmentIcon({ mimeType: 'application/pdf' });
        return (video && image && doc && video !== image && video !== doc)
          || ('got ' + JSON.stringify({ video: video, image: image, doc: doc }));
      });

      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:media' });
  const win = new BrowserWindow({ show: false, width: 1100, height: 780 });
  await win.loadFile(path.join(__dirname, 'media-harness.html'));
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);
  return JSON.parse(result);
}

/** Same shape as add, for the assertions that have to touch real files. */
async function addAsync(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = await fn();
    ok = r === true;
    if (r !== true) detail = String(r);
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  cases.push([name, ok, detail]);
}

async function main() {
  let locate = [];
  try {
    await locateCases();
  } catch (err) {
    locate = [['the locate fixtures ran', false, err.message]];
  }

  let rendered = [];
  try {
    rendered = await renderChecks();
  } catch (err) {
    // The browser half failing wholesale is itself a result. Record it and
    // still print the filename half, so a broken check never looks like one
    // broken file.
    rendered = [['the rendering harness ran', false, err.message]];
  }
  cases.push(...rendered);

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});