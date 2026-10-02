/**
 * Dev helper: performs a real press-move-release drag inside the running app
 * over CDP, to verify the image viewer pans instead of closing.
 *
 * The viewer is its own window (viewer.html), so this defaults to that target.
 * Pass --page=index.html to drag inside the main window instead.
 *
 * Usage: node tools/drag.js [--page=<substring>] [--port=9222] <selector> [dx] [dy]
 */
const WS = require('ws');

async function main() {
  const args = process.argv.slice(2);
  const pageFlag = args.find((a) => a.startsWith('--page='));
  const portFlag = args.find((a) => a.startsWith('--port='));
  const port = portFlag ? Number(portFlag.slice('--port='.length)) : 9222;
  const match = pageFlag ? pageFlag.slice('--page='.length) : 'viewer.html';
  const rest = args.filter((a) => !a.startsWith('--'));

  const [selector, dxArg, dyArg] = rest;
  if (!selector) {
    console.error('usage: node tools/drag.js [--page=<substring>] <selector> [dx] [dy]');
    process.exit(1);
  }
  const dx = Number(dxArg ?? -140);
  const dy = Number(dyArg ?? -90);

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(match));
  if (!page) {
    console.error(`no renderer target matching "${match}"`);
    process.exit(1);
  }

  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value;
  };

  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');

  const sel = JSON.stringify(selector);
  const rect = await evaluate(
    `(() => { const e = document.querySelector(${sel}); if (!e) return null;
       const r = e.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!rect) throw new Error(`selector not found: ${selector}`);

  // Viewer's own DOM: #img carries the transform, #zoom shows the percentage.
  // "still open" means the viewer window's renderer is still attached.
  const stateExpr = `(() => {
    const img = document.getElementById('img');
    return {
      transform: img ? img.style.transform : null,
      zoom: document.getElementById('zoom')?.textContent ?? null,
      open: !!document.getElementById('stage'),
    };
  })()`;

  const before = await evaluate(stateExpr);

  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1,
  });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x + (dx * i) / steps,
      y: rect.y + (dy * i) / steps,
      button: 'left',
      buttons: 1,
    });
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: rect.x + dx, y: rect.y + dy, button: 'left', buttons: 0, clickCount: 1,
  });
  await new Promise((r) => setTimeout(r, 350));

  const after = await evaluate(stateExpr);

  console.log('page:   ', match);
  console.log('before:', JSON.stringify(before));
  console.log('after: ', JSON.stringify(after));
  console.log('panned:  ', before.transform !== after.transform ? 'YES ✓' : 'NO ✗');
  console.log('still open:', after.open ? 'YES ✓' : 'NO ✗ (click closed it)');
  ws.close();
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
