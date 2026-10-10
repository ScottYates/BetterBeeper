/**
 * One-off visual probe for the download feature.
 *
 * Not part of the suite: it writes a PNG so the button can be looked at rather
 * than measured. It renders through the real thread.js render path with the
 * real stylesheet and a real video file, then hovers the video with a real
 * mouse event so the button appears exactly as it does for a person.
 *
 * Run with: electron tools/download-shot.js <path-to-some.mp4>
 *
 * The video is passed in rather than generated, because the point is to render
 * something a real decoder accepts - a stub URL makes the player fail and the
 * render falls back to a file row, which is a screenshot of the wrong thing.
 */
const path = require('path');
const fs = require('node:fs');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'download-shot.png');

const SOURCE = process.argv[2];
if (!SOURCE || !fs.existsSync(SOURCE)) {
  console.error('usage: electron tools/download-shot.js <path-to-some.mp4>');
  process.exit(1);
}
// Copied next to the harness so the page can load it as a relative same-scheme
// subresource, which a path outside the page's own directory cannot always do.
const VIDEO = path.join(__dirname, '.shot-video.mp4');
fs.copyFileSync(SOURCE, VIDEO);

function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-download-shot-profile'));

  const url = (p) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', p)).href;

  return app.whenReady().then(async () => {
    harnessGuard(app, { label: 'download-shot' });
    // Shown, not hidden. A :hover rule only engages on a window the compositor
    // is actually tracking, so a hidden window leaves the button at opacity 0
    // and the screenshot would show a feature that is not there.
    const win = new BrowserWindow({ width: 560, height: 820, show: true });

    await win.loadFile(path.join(__dirname, 'download-harness.html'));

    const build = `(async () => {
      const videoURL = ${JSON.stringify(pathToFileURL(VIDEO).href)};
      const imgURL = 'data:image/svg+xml;base64,' + btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">'
        + '<rect width="240" height="240" fill="%233b6ea5"/>'
        + '<circle cx="120" cy="100" r="52" fill="%23f2c14e"/>'
        + '<rect y="176" width="240" height="64" fill="%232d4a66"/></svg>'
      );
      window.beeper = new Proxy({}, {
        get: (_t, ns) => new Proxy({}, {
          get: (_t2, fn) => (...args) => {
            const a = args[0] || {};
            if (ns === 'assets' && fn === 'resolve') {
              return Promise.resolve({ ok: true, data: { url: a.id === 'v1' ? videoURL : imgURL } });
            }
            return Promise.resolve({ ok: true, data: {} });
          },
        }),
      });

      const T = await import(${JSON.stringify(url('thread.js'))});
      const St = await import(${JSON.stringify(url('state.js'))});

      const CHAT = { id: '!shot', title: 'Note to self', unreadCount: 0, lastActivity: '2026-03-04T00:00:00Z' };
      document.body.style.background = '#11161d';
      St.state.chats.set(CHAT.id, CHAT);
      St.state.messages.set(CHAT.id, [{
        id: '~shot', chatID: CHAT.id, text: 'two attachments', senderName: 'You',
        isSender: true, isUnread: false, timestamp: new Date().toISOString(), sortKey: '~shot',
        attachments: [
          { id: 'v1', fileName: 'video.mp4', mimeType: 'video/mp4', fileSize: 1639620 },
          { id: 'i1', fileName: 'picture.png', mimeType: 'image/png', fileSize: 2048 },
        ],
      }]);
      T.initThread();
      await T.openChat(CHAT.id);
      await new Promise((r) => setTimeout(r, 1200));

      // Report what the player actually did, so a fallback cannot quietly turn
      // this screenshot into a picture of a file row.
      const v = document.querySelector('#message-list .att-video');
      const wrap = document.querySelector('#message-list .att-video-wrap');
      const btn = document.querySelector('#message-list .att-download');
      const box = wrap ? wrap.getBoundingClientRect() : null;
      const bb = btn ? btn.getBoundingClientRect() : null;
      return JSON.stringify({
        fellBackToFile: !wrap,
        videoReady: v ? (v.readyState >= 1) : false,
        wrap: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
        btn: bb ? { x: bb.x, y: bb.y, w: bb.width, h: bb.height } : null,
        doc: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
      });
    })()`;

    const info = JSON.parse(await win.webContents.executeJavaScript(build, true));
    console.log('render:', JSON.stringify(info));

    if (info.fellBackToFile) {
      console.log('the video fell back to a file row - nothing to look at');
      app.exit(0);
      return;
    }

    // A real hover, so the button appears through the real :hover rule rather
    // than by having its opacity forced from outside.
    const cx = Math.round(info.btn.x + info.btn.w / 2);
    const cy = Math.round(info.btn.y + info.btn.h / 2);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
    await new Promise((r) => setTimeout(r, 400));

    const opacity = await win.webContents.executeJavaScript(
      'getComputedStyle(document.querySelector("#message-list .att-download")).opacity', true);
    console.log('button opacity while hovered:', opacity);

    const image = await win.webContents.capturePage();
    fs.writeFileSync(OUT, image.toPNG());
    console.log('wrote', OUT);
    app.exit(0);
  });
}

main().catch((err) => { console.error('failed:', err.message); process.exit(1); });
