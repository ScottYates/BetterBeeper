/**
 * Dev-only probe: what the read receipts look like on a real thread.
 *
 * Opens a chat that has read receipts in it, screenshots the rows that carry
 * one, and reports the count of receipts drawn against messages that have none.
 */
const WS = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(flag('port', '9222'));
const chatTitle = flag('chat', 'Beeper Updates');

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
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evaluate = (expression) =>
    send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    }).then((out) => {
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'failed');
      return out.result.value;
    });
  return { ws, evaluate, send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ws, evaluate, send } = await connect();
  await evaluate(`
    const box = document.getElementById('search-input') || document.querySelector('input[type=search]');
    box.focus();
    box.value = ${JSON.stringify(chatTitle)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(1600);
  const opened = await evaluate(`
    const label = (n) => (n.querySelector('.chat-item-title')?.textContent.trim()
      || n.textContent.trim().split('\\n')[0] || '').toLowerCase();
    const want = ${JSON.stringify(chatTitle)}.toLowerCase();
    const row = [...document.querySelectorAll('.chat-item, .note-card')]
      .find((n) => label(n) === want || label(n).startsWith(want));
    if (row) row.click();
    return !!row;
  `);
  if (!opened) throw new Error('could not open ' + chatTitle);
  await sleep(2500);

  const report = await evaluate(`
    const rows = [...document.querySelectorAll('#message-list [data-message-id]')]
      .filter((n) => n.offsetParent !== null);
    const receipts = rows
      .map((n) => {
        const seen = n.querySelector('.msg-seen');
        return seen ? {
          id: n.getAttribute('data-message-id'),
          text: seen.textContent.trim(),
          title: seen.getAttribute('title') || '',
          outgoing: n.classList.contains('is-out'),
        } : null;
      })
      .filter(Boolean);
    const stray = receipts.filter((r) => !r.outgoing);
    return {
      rows: rows.length,
      receipts: receipts.length,
      onIncoming: stray.length,
      sample: receipts.slice(-4),
      hasOldSeenLine: !!document.getElementById('seen-line'),
    };
  `);

  console.log(`rows            : ${report.rows}`);
  console.log(`receipts drawn  : ${report.receipts}`);
  console.log(`on incoming     : ${report.onIncoming} (must be 0)`);
  console.log(`old seen line   : ${report.hasOldSeenLine} (must be false)`);
  for (const r of report.sample) {
    console.log(`  ${r.outgoing ? 'out' : 'IN '} ${r.id}  ${JSON.stringify(r.text)}  ${JSON.stringify(r.title)}`);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(os.tmpdir(), 'bb-seen-receipts.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`\nscreenshot: ${out}`);
  ws.close();
  process.exit(report.onIncoming === 0 && !report.hasOldSeenLine ? 0 : 1);
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(2);
});