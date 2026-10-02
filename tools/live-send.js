/**
 * Dev-only helper: end-to-end check of the send path in the *running* app.
 *
 * Opens Note to self, sends one uniquely tagged message through the real
 * composer, waits for the REST round trip plus the WebSocket echo, then asserts
 * the thread shows exactly one copy of it and nothing left on "Sending".
 *
 * Usage: node tools/live-send.js [--port=9222] [--chat="Note to self"]
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
const TAG = `live send ${crypto.randomBytes(3).toString('hex')}`;

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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return out.result.value;
  };

  return { ws, evaluate };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ws, evaluate } = await connect();

  // Chats past the first page are not in the rendered list, so fall back to
  // typing the title into the search box - which is how a user finds them too.
  const clicker = (title) => `
    function findRow(el) {
      const label = (n) => (n.querySelector('.chat-item-title')?.textContent.trim()
        || n.textContent.trim().split('\\n')[0] || '').toLowerCase();
      const want = ${JSON.stringify(title)}.toLowerCase();
      const row = [...document.querySelectorAll('.chat-item, .note-card')]
        .find((n) => label(n) === want || label(n).startsWith(want));
      if (row) row.click();
      return !!row;
    }
    return findRow();
  `;

  let opened = await evaluate(clicker(chatTitle));
  if (!opened) {
    console.log('not on the first page - searching for it');
    await evaluate(`
      const box = document.getElementById('search-input') || document.querySelector('input[type=search]');
      if (!box) throw new Error('search box not found');
      box.focus();
      box.value = ${JSON.stringify(chatTitle)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(1400);
    opened = await evaluate(clicker(chatTitle));
  }
  if (!opened) throw new Error('could not open ' + chatTitle);
  await sleep(1200);

  const sent = await evaluate(`
    const text = ${JSON.stringify(TAG)};
    const box = document.getElementById('composer');
    if (!box) throw new Error('composer not found');
    box.focus();
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-send').click();
    return box.value;
  `);
  console.log(`sent tag   : ${TAG}`);
  console.log(`composer  : ${sent === '' ? 'cleared' : `still holds ${JSON.stringify(sent)}`}`);

  // Round trip plus WebSocket echo.
  await sleep(6000);

  const result = await evaluate(`
    const tag = ${JSON.stringify(TAG)};
    // Count the message bubbles themselves, not the rows: a row also carries the
    // id of a REACTION event rendered against it, and its textContent includes
    // the message it is reacting to. Counting rows reports a phantom duplicate.
    const bubbles = [...document.querySelectorAll('#message-list .msg-bubble')]
      .filter((b) => b.offsetParent !== null);
    const matching = bubbles.filter((b) => b.textContent.includes(tag));
    const stuck = bubbles.filter((b) => {
      const el = b.closest('[data-message-id]')?.querySelector('[class*=msg-status]');
      return el && /sending|pending|failed/i.test(el.textContent);
    });
    return {
      totalBubbles: bubbles.length,
      copies: matching.length,
      copiesText: matching.map((b) => b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60)),
      stuckCount: stuck.length,
      stuckText: stuck.map((b) => b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 50)),
      // Beeper models a reaction as its own hidden record. If one is ever drawn
      // as a row again it duplicates the message text and looks like a re-send.
      ghostRows: [...document.querySelectorAll('#message-list .msg')]
        .filter((n) => /\\[reaction\\]/.test(n.textContent)).length,
      // A network badge must stay square. The padding that a monogram needs
      // used to make every badge 23x21, and border-radius 50% on a non-square
      // box renders an oval instead of Beeper's circle.
      ovalBadges: [...document.querySelectorAll('.net-badge:not(.is-mono)')]
        .filter((b) => Math.abs(b.getBoundingClientRect().width - b.getBoundingClientRect().height) > 0.5)
        .length,
      // Notes are pinned by position, not by being made larger.
      noteTaller: (() => {
        const note = document.querySelector('.chat-item[data-note]');
        const plain = document.querySelector('.chat-item:not([data-note]):not([data-view])');
        if (!note || !plain) return 0;
        return note.getBoundingClientRect().height > plain.getBoundingClientRect().height + 2 ? 1 : 0;
      })(),
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim().slice(0, 80)),
    };
  `);

  console.log(`bubbles   : ${result.totalBubbles}`);
  console.log(`copies    : ${result.copies}`);
  console.log(`stuck     : ${result.stuckCount}${result.stuckText.length ? ' ' + JSON.stringify(result.stuckText) : ''}`);
  console.log(`ghost rows: ${result.ghostRows}`);
  console.log(`oval badge: ${result.ovalBadges}`);
  console.log(`note tall : ${result.noteTaller}`);
  console.log(`toasts    : ${result.toasts.length ? JSON.stringify(result.toasts) : 'none'}`);

  const ok = result.copies === 1
    && result.stuckCount === 0
    && result.ghostRows === 0
    && result.ovalBadges === 0
    && result.noteTaller === 0;
  console.log(ok ? '\n✓ one bubble, nothing stuck, list intact' : '\n✗ send path problem');
  ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('live-send failed:', err.message);
  process.exit(1);
});
