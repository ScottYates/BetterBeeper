/**
 * Dev helper: render candidate glyphs large on their real badge colour so the
 * shape can be compared before it ships.
 *
 * Usage: node tools/glyph-candidates.js --key=facebook [--shot=out.png]
 *
 * Candidates live in CANDIDATES below. Each is markup for a 16x16 viewBox,
 * painted in `currentColor` unless it needs its own colours.
 */
const WS = require('ws');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const key = flag('key', 'facebook');
const shot = flag('shot', '');
const port = Number(flag('port', '9222'));

const CANDIDATES = {
  facebook: [
    {
      name: 'g-1 f2 centred',
      badge: '#1877f2',
      svg: '<path d="M13.9 1.9c-.9-.1-1.6-.2-2.5-.2-3 0-4.9 1.8-4.9 5v1.6H4.1v2.9h2.4v5.1h3.4v-5.1h2.8l.4-2.9H9.9V6.9c0-1.1.5-1.6 1.7-1.6.7 0 1.4.1 2 .3Z" fill="currentColor"/>',
    },
    {
      name: 'g-2 rounder bowl',
      badge: '#1877f2',
      svg: '<path d="M14 1.8c-1-.1-1.8-.2-2.7-.2-3.1 0-5 1.9-5 5.2v1.4H4v3h2.3v5.1h3.5V11.2h2.9l.4-3H9.8V6.8c0-1.1.5-1.6 1.8-1.6.7 0 1.5.1 2.1.3Z" fill="currentColor"/>',
    },
    {
      name: 'g-3 classic',
      badge: '#1877f2',
      svg: '<path d="M13.8 2c-.9-.1-1.6-.2-2.4-.2-2.9 0-4.8 1.8-4.8 4.9v1.7H4.2v2.8h2.4v5.1h3.4V11.2h2.8l.4-2.8H10V6.8c0-1.1.5-1.6 1.7-1.6.6 0 1.4.1 2 .3Z" fill="currentColor"/>',
    },
    {
      name: 'g-4 f2 tighter',
      badge: '#1877f2',
      svg: '<path d="M13.6 2.1c-.8-.1-1.5-.2-2.3-.2-2.8 0-4.6 1.7-4.6 4.8v1.5H4.5v2.8h2.2v5.1h3.2V11.2h2.7l.4-2.8H9.7V6.9c0-1.1.5-1.6 1.6-1.6.6 0 1.3.1 1.9.3Z" fill="currentColor"/>',
    },
    {
      name: 'g-5 on dark',
      badge: '#101418',
      svg: '<path d="M13.6 2.1c-.8-.1-1.5-.2-2.3-.2-2.8 0-4.6 1.7-4.6 4.8v1.5H4.5v2.8h2.2v5.1h3.2V11.2h2.7l.4-2.8H9.7V6.9c0-1.1.5-1.6 1.6-1.6.6 0 1.3.1 1.9.3Z" fill="#4a90ff"/>',
    },
  ],
};

async function main() {
  const cands = CANDIDATES[key];
  if (!cands) throw new Error(`no candidates for "${key}" (have: ${Object.keys(CANDIDATES).join(', ')})`);

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

  const cells = cands.map((c, i) => {
    const big = `<svg viewBox="0 0 16 16" width="110" height="110">${c.svg}</svg>`;
    const small = `<svg viewBox="0 0 16 16" width="11" height="11">${c.svg}</svg>`;
    const disc = (size, inner) =>
      `<span style="display:grid;place-items:center;width:${size}px;height:${size}px;`
      + `border-radius:50%;background:${c.badge};color:#fff;margin:0 auto 6px">${inner}</span>`;
    return { name: c.name, html: disc(124, big) + disc(124, small) };
  });

  const expression = `(() => {
    document.getElementById('cand-preview')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'cand-preview';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0d0d0f;color:#ececee;'
      + 'font:12px system-ui;padding:22px;display:flex;gap:18px;align-items:flex-start';
    ${JSON.stringify(cells)}.forEach((c) => {
      const cell = document.createElement('div');
      cell.style.cssText = 'text-align:center';
      cell.innerHTML = c.html;
      cell.append(Object.assign(document.createElement('div'), { textContent: c.name }));
      wrap.append(cell);
    });
    document.body.append(wrap);
    return 'up: ' + ${cells.length};
  })()`;

  const out = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'failed');
  console.log(out.result.value);

  if (shot) {
    const img = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(img.data, 'base64'));
    console.log('— screenshot written to ' + shot);
  }
  ws.close();
}

main().catch((e) => { console.error('glyph-candidates failed:', e.message); process.exit(1); });
