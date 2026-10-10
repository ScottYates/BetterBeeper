/**
 * Live probe: does the taskbar button really flash, and really stop?
 *
 * check:flash covers the decisions and the call. Neither can see a taskbar, so
 * this runs the same src/main/flash.js against a real window and measures the
 * pixels.
 *
 * The button is found by its behaviour rather than by guessing where it is:
 * several shots are taken in a row and the columns whose brightness moves are
 * the ones flashing. Then the window is focused, the flash is stopped, and the
 * same measurement is taken again - those columns should go still.
 *
 * The taskbar is captured with PrintWindow against Shell_TrayWnd; CopyFromScreen
 * gets nothing here because the taskbar is auto-hidden and covered.
 *
 * Run: npx electron tools/flash-taskbar-probe.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(os.tmpdir(), 'bb-flash');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLASH = path.join(__dirname, '..', 'src', 'main', 'flash.js');

/**
 * One shot: a PNG of the taskbar strip, plus a row of brightness samples.
 *
 * PowerShell does the capture because PrintWindow has to be called from it.
 * The samples come back as CSV so the flashing can be measured rather than
 * eyeballed from a picture.
 */
function shot(name) {
  const ps = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
public class TB {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing
$h = [TB]::FindWindow('Shell_TrayWnd', $null)
$r = New-Object TB+RECT
[void][TB]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$hgt = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap($w, $hgt)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][TB]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save('${OUT}\\${name}', [System.Drawing.Imaging.ImageFormat]::Png)

# One row through the middle of the taskbar, every third pixel.
$y = [int]($hgt / 2)
$row = @()
for ($x = 0; $x -lt $w; $x += 3) {
  $p = $bmp.GetPixel($x, $y)
  $row += [int](0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
}
$bmp.Dispose()
Write-Output ($row -join ',')
`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const line = out.trim().split(/\r?\n/).pop();
  return { file: path.join(OUT, name), row: line.split(',').map(Number) };
}

/**
 * Columns whose brightness oscillates between shots.
 *
 * Counting how many *transitions* each column makes, not how far it moves. A
 * flashing button alternates bright/dim on every sample; a button that merely
 * animates once when its window takes focus moves a long way exactly once. A
 * plain peak-to-peak reading calls the second one "still moving" and would have
 * reported a stopped flash as a running one.
 */
function movement(rows) {
  const width = Math.min(...rows.map((r) => r.length));
  const perColumn = [];
  for (let x = 0; x < width; x++) {
    let transitions = 0;
    let peak = 0;
    for (let i = 1; i < rows.length; i++) {
      const delta = Math.abs(rows[i][x] - rows[i - 1][x]);
      if (delta > 8) transitions++;
      if (delta > peak) peak = delta;
    }
    perColumn.push({ transitions, peak });
  }
  const runs = [];
  let start = -1;
  for (let x = 0; x <= perColumn.length; x++) {
    const oscillating = x < perColumn.length && perColumn[x].transitions >= 3;
    if (oscillating) {
      if (start === -1) start = x;
    } else if (start !== -1) {
      const slice = perColumn.slice(start, x);
      runs.push({
        from: start * 3,
        to: (x - 1) * 3,
        transitions: Math.max(...slice.map((s) => s.transitions)),
        peak: Math.max(...slice.map((s) => s.peak)),
      });
      start = -1;
    }
  }
  return runs.filter((r) => r.to - r.from > 6);
}

async function main() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-flash-probe-profile'));
  await app.whenReady();

  const flash = require(FLASH);

  // The window has to have a taskbar button, and it must not be the focused
  // window, or shouldStart() would correctly refuse to flash it.
  const win = new BrowserWindow({ width: 700, height: 460, show: true, title: 'flash probe' });
  win.loadURL('data:text/html,<body style="background:#123"><h1 style="color:#fff">flash probe</h1></body>');
  await sleep(1500);
  win.minimize();
  await sleep(900);

  flash.setWindowSource(() => win);

  console.log('window focused?', win.isFocused(), ' visible?', win.isVisible());
  console.log('platform supports flash:', flash.supportsFlash(process.platform));
  console.log('');

  // ---- while it should be flashing ----
  const started = flash.onIncoming(win, {});
  console.log('onIncoming started a flash:', started, '| state:', flash.isFlashing());
  await sleep(300);

  const flashing = [];
  for (let i = 0; i < 6; i++) {
    flashing.push(shot('flash-' + i + '.png'));
    await sleep(260);
  }
  const flashingRuns = movement(flashing.map((s) => s.row));
  console.log('while flashing, moving columns:', JSON.stringify(flashingRuns));

  // ---- after the window comes back ----
  win.restore();
  win.focus();
  await sleep(700);
  const stopped = flash.onFocus(win);
  console.log('onFocus stopped the flash:', stopped, '| state:', flash.isFlashing());
  await sleep(400);

  const still = [];
  for (let i = 0; i < 6; i++) {
    still.push(shot('still-' + i + '.png'));
    await sleep(260);
  }
  const stillRuns = movement(still.map((s) => s.row));
  console.log('after focus, moving columns: ', JSON.stringify(stillRuns));

  console.log('');
  console.log('VERDICT:');
  console.log('  flashing detected:', flashingRuns.length > 0 ? 'YES at x=' + flashingRuns[0].from + '-' + flashingRuns[0].to : 'NO');
  console.log('  still when focused:', stillRuns.length === 0 ? 'YES' : 'NO, still moving at ' + JSON.stringify(stillRuns));
  console.log('  images in', OUT);

  app.exit(flashingRuns.length > 0 && stillRuns.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('probe failed:', err.message);
  process.exit(1);
});