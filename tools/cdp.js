/**
 * Dev-only helper: attaches to the running app over the Chrome DevTools
 * Protocol, evaluates expressions in the renderer, and prints results.
 * Usage: node tools/cdp.js [--page=<url-substring>] "<expression>" ["<expression>" ...]
 */
const WS = require('ws');

async function main() {
  const args = process.argv.slice(2);
  const pageFlag = args.find((a) => a.startsWith('--page='));
  const watchFlag = args.find((a) => a.startsWith('--watch='));
  const portFlag = args.find((a) => a.startsWith('--port='));
  const port = portFlag ? Number(portFlag.slice('--port='.length)) : 9222;
  const reload = args.includes('--reload');
  const expressions = args.filter((a) => !a.startsWith('--') );
  const match = pageFlag ? pageFlag.slice('--page='.length) : 'index.html';
  if (!expressions.length && !reload) {
    console.error('usage: node tools/cdp.js [--port=9222] [--page=<substring>] [--reload] [--watch=<ms>] [--shot=<path>] "<expr>" [...]');
    process.exit(1);
  }

  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(match));
  if (!page) {
    console.error(`no renderer target matching "${match}"`);
    process.exit(1);
  }

  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();

  // Say which document we attached to. Two copies of the app can be running at
  // once and only one owns the debugging port, so an evaluation can silently
  // land in the installed build while you believe you are looking at a dev run.
  console.log(`# attached: ${page.url}`);

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ');
      console.log(`[console.${msg.params.type}] ${text}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      console.log(
        `[pageerror] ${d.exception?.description || d.text} @ ${d.url || ''}:${d.lineNumber ?? '?'}`,
      );
    }
  });

  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  if (reload) {
    await send('Page.reload', { ignoreCache: false });
    console.log('— reloaded, watching for renderer output…');
  }

  for (const expression of expressions) {
    const out = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    if (out.exceptionDetails) {
      console.log(`✗ ${expression}\n  ${out.exceptionDetails.exception?.description || out.exceptionDetails.text}`);
    } else {
      const value = out.result?.value;
      console.log(`✓ ${expression}\n  ${JSON.stringify(value, null, 2)}`);
    }
  }

  const watchMs = watchFlag ? Number(watchFlag.slice('--watch='.length)) : 0;
  if (watchMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, watchMs));
  }

  const sizeFlag = args.find((a) => a.startsWith('--size='));
  if (sizeFlag) {
    // Override the viewport for the capture only, so a screenshot taken in a
    // small or oddly-sized window is still usable. Never persisted.
    const [w, h] = sizeFlag.slice('--size='.length).split('x').map(Number);
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: false,
    });
  }

  const shotFlag = args.find((a) => a.startsWith('--shot='));
  if (shotFlag) {
    const fs = require('node:fs');
    const out = shotFlag.slice('--shot='.length);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`— screenshot written to ${out}`);
  }

  if (sizeFlag) {
    await send('Emulation.clearDeviceMetricsOverride');
  }

  ws.close();
}

main().catch((err) => {
  console.error('cdp failed:', err.message);
  process.exit(1);
});
