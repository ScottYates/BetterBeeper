// Dev helper: dump the raw message records behind the last few bubbles, so a
// duplicate or stuck placeholder can be diagnosed from the data rather than the DOM.
const WS = require('ws');
const args = process.argv.slice(2);
const flag = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const chatTitle = flag('chat', 'Signal Note to Self');
const count = Number(flag('n', '6'));

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json/list');
  const t = (await res.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
  if (!t) throw new Error('no renderer target');
  const ws = new WS(t.webSocketDebuggerUrl, { perMessageDeflate: false });
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

  const expression = `(async () => {
    const m = await import('./js/state.js');
    const list = [...m.state.messages.get(m.state.activeChatID) || []];
    return JSON.stringify(list.slice(-${count}).map((x) => ({
      id: x.id,
      isSender: x.isSender,
      sendStatus: x.sendStatus || null,
      text: (x.text || '').slice(0, 42),
      ts: x.timestamp,
      acct: x.accountID || null,
      reply: x.replyToMessageID || null,
    })), null, 1);
  })()`;

  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description);
  console.log('activeChatID:', await send('Runtime.evaluate', {
    expression: "import('./js/state.js').then(m=>m.state.activeChatID)", awaitPromise: true, returnByValue: true,
  }).then((r) => r.result.value));
  console.log(out.result.value);
  ws.close();
}
main().catch((e) => { console.error('msg-dump failed:', e.message); process.exit(1); });
