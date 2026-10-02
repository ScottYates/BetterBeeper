/**
 * Dev helper: render the shipped network glyphs large, on their real badge
 * colours, and screenshot the sheet. Used to eyeball the artwork and to
 * regenerate docs/network-glyphs.png.
 *
 * Usage: node tools/glyph-sheet.js [--shot=docs/network-glyphs.png]
 *
 * The module is imported with a cache-busting query because ES modules are
 * cached by URL: re-importing the same specifier would not re-run it.
 */
const WS = require('ws');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const shot = (args.find((a) => a.startsWith('--shot=')) || '--shot=docs/network-glyphs.png').slice(7);
const port = Number((args.find((a) => a.startsWith('--port=')) || '--port=9222').slice(7));

const NAMES = [
  'Beeper', 'Signal', 'Google Voice', 'Facebook', 'WhatsApp', 'Telegram', 'Instagram',
  'Discord', 'SMS', 'iMessage', 'Gmail', 'Google Chat', 'X / Twitter', 'LinkedIn',
  'TikTok', 'Reddit', 'Bluesky', 'Steam', 'Slack', 'Zoom', 'LINE', 'WeChat',
  'Nextcloud', 'Pinterest', 'Twitch', 'Some Unknown Net',
];

async function main() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const target = (await res.json()).find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!target) throw new Error('no renderer target (start the app with --remote-debugging-port)');

  const ws = new WS(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  const moduleURL =
    'file:///' + path.join(__dirname, '..', 'src', 'renderer', 'js', 'network-icons.js').replace(/\\/g, '/');

  const expression = `(async () => {
    const m = await import(${JSON.stringify(moduleURL)} + '?v=' + Date.now());
    document.getElementById('glyph-preview')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'glyph-preview';
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:#0d0d0f;color:#ececee;'
      + 'font:13px system-ui;padding:24px;display:grid;gap:16px;'
      + 'grid-template-columns:repeat(7,1fr);align-content:start';
    for (const n of ${JSON.stringify(NAMES)}) {
      const cell = document.createElement('div');
      cell.style.cssText = 'text-align:center';
      const svg = m.networkIconMarkup(n, { size: 46 });
      const disc = m.badgeBackground(n) || '#2a2a30';
      cell.innerHTML = svg
        ? '<span style="display:grid;place-items:center;width:66px;height:66px;margin:0 auto 8px;'
          + 'border-radius:50%;color:#fff;background:' + disc + '">' + svg + '</span>'
        : '<span style="display:grid;place-items:center;width:66px;height:66px;margin:0 auto 8px;'
          + 'border-radius:50%;background:#6a2a2a;font-size:26px;font-weight:800">'
          + n.slice(0, 2).toUpperCase() + '</span>';
      cell.append(Object.assign(document.createElement('div'), { textContent: n }));
      wrap.append(cell);
    }
    document.body.append(wrap);
    return 'up: ' + ${NAMES.length};
  })()`;

  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'render failed');
  console.log(out.result.value);

  if (shot) {
    const img = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(img.data, 'base64'));
    console.log('— screenshot written to ' + shot);
  }
  ws.close();
}

main().catch((e) => { console.error('glyph-sheet failed:', e.message); process.exit(1); });
