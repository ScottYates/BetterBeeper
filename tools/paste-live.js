/**
 * Dev check: a real Ctrl+V of a real clipboard image attaches to the composer.
 *
 * check:paste exercises the parsing functions against a fake clipboard, which
 * cannot catch the thing that actually broke: the paste event never arriving,
 * or arriving with no image on it. This one uses the OS clipboard and a real
 * key event through the input pipeline, so it fails for the real reasons.
 *
 * Put an image on the clipboard first:
 *   powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File tools/clip-put.ps1
 * Then run:
 *   npm run check:paste-live
 *
 * It attaches an image and then removes it again. It never sends a message.
 *
 * The app must be running with --remote-debugging-port=9222.
 */
const WS = require('ws');

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=9222').slice(7));
const MATCH = 'index.html';
const WAIT_MS = 15000;
// Must match tools/clip-put-text.ps1.
const TEXT = 'pasted text 123';

const CHIPS = `(() => {
  const wrap = document.getElementById('attachment-chips');
  const chips = Array.from(wrap.children).map((c) => c.textContent.trim());
  return JSON.stringify({
    count: chips.length,
    chips: chips,
    composerText: document.getElementById('composer').value,
  });
})()`;

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(MATCH));
  if (!page) {
    console.error('no renderer target - is the app running with --remote-debugging-port=9222?');
    process.exit(1);
  }
  console.log(`# attached: ${page.url}`);

  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    }
  });

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await send('Runtime.enable');
  await send('Page.enable');

  // Chromium caches file:// ES modules in userData, so a running dev app will
  // happily keep executing last run's thread.js after the file changed. A
  // check that quietly tests stale code is worse than no check, so force a
  // cold load before asserting anything.
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const reloaded = new Promise((resolve) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Page.loadEventFired') {
        ws.off('message', onMessage);
        resolve();
      }
    };
    ws.on('message', onMessage);
  });
  await send('Page.reload', { ignoreCache: true });
  await reloaded;
  // The reload tears down the execution context; re-enable once it is back.
  await send('Runtime.enable');
  console.log('# reloaded with the cache disabled');

  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    }
    return out.result?.value;
  };

  const cases = [];
  const add = (name, ok, detail) => cases.push([name, Boolean(ok), detail || '']);

  // Always test against a note-to-self chat, never a real person. The reload
  // above dropped whatever was selected, so pick the built-in Note chat back.
  // The list fills in from the API after the reload, so wait for the row.
  const openDeadline = Date.now() + 25000;
  let opened = null;
  let thread = '';
  while (Date.now() < openDeadline) {
    opened = await evaluate(`(() => {
      const rows = Array.from(document.getElementById('chat-list').children);
      const note = rows.find((r) => r.classList.contains('is-note'));
      if (note) note.click();
      return note ? note.dataset.chatId || 'clicked' : null;
    })()`);
    if (opened) {
      await new Promise((r) => setTimeout(r, 800));
      thread = await evaluate("document.getElementById('thread-name').textContent || ''");
      if (/note/i.test(thread)) break;
    } else {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  add('a note-to-self chat is open to paste into', Boolean(opened), 'no is-note row in the list');
  add('the open chat is the Note to self chat', /note/i.test(thread), `open chat is "${thread}"`);

  // Start from a clean composer so a chip from an earlier run cannot pass this.
  await evaluate(`(() => {
    document.getElementById('attachment-chips').replaceChildren();
    const c = document.getElementById('composer');
    c.value = '';
    return true;
  })()`);

  const before = JSON.parse(await evaluate(CHIPS));
  add('the composer starts with no attachments', before.count === 0, `had ${before.count}`);

  // A real Ctrl+V: Control down, v down, v up, Control up. Sending text:'v'
  // with the Control modifier is what makes Chromium run the Paste editing
  // command instead of inserting the letter.
  const CTRL = 2;
  const key = (type, extra) => send('Input.dispatchKeyEvent', { type, modifiers: CTRL, ...extra });
  const pressPaste = async () => {
    await key('rawKeyDown', { windowsVirtualKeyCode: 17, code: 'ControlLeft', key: 'Control' });
    await key('keyDown', {
      windowsVirtualKeyCode: 86, code: 'KeyV', key: 'v', text: 'v', unmodifiedText: 'v',
    });
    await key('keyUp', { windowsVirtualKeyCode: 86, code: 'KeyV', key: 'v' });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 0, windowsVirtualKeyCode: 17, code: 'ControlLeft', key: 'Control',
    });
  };

  await pressPaste();

  // The upload is a round trip to Beeper, so poll rather than guess a delay.
  const deadline = Date.now() + WAIT_MS;
  let after = before;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    after = JSON.parse(await evaluate(CHIPS));
    if (after.count > 0) break;
  }

  add('Ctrl+V attached the clipboard image', after.count > 0,
    after.count ? '' : `no attachment after ${WAIT_MS} ms; composer held ${JSON.stringify(after.composerText)}`);
  add('the attachment is named like a paste', after.count > 0 && /pasted-image-1\./.test(after.chips[0] || ''),
    after.chips[0] || '');
  add('the attachment is chipped as a picture', after.count > 0 && /🖼/.test(after.chips[0] || ''),
    after.chips[0] || '');
  add('the image was not also pasted as text', after.composerText === '',
    `composer holds ${JSON.stringify(after.composerText)}`);

  // Take the attachment back off so a second run starts clean.
  await evaluate(`(() => {
    const wrap = document.getElementById('attachment-chips');
    const remove = wrap.querySelector('button');
    if (remove) remove.click();
    return wrap.children.length;
  })()`);
  const cleaned = JSON.parse(await evaluate(CHIPS));
  add('the attachment can be taken back off', cleaned.count === 0, `${cleaned.count} left`);

  // The regression that would matter most: an ordinary text paste has to keep
  // working. Put plain text on the clipboard and paste it for real.
  await evaluate(`(() => {
    const c = document.getElementById('composer');
    c.value = '';
    c.focus();
    return true;
  })()`);
  await pressPaste();
  await new Promise((r) => setTimeout(r, 700));
  const textState = JSON.parse(await evaluate(CHIPS));
  add('an ordinary text paste still reaches the composer', textState.composerText === TEXT,
    `composer holds ${JSON.stringify(textState.composerText)}, wanted ${JSON.stringify(TEXT)}`);
  add('a text paste does not become an attachment', textState.count === 0, `${textState.count} attached`);

  await evaluate(`(() => { document.getElementById('composer').value = ''; return true; })()`);

  add('nothing threw in the renderer', pageErrors.length === 0, pageErrors.join(' | '));

  ws.close();

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
