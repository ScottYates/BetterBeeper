/**
 * Dev helper: performs a real mouse click on an element inside the running app
 * over CDP, so click handlers fire the way they do for a user.
 * Usage: node tools/click.js [--page=<substring>] [--port=9222] <selector>
 */
const WS = require('ws');

async function main() {
  const args = process.argv.slice(2);
  const pageFlag = args.find((a) => a.startsWith('--page='));
  const portFlag = args.find((a) => a.startsWith('--port='));
  const port = portFlag ? Number(portFlag.slice('--port='.length)) : 9222;
  const match = pageFlag ? pageFlag.slice('--page='.length) : 'index.html';
  const selector = args.find((a) => !a.startsWith('--'));
  if (!selector) {
    console.error('usage: node tools/click.js [--page=<substring>] <selector>');
    process.exit(1);
  }

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
  const point = await evaluate(
    `(() => { const e = document.querySelector(${sel}); if (!e) return null;
       e.scrollIntoView({ block: 'center', inline: 'center' });
       const r = e.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`,
  );
  if (!point) throw new Error(`selector not found: ${selector}`);
  if (point.w === 0 || point.h === 0) throw new Error(`selector has no box: ${selector}`);

  console.log(`clicking ${selector} at (${Math.round(point.x)}, ${Math.round(point.y)}) box ${point.w}x${point.h}`);

  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y, buttons: 0,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  });

  ws.close();
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
