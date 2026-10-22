/**
 * Dev check: pasting and dropping into the composer attaches the file.
 *
 * The composer had no paste listener at all, so Ctrl+V of a screenshot did
 * nothing at all - a pasted screenshot arrives as a clipboard *file* with no
 * text beside it, and a textarea given a file it cannot insert just ignores it.
 * The paperclip button worked because it went through the OS file dialog and
 * had a path to upload; a paste has no path, which is the whole difference.
 *
 * Three separate mistakes live here, and they pull in opposite directions:
 *
 *  - Claiming every paste would turn a pasted screenshot into an attachment,
 *    but it would also eat every ordinary text paste. So the handler has to
 *    decide synchronously, from the clipboard item types alone, whether this
 *    is a file paste at all.
 *  - Dropping a file that is too large without a word is indistinguishable,
 *    from the user's side, from the paste not working. So the size limit has
 *    to be reported, not swallowed.
 *  - A drag that appears to be ignored is one nobody tries twice, so the drop
 *    has to be claimed during dragover - without preventDefault there, the
 *    browser refuses the drop and the drop event never fires at all.
 *
 * It used to be images only. A document copied from Explorer is a file like
 * any other, and dropping a file on a conversation is the gesture people
 * already know, so both now take any file.
 *
 * Two halves live here. The first drives the parsing functions directly: what
 * the clipboard or the drag holds, what name a file gets, what is too big.
 * The second drives the whole path in the DOM the app ships - a real drag
 * event, a real drop event, a real paste event, and the upload that follows.
 * The upload is stubbed at the API boundary, so the second half runs with no
 * account, no window and no network.
 *
 * The upload against the real Beeper is covered by check:paste --live, which
 * drives the installed app and always works in the Note to self chat.
 *
 * Run with `npm run check:paste`.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const HARNESS = path.join(__dirname, '.paste-harness.html');

/**
 * Real markup, real stylesheet, no app scripts.
 *
 * The DOM in a check has to be the DOM the app ships, or the check is about a
 * program nobody runs. The composer in particular is a textarea in the app,
 * and a fixture that says div where the app says textarea is a fixture that
 * lies: code which reads the draft out of the composer gets undefined, and
 * the check reports a failure that is not in the app.
 */
function buildHarness() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/href="styles\.css"/g, 'href="../src/renderer/styles.css"')
    .replace(/(href|src)="\.\//g, '$1="../src/renderer/');
  fs.writeFileSync(HARNESS, stripped);
}

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  // An isolated profile, so the test cannot execute a cached copy of thread.js.
  app.setPath('userData', path.join(os.tmpdir(), 'bb-paste-check-profile'));
  buildHarness();

  const harness = String.raw`
    (async () => {
      // ---- the API boundary -----------------------------------------------
      //
      // Stubbed before anything is imported, and the upload is recorded
      // rather than performed: this half of the check must not need an
      // account, and must not put a file in anyone's account.
      const envelope = (data) => ({ ok: true, data });
      const uploads = [];

      window.beeper = {
        app: { bootstrap: async () => envelope({}), refreshDiscovery: async () => envelope({}), badge: async () => envelope(true) },
        updater: { check: async () => envelope({}), download: async () => envelope({}), quit: async () => envelope({}) },
        auth: { status: async () => envelope({}), connect: async () => envelope({}), manual: async () => envelope({}), disconnect: async () => envelope({}) },
        accounts: { list: async () => envelope([]) },
        contacts: { list: async () => envelope({ items: [] }) },
        assets: {
          uploadBytes: async (payload) => {
            uploads.push({
              fileName: payload.fileName,
              mimeType: payload.mimeType,
              bytes: payload.data && typeof payload.data.byteLength === 'number' ? payload.data.byteLength : -1,
            });
            return envelope({ uploadID: 'upload-1', fileName: payload.fileName, mimeType: payload.mimeType });
          },
          resolve: async () => envelope({ url: null }),
          reupload: async () => envelope({}),
        },
        images: {},
        shell: { openExternal: async () => envelope(true), showItemInFolder: async () => envelope(true) },
        mcp: { tools: async () => envelope({ tools: [] }) },
        settings: { get: async () => envelope({}), set: async () => envelope({}) },
        events: { subscribe: async () => envelope({ subscribed: 1 }) },
        chats: {
          list: async () => envelope([]),
          search: async () => envelope({ items: [] }),
          get: async () => envelope(null),
          patch: async () => envelope({}),
          archive: async () => envelope(true),
          markRead: async () => envelope(true),
          markUnread: async () => envelope(true),
          create: async () => envelope({}),
        },
        messages: { list: async () => envelope({ items: [], hasMore: false }) },
        history: {
          open: async () => envelope({ messages: [], complete: true }),
          page: async () => envelope({ messages: [], hasMore: false, complete: true }),
          upsert: async () => envelope({ written: 1 }),
          search: async () => envelope([]),
          status: async () => envelope({ messages: 0, chats: 0, bytes: 0, mediaBytes: 0, running: 0, queued: 0 }),
          refresh: async () => envelope({ queued: true }),
          jobs: async () => envelope({ jobs: [] }),
        },
      };

      const T = await import(${JSON.stringify(js('thread.js'))});
      const hasFileItem = T.hasFileItem;
      const payloadFiles = T.payloadFiles;
      const filesToUpload = T.filesToUpload;
      const attachFileName = T.attachFileName;
      const pasteImageName = T.pasteImageName;
      const attachmentIcon = T.attachmentIcon;
      const focusComposer = T.focusComposer;

      // A clipboard item shaped like the real ones. The item carries a
      // File-alike whose arrayBuffer() resolves to 'size' zero bytes.
      const fileItem = (type, size, name) => ({
        kind: 'file',
        type: type,
        getAsFile: () => ({
          type: type,
          size: size,
          name: name || '',
          arrayBuffer: async () => new Uint8Array(size).buffer,
        }),
      });
      const textItem = (type) => ({ kind: 'string', type: type, getAsFile: () => null });
      const clipboard = (items) => ({ items: items });
      const drop = (files) => ({ files: files, items: [] });

      // A drag in progress. The browser keeps the payload in protected mode
      // while the pointer is still over the window, so the files cannot be
      // read yet - all the app gets is the list of types.
      const drag = (types) => ({ types: types, items: [], files: [] });

      // A dropped file is a File-alike: it has a name, and it can be read.
      const dropFile = (type, size, name) => ({
        type: type,
        size: size,
        name: name || '',
        arrayBuffer: async () => new Uint8Array(size).buffer,
      });

      const PNG = fileItem('image/png', 2048);
      const PASTE_LIMIT = 25 * 1024 * 1024;
      const DROP_LIMIT = 100 * 1024 * 1024;

      const cases = [];
      const add = async (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = await fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      await add('a pasted screenshot is recognised as a file', () => {
        return hasFileItem(clipboard([PNG])) === true
          || ('got ' + hasFileItem(clipboard([PNG])));
      });

      await add('a pasted document is recognised as a file', () => {
        const PDF = fileItem('application/pdf', 4096, 'report.pdf');
        return hasFileItem(clipboard([PDF])) === true
          || ('got ' + hasFileItem(clipboard([PDF])));
      });

      await add('a text paste is NOT claimed, so it still pastes normally', () => {
        // The regression that matters most: a clipboard with only text must
        // be left alone, or every ordinary Ctrl+V in the app breaks.
        const dt = clipboard([textItem('text/plain'), textItem('text/html')]);
        return hasFileItem(dt) === false || ('got ' + hasFileItem(dt));
      });

      await add('an empty or absent clipboard is not a file', () => {
        return hasFileItem(clipboard([])) === false
          && hasFileItem(null) === false
          && hasFileItem(undefined) === false
          || 'claimed an empty clipboard';
      });

      await add('a dropped file is recognised', () => {
        const dt = drop([dropFile('image/png', 10, 'holiday.png')]);
        return hasFileItem(dt) === true || ('got ' + hasFileItem(dt));
      });

      await add('a drop with nothing in it is not a file', () => {
        return hasFileItem(drop([])) === false || 'claimed an empty drop';
      });

      // --- the drag, while the files still cannot be read -------------------

      await add('a drag that carries files is recognised before the files can be read', () => {
        // This is the case that makes the whole drag work. While the pointer
        // is over the window the browser holds the payload in protected mode,
        // so there is no file to look at yet - only the list of types.
        return hasFileItem(drag(['Files'])) === true || ('got ' + hasFileItem(drag(['Files'])));
      });

      await add('a drag of text is not claimed, so text can still be dragged', () => {
        const dt = drag(['text/plain', 'text/html']);
        return hasFileItem(dt) === false || ('got ' + hasFileItem(dt));
      });

      await add('CONTROL: without the types list the same drag holds nothing readable', () => {
        // The control for the case above. This is what the drag looked like
        // before the types list was consulted, and it is why reading the
        // files alone is not enough to spot a file drag.
        const dt = drag(['Files']);
        return payloadFiles(dt).length === 0
          || ('the payload held ' + payloadFiles(dt).length + ' files');
      });

      await add('a composer that is not a textarea is focused without throwing', () => {
        // The composer is a textarea in the app, but openChat must not fall
        // over if it ever is not: an exception raised while opening a chat
        // would leave the user with a chat that did not open at all.
        const old = document.getElementById('composer');
        if (old) old.remove();
        const stub = document.createElement('div');
        stub.id = 'composer';
        document.body.appendChild(stub);
        let threw = null;
        try { focusComposer(); } catch (e) { threw = e.message; }
        stub.remove();
        if (old) document.body.appendChild(old);
        return threw === null || ('threw ' + threw);
      });

      await add('the clipboard item is preferred over the files list', () => {
        // A screenshot has no name and no path, and only the item carries it.
        const dt = { items: [PNG], files: [{ type: 'image/png', size: 999, name: 'wrong.png' }] };
        const files = payloadFiles(dt);
        return files.length === 1 && files[0].size === 2048
          || ('got ' + JSON.stringify(files.map((f) => f.size)));
      });

      await add('a drop is read from the files list', () => {
        const dt = drop([dropFile('application/pdf', 4096, 'report.pdf')]);
        const files = payloadFiles(dt);
        return files.length === 1 && files[0].name === 'report.pdf'
          || ('got ' + JSON.stringify(files.map((f) => f.name)));
      });

      await add('the pasted bytes come back ready to upload', async () => {
        const { uploads } = await filesToUpload(payloadFiles(clipboard([PNG])), PASTE_LIMIT);
        const one = uploads[0];
        if (!one) return 'no upload returned';
        return one.data instanceof Uint8Array && one.data.length === 2048 && one.mimeType === 'image/png'
          || ('got ' + JSON.stringify({ len: one.data && one.data.length, mime: one.mimeType }));
      });

      await add('a pasted image is given a name with the right extension', async () => {
        const { uploads } = await filesToUpload(payloadFiles(clipboard([PNG])), PASTE_LIMIT);
        return uploads[0] && uploads[0].fileName === 'pasted-image-1.png'
          || ('got ' + JSON.stringify(uploads[0] && uploads[0].fileName));
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
        const { uploads } = await filesToUpload(payloadFiles(clipboard([
          fileItem('image/png', 10), fileItem('image/jpeg', 20),
        ])), PASTE_LIMIT);
        return uploads.length === 2 && uploads[0].fileName !== uploads[1].fileName
          || ('got ' + JSON.stringify(uploads.map((i) => i.fileName)));
      });

      await add('a text paste yields no attachments and no rejection', async () => {
        const r = await filesToUpload(payloadFiles(clipboard([textItem('text/plain')])), PASTE_LIMIT);
        return r.uploads.length === 0 && r.rejected.length === 0
          || ('got ' + JSON.stringify({ n: r.uploads.length, rej: r.rejected.length }));
      });

      await add('an oversized image is reported, not silently dropped', async () => {
        const huge = fileItem('image/png', 30 * 1024 * 1024);
        const r = await filesToUpload(payloadFiles(clipboard([huge])), PASTE_LIMIT);
        return r.uploads.length === 0 && r.rejected.length === 1 && r.rejected[0].bytes === 30 * 1024 * 1024
          || ('got ' + JSON.stringify({ n: r.uploads.length, rej: r.rejected.map((x) => x.bytes) }));
      });

      await add('a good image is kept even when a huge one is beside it', async () => {
        const r = await filesToUpload(payloadFiles(clipboard([
          fileItem('image/png', 30 * 1024 * 1024), fileItem('image/png', 512),
        ])), PASTE_LIMIT);
        return r.uploads.length === 1 && r.rejected.length === 1
          || ('got ' + JSON.stringify({ n: r.uploads.length, rej: r.rejected.length }));
      });

      // --- and the same rules for a drop ------------------------------------

      await add('a dropped file keeps the name it came with', async () => {
        const dt = drop([dropFile('application/pdf', 4096, 'report.pdf')]);
        const { uploads } = await filesToUpload(payloadFiles(dt), DROP_LIMIT);
        return uploads.length === 1 && uploads[0].fileName === 'report.pdf'
          || ('got ' + JSON.stringify(uploads.map((u) => u.fileName)));
      });

      await add('a dropped file keeps its mime type', async () => {
        const dt = drop([dropFile('application/pdf', 4096, 'report.pdf')]);
        const { uploads } = await filesToUpload(payloadFiles(dt), DROP_LIMIT);
        return uploads.length === 1 && uploads[0].mimeType === 'application/pdf'
          || ('got ' + JSON.stringify(uploads.map((u) => u.mimeType)));
      });

      await add('a dropped file is allowed to be bigger than a pasted one', async () => {
        // The same file is refused by the paste limit and accepted by the drop
        // limit, because a dropped file is one the user picked out of a folder.
        const big = dropFile('video/mp4', 60 * 1024 * 1024, 'holiday.mp4');
        const pasted = await filesToUpload([big], PASTE_LIMIT);
        const dropped = await filesToUpload([big], DROP_LIMIT);
        return pasted.rejected.length === 1 && dropped.uploads.length === 1
          || ('got ' + JSON.stringify({ pasted: pasted.rejected.length, dropped: dropped.uploads.length }));
      });

      await add('a dropped file that is too big is reported, not silently dropped', async () => {
        const huge = dropFile('video/mp4', 200 * 1024 * 1024, 'huge.mp4');
        const r = await filesToUpload([huge], DROP_LIMIT);
        return r.uploads.length === 0 && r.rejected.length === 1
          || ('got ' + JSON.stringify({ n: r.uploads.length, rej: r.rejected.length }));
      });

      await add('a dropped file with no name still gets one', () => {
        const name = attachFileName({ type: 'image/png', name: '' }, 0);
        return name === 'pasted-image-1.png' || ('got ' + name);
      });

      await add('a dropped document with no name gets a name that says what it is', () => {
        const name = attachFileName({ type: 'application/pdf', name: '' }, 0);
        return name === 'pasted-file-1.pdf' || ('got ' + name);
      });

      await add('a file with no name and no type still gets a name', () => {
        const name = attachFileName({ type: '', name: '' }, 2);
        return name === 'pasted-file-3.bin' || ('got ' + name);
      });

      await add('a pasted screenshot is chipped as a picture, not a document', () => {
        const pic = attachmentIcon({ mimeType: 'image/png' });
        const doc = attachmentIcon({ mimeType: 'application/pdf' });
        return pic && doc && pic !== doc
          || ('got ' + JSON.stringify({ pic: pic, doc: doc }));
      });

      // =====================================================================
      // The whole path, in the DOM the app ships
      // =====================================================================
      //
      // Everything above proves the parsing. This proves the wiring: a real
      // drag event, a real drop event, a real paste event, and the upload
      // that follows each one.
      const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60));

      const S = await import(${JSON.stringify(js('state.js'))});
      T.initThread();

      // A chat to drop into. The app opens a chat before anything can be
      // attached to it, and the drop is refused without one.
      S.state.chats.set('c-dom', {
        id: 'c-dom',
        title: 'A chat',
        type: 'single',
        participants: { items: [{ isSelf: true }, { isSelf: false }] },
      });
      S.state.chats.set('c-other', {
        id: 'c-other',
        title: 'Another chat',
        type: 'single',
        participants: { items: [{ isSelf: true }, { isSelf: false }] },
      });
      await T.openChat('c-dom');
      await settle();

      const listEl = document.getElementById('message-list');
      const chipsEl = document.getElementById('attachment-chips');
      const appEl = document.getElementById('app');
      const composerEl = document.getElementById('composer');

      // A hidden window cannot take focus, so document.activeElement is not
      // usable here. What is measured is that the app asks the composer for
      // focus, and that the composer is the last thing it asked.
      const focusCalls = [];
      const realFocus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function () {
        focusCalls.push(this.id || this.tagName);
        return realFocus.apply(this, arguments);
      };

      // A real File, as a real drag or paste carries it.
      const payload = (name, type, size) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(size)], name, { type: type }));
        return dt;
      };

      // Take the attachments off the way a user does: the remove button on
      // the chip. Emptying the DOM instead would leave the app still holding
      // them, and the next chip would be counted twice.
      const clearChips = async () => {
        for (let i = 0; i < 10; i++) {
          const remove = chipsEl.querySelector('button');
          if (!remove) break;
          remove.click();
          await settle(10);
        }
      };

      // --- a drag over the thread ------------------------------------------

      const dragPayload = payload('holiday.txt', 'text/plain', 2048);
      const over = new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dragPayload,
      });
      listEl.dispatchEvent(over);

      await add('a drag over the thread is claimed, or the drop never happens', () =>
        over.defaultPrevented === true || 'the dragover was not cancelled');

      await add('and the window says it will take the file', () =>
        appEl.classList.contains('is-dropping') || 'the drop hint was not shown');

      // --- the drop ---------------------------------------------------------

      const dropEvent = new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dragPayload,
      });
      listEl.dispatchEvent(dropEvent);
      await settle(200);

      await add('the drop is claimed, so the window cannot navigate to the file', () =>
        dropEvent.defaultPrevented === true || 'the drop was not cancelled');

      await add('a dropped file is uploaded', () =>
        uploads.length === 1 || (uploads.length + ' uploads happened'));

      await add('the upload carries the name the file was dropped with', () =>
        (uploads[0] && uploads[0].fileName === 'holiday.txt')
          || JSON.stringify(uploads[0]));

      await add('the upload carries the bytes of the dropped file', () =>
        (uploads[0] && uploads[0].bytes === 2048) || JSON.stringify(uploads[0]));

      await add('the upload carries the type of the dropped file', () =>
        (uploads[0] && uploads[0].mimeType === 'text/plain') || JSON.stringify(uploads[0]));

      await add('the dropped file shows up as a chip on the composer', () =>
        chipsEl.querySelectorAll('.att-chip').length === 1
          || (chipsEl.children.length + ' chips'));

      await add('the chip names the file', () =>
        /holiday\.txt/.test(chipsEl.textContent || '') || (chipsEl.textContent || ''));

      await add('the hint goes away once the file is dropped', () =>
        !appEl.classList.contains('is-dropping') || 'the hint is still showing');

      await add('the cursor goes back to the composer after the drop', () =>
        focusCalls[focusCalls.length - 1] === 'composer'
          || ('the last focus went to ' + focusCalls[focusCalls.length - 1]));

      // --- a paste ----------------------------------------------------------

      uploads.length = 0;
      await clearChips();

      const clipPayload = payload('pasted-doc.txt', 'text/plain', 1024);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: clipPayload,
      });
      composerEl.dispatchEvent(pasteEvent);
      await settle(200);

      await add('a pasted file is uploaded too', () =>
        uploads.length === 1 || (uploads.length + ' uploads happened'));

      await add('a pasted file keeps the name it came with', () =>
        (uploads[0] && uploads[0].fileName === 'pasted-doc.txt') || JSON.stringify(uploads[0]));

      await add('a pasted file shows up as a chip on the composer', () =>
        chipsEl.querySelectorAll('.att-chip').length === 1
          || (chipsEl.children.length + ' chips'));

      // --- the app re-opens the chat it is showing --------------------------
      //
      // The live event socket reconnects, and the app re-opens the chat it is
      // showing when it does. A file the user has just attached belongs to
      // that chat and has to survive the re-open.
      await T.openChat('c-dom');
      await settle(150);

      await add('re-opening the same chat keeps the attachment', () =>
        chipsEl.querySelectorAll('.att-chip').length === 1
          || (chipsEl.children.length + ' chips left after the re-open'));

      await T.openChat('c-other');
      await settle(150);

      await add('opening a different chat clears the attachment', () =>
        chipsEl.children.length === 0
          || (chipsEl.children.length + ' chips carried over to another chat'));

      // Back to the chat under test, with nothing pending.
      await T.openChat('c-dom');
      await settle(120);
      await clearChips();

      // --- and an ordinary text paste is left alone -------------------------

      uploads.length = 0;
      await clearChips();

      const textPayload = new DataTransfer();
      textPayload.setData('text/plain', 'just text');
      const textPaste = new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: textPayload,
      });
      composerEl.dispatchEvent(textPaste);
      await settle(150);

      await add('a text paste is not claimed, so it still pastes normally', () =>
        textPaste.defaultPrevented === false || 'the text paste was swallowed');

      await add('a text paste attaches nothing', () =>
        uploads.length === 0 || (uploads.length + ' uploads happened'));

      await add('a text paste puts no chip on the composer', () =>
        chipsEl.children.length === 0 || (chipsEl.children.length + ' chips'));

      // --- a drop with no chat open -----------------------------------------

      T.closeThread();
      await settle(80);
      uploads.length = 0;

      const orphanPayload = payload('orphan.txt', 'text/plain', 512);
      const orphanOver = new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: orphanPayload,
      });
      document.body.dispatchEvent(orphanOver);
      const orphanDrop = new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: orphanPayload,
      });
      document.body.dispatchEvent(orphanDrop);
      await settle(150);

      await add('a file dragged in with no chat open is still claimed', () =>
        orphanOver.defaultPrevented === true && orphanDrop.defaultPrevented === true
          || 'the drag was not claimed, so the browser would open the file');

      await add('and nothing is uploaded when there is no chat to attach it to', () =>
        uploads.length === 0 || (uploads.length + ' uploads happened'));

      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:paste' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(HARNESS);
  let harnessCases;
  try {
    const result = await win.webContents.executeJavaScript(harness, true);
    harnessCases = JSON.parse(result);
  } catch (err) {
    harnessCases = [['the browser harness ran to the end', false, err.message]];
  }
  app.exit(0);

  // The event wiring is checked against the source. The listeners only exist
  // once initThread() has run, and the browser-level path against the real
  // Beeper is covered by check:paste --live against the installed app.
  const threadSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'thread.js'), 'utf8');
  const sourceCases = [
    ['a drag is claimed during dragover, or the drop never happens at all',
      /addEventListener\('dragover',[\s\S]{0,600}?event\.preventDefault\(\);/.test(threadSrc)],
    ['the drop is claimed before the chat check, so the window cannot navigate to the file',
      /addEventListener\('drop',[\s\S]{0,600}?if \(files\.length\) event\.preventDefault\(\);[\s\S]{0,300}?if \(!currentChat\)/.test(threadSrc)],
    ['the composer is focused when a chat is opened',
      /export async function openChat[\s\S]{0,3000}?focusComposer\(\);/.test(threadSrc)],
  ].map(([name, ok]) => [name, ok, '']);

  const cases = harnessCases.concat(sourceCases);
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
