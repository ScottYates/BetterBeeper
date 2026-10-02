/**
 * Dev helper: sends a real wheel event to the running app over CDP and
 * reports whether the target scroller actually moved.
 *
 * The image viewer is its own window, so pass --page=viewer.html to zoom an
 * image instead of scrolling the main window.
 *
 * Usage: node tools/wheel.js [--page=<substring>] <selector> <deltaY> [x] [y]
 */
const WS = require('ws');

async function main() {
  const args = process.argv.slice(2);
  const pageFlag = args.find((a) => a.startsWith('--page='));
  const match = pageFlag ? pageFlag.slice('--page='.length) : 'index.html';
  const [selector, deltaYArg, xArg, yArg] = args.filter((a) => !a.startsWith('--'));
  if (!selector) {
    console.error('usage: node tools/wheel.js [--page=<substring>] <selector> <deltaY> [x] [y]');
    process.exit(1);
  }
  const deltaY = Number(deltaYArg ?? -400);

  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(match));
  if (!page) throw new Error(`no renderer target matching "${match}"`);

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

  const rect = await evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
  );
  if (!rect) throw new Error(`selector not found: ${selector}`);

  const x = Number(xArg ?? rect.x);
  const y = Number(yArg ?? rect.y);

  const before = await evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)});
      return { scrollTop: e.scrollTop, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }; })()`,
  );

  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse',
  });
  await new Promise((r) => setTimeout(r, 500));

  const after = await evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)});
      return { scrollTop: e.scrollTop, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }; })()`,
  );

  console.log('before:', JSON.stringify(before));
  console.log('after: ', JSON.stringify(after));

  // The image viewer answers the wheel with a zoom, not a scroll, so report the
  // thing that actually moved rather than always claiming the scroll failed.
  const zoom = await evaluate(
    `(() => { const z = document.getElementById('zoom'); const i = document.getElementById('img');
      return z || i ? { zoom: z?.textContent ?? null, transform: i?.style.transform ?? null } : null; })()`,
  );
  if (zoom) {
    console.log('zoom:  ', JSON.stringify(zoom));
    console.log(
      match.includes('viewer')
        ? (zoom.transform ? 'ZOOMED ✓' : 'DID NOT ZOOM ✗')
        : (zoom.zoom && zoom.zoom !== '100%' ? 'NOTE: zoom is not 100% - are you on the viewer window?' : ''),
    );
  }

  console.log(
    after.scrollTop !== before.scrollTop
      ? 'SCROLLED ✓'
      : (zoom && match.includes('viewer') ? 'no scroll (expected - the wheel zooms here)' : 'DID NOT SCROLL ✗'),
  );
  ws.close();
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
