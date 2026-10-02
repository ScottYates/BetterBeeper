/**
 * Dev helper: report the real browser window bounds (Browser.getWindowForTarget),
 * which are independent of any renderer-side Emulation override.
 * Usage: node tools/window-bounds.js
 */
const WS = require('ws');

async function main() {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const pages = targets.filter((t) => t.type === 'page');
  console.log('targets:');
  for (const t of pages) console.log('  -', t.url.slice(0, 110));

  // The Browser domain is only reachable from the browser-level endpoint.
  const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const ws = new WS(version.webSocketDebuggerUrl, { perMessageDeflate: false });
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

  await new Promise((r) => ws.on('open', r));
  for (const t of pages) {
    const forTarget = await send('Browser.getWindowForTarget', { targetId: t.id });
    const windowId = forTarget.result?.windowId;
    if (windowId == null) {
      console.log(`  ${t.url.slice(-40)}: no windowId (${JSON.stringify(forTarget.error ?? {})})`);
      continue;
    }
    const bounds = await send('Browser.getWindowBounds', { windowId });
    const b = bounds.result.bounds;
    console.log(`  ${t.url.slice(-24)}: ${b.width}x${b.height} at (${b.x},${b.y}) state=${bounds.result.windowState}`);
  }
  ws.close();
}

main().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
