'use strict';

/**
 * The taskbar icon flashing because a message has arrived.
 *
 * Windows only. This is the taskbar asking for attention on the application's
 * behalf, which is the platform's own gesture rather than something to draw -
 * macOS and Linux have no equivalent call, and inventing one would be another
 * thing that only looks like it works.
 *
 * Split the same way badge.js is: the decisions are pure and need no window, and
 * the single call that touches the window sits behind an object so a check can
 * watch it. A flash that silently does nothing and a flash that works look
 * identical from outside this process.
 *
 * Two things are deliberate and worth stating:
 *
 *   - It is not tied to the notification settings. A toast is an interruption
 *     that takes over part of the screen and can be turned off; a flashing
 *     taskbar button is the same signal Windows already gives for every other
 *     application, and the unread badge it sits next to is not tied to those
 *     settings either. Turning notifications off should not silence the taskbar.
 *   - It never steals focus. No `show()`, no `restore()`, no `focus()`. Asking
 *     to be noticed is not the same as interrupting.
 */

/** Whether this platform has a taskbar that flashes at all. */
function supportsFlash(platform) {
  return platform === 'win32';
}

/**
 * Should this arriving message start a flash?
 *
 * Your own message does not count: you sent it, you know it went. Neither does
 * one that arrives while the window is in front of you, because a flashing
 * button on the window you are already reading is noise.
 *
 * "Visible but not focused" is the background case that matters - the window is
 * behind something else, and its button flashes until you go to it.
 */
function shouldStart({ windowFocused = false, windowVisible = false, messageIsOwn = false } = {}) {
  if (messageIsOwn) return false;
  if (windowFocused && windowVisible) return false;
  return true;
}

/**
 * Should an active flash stop?
 *
 * On focus, and only then. Windows keeps flashing until it is told to stop, so
 * a flash left running after the user has come back to the window is the most
 * visible way this can be got wrong.
 */
function shouldStop({ flashing = false, windowFocused = false } = {}) {
  return Boolean(flashing && windowFocused);
}

/**
 * The one call that touches the window.
 *
 * Behind an object, as in badge.js, because a check has to be able to see what
 * would have happened rather than take the result on trust.
 */
const taskbar = {
  set(on) {
    const win = currentWindow();
    // Guarded on every side: the window can be gone, and on a platform with no
    // taskbar there is no such method at all.
    if (!win || win.isDestroyed()) return false;
    if (typeof win.flashFrame !== 'function') return false;
    win.flashFrame(Boolean(on));
    return true;
  },
};

/** Injected by main.js so this module never has to reach for a global. */
let currentWindow = () => null;

/** Test seam, and how main.js hands the window over. */
function setWindowSource(fn) {
  currentWindow = typeof fn === 'function' ? fn : () => null;
}

/** Whether a flash is currently running. null before anything has been asked for. */
let flashing = null;

/**
 * A message arrived. Start flashing if it warrants it.
 *
 * Returns whether anything was done, so a caller can tell a deliberate start
 * from a no-op. A second message while already flashing changes nothing: the
 * taskbar button is already flashing and re-asking does not make it louder.
 */
function onIncoming(win, { messageIsOwn = false } = {}) {
  if (flashing === true) return false;
  if (!shouldStart({
    windowFocused: Boolean(win?.isFocused?.()),
    windowVisible: Boolean(win?.isVisible?.()),
    messageIsOwn,
  })) return false;
  flashing = true;
  taskbar.set(true);
  return true;
}

/**
 * The window came back to the front; stop flashing.
 *
 * Safe to call far more often than there is anything to stop.
 */
function onFocus(win) {
  if (!shouldStop({
    flashing: flashing === true,
    windowFocused: Boolean(win?.isFocused?.()),
  })) return false;
  flashing = false;
  taskbar.set(false);
  return true;
}

/** Test seam: is a flash running? null before anything has been asked for. */
function isFlashing() {
  return flashing;
}

/** Test seam: forget the state. The taskbar is not touched. */
function resetFlash() {
  flashing = null;
}

module.exports = {
  supportsFlash,
  shouldStart,
  shouldStop,
  taskbar,
  setWindowSource,
  onIncoming,
  onFocus,
  isFlashing,
  resetFlash,
};