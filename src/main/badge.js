'use strict';

/**
 * The unread count on the app icon.
 *
 * Two halves, deliberately split. The decision - how many, whether it changed -
 * is pure and testable without a window. Applying it is the only part that needs
 * Electron.
 *
 * The count is handed to the platform with `app.setBadgeCount` and Windows draws
 * the badge itself.
 *
 * It was not always this way. An earlier version drew the number pixel by pixel
 * into a bitmap and handed it over as an overlay icon. That was a lot of code to
 * reimplement something the operating system already puts on your taskbar, and
 * worse, `app.setOverlayIcon` no longer exists in Electron 38 - so it threw
 * `app.setOverlayIcon is not a function` every time the count changed, and no
 * amount of checking the drawing would have found it. The check that exists now
 * calls the real API for exactly that reason.
 */

const { app } = require('electron');

/**
 * Does this value warrant touching the icon?
 *
 * The icon is a shared, visible thing: redrawing the same number on every chat
 * event would repaint the taskbar continuously on a busy account. Clearing is
 * an update too - a count that drops to zero has to take the badge away, not
 * leave the last number sitting there.
 */
function shouldApply(current, next) {
  // Nothing on the icon yet is not the same as nothing unread: the first call
  // has to go through, or a count that is zero to begin with is never cleared.
  // `Number(null)` is 0, so this cannot be left to the comparison below.
  if (current === null || current === undefined) return true;
  return Number(current) !== Number(next);
}

/**
 * The one call that touches the icon.
 *
 * Behind an object rather than called directly because the Electron API cannot
 * be replaced on the app object, and a check has to be able to watch what would
 * have happened - a badge that silently does nothing and a badge that works look
 * identical from outside this process.
 */
const overlay = {
  set(count) {
    app.setBadgeCount(count);
  },
};

/** What is on the icon right now. null before anything has been applied. */
let applied = null;

/**
 * Put a count on the icon, or take it off.
 *
 * Zero removes the badge; that is the platform's job, not ours to fake with an
 * empty image. Returns whether anything was actually done, so a caller can tell
 * a deliberate clear from a no-op. Repeated counts and repeated zeros are both
 * no-ops.
 *
 * The number is passed through as it is. There is no cap: the platform draws the
 * digit and sizes the badge for it, and a cap would only ever be a second place
 * for the count to be wrong.
 */
function applyBadge(count) {
  const next = Math.max(0, Math.floor(Number(count) || 0));
  if (!shouldApply(applied, next)) return false;
  applied = next;
  overlay.set(next);
  return true;
}

/** Test seam: the count currently on the icon. */
function currentBadge() {
  return applied;
}

/** Test seam: forget the applied count. The platform badge is not touched. */
function resetBadge() {
  applied = null;
}

module.exports = {
  shouldApply,
  applyBadge,
  overlay,
  currentBadge,
  resetBadge,
};