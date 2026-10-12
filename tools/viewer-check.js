/**
 * Dev check: the standalone image viewer can be panned freely.
 *
 * The bug it guards was a clamp that measured the window instead of the image,
 * so a tall picture could not be dragged far enough up to see its bottom. The
 * numbers in that comment came from measuring this window; the check drives
 * real pointer events and reads the image's real position back, because the
 * pan limit is only observable as where the pixels end up.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const VIEWER = path.join(ROOT, 'src', 'renderer', 'viewer.html');

// A portrait image, larger than the window in both directions: that is the
// shape the complaint was about.
const NATURAL_W = 1200;
const NATURAL_H = 4000;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${NATURAL_W}" height="${NATURAL_H}"><rect width="${NATURAL_W}" height="${NATURAL_H}" fill="#345"/></svg>`;
const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const harness = `
(async () => {
  const cases = [];
  const add = (name, fn) => {
    let ok = false;
    let detail = '';
    try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
    catch (e) { ok = false; detail = e.message; }
    cases.push([name, ok, detail]);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const stage = document.getElementById('stage');
  const img = document.getElementById('img');
  await new Promise((resolve) => {
    if (img.complete && img.naturalWidth) return resolve();
    img.addEventListener('load', resolve, { once: true });
  });
  await wait(120);

  add('the image loaded at its natural size', () =>
    (img.naturalWidth === ${NATURAL_W} && img.naturalHeight === ${NATURAL_H})
    || ('natural size was ' + img.naturalWidth + 'x' + img.naturalHeight));

  add('it starts fitted to the window', () => {
    const r = img.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return (r.height <= s.height + 2 && r.width <= s.width + 2)
      || ('drawn ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' in ' + Math.round(s.width) + 'x' + Math.round(s.height));
  });

  const zoomIn = async (times) => {
    const s = stage.getBoundingClientRect();
    for (let i = 0; i < times; i++) {
      stage.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -240, clientX: s.left + s.width / 2, clientY: s.top + s.height / 2,
        bubbles: true, cancelable: true,
      }));
      await wait(30);
    }
  };

  // A real drag: pointerdown, a long pointermove, then pointerup. Reported
  // through the element's own position, which is the thing the user sees.
  const drag = async (dx, dy) => {
    const before = img.getBoundingClientRect();
    const sx = 400;
    const sy = 400;
    const opts = { pointerId: 1, bubbles: true, cancelable: true, button: 0, buttons: 1 };
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: sx, clientY: sy }));
    stage.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: sx + dx, clientY: sy + dy }));
    await wait(40);
    const after = img.getBoundingClientRect();
    stage.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, clientX: sx + dx, clientY: sy + dy }));
    await wait(40);
    return {
      movedX: Math.round(after.left - before.left),
      movedY: Math.round(after.top - before.top),
    };
  };

  await zoomIn(6);
  const zoomed = img.getBoundingClientRect();
  add('zooming makes the image taller than the window', () =>
    zoomed.height > stage.getBoundingClientRect().height + 2
    || ('zoomed height ' + Math.round(zoomed.height)));

  // The old clamp allowed about a third of the stage height here. Ask for far
  // more than that and check the image actually went.
  const up = await drag(0, -3000);
  add('the image can be dragged up past the window height', () =>
    up.movedY <= -1000
    || ('dragging up 3000px only moved it ' + up.movedY + 'px'));

  const down = await drag(0, 6000);
  add('and back down again, by as much as asked', () =>
    down.movedY >= 1000
    || ('dragging down 6000px only moved it ' + down.movedY + 'px'));

  const across = await drag(4000, 0);
  add('and sideways, which the old clamp also got wrong', () =>
    Math.abs(across.movedX) >= 1000
    || ('dragging across 4000px only moved it ' + across.movedX + 'px'));

  // The way back out. Without this, free movement would be a trap.
  document.getElementById('zoom-fit').click();
  await wait(60);
  add('the Fit button brings it back to the window', () => {
    const r = img.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return (r.height <= s.height + 2 && Math.abs(r.left - (s.left + (s.width - r.width) / 2)) < 3)
      || ('after Fit the image is ' + Math.round(r.width) + 'x' + Math.round(r.height));
  });

  // A press that does not move is a click, which closes. This matters more now
  // than it did: with the clamp gone a mis-read drag could fling the image
  // away, and closing on that would be the wrong way to recover from it.
  let closes = 0;
  const realClose = window.close;
  window.close = () => { closes++; };

  const opts = { pointerId: 1, bubbles: true, cancelable: true, button: 0 };
  stage.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1, clientX: 500, clientY: 500 }));
  stage.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, clientX: 500, clientY: 500 }));
  await wait(40);
  add('a press that does not move closes the viewer', () =>
    closes === 1 || ('window.close was called ' + closes + ' times'));

  stage.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1, clientX: 500, clientY: 500 }));
  stage.dispatchEvent(new PointerEvent('pointermove', { ...opts, buttons: 1, clientX: 700, clientY: 500 }));
  await wait(30);
  stage.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, clientX: 700, clientY: 500 }));
  await wait(40);
  add('a drag does not close it', () =>
    closes === 1 || ('a drag closed the viewer as well (' + closes + ')'));

  window.close = realClose;

  return JSON.stringify(cases);
})()
  `;

async function main() {
  if (!fs.existsSync(VIEWER)) {
    console.error('no viewer.html at ' + VIEWER);
    process.exit(1);
  }
  await app.whenReady();
  harnessGuard(app, { label: 'check:viewer' });
  const win = new BrowserWindow({ show: false, width: 1000, height: 700 });
  await win.loadFile(VIEWER, { search: `src=${encodeURIComponent(src)}` });
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);

  const cases = JSON.parse(result);
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