/**
 * Dev-only probe: how long a chat takes to show its stored messages.
 *
 * Watches the message list from before the click, so the times are measured
 * from the click itself rather than from whenever the observer happened to be
 * attached. Only clicks and DOM observation - it never calls the API it is
 * timing, because history.open queues a sync and would perturb the very thing
 * being measured.
 *
 * Usage: node tools/open-timing-probe.js [--port=9222] [--chat="Mike Fazio"]
 */
const WS = require('ws');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(flag('port', '9222'));
const chatTitle = flag('chat', 'Mike Fazio');

async function connect() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('no renderer target matching "index.html"');
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true },
      }));
    }).then((out) => {
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'failed');
      return out.result.value;
    });
  return { ws, evaluate };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ws, evaluate } = await connect();

  // Find the chat without opening it, so the observer can be armed first.
  const found = await evaluate(`
    const box = document.getElementById('search-input') || document.querySelector('input[type=search]');
    box.focus();
    box.value = ${JSON.stringify(chatTitle)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  if (!found) throw new Error('no search box');
  await sleep(1600);

  const armed = await evaluate(`
    const label = (n) => (n.querySelector('.chat-item-title')?.textContent.trim()
      || n.textContent.trim().split('\\n')[0] || '').toLowerCase();
    const want = ${JSON.stringify(chatTitle)}.toLowerCase();
    const row = [...document.querySelectorAll('.chat-item, .note-card')]
      .find((n) => label(n) === want || label(n).startsWith(want));
    if (!row) return { ok: false };

    // Armed before the click, so nothing between click and first paint escapes.
    const list = document.getElementById('message-list');
    window.__t = { click: 0, firstRow: null, placeholderGone: null, rows: 0 };
    const obs = new MutationObserver(() => {
      const now = performance.now();
      const rows = list.querySelectorAll('[data-message-id]').length;
      if (rows > 0 && window.__t.firstRow === null) window.__t.firstRow = now;
      window.__t.rows = rows;
      if (!list.querySelector('.search-loading') && window.__t.placeholderGone === null) {
        window.__t.placeholderGone = now;
      }
    });
    obs.observe(list, { childList: true, subtree: true });

    window.__t.click = performance.now();
    row.click();
    return { ok: true };
  `);
  if (!armed.ok) throw new Error('could not find the chat row');

  // Give the sync time to land too, so we can tell "painted" from "settled".
  await sleep(6000);

  const out = await evaluate(`
    const t = window.__t;
    return {
      click: t.click,
      firstRow: t.firstRow,
      placeholderGone: t.placeholderGone,
      rows: t.rows,
      toFirstRow: t.firstRow === null ? null : Math.round(t.firstRow - t.click),
      toPlaceholderGone: t.placeholderGone === null ? null : Math.round(t.placeholderGone - t.click),
    };
  `);

  console.log(`chat              : ${chatTitle}`);
  console.log(`placeholder shown : ${out.toPlaceholderGone === null ? 'never' : out.toPlaceholderGone + 'ms'}`);
  console.log(`first message row : ${out.toFirstRow === null ? 'NEVER' : out.toFirstRow + 'ms'}`);
  console.log(`rows after 6s     : ${out.rows}`);
  ws.close();
  process.exit(out.firstRow === null ? 1 : 0);
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(2);
});