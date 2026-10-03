/**
 * Dev check: a displayed image can be copied to the clipboard and pasted back.
 *
 * check:imagecopy proves the URL allowlist and path decoding in isolation.
 * This one proves the part that only a real clipboard can answer:
 *
 *   1. copy an image through the real bridge and the real main process;
 *   2. read the Windows clipboard back and confirm it holds a picture of the
 *      right size - not a path, not a string, not an empty CF_DIB;
 *   3. paste it into the composer for real and confirm it becomes an
 *      attachment.
 *
 * Step 3 is the point of the whole feature. "Copy" is only useful if the result
 * is something a paste can consume, so the check closes the loop instead of
 * stopping at "the clipboard is not empty".
 *
 * It attaches and removes an attachment in the Note to self chat and never
 * sends a message.
 *
 * The app must be running with --remote-debugging-port=9222.
 * Run with `npm run check:imagecopy-live`.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const WS = require('ws');

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=9222').slice(7));
const FIXTURE = path.join(__dirname, '.copy-sample.png');
const EXPECT_W = 120;
const EXPECT_H = 80;

function ps1(name, args = []) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, name), ...args],
    { encoding: 'utf8' },
  ).trim();
}

/** beeper-file://local/C:/... is how the app addresses a local file. */
function beeperFileUrl(absPath) {
  return `beeper-file://local/${absPath.replace(/\\/g, '/').replace(/^[A-Za-z]:/, (d) => d)}`;
}

async function main() {
  ps1('clip-make-image.ps1');

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) {
    console.error('no renderer target - is the app running with --remote-debugging-port=9222?');
    process.exit(1);
  }
  console.log(`# attached: ${page.url}`);

  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
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
  // A running dev app keeps serving last run's modules from the file:// cache.
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const loaded = new Promise((resolve) => {
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
  await loaded;
  await send('Runtime.enable');
  console.log('# reloaded with the cache disabled');

  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result?.value;
  };

  const cases = [];
  const add = (name, ok, detail) => cases.push([name, Boolean(ok), detail || '']);

  const CHIPS = `(() => {
    const wrap = document.getElementById('attachment-chips');
    return JSON.stringify({
      count: wrap.children.length,
      chips: Array.from(wrap.children).map((c) => c.textContent.trim()),
      composerText: document.getElementById('composer').value,
    });
  })()`;

  // Open the Note to self chat so nothing here can reach a real person.
  const openDeadline = Date.now() + 25000;
  let thread = '';
  while (Date.now() < openDeadline) {
    await evaluate(`(() => {
      const rows = Array.from(document.getElementById('chat-list').children);
      const note = rows.find((r) => r.classList.contains('is-note'));
      if (note) note.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    thread = await evaluate("document.getElementById('thread-name').textContent || ''");
    if (/note/i.test(thread)) break;
  }
  add('the open chat is the Note to self chat', /note/i.test(thread), `open chat is "${thread}"`);

  await evaluate(`(() => {
    document.getElementById('attachment-chips').replaceChildren();
    document.getElementById('composer').value = '';
    return true;
  })()`);

  const srcURL = beeperFileUrl(FIXTURE);
  const copyRes = JSON.parse(await evaluate(
    `(async () => JSON.stringify(await window.beeper.images.copy(${JSON.stringify(srcURL)})))()`,
  ));
  add('copying the image succeeds through the bridge', copyRes.ok === true,
    JSON.stringify(copyRes.error || copyRes));

  let clipboard = '';
  try {
    clipboard = ps1('clip-has-image.ps1');
  } catch {
    clipboard = 'no-image';
  }
  add('the clipboard holds a real image', clipboard.startsWith('image'), clipboard);
  add(`the copied image is the right size (${EXPECT_W}x${EXPECT_H})`,
    clipboard === `image ${EXPECT_W}x${EXPECT_H}`, clipboard);

  // The loop the feature exists for: paste what we just copied.
  const CTRL = 2;
  const key = (type, extra) => send('Input.dispatchKeyEvent', { type, modifiers: CTRL, ...extra });
  await key('rawKeyDown', { windowsVirtualKeyCode: 17, code: 'ControlLeft', key: 'Control' });
  await key('keyDown', { windowsVirtualKeyCode: 86, code: 'KeyV', key: 'v', text: 'v', unmodifiedText: 'v' });
  await key('keyUp', { windowsVirtualKeyCode: 86, code: 'KeyV', key: 'v' });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 0, windowsVirtualKeyCode: 17, code: 'ControlLeft', key: 'Control',
  });

  const deadline = Date.now() + 15000;
  let after = { count: 0, chips: [], composerText: '' };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    after = JSON.parse(await evaluate(CHIPS));
    if (after.count > 0) break;
  }
  add('the copied image pastes back into the composer', after.count > 0,
    `no attachment after 15 s; composer held ${JSON.stringify(after.composerText)}`);
  add('it arrives as an image attachment', /pasted-image-1\./.test(after.chips[0] || ''), after.chips[0] || '');

  await evaluate(`(() => {
    const remove = document.getElementById('attachment-chips').querySelector('button');
    if (remove) remove.click();
    return true;
  })()`);

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
