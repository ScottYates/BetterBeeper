'use strict';

/**
 * Where the window opens, given where it was left.
 *
 * The rule is one sentence: the window opens exactly where it was closed.
 *
 * That is worth spelling out, because the obvious alternative - clamp the
 * position into the display's work area, so the window is always fully on
 * screen - is what made the window come back slightly off, and it was not a
 * rounding artefact. Measured on the desktop that reported it, across every
 * edge of every display, the offset was *exactly* how far the window had been
 * over the edge. A window closed 30px past the right edge of a display came
 * back 30px to the left of that. A window closed over the taskbar came back
 * above the taskbar. The window had not been lost; it had been tidied up.
 *
 * So the position is not clamped. What is kept is the reason the clamp was
 * written in the first place: if the display the window was on is gone, the
 * window would open in the void, with no way to get it back. That case is a
 * rescue, and it happens only when the window no longer touches any display
 * at all - not when it hangs over an edge, which is a position the user chose.
 *
 * The size is the user's as well. A window wider than the screen it opens on
 * is a size the user chose, and the rule that keeps the position keeps the
 * size: the app does not tidy the window up.
 *
 * The geometry lives here, away from Electron, so it can be checked against
 * displays that do not exist - a monitor that was unplugged, a taskbar in the
 * way - without needing a desktop that looks like that.
 */

/** The smallest window the app will open at. */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

/**
 * How much of two rectangles lies on top of each other.
 */
function overlap(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return { width, height };
}

/**
 * The display a rectangle sits on: the one it covers most of.
 *
 * This is what Electron's `screen.getDisplayMatching` answers, and the app
 * used to ask it. It is kept here because the question is still worth asking
 * - it decides how big the window is allowed to be - but the answer no longer
 * decides where the window goes.
 */
function displayUnder(displays, rect) {
  let best = null;
  let bestArea = 0;
  for (const display of displays) {
    const covered = overlap(rect, display.bounds);
    const area = covered.width * covered.height;
    if (area > bestArea) {
      bestArea = area;
      best = display;
    }
  }
  return best;
}

/** The primary display, or the first one there is. */
function primaryOf(displays) {
  return displays.find((d) => d.primary) || displays[0] || null;
}

/**
 * Does the rectangle touch any display at all?
 *
 * "Touches" is deliberately loose: a window hanging over an edge touches its
 * display, and a window on a monitor that has been unplugged does not touch
 * anything. That distinction is the whole of the rescue rule.
 */
function touchesADisplay(displays, rect) {
  return displays.some((display) => {
    const covered = overlap(rect, display.bounds);
    return covered.width > 0 && covered.height > 0;
  });
}

/**
 * Where the window should open.
 *
 * `saved` is the bounds the window was left at, `displays` is what the
 * desktop looks like now. Each display is `{ bounds, workArea, primary }`.
 *
 * Returns `null` when there is nothing to restore, which is the app's signal
 * to open at its defaults.
 */
function resolveWindowBounds(saved, displays, options = {}) {
  const minWidth = Number.isFinite(options.minWidth) ? options.minWidth : MIN_WIDTH;
  const minHeight = Number.isFinite(options.minHeight) ? options.minHeight : MIN_HEIGHT;

  if (!saved || typeof saved !== 'object') return null;
  if (!Array.isArray(displays) || displays.length === 0) return null;

  const x = Number(saved.x);
  const y = Number(saved.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const savedWidth = Number(saved.width);
  const savedHeight = Number(saved.height);

  // The display it was on. It is only asked for one thing: the size to open
  // at when the saved bounds do not carry one, which is the first run.
  const home =
    displayUnder(displays, {
      x,
      y,
      width: Number.isFinite(savedWidth) ? savedWidth : 0,
      height: Number.isFinite(savedHeight) ? savedHeight : 0,
    }) || primaryOf(displays);
  const area = home.workArea;

  // The size is the size the user had, like the position. It is not fitted to
  // the display: a window that is wider than the screen it opens on is a size
  // the user chose, and the rule that keeps the position keeps the size. The
  // only thing that is not allowed is a window smaller than the app's
  // minimum, which the window manager would refuse anyway.
  const width = Number.isFinite(savedWidth) && savedWidth > 0 ? Math.max(minWidth, savedWidth) : area.width;
  const height = Number.isFinite(savedHeight) && savedHeight > 0 ? Math.max(minHeight, savedHeight) : area.height;

  const rect = { x: Math.round(x), y: Math.round(y), width, height };

  // The position is the user's, and it stays the user's.
  if (touchesADisplay(displays, rect)) return rect;

  // The display it was on is gone: the window would open in the void, so it is
  // brought onto the primary display instead. This is the only case in which
  // the window moves to somewhere it was not left.
  const fallback = primaryOf(displays);
  if (!fallback) return rect;
  const fa = fallback.workArea;
  const fw = Math.max(minWidth, Math.min(width, fa.width));
  const fh = Math.max(minHeight, Math.min(height, fa.height));
  return {
    width: fw,
    height: fh,
    x: Math.round(fa.x + Math.max(0, (fa.width - fw) / 2)),
    y: Math.round(fa.y + Math.max(0, (fa.height - fh) / 2)),
  };
}

/**
 * The bounds worth remembering, and whether the window was maximized.
 *
 * A minimized or full-screen window is not worth remembering: its bounds are
 * not the shape the user chose, and saving them would open the window at a
 * size nobody asked for. A maximized window is remembered as the rectangle it
 * had before it was maximized, which is what it should come back to.
 *
 * The window is passed in rather than reached for, so this can be asked
 * about a window that is not the main one.
 */
function boundsToRemember(win) {
  if (!win || typeof win.getNormalBounds !== 'function') return null;
  try {
    if (win.isMinimized() || win.isFullScreen()) return null;
    return {
      windowBounds: win.getNormalBounds(),
      windowMaximized: win.isMaximized(),
    };
  } catch {
    return null; // a window that is on its way out has no bounds to give
  }
}

module.exports = { resolveWindowBounds, boundsToRemember, overlap, MIN_WIDTH, MIN_HEIGHT };
