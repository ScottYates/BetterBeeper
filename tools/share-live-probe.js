/**
 * Live probe: open the Share with... picker on the real app and photograph it.
 *
 * The checks drive the rules, but they cannot tell whether the thing looks like
 * something a person would use. This walks the actual route a user takes - the
 * "..." button on a real message, then the menu item - and writes screenshots
 * to %TEMP%\bb-share.
 *
 * It never sends anything. The picker is opened and photographed, not used.
 *
 * Run: node tools/share-live-probe.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const WS = require('ws');

const OUT = path.join(os.tmpdir(), 'bb-share');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error('no renderer page on port 9222');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  wrote ${file}`);
  }
}

async function main() {
  const target = await findPage();
  const ws = new WS(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const cdp = new Cdp(ws);

  // Give the app time to finish its first load before poking at it.
  await sleep(4000);

  // Open the first real chat that has messages, so the menu is driven by a real
  // message rather than a synthetic one.
  const opened = await cdp.eval(`(async () => {
    const list = [...document.querySelectorAll('#chat-list > .chat-item')];
    if (!list.length) return 'no chats in the sidebar';
    for (const item of list) {
      item.click();
      await new Promise((r) => setTimeout(r, 900));
      if (document.querySelector('.msg button[title="More"]')) return 'opened: ' + (item.textContent || '').trim().slice(0, 40);
    }
    return 'no chat had a message to menu';
  })()`);
  console.log('  ' + opened);
  if (opened.startsWith('no ')) throw new Error(opened);

  // The "..." button on the first message row.
  const menuLabels = await cdp.eval(`(() => {
    const btn = document.querySelector('.msg button[title="More"]');
    if (!btn) return 'MISSING';
    btn.click();
    return [...document.querySelectorAll('.msg-menu button')].map((b) => b.textContent.trim()).join(' | ');
  })()`);
  await sleep(400);
  console.log('  message menu: ' + menuLabels);
  await cdp.shot('1-message-menu.png');

  // Click Share with...
  const openedPicker = await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('.msg-menu button')].find((b) => b.textContent.trim() === 'Share with...');
    if (!item) return 'MISSING';
    item.click();
    return 'clicked';
  })()`);
  console.log('  picker: ' + openedPicker);
  if (openedPicker === 'MISSING') throw new Error('Share with... was not in the menu');
  await sleep(900);
  await cdp.shot('2-picker.png');

  const picker = await cdp.eval(`(() => {
    const root = document.querySelector('#modal-root');
    if (!root || root.hidden) return 'modal is not showing';
    const lists = [...root.querySelectorAll('.result-list')];
    return JSON.stringify({
      title: (root.querySelector('h3') || {}).textContent,
      header: (root.querySelector('.search-summary') || {}).textContent,
      summary: [...root.querySelectorAll('.search-summary')].pop().textContent,
      chatRows: [...(lists[0] ? lists[0].querySelectorAll('.result-item-title') : [])].map((n) => n.textContent).slice(0, 8),
    });
  })()`);
  console.log('  picker contents: ' + picker);

  // Type something, so the contacts half of the picker is exercised too.
  await cdp.eval(`(() => {
    const s = document.querySelector('#modal-root input[type=search]');
    s.value = 'benji';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  // Poll rather than guess: the debounce is 200ms and the contact search is a
  // network round trip whose duration is not ours to assume.
  let settled = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const snapshot = await cdp.eval(`(() => {
      const root = document.querySelector('#modal-root');
      const lists = [...root.querySelectorAll('.result-list')];
      return JSON.stringify({
        searching: [...root.querySelectorAll('.search-summary')].some((n) => /Searching contacts/.test(n.textContent)),
        contactRows: lists[1] ? lists[1].querySelectorAll('.result-item').length : -1,
        summary: [...root.querySelectorAll('.search-summary')].pop().textContent,
      });
    })()`);
    const s = JSON.parse(snapshot);
    if (!s.searching) { settled = s; break; }
    settled = s;
  }
  await cdp.shot('3-picker-search.png');

  const searched = await cdp.eval(`(() => {
    const root = document.querySelector('#modal-root');
    const lists = [...root.querySelectorAll('.result-list')];
    return JSON.stringify({
      chatRows: [...(lists[0] ? lists[0].querySelectorAll('.result-item-title') : [])].map((n) => n.textContent).length,
      contactRows: [...(lists[1] ? lists[1].querySelectorAll('.result-item') : [])].map((n) => n.textContent.trim().slice(0, 40)),
    });
  })()`);
  console.log('  after search settled: ' + JSON.stringify(settled));
  console.log('  rows: ' + searched);

  // Close without sending anything.
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('#modal-root button')].find((x) => x.textContent.trim() === 'Cancel'); if (b) b.click(); return 'closed'; })()`);
  ws.close();
  console.log('\ndone - nothing was sent');
}

main().catch((err) => {
  console.error('probe failed:', err.message);
  process.exit(1);
});