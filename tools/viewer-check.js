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

// The mirror shape: limited by its width in a window that is wider than it is
// tall, so the axis the portrait above took for granted is the one under test.
const WIDE_W = 4000;
const WIDE_H = 1200;
const svgWide = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDE_W}" height="${WIDE_H}"><rect width="${WIDE_W}" height="${WIDE_H}" fill="#753"/></svg>`;
const srcWide = `data:image/svg+xml;base64,${Buffer.from(svgWide).toString('base64')}`;

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

  // The check above is satisfied by an image that is far too small as well, so
  // it cannot tell fitted from shrunk-to-nothing. Fitting means touching the
  // limiting edge of the window: one of the two dimensions has to be spent.
  // Both the stylesheet and the viewer's own fit calculation were doing that
  // work at once, so the picture arrived at fit squared - correct-looking,
  // half the size it should be, and labelled 100%.
  add('at rest it fills the window on the axis that fits', () => {
    const r = img.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const used = Math.max(r.width / s.width, r.height / s.height);
    return used > 0.98
      || ('used ' + Math.round(used * 100) + '%; image ' + Math.round(r.width) + 'x' + Math.round(r.height)
        + ' at ' + Math.round(r.left) + ',' + Math.round(r.top)
        + ' in a ' + Math.round(s.width) + 'x' + Math.round(s.height) + ' stage at ' + Math.round(s.left) + ',' + Math.round(s.top)
        + '; natural ' + img.naturalWidth + 'x' + img.naturalHeight
        + '; transform ' + img.style.transform);
  });

  add('it is centred in the window', () => {
    const r = img.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const dx = Math.abs(r.left - (s.left + (s.width - r.width) / 2));
    const dy = Math.abs(r.top - (s.top + (s.height - r.height) / 2));
    return (dx < 2 && dy < 2)
      || ('off centre by ' + Math.round(dx) + 'px across and ' + Math.round(dy) + 'px down');
  });

  // Zooming has to hold the point under the pointer still, and nothing else
  // here asked. Every wheel event above was dispatched from the centre of the
  // stage, and the pan checks read the image's own position rather than
  // watching one point stay where it was - so an anchor that was off by the
  // half-size of the window would still have passed all of them.
  const zoomAt = async (fx, fy, deltaY) => {
    const before = img.getBoundingClientRect();
    const p = {
      x: before.left + fx * before.width,
      y: before.top + fy * before.height,
    };
    stage.dispatchEvent(new WheelEvent('wheel', {
      deltaY: deltaY, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true,
    }));
    await wait(60);
    const after = img.getBoundingClientRect();
    const drift = {
      x: (after.left + fx * after.width) - p.x,
      y: (after.top + fy * after.height) - p.y,
    };
    document.getElementById('zoom-fit').click();
    await wait(60);
    return drift;
  };

  const middle = await zoomAt(0.5, 0.5, -240);
  add('zooming holds the point under the pointer still', () =>
    (Math.abs(middle.x) < 2 && Math.abs(middle.y) < 2)
    || ('that point drifted ' + Math.round(middle.x) + 'px across and ' + Math.round(middle.y) + 'px down on one step'));

  const quarter = await zoomAt(0.25, 0.25, -240);
  add('and it holds a point well away from the middle too', () =>
    (Math.abs(quarter.x) < 2 && Math.abs(quarter.y) < 2)
    || ('that point drifted ' + Math.round(quarter.x) + 'px across and ' + Math.round(quarter.y) + 'px down'));

  // The other direction. Same anchor, ratio below one instead of above it, so
  // this is where a sign that only ever worked one way up would show.
  const out = await zoomAt(0.5, 0.5, 240);
  add('and zooming back out holds it still too', () =>
    (Math.abs(out.x) < 2 && Math.abs(out.y) < 2)
    || ('that point drifted ' + Math.round(out.x) + 'px across and ' + Math.round(out.y) + 'px down'));

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

  // The other axis. The portrait is limited by its height, so it fills the
  // window top to bottom and its vertical centring was never in doubt - only
  // its width was ever short. A landscape picture in the same window is
  // limited by its width instead, and between the two every axis has been
  // asked the question that actually matters: is the spare room split evenly?
  img.src = ${JSON.stringify(srcWide)};
  await new Promise((resolve) => {
    if (img.complete && img.naturalWidth === ${WIDE_W}) return resolve();
    img.addEventListener('load', resolve, { once: true });
  });
  await wait(120);

  add('a landscape picture fills the window on its own axis', () => {
    const r = img.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const used = Math.max(r.width / s.width, r.height / s.height);
    return used > 0.98 || ('it used only ' + Math.round(used * 100) + '% of the window it could have');
  });

  add('and the spare room is split evenly on both axes', () => {
    const r = img.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const dx = Math.abs(r.left - (s.left + (s.width - r.width) / 2));
    const dy = Math.abs(r.top - (s.top + (s.height - r.height) / 2));
    return (dx < 2 && dy < 2)
      || ('off centre by ' + Math.round(dx) + 'px across and ' + Math.round(dy) + 'px down');
  });

  add('its shape is kept, not stretched', () => {
    const r = img.getBoundingClientRect();
    const drawn = r.width / r.height;
    return Math.abs(drawn - ${WIDE_W} / ${WIDE_H}) < 0.01
      || ('drawn at ' + drawn.toFixed(3) + ', expected ' + (${WIDE_W} / ${WIDE_H}).toFixed(3));
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