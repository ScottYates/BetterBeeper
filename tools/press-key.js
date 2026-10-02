/**
 * Dev helper: sends a real key press to the running app over CDP, so keyboard
 * shortcuts can be verified the way a user actually triggers them.
 *
 * Usage: node tools/press-key.js Escape [--shot=out.png]
 */
const WS = require('ws');
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const shotArg = args.find((a) => a.startsWith('--shot='));
  const [key] = args.filter((a) => !a.startsWith('--shot='));
  if (!key) {
    console.error('usage: node tools/press-key.js <Key> [--shot=out.png]');
    process.exit(1);
  }

  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('no renderer target');

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
  await send('Page.enable');

  const stateExpr = `JSON.stringify({
    chat: document.getElementById('thread-name')?.textContent ?? null,
    threadHidden: document.getElementById('thread')?.hidden ?? null,
    emptyShown: !document.getElementById('thread-empty')?.hidden ?? null,
    modalOpen: !document.getElementById('modal-root')?.hidden ?? null,
  })`;

  const before = await evaluate(stateExpr);

  const base = {
    key,
    code: key,
    windowsVirtualKeyCode: key === 'Escape' ? 27 : 0,
    nativeVirtualKeyCode: key === 'Escape' ? 27 : 0,
  };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await new Promise((r) => setTimeout(r, 400));

  const after = await evaluate(stateExpr);

  console.log('key   :', key);
  console.log('before:', before);
  console.log('after :', after);

  if (shotArg) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = shotArg.slice('--shot='.length);
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('shot  :', out);
  }
  ws.close();
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
