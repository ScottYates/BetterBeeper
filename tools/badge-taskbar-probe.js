/**
 * Dev-only probe: does an unread count actually land on the Windows taskbar?
 *
 * Every other check in this repo can be satisfied by an app that is broken in
 * the one way that matters here: the count reaches main, main reports it back,
 * and no badge is ever drawn. Windows draws the badge, outside the process, so
 * the only honest proof is to look at the taskbar.
 *
 * It drives the real path - the same `app:badge` IPC the chat list uses - and
 * photographs the tray. Capturing the tray window directly rather than
 * screenshotting the screen, because the taskbar can be auto-hidden or covered
 * while `CopyFromScreen` still faithfully returns whatever is on top of it.
 *
 * Usage: node tools/badge-taskbar-probe.js [--port=9222] [--count=7]
 */
const WS = require('ws');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(flag('port', '9222'));
const count = Number(flag('count', '7'));

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
        params: {
          expression: `(async () => { ${expression} })()`,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    }).then((out) => {
      if (out.exceptionDetails) {
        throw new Error(out.exceptionDetails.exception?.description || 'evaluate failed');
      }
      return out.result.value;
    });
  return { evaluate, close: () => ws.close() };
}

/**
 * Photograph the taskbar.
 *
 * PrintWindow with PW_RENDERFULLCONTENT, because the tray is a XAML window that
 * a plain screen grab misses whenever it is hidden or overlapped.
 */
function shootTaskbar(outFile) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class BB {
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$h = [BB]::FindWindow('Shell_TrayWnd', $null)
if ($h -eq [IntPtr]::Zero) { throw 'no taskbar window on this desktop' }
$r = New-Object BB+RECT
[void][BB]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
try { [void][BB]::PrintWindow($h, $hdc, 2) } finally { $g.ReleaseHdc($hdc) }
$bmp.Save('${outFile}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ($w.ToString() + 'x' + $ht.ToString())
`;
  const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (out.status !== 0) throw new Error(`taskbar capture failed: ${(out.stderr || '').trim()}`);
  return out.stdout.trim();
}

async function main() {
  const { evaluate, close } = await connect();
  const dir = path.join(os.tmpdir(), 'bb-badges');
  fs.mkdirSync(dir, { recursive: true });

  console.log(`# attached to the running app on port ${port}`);
  const before = shootTaskbar(path.join(dir, 'taskbar-before.png'));
  console.log(`taskbar before: ${before}`);

  const set = await evaluate(`return JSON.stringify(await window.beeper.app.badge(${count}))`);
  console.log(`app:badge(${count}) -> ${set}`);
  await new Promise((r) => setTimeout(r, 1200)); // the shell redraws on its own clock

  const after = shootTaskbar(path.join(dir, 'taskbar-after.png'));
  console.log(`taskbar after : ${after}`);

  const cleared = await evaluate(`return JSON.stringify(await window.beeper.app.badge(0))`);
  console.log(`app:badge(0)   -> ${cleared}`);
  await new Promise((r) => setTimeout(r, 800));
  shootTaskbar(path.join(dir, 'taskbar-cleared.png'));

  console.log(`\nbefore : ${path.join(dir, 'taskbar-before.png')}`);
  console.log(`after  : ${path.join(dir, 'taskbar-after.png')}`);
  console.log(`cleared: ${path.join(dir, 'taskbar-cleared.png')}`);
  console.log('\nLook at the app icon in the taskbar: the number must appear, then go.');
  close();
}

main().catch((err) => {
  console.error('badge-taskbar-probe failed:', err.message);
  process.exit(2);
});