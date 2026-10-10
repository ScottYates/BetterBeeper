/**
 * Dev check: getting a message attachment out to disk.
 *
 * The gap this exists for: a file row was already the button that saves itself,
 * so plain documents could be saved by clicking them. Nothing did the same for
 * the two kinds the thread draws inline. An image could only be copied out as a
 * pasteable picture - not saved, because its menu had no Save item and its src
 * is a resolved beeper-file:// URL carrying no name to offer the dialog. A
 * video had no affordance at all: the image menu is wired to <img> only, so the
 * full message menu was the single route out, several clicks away.
 *
 * The rule is pure (download.js) and driven directly. The DOM is real: messages
 * are seeded into real state, rendered by the real render path, and the menu
 * that comes back is read off the real popover. Only the IPC boundary is
 * replaced, because the thing under test is the wiring between an attachment
 * and the save dialog - not the dialog.
 *
 * Run with `npm run check:download`.
 */
const path = require('path');
const fs = require('node:fs');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const url = (...p) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', ...p)).href;
const downloadURL = url('download.js');
const threadURL = url('thread.js');
const uiURL = url('ui.js');
const stateURL = url('state.js');
const threadPath = path.join(ROOT, 'src', 'renderer', 'js', 'thread.js');
const cssPath = path.join(ROOT, 'src', 'renderer', 'styles.css');

/**
 * The pure rule, run outside the browser.
 *
 * download.js has no imports and touches no DOM, so it is checked here rather
 * than over the wire. These are merged into the harness results below.
 */
async function pureCases() {
  const D = await import(downloadURL);
  const cases = [];
  // Strict, on purpose. These assertions are written as `cond || 'why it failed'`,
  // and a helper that coerces with !! would read that diagnostic string as a
  // pass - so every one of them below would be green forever no matter what the
  // rule did. Only a real true counts.
  const add = (name, ok, detail) => {
    const passed = ok === true;
    cases.push([name, passed, passed ? '' : (detail ?? String(ok))]);
  };
  // One assertion must never be able to take down the others. When the rule is
  // broken the thing most likely to break first is the code that reports it -
  // a diagnostic that walks the very array the bug corrupted will throw on the
  // null it was written to expose, and an uncaught throw takes the whole suite
  // with it, printing nothing at all. A rule that fails quietly is worse than
  // one that fails loudly.
  const check = (name, fn) => {
    try {
      const r = fn();
      add(name, r === true, r === true ? '' : String(r));
    } catch (e) {
      add(name, false, 'threw: ' + e.message);
    }
  };

  const att = (n) => ({ id: 'p' + n, fileName: 'file' + n + '.bin' });
  // Null-safe by construction: reports what it can name rather than throwing on
  // the first entry it cannot.
  const names = (list) => JSON.stringify(list.map((a) => (a ? a.id : String(a))));

  check('one attachment is a singular label', () =>
    D.downloadLabel(1) === 'Download attachment' || 'got: ' + D.downloadLabel(1));

  check('several attachments are plural and carry the count', () =>
    D.downloadLabel(4) === 'Download all (4)' || 'got: ' + D.downloadLabel(4));

  check('none at all does not become a download', () =>
    (D.downloadMenuItems({ attachments: [] }).length === 0
      && D.downloadMenuItems({}).length === 0
      && D.downloadMenuItems().length === 0) || 'an empty message still offered a download');

  // A null in the array would otherwise be counted in the label and then handed
  // to the save dialog, which has nothing to resolve for it.
  check('an empty slot is not counted as a file', () => {
    const withHoles = D.downloadableAttachments({ attachments: [att(1), null, att(2), undefined] });
    const label = D.downloadMenuItems({ attachments: [att(1), null, att(2)] })[0];
    return (withHoles.length === 2 && label.label === 'Download all (2)')
      || 'kept ' + withHoles.length + ' of 4, labelled "' + (label && label.label) + '"';
  });

  check('an attachments field of the wrong shape is treated as none', () =>
    (D.downloadableAttachments({ attachments: 'nope' }).length === 0
      && D.downloadableAttachments({ attachments: null }).length === 0) || 'it tried to iterate something else');

  // The count in the label is a promise about what happens when it is chosen.
  check('the count in the label is the number of files offered', () =>
    D.downloadMenuItems({ attachments: [att(1), att(2), att(3)] })[0].count === 3 || 'the count disagreed');

  check('a video button names the file when there is one', () =>
    D.videoSaveTitle({ fileName: 'clip.mp4' }) === 'Save clip.mp4'
      || 'got: ' + D.videoSaveTitle({ fileName: 'clip.mp4' }));

  check('a video with no filename still says what the button does', () =>
    (D.videoSaveTitle({}) === 'Save video' && D.videoSaveLabel({}) === 'Save video')
      || 'got: ' + names([{ title: D.videoSaveTitle({}) }, { label: D.videoSaveLabel({}) }]));

  return cases;
}

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-download-check-profile'));

  const harness = `
  (async () => {
      // The harness page has no preload, so window.beeper does not exist. This
      // is the boundary: everything above it is the app's own code.
      const saves = [];
      const resolved = [];
      window.beeper = new Proxy({}, {
        get: (_t, ns) => new Proxy({}, {
          get: (_t2, fn) => (...args) => {
            if (ns === 'assets' && fn === 'saveAs') {
              saves.push(args[0]);
              return Promise.resolve({ ok: true, data: { saved: true, name: (args[0] || {}).fileName || 'file' } });
            }
            if (ns === 'assets' && fn === 'resolve') {
              const a = args[0] || {};
              resolved.push(a);
              // One video deliberately has nothing behind it, so the inline
              // player cannot be built and the file row has to take over.
              if (String(a.id || '').indexOf('broken') !== -1) return Promise.resolve({ ok: true, data: {} });
              return Promise.resolve({ ok: true, data: { url: 'https://example.invalid/' + a.id } });
            }
            return Promise.resolve({ ok: true, data: {} });
          },
        }),
      });

      const T = await import(${JSON.stringify(threadURL)});
      const UI = await import(${JSON.stringify(uiURL)});
      const St = await import(${JSON.stringify(stateURL)});

      const cases = [];
      // Strict for the same reason as the one in pureCases: a helper that
      // coerces with !! would turn every assertion written as
      // "condition || reason it failed" into a check that can never fail,
      // because the reason is itself a truthy string.
      const add = (name, ok, detail) => {
        const passed = ok === true;
        cases.push([name, passed, passed ? '' : (detail ?? String(ok))]);
      };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      const CHAT = { id: '!download-check', title: 'Download chat', unreadCount: 0, lastActivity: '2026-03-04T00:00:00Z' };

      const msg = (id, attachments) => ({
        id: id, chatID: CHAT.id, text: 'here you go', senderName: 'Someone',
        isSender: false, isUnread: false,
        timestamp: new Date().toISOString(), sortKey: id,
        attachments: attachments || [],
      });

      // ---- the image path --------------------------------------------------

      const imgAtt = { id: 'att-img-1', fileName: 'picture.png', mimeType: 'image/png', fileSize: 2048 };
      St.state.chats.set(CHAT.id, CHAT);
      St.state.messages.set(CHAT.id, [msg('~dl:image', [imgAtt])]);
      T.initThread();
      await T.openChat(CHAT.id);
      await wait(200);

      const img = document.querySelector('#message-list img.att-image');
      add('an image attachment is drawn', img ? true : 'no .att-image was rendered');
      add('the image carries the attachment it was drawn from',
        (img && img.__attachment && img.__attachment.id === imgAtt.id) || 'the element had nothing to save');

      // Right-click it for real, through the delegated handler.
      const menuFor = (target) => {
        document.querySelectorAll('.msg-menu').forEach((n) => n.remove());
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
        return Array.from(document.querySelectorAll('.msg-menu button')).map((b) => b.textContent);
      };
      const labels = menuFor(img);
      add('right-clicking an attachment image offers to save it',
        labels.indexOf('Save image...') !== -1 || JSON.stringify(labels));

      // And the item does the right thing: the attachment behind that image,
      // not the src, which is a beeper-file:// URL with no name on it.
      saves.length = 0;
      const saveItem = Array.from(document.querySelectorAll('.msg-menu button'))
        .find((b) => b.textContent === 'Save image...');
      if (saveItem) saveItem.click();
      await wait(120);
      add('saving from the image menu saves that exact attachment',
        (saves.length === 1 && saves[0] && saves[0].id === imgAtt.id) || JSON.stringify(saves.map((s) => s && s.id)));

      {
        // The guard, on the real delegated path. The element goes inside
        // #message-list because that is the only place the handler is wired;
        // anything with nothing behind it must still get a menu, just not a
        // Save item that could not work.
        const list = document.querySelector('#message-list');
        const bare = document.createElement('img');
        bare.src = 'https://example.invalid/bare.png';
        list.append(bare);
        const bareLabels = menuFor(bare);
        bare.remove();
        add('an image with no attachment behind it is not offered a save',
          bareLabels.indexOf('Save image...') === -1 || JSON.stringify(bareLabels));
        add('and it still offers what it always did',
          bareLabels.indexOf('Open image') !== -1 || JSON.stringify(bareLabels));
      }

      // ---- the video path --------------------------------------------------

      const vidAtt = { id: 'att-vid-1', fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: 999 };
      St.state.messages.set(CHAT.id, [msg('~dl:video', [vidAtt])]);
      T.closeThread();
      await T.openChat(CHAT.id);

      // Read the DOM now, with no wait. The wrapper and its button are built
      // synchronously by the render, but this harness has no real video to give
      // the player: the stub URL is not decodable, so once the media stack
      // rejects it the error handler swaps the whole wrapper for a file row -
      // correctly, and exactly what the next block tests. Sleeping here would
      // race that and test the fallback instead of the player.
      const wrap = document.querySelector('#message-list .att-video-wrap');
      const dlBtn = wrap && wrap.querySelector('button.att-download');

      add('a video is drawn inside a wrapper', wrap ? true : 'the video is not wrapped');
      add('the wrapper holds the player and a save button',
        (wrap !== null
          && wrap.querySelector('video.att-video') !== null
          && dlBtn !== null && dlBtn !== undefined)
          || 'the wrapper is missing one of its two parts');

      // el() sets whatever key it is given, and the DOM lowercases attribute
      // names - so a stray ariaLabel would be present on the element and read
      // by nothing at all. This is the check for that specific mistake.
      add('the save button has a real aria-label, not a silently ignored one',
        (dlBtn && dlBtn.getAttribute('aria-label') && !dlBtn.getAttribute('arialabel'))
          || 'aria-label was missing or misspelled');

      saves.length = 0;
      // Clicked before any await, while the wrapper is still the live node.
      if (dlBtn) dlBtn.click();
      await wait(120);
      add('the video save button saves the video',
        (saves.length === 1 && saves[0] && saves[0].id === vidAtt.id) || JSON.stringify(saves.map((s) => s && s.id)));

      // ---- a video that is not a video -------------------------------------

      const brokenAtt = { id: 'att-broken-1', fileName: 'pretend.mp4', mimeType: 'video/mp4', fileSize: 12 };
      St.state.messages.set(CHAT.id, [msg('~dl:broken', [brokenAtt])]);
      T.closeThread();
      await T.openChat(CHAT.id);
      await wait(250);

      add('a video that cannot be resolved becomes an ordinary file row',
        document.querySelector('#message-list button.att-file') ? true : 'no file row took its place');
      // Replacing the bare <video> instead of the wrapper would leave the save
      // button stranded beside the file row, with no video under it.
      add('and it leaves no orphaned save button behind',
        (document.querySelector('#message-list .att-download') === null) || 'the button outlived the video it belonged to');

      // ---- a plain file still saves itself ----------------------------------

      const fileAtt = { id: 'att-file-1', fileName: 'notes.pdf', fileSize: 42 };
      St.state.messages.set(CHAT.id, [msg('~dl:file', [fileAtt])]);
      T.closeThread();
      await T.openChat(CHAT.id);
      await wait(250);

      saves.length = 0;
      const fileRow = document.querySelector('#message-list button.att-file');
      if (fileRow) fileRow.click();
      await wait(120);
      add('a file row still saves by being clicked',
        (saves.length === 1 && saves[0] && saves[0].id === fileAtt.id) || JSON.stringify(saves.map((s) => s && s.id)));

      // ---- the message menu -------------------------------------------------

      const anchor = document.createElement('div');
      document.body.append(anchor);
      const menuLabels = (m) => T.messageMenuItems(anchor, m).map((i) => i.label);
      const pick = (m, prefix) => {
        const item = T.messageMenuItems(anchor, m).find((i) => i.label.indexOf(prefix) === 0);
        return item ? item.onSelect() : undefined;
      };

      const one = menuLabels(msg('~dl:one', [imgAtt]));
      add('a message with one attachment offers to download it',
        one.indexOf('Download attachment') !== -1 || JSON.stringify(one));

      const three = menuLabels(msg('~dl:three', [imgAtt, vidAtt, fileAtt]));
      add('a message with three says how many',
        three.indexOf('Download all (3)') !== -1 || JSON.stringify(three));

      const none = menuLabels(msg('~dl:none', []));
      add('a message with no attachments has no download entry',
        !none.some((l) => l.indexOf('Download') === 0) || JSON.stringify(none));

      saves.length = 0;
      await pick(msg('~dl:three', [imgAtt, vidAtt, fileAtt]), 'Download');
      await wait(250);
      add('downloading a message saves every attachment, one dialog each',
        saves.length === 3 || JSON.stringify(saves.map((s) => s && s.id)));

      // ---- the cached image must not go stale -------------------------------

      // The same attachment id can come back with a different object behind it -
      // a re-sent file, a name that changed. The element is cached and reused,
      // so an attachment carried forward from the first render would save the
      // old file while the user was looking at the new one.
      const first = { id: 'att-reuse', fileName: 'old.png', mimeType: 'image/png' };
      const second = { id: 'att-reuse', fileName: 'new.png', mimeType: 'image/png' };
      St.state.messages.set(CHAT.id, [msg('~dl:reuse', [first])]);
      T.closeThread();
      await T.openChat(CHAT.id);
      await wait(250);
      const firstEl = document.querySelector('#message-list img.att-image');

      St.state.messages.set(CHAT.id, [msg('~dl:reuse', [second])]);
      T.closeThread();
      await T.openChat(CHAT.id);
      await wait(250);
      const secondEl = document.querySelector('#message-list img.att-image');

      add('a reused image element really was reused',
        (firstEl && secondEl && firstEl === secondEl) || 'the fixture never hit the cache');
      add('and it saves the file it is now showing, not the one it first showed',
        (secondEl && secondEl.__attachment && secondEl.__attachment.fileName === 'new.png')
          || 'a stale attachment was left on the cached element');

      // ---- where the button actually lands ----------------------------------

      // Measured in a real layout, because this is the one thing the source
      // cannot answer. .msg-attachments is a column flex container, and a flex
      // item is blockified - so display: inline-block on the wrapper does NOT
      // keep it shrink-wrapped; align-items: stretch fills it across the bubble
      // instead, and the absolutely positioned button lands in the far corner
      // of empty space rather than on the video.
      {
        const host = document.createElement('div');
        host.className = 'msg-attachments';
        host.style.width = '640px';
        const probe = document.createElement('div');
        probe.className = 'att-video-wrap';
        const player = document.createElement('video');
        player.className = 'att-video';
        player.style.width = '200px';
        player.style.height = '120px';
        const mark = document.createElement('button');
        mark.className = 'att-download';
        probe.append(player, mark);
        host.append(probe);
        document.body.append(host);

        const wrapBox = probe.getBoundingClientRect();
        const videoBox = player.getBoundingClientRect();
        const markBox = mark.getBoundingClientRect();
        host.remove();

        add('the video wrapper shrink-wraps to the video rather than the bubble',
          Math.abs(wrapBox.width - videoBox.width) <= 1
            || 'wrapper ' + Math.round(wrapBox.width) + 'px wide around a ' + Math.round(videoBox.width) + 'px video');

        // The point of shrinking: the button sits over the video's own corner,
        // not over the far side of the bubble.
        const insideVideo = markBox.left >= videoBox.left - 1 && markBox.right <= videoBox.right + 1;
        add('the save button sits on the video, not in the corner of the bubble',
          insideVideo
            || 'button spans ' + Math.round(markBox.left) + '-' + Math.round(markBox.right)
              + ' over a video at ' + Math.round(videoBox.left) + '-' + Math.round(videoBox.right));
      }

      anchor.remove();
      St.state.chats.delete(CHAT.id);
      St.state.messages.delete(CHAT.id);

      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:download' });

  const pure = await pureCases();

  // The source checks are computed here, before the browser runs, and merged
  // with whatever it produced. A harness that dies on load must still be able
  // to report the wiring that is missing from the source.
  const threadSrc = fs.readFileSync(threadPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const sourceCases = [
    ['the video fallback replaces the wrapper, not the bare player',
      /if \(!wrap\.isConnected\) return;\s*wrap\.replaceWith\(fileNode\(attachment\)\);/.test(threadSrc)],
    ['the image menu is given the attachment to save',
      /attachment: img\.__attachment/.test(threadSrc)],
    ['the attachment is stamped on the image at creation',
      /img\.__attachment = attachment;/.test(threadSrc)],
    ['the cached image has it refreshed on reuse too',
      /cached\.__attachment = attachment;/.test(threadSrc)],
    ['the message menu uses the shared rule for its label',
      /\.\.\.downloadMenuItems\(message\)\.map/.test(threadSrc)],
    ['saving a message goes through the one-at-a-time helper',
      /saveAttachments\(downloadableAttachments\(message\)\)/.test(threadSrc)],
    ['the save button starts unclickable while it is invisible',
      // Scoped to the .att-download block, not the bare declarations: an
      // unrelated rule already pairs opacity: 0 with pointer-events: none, so
      // an unscoped pattern matched that one and passed no matter what happened
      // to this button.
      /\.att-download \{[^}]*opacity: 0;[^}]*pointer-events: none;/.test(css)],
    ['the wrapper positions the button against the video',
      /\.att-video-wrap \{[^}]*position: relative;/.test(css)],
    // The browser measures the layout above; this is the fast textual signal
    // for the part that is easy to drop, since flexbox blockifies the wrapper
    // and stretches it across the bubble without it.
    ['the wrapper opts out of the flex stretch that would widen it',
      /\.att-video-wrap \{[^}]*align-self: flex-start;/.test(css)],
  ].map(([name, ok]) => [name, ok, '']);

  const win = new BrowserWindow({ show: false });
  // A real file:// page, because a data: URL cannot import an ES module.
  await win.loadFile(path.join(__dirname, 'download-harness.html'));
  let harnessCases;
  try {
    const result = await win.webContents.executeJavaScript(harness, true);
    harnessCases = JSON.parse(result);
  } catch (err) {
    harnessCases = [['the browser harness ran to the end', false, err.message]];
  }
  app.exit(0);
  return pure.concat(harnessCases).concat(sourceCases);
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
