/**
 * Dev-only probe: two identical messages sent back to back, sampled before the
 * confirmations land.
 *
 * This is the case the store cannot show and the unit check does show: with the
 * optimistic-insert bug, typing the same thing twice let the second bubble
 * swallow the first as it was inserted, so the thread briefly showed one bubble
 * for two sends. After the confirmations both arrive anyway, so the end state
 * looks identical - the difference only exists while the sends are in flight.
 *
 * Usage: node tools/send-race-probe.js [--port=9222] [--chat="Note to self"]
 */
const WS = require('ws');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(flag('port', '9222'));
const chatTitle = flag('chat', 'Note to self');

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
      ws.send(
        JSON.stringify({
          id: msgId,
          method: 'Runtime.evaluate',
          params: {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    }).then((out) => {
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'failed');
      return out.result.value;
    });
  return { ws, evaluate };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ws, evaluate } = await connect();

  await evaluate(`
    const box = document.getElementById('search-input') || document.querySelector('input[type=search]');
    box.focus();
    box.value = ${JSON.stringify(chatTitle)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(1500);
  const found = await evaluate(`
    const label = (n) => (n.querySelector('.chat-item-title')?.textContent.trim()
      || n.textContent.trim().split('\\n')[0] || '').toLowerCase();
    const want = ${JSON.stringify(chatTitle)}.toLowerCase();
    const row = [...document.querySelectorAll('.chat-item, .note-card')]
      .find((n) => label(n) === want || label(n).startsWith(want));
    if (row) row.click();
    return !!row;
  `);
  if (!found) throw new Error('could not open ' + chatTitle);
  await sleep(1500);

  const tag = `twice ${crypto.randomBytes(3).toString('hex')}`;
  console.log(`tag: ${tag}`);

  // Two sends with nothing in between: the second placeholder goes in while the
  // first is still waiting for its confirmation.
  await evaluate(`
    const box = document.getElementById('composer');
    const type = (v) => {
      box.focus();
      box.value = v;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-send').click();
    };
    type(${JSON.stringify(tag)});
    type(${JSON.stringify(tag)});
    return box.value;
  `);

  await sleep(250);
  const during = await evaluate(`
    const rows = [...document.querySelectorAll('#message-list [data-message-id]')]
      .filter((n) => n.offsetParent !== null && n.textContent.includes(${JSON.stringify(tag)}));
    return {
      bubbles: rows.length,
      pending: rows.filter((n) => n.querySelector('.msg-status-pending')).length,
    };
  `);
  console.log(`in flight : ${during.bubbles} bubbles, ${during.pending} on "sending"`);

  await sleep(6000);
  const after = await evaluate(`
    const rows = [...document.querySelectorAll('#message-list [data-message-id]')]
      .filter((n) => n.offsetParent !== null && n.textContent.includes(${JSON.stringify(tag)}));
    return {
      bubbles: rows.length,
      pending: rows.filter((n) => n.querySelector('.msg-status-pending')).length,
      failed: rows.filter((n) => n.querySelector('.msg-status-failed')).length,
      ids: rows.map((n) => n.getAttribute('data-message-id')),
    };
  `);
  console.log(`settled   : ${after.bubbles} bubbles, ${after.pending} pending, ${after.failed} failed`);
  console.log(`ids       : ${JSON.stringify(after.ids)}`);

  const ok =
    during.bubbles === 2 && during.pending === 2
    && after.bubbles === 2 && after.pending === 0 && after.failed === 0;
  console.log(ok ? '\nOK  both sends shown while in flight, both settled' : '\nPROBLEM');
  ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('send-race-probe failed:', err.message);
  process.exit(2);
});