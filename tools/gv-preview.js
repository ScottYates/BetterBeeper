// Dev helper: render candidate Google Voice glyphs large, side by side, so the
// shape can be compared against the real app icon before it ships.
// Usage: node tools/gv-preview.js [--shot=docs/gv.png]
const WS = require('ws');

const args = process.argv.slice(2);
const shot = (args.find((a) => a.startsWith('--shot=')) || '--shot=').slice(7);
const port = 9222;

// Each candidate is one 16x16 SVG. `fill` is shared so the gradient can be
// swapped per candidate.
const gradient = (id) => `
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#00C9A7"/>
      <stop offset="0.5" stop-color="#3ED16B"/>
      <stop offset="1" stop-color="#25C55F"/>
    </linearGradient>
  </defs>`;

// The mark is two pieces: a petal in the upper right whose tip points to the
// lower left, and a comma-shaped hook below it whose rounded end is the bulb.
// They are separated by a thin diagonal gap, as in the real app icon.
const CANDIDATES = [
  {
    name: 'U R + sharp tip',
    svg: (g) => `${gradient(g)}
      <path d="M4.3 8.2C4.7 4.1 7.3 1.3 10.2 1.3c2.6 0 4.3 1.4 4.3 3.9 0 2.1-1.4 3.7-3.7 3.9Z" fill="url(#${g})"/>
      <path d="M3.0 7.9c-.3 2.9 1.7 5.8 5.0 6.2 2.1.2 3.8-.8 4.3-2.4" fill="none" stroke="url(#${g})" stroke-width="2.55" stroke-linecap="round"/>`,
  },
  {
    name: 'V R + tighter fit',
    svg: (g) => `${gradient(g)}
      <path d="M4.6 8.5C5.0 4.4 7.5 1.6 10.3 1.6c2.5 0 4.2 1.4 4.2 3.7 0 2-1.4 3.5-3.6 3.8Z" fill="url(#${g})"/>
      <path d="M3.2 8.2c-.3 2.8 1.6 5.5 4.7 5.9 2 .2 3.6-.8 4.1-2.3" fill="none" stroke="url(#${g})" stroke-width="2.5" stroke-linecap="round"/>`,
  },
  {
    name: 'W S + bigger hook',
    svg: (g) => `${gradient(g)}
      <path d="M5.1 8.3C5.4 4.3 7.8 1.4 10.4 1.4c2.5 0 4.1 1.4 4.1 3.8 0 2.1-1.4 3.5-3.6 3.8Z" fill="url(#${g})"/>
      <path d="M3.0 7.3c-.4 3.1 1.7 6.2 5.1 6.5 2.1.2 3.8-.8 4.2-2.4" fill="none" stroke="url(#${g})" stroke-width="2.6" stroke-linecap="round"/>`,
  },
  {
    name: 'X balanced',
    svg: (g) => `${gradient(g)}
      <path d="M4.5 8.3C4.8 4.2 7.4 1.3 10.3 1.3c2.6 0 4.3 1.4 4.3 3.8 0 2.1-1.4 3.6-3.7 3.9Z" fill="url(#${g})"/>
      <path d="M3.1 7.6c-.4 3 1.7 6 5.1 6.4 2.1.2 3.8-.8 4.2-2.4" fill="none" stroke="url(#${g})" stroke-width="2.55" stroke-linecap="round"/>`,
  },
  {
    name: 'Y flat-bottom petal',
    svg: (g) => `${gradient(g)}
      <path d="M4.6 8.6C4.9 4.4 7.4 1.4 10.3 1.4c2.6 0 4.3 1.5 4.3 3.9 0 2-1.4 3.4-3.6 3.7Z" fill="url(#${g})"/>
      <path d="M3.0 7.7c-.4 3 1.7 6 5.1 6.4 2.1.2 3.8-.8 4.2-2.4" fill="none" stroke="url(#${g})" stroke-width="2.55" stroke-linecap="round"/>`,
  },
];

async function main() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('no renderer target (is the app running with --remote-debugging-port=9222?)');

  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id; pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  // Functions do not survive JSON.stringify, so render the markup here and pass
  // the finished cells across.
  const cells = CANDIDATES.map((c, i) => {
    const big = `<svg viewBox="0 0 16 16" width="120" height="120">${c.svg('g' + i)}</svg>`;
    const small = `<svg viewBox="0 0 16 16" width="11" height="11">${c.svg('s' + i)}</svg>`;
    const disc = (bg, inner, size) =>
      `<span style="display:grid;place-items:center;width:${size}px;height:${size}px;`
      + `border-radius:50%;background:${bg};margin:0 auto 6px">${inner}</span>`;
    return {
      name: c.name,
      html:
        disc('#0f1512', big, 132)
        + disc('#34a853', small, 132)
        + `<span style="display:grid;place-items:center;width:26px;height:26px;`
        + `border-radius:50%;background:#0f1512;margin:0 auto">${small}</span>`,
    };
  });

  const expression = `(() => {
    document.getElementById('gv-preview')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'gv-preview';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0d0d0f;color:#ececee;'
      + 'font:12px system-ui;padding:20px;display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap';
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

  const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'failed');
  console.log(out.result.value);

  if (shot) {
    const shotRes = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(shot, Buffer.from(shotRes.data, 'base64'));
    console.log('— screenshot written to ' + shot);
  }
  ws.close();
}

main().catch((e) => { console.error('gv-preview failed:', e.message); process.exit(1); });
