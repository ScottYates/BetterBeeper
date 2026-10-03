/**
 * Dev check: pasting an image into the composer attaches it.
 *
 * The composer had no paste listener at all, so Ctrl+V of a screenshot did
 * nothing at all - a pasted screenshot arrives as a clipboard *file* with no
 * text beside it, and a textarea given a file it cannot insert just ignores it.
 * The paperclip button worked because it went through the OS file dialog and
 * had a path to upload; a paste has no path, which is the whole difference.
 *
 * Two separate mistakes live here, and they pull in opposite directions:
 *
 *  - Claiming every paste would turn a pasted screenshot into an attachment,
 *    but it would also eat every ordinary text paste. So the handler has to
 *    decide synchronously, from the clipboard item types alone, whether this
 *    is an image paste at all.
 *  - Dropping an image that is too large without a word is indistinguishable,
 *    from the user's side, from the paste not working. So the size limit has
 *    to be reported, not swallowed.
 *
 * The upload itself needs a real clipboard and a real Beeper, so it is covered
 * by check:paste --live against the installed app instead.
 *
 * Run with `npm run check:paste`.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const threadURL = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'thread.js')).href;

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  // An isolated profile, so the test cannot execute a cached copy of thread.js.
  app.setPath('userData', path.join(os.tmpdir(), 'bb-paste-check-profile'));

  const harness = `
    (async () => {
      const T = await import(${JSON.stringify(threadURL)});
      const hasImageItem = T.hasImageItem;
      const pastedImages = T.pastedImages;
      const pasteImageName = T.pasteImageName;
      const attachmentIcon = T.attachmentIcon;

      // A clipboard item shaped like the real ones. The image item carries a
      // File-alike whose arrayBuffer() resolves to 'size' zero bytes.
      const imageItem = (type, size) => ({
        kind: 'file',
        type: type,
        getAsFile: () => ({
          type: type,
          size: size,
          arrayBuffer: async () => new Uint8Array(size).buffer,
        }),
      });
      const textItem = (type) => ({ kind: 'string', type: type, getAsFile: () => null });
      const clipboard = (items) => ({ items: items });

      const PNG = imageItem('image/png', 2048);

      const cases = [];
      const add = async (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = await fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      await add('a pasted screenshot is recognised as an image', () => {
        return hasImageItem(clipboard([PNG])) === true
          || ('got ' + hasImageItem(clipboard([PNG])));
      });

      await add('a text paste is NOT claimed, so it still pastes normally', () => {
        // The regression that matters most: a clipboard with only text must
        // be left alone, or every ordinary Ctrl+V in the app breaks.
        const dt = clipboard([textItem('text/plain'), textItem('text/html')]);
        return hasImageItem(dt) === false || ('got ' + hasImageItem(dt));
      });

      await add('an empty or absent clipboard is not an image', () => {
        return hasImageItem(clipboard([])) === false
          && hasImageItem(null) === false
          && hasImageItem(undefined) === false
          || 'claimed an empty clipboard';
      });

      await add('the pasted bytes come back ready to upload', async () => {
        const { images } = await pastedImages(clipboard([PNG]));
        const one = images[0];
        if (!one) return 'no image returned';
        return one.data instanceof Uint8Array && one.data.length === 2048 && one.mimeType === 'image/png'
          || ('got ' + JSON.stringify({ len: one.data && one.data.length, mime: one.mimeType }));
      });

      await add('a pasted image is given a name with the right extension', async () => {
        const { images } = await pastedImages(clipboard([PNG]));
        return images[0] && images[0].fileName === 'pasted-image-1.png'
          || ('got ' + JSON.stringify(images[0] && images[0].fileName));
      });

      await add('the extension follows the mime type, not a guess', () => {
        return pasteImageName('image/jpeg', 0) === 'pasted-image-1.jpg'
          && pasteImageName('image/gif', 0) === 'pasted-image-1.gif'
          && pasteImageName('image/webp', 0) === 'pasted-image-1.webp'
          || 'wrong extension';
      });

      await add('an unknown mime type still gets a usable name', () => {
        const name = pasteImageName('image/tiff', 2);
        return name === 'pasted-image-3.png' || ('got ' + name);
      });

      await add('two pasted images get two different names', async () => {
        const { images } = await pastedImages(clipboard([
          imageItem('image/png', 10), imageItem('image/jpeg', 20),
        ]));
        return images.length === 2 && images[0].fileName !== images[1].fileName
          || ('got ' + JSON.stringify(images.map((i) => i.fileName)));
      });

      await add('a text paste yields no attachments and no rejection', async () => {
        const r = await pastedImages(clipboard([textItem('text/plain')]));
        return r.images.length === 0 && r.rejected.length === 0
          || ('got ' + JSON.stringify({ n: r.images.length, rej: r.rejected.length }));
      });

      await add('an oversized image is reported, not silently dropped', async () => {
        const huge = imageItem('image/png', 30 * 1024 * 1024);
        const r = await pastedImages(clipboard([huge]));
        return r.images.length === 0 && r.rejected.length === 1 && r.rejected[0].bytes === 30 * 1024 * 1024
          || ('got ' + JSON.stringify({ n: r.images.length, rej: r.rejected.map((x) => x.bytes) }));
      });

      await add('a good image is kept even when a huge one is beside it', async () => {
        const r = await pastedImages(clipboard([
          imageItem('image/png', 30 * 1024 * 1024), imageItem('image/png', 512),
        ]));
        return r.images.length === 1 && r.rejected.length === 1
          || ('got ' + JSON.stringify({ n: r.images.length, rej: r.rejected.length }));
      });

      await add('a pasted screenshot is chipped as a picture, not a document', () => {
        const pic = attachmentIcon({ mimeType: 'image/png' });
        const doc = attachmentIcon({ mimeType: 'application/pdf' });
        return pic && doc && pic !== doc
          || ('got ' + JSON.stringify({ pic: pic, doc: doc }));
      });

      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:paste' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(path.join(__dirname, 'paste-harness.html'));
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);

  const cases = JSON.parse(result);
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
