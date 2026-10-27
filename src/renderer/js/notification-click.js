/**
 * Clicking a desktop notification opens that conversation and puts the
 * cursor in its composer.
 *
 * The main process sends the chat the notification was about. A click on a
 * toast is a request to reply, not merely to bring the window up, so the
 * conversation opens and the caret goes into the composer - the same thing
 * that happens when the user clicks the chat in the list.
 *
 * The window is often not the foreground window yet when the click arrives:
 * the main process has only just been asked to show it, and Windows can
 * refuse the foreground request outright. A caret set in a background window
 * does not always survive the activation, so the composer is asked for focus
 * again when the window actually takes focus.
 *
 * It is armed once, and only for a click that asked for it. An ordinary
 * return to the window must not drag the caret back into the composer, since
 * the user may have been somewhere else entirely - the search box, a
 * message, a reply being written.
 */
import { openChat, focusComposer } from './thread.js';

// Set when a notification click wants the composer focused and the window
// was not the foreground window at the time.
let waitingForWindowFocus = false;

/**
 * Open the conversation a notification was about, and put the cursor in it.
 *
 * `windowActive` says whether the window is the foreground window. It is
 * passed in rather than read from the document so the behaviour can be
 * exercised in both directions, and it defaults to what the document knows.
 */
export function openFromNotification(chatID, { windowActive } = {}) {
  const id = String(chatID || '').trim();
  if (!id) return false;

  // Arm the second attempt for when the window does take focus - unless it
  // is already active, in which case the caret below is enough, and arming
  // it would drag the caret back to the composer every time the user came
  // back to the window for any other reason.
  const active = windowActive === undefined ? document.hasFocus() : Boolean(windowActive);
  waitingForWindowFocus = !active;

  openChat(id);
  // Asked for by name, so this does not depend on openChat happening to do
  // it as well.
  focusComposer();
  return true;
}

/**
 * Put the cursor in the composer when the window takes focus, if a
 * notification click was waiting for it.
 *
 * Returns whether it did, so the one-shot nature is visible to a caller and
 * to a check.
 */
export function focusComposerOnWindowFocus() {
  if (!waitingForWindowFocus) return false;
  waitingForWindowFocus = false;
  focusComposer();
  return true;
}

/**
 * Listen for the click.
 *
 * The wiring lives here rather than in the bootstrap so the whole path can be
 * exercised in a check: the handler is the one the app really installs, not
 * a copy of it.
 */
export function wireNotificationClicks() {
  window.beeper.on.notificationClick((chatID) => openFromNotification(chatID));
}
