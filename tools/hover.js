/**
 * Dev helper: moves the real mouse over an element over CDP and reports how a
 * target reacts, so hover-only UI (the row archive button) can be verified.
 *
 * Usage: node tools/hover.js <hoverSelector> [observeSelector] [--shot=out.png]
 */
const WS = require('ws');
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const shotArg = args.find((a) => a.startsWith('--shot='));
  const [hoverSelector, observeSelector = '.row-action'] = args.filter((a) => !a.startsWith('--shot='));

  if (!hoverSelector) {
    console.error('usage: node tools/hover.js <hoverSelector> [observeSelector] [--shot=out.png]');
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

  const rect = await evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(hoverSelector)});
       if (!e) return null; const r = e.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!rect) throw new Error(`selector not found: ${hoverSelector}`);

  // Prefer the target inside the hovered element - the chat list renders the
  // Note card first, so a bare document lookup would watch the wrong button.
  const observeExpr = `(() => {
     const scope = document.querySelector(${JSON.stringify(hoverSelector)});
     const e = (scope && scope.querySelector(${JSON.stringify(observeSelector)}))
            || document.querySelector(${JSON.stringify(observeSelector)});
     if (!e) return null; const s = getComputedStyle(e);
     return { opacity: s.opacity, pointerEvents: s.pointerEvents, tip: e.dataset.tip || null,
              text: e.textContent }; })()`;

  const before = await evaluate(observeExpr);

  // A couple of intermediate moves, so :hover engages the way it does for a
  // user. The chat list re-renders on live events, which replaces the row node
  // out from under :hover - so the last move has to land after that settles.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x - 40, y: rect.y });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await new Promise((r) => setTimeout(r, 500)); // long enough for the tooltip dwell
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 1, y: rect.y });
  await new Promise((r) => setTimeout(r, 250));

  const after = await evaluate(observeExpr);

  console.log('hover   :', hoverSelector, JSON.stringify(rect));
  console.log('observe :', observeSelector);
  console.log('before  :', JSON.stringify(before));
  console.log('after   :', JSON.stringify(after));

  const revealed = after && Number(after.opacity) > 0.9 && after.pointerEvents !== 'none';
  console.log('revealed:', revealed ? 'YES ✓' : 'NO ✗');

  if (shotArg) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = shotArg.slice('--shot='.length);
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('shot    :', out);
  }
  ws.close();
  process.exit(revealed ? 0 : 1);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
