/**
 * Dev check: the window opens exactly where it was closed.
 *
 * The bug this exists for: the window was restored into the work area of
 * whichever display owned the saved position, so a window closed near an edge
 * came back slightly off. Measured across every edge of every display, the
 * offset was exactly how far the window had been over the edge - 30px past
 * the right edge came back 30px to the left of it - and a window closed over
 * the taskbar came back above the taskbar. The window had not been lost; it
 * had been tidied up.
 *
 * Two halves, and both are needed:
 *
 *   1. The position is the user's. A window closed over an edge of a display,
 *      or over the taskbar, comes back over that edge, to the pixel.
 *
 *   2. The rescue still works. A window whose display has been unplugged
 *      must not open in the void with no way to get it back, so it is brought
 *      onto the primary display instead.
 *
 * The first half is checked against displays that are made up, because the
 * cases that matter - a taskbar in the way, a monitor that is not there - are
 * not the ones this machine happens to have. The second half is checked
 * against the real displays, and against a real window: the bounds the app
 * works out have to be the bounds the window actually lands on.
 *
 * Run with `npm run check:windowbounds`.
 */
const fs = require('node:fs');
const path = require('node:path');

const { app, BrowserWindow, screen } = require('electron');

const { resolveWindowBounds, boundsToRemember, MIN_WIDTH, MIN_HEIGHT } = require('../src/main/window-bounds.js');

const results = [];
const add = (name, ok, detail) => results.push({ name, ok: ok === true, detail });

// A desktop with the things that cause the offset: a taskbar along the
// bottom of the primary display, a second display off to the left, and a
// narrow portrait display that is smaller than the minimum window width.
const PRIMARY = {
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  primary: true,
};
const LEFT = {
  bounds: { x: -1920, y: 708, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 708, width: 1920, height: 1080 },
  primary: false,
};
const NARROW = {
  bounds: { x: -703, y: -2932, width: 682, height: 2560 },
  workArea: { x: -703, y: -2932, width: 682, height: 2560 },
  primary: false,
};
const DISPLAYS = [PRIMARY, LEFT, NARROW];

const W = 900;
const H = 600;

function same(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function where(r) {
  return r ? `x=${r.x} y=${r.y} w=${r.width} h=${r.height}` : 'nothing';
}

/** A window closed at this position must come back at exactly this position. */
function exact(name, saved) {
  const resolved = resolveWindowBounds(saved, DISPLAYS);
  add(name, resolved != null && same(resolved, { x: saved.x, y: saved.y, width: saved.width, height: saved.height }),
    `saved ${where(saved)} came back ${where(resolved)}`);
}

function main() {
  // --- the position is the user's ------------------------------------------
  exact('a window closed in the middle comes back exactly',
    { x: 800, y: 400, width: W, height: H });

  exact('a window flush with the left edge comes back exactly',
    { x: 0, y: 300, width: W, height: H });

  exact('a window flush with the right edge comes back exactly',
    { x: 2560 - W, y: 300, width: W, height: H });

  exact('a window flush with the bottom of the work area comes back exactly',
    { x: 300, y: 1392 - H, width: W, height: H });

  exact('a window closed over the taskbar comes back exactly',
    { x: 300, y: 1392 - H + 30, width: W, height: H });

  exact('a window closed 30px past the right edge comes back exactly',
    { x: 2560 - W + 30, y: 300, width: W, height: H });

  exact('a window closed 30px past the left edge comes back exactly',
    { x: -30, y: 300, width: W, height: H });

  exact('a window closed 30px above the top edge comes back exactly',
    { x: 300, y: -30, width: W, height: H });

  exact('a window closed 30px below the work area comes back exactly',
    { x: 300, y: 1392 - H + 30, width: W, height: H });

  exact('a window on another display, past that display right edge, comes back exactly',
    { x: -1920 + 1920 - W + 30, y: 708 + 100, width: W, height: H });

  exact('a window on another display, over that display bottom edge, comes back exactly',
    { x: -1920 + 100, y: 708 + 1080 - H + 30, width: W, height: H });

  // --- the size ------------------------------------------------------------
  {
    const saved = { x: 300, y: 300, width: 1000, height: 700 };
    const resolved = resolveWindowBounds(saved, DISPLAYS);
    add('the size is the size it was closed at',
      resolved != null && resolved.width === 1000 && resolved.height === 700,
      `saved 1000x700 came back ${resolved ? `${resolved.width}x${resolved.height}` : 'nothing'}`);
  }

  {
    // A window that is wider than the display it was on keeps its width: that
    // is the size the user had. It is not moved to fit either - the position
    // and the size are both the user's.
    const saved = { x: 300, y: 300, width: 3000, height: 700 };
    const resolved = resolveWindowBounds(saved, DISPLAYS);
    add('a window wider than its display keeps its size',
      resolved != null && resolved.width === 3000 && resolved.height === 700,
      `came back ${resolved ? `${resolved.width}x${resolved.height}` : 'nothing'}`);
    add('a window wider than its display is not moved to fit',
      resolved != null && resolved.x === 300 && resolved.y === 300,
      `came back ${where(resolved)}`);
  }

  {
    const saved = { x: -5000, y: 5000, width: W, height: H };
    const resolved = resolveWindowBounds(saved, DISPLAYS);
    add('a window whose display has gone is brought back onto a display',
      resolved != null && DISPLAYS.some((d) => {
        const over = Math.min(resolved.x + resolved.width, d.bounds.x + d.bounds.width) - Math.max(resolved.x, d.bounds.x);
        const down = Math.min(resolved.y + resolved.height, d.bounds.y + d.bounds.height) - Math.max(resolved.y, d.bounds.y);
        return over > 0 && down > 0;
      }),
      `came back ${where(resolved)}`);
    add('a window whose display has gone is not left in the void',
      resolved != null && resolved.x >= PRIMARY.bounds.x && resolved.y >= PRIMARY.bounds.y
        && resolved.x + resolved.width <= PRIMARY.bounds.x + PRIMARY.bounds.width
        && resolved.y + resolved.height <= PRIMARY.bounds.y + PRIMARY.bounds.height,
      `came back ${where(resolved)}`);
  }

  {
    // A display that is still there but has been rearranged: the window is
    // over the gap between two displays, but it still touches one of them, so
    // it stays where it was put.
    const saved = { x: 300, y: 300, width: W, height: H };
    const resolved = resolveWindowBounds(saved, DISPLAYS);
    add('a window on a display that is still there is not moved',
      resolved != null && resolved.x === 300 && resolved.y === 300,
      `came back ${where(resolved)}`);
  }

  {
    add('nonsense bounds are not restored',
      resolveWindowBounds(null, DISPLAYS) === null
        && resolveWindowBounds({ x: 'left', y: 'up', width: 10, height: 10 }, DISPLAYS) === null
        && resolveWindowBounds({ x: 10, y: 10, width: 10, height: 10 }, []) === null,
      'nonsense was turned into bounds');
  }

  {
    // A display narrower than the minimum window width: the window cannot fit
    // it, and the answer is not to shrink the window below the minimum or to
    // shove it somewhere else.
    const saved = { x: NARROW.bounds.x + 100, y: NARROW.bounds.y + 100, width: W, height: H };
    const resolved = resolveWindowBounds(saved, DISPLAYS);
    add('a window wider than a narrow display keeps its width',
      resolved != null && resolved.width === Math.max(MIN_WIDTH, W),
      `came back ${where(resolved)}`);
    add('a window wider than a narrow display keeps its place',
      resolved != null && resolved.x === saved.x && resolved.y === saved.y,
      `saved ${where(saved)} came back ${where(resolved)}`);
  }

  {
    // What gets remembered is a rule of its own: a minimized or full-screen
    // window is not the shape the user chose, and a maximized window is
    // remembered as the rectangle it had before it was maximized.
    const fake = (over) => ({
      getNormalBounds: () => ({ x: 10, y: 20, width: 900, height: 600 }),
      isMinimized: () => false,
      isFullScreen: () => false,
      isMaximized: () => false,
      ...over,
    });

    add('a minimized window is not remembered',
      boundsToRemember(fake({ isMinimized: () => true })) === null,
      'the minimized bounds were remembered');
    add('a full-screen window is not remembered',
      boundsToRemember(fake({ isFullScreen: () => true })) === null,
      'the full-screen bounds were remembered');
    const maximized = boundsToRemember(fake({ isMaximized: () => true }));
    add('a maximized window is remembered as the rectangle before it was maximized',
      maximized != null && maximized.windowMaximized === true
        && maximized.windowBounds.x === 10 && maximized.windowBounds.y === 20
        && maximized.windowBounds.width === 900 && maximized.windowBounds.height === 600,
      `remembered ${JSON.stringify(maximized)}`);
    add('a window that is not there is not remembered',
      boundsToRemember(null) === null && boundsToRemember({}) === null,
      'something was remembered about no window');
  }

  {
    // The app has to actually ask the module. The geometry can be perfect and
    // the app can still clamp the position itself, which is what it used to
    // do, so the wiring is checked as well as the geometry.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    add('the app asks the geometry module where to put the window',
      source.includes('resolveWindowBounds(') && !source.includes('area.x + area.width - width'),
      'main.js does not use the module, or clamps the position itself');
    add('the window is remembered when it closes',
      source.includes("on('close'") && source.includes('saveBounds()'),
      'main.js does not save the bounds when the window closes');
  }
}

/**
 * The part that cannot be faked: the bounds the app works out have to be the
 * bounds the window actually lands on.
 *
 * The window is never shown, so nothing appears on the desktop. It is put
 * where the app puts one - constructed at the bounds, then bounded again once
 * it exists, because that is what main.js does - and then read back.
 */
async function livePlacement() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const live = displays.map((display) => ({
    bounds: display.bounds,
    workArea: display.workArea,
    primary: display.id === primary.id,
  }));

  const wa = primary.workArea;
  const saved = { x: wa.x + wa.width - W + 30, y: wa.y + 40, width: W, height: H };
  const resolved = resolveWindowBounds(saved, live);
  add('the real desktop is asked the same question as the made-up one',
    resolved != null && resolved.x === saved.x && resolved.y === saved.y,
    `saved ${where(saved)} resolved ${where(resolved)}`);

  const win = new BrowserWindow({
    width: resolved.width,
    height: resolved.height,
    x: resolved.x,
    y: resolved.y,
    show: false,
    frame: true,
    autoHideMenuBar: true,
  });
  win.setBounds({ x: resolved.x, y: resolved.y, width: resolved.width, height: resolved.height });
  const landed = win.getBounds();
  win.destroy();

  add('the window lands exactly where the app asked for it',
    landed.x === resolved.x && landed.y === resolved.y
      && landed.width === resolved.width && landed.height === resolved.height,
    `asked for ${where(resolved)} landed at ${where(landed)}`);
}

app.whenReady().then(async () => {
  main();
  await livePlacement();

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `  [${r.detail}]`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed ? 1 : 0);
});
