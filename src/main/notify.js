'use strict';

/**
 * Desktop notification policy, kept pure so it can be reasoned about (and
 * tested) without a running window. `main.js` supplies the live state.
 */

/** Which notifications to raise at all. */
function shouldNotify({ prefs, windowFocused, windowVisible, chat, messageIsOwn = false }) {
  if (!prefs || prefs.notifyEnabled === false) return false;
  if (messageIsOwn) return false; // do not notify yourself about your own message

  // Off the bat when the user is already looking at this window, unless they
  // explicitly asked to be notified anyway.
  const looking = Boolean(windowFocused && windowVisible);
  if (looking && prefs.notifyWhenFocused !== true) return false;

  if (chat?.isMuted && prefs.notifyMutedChats !== true) return false;

  return true;
}

/** The notification body, according to the preview preference. */
function notificationBody(entry, previewMode = 'full') {
  if (previewMode === 'none') return 'New message';

  const sender = String(entry?.senderName || '').trim();
  const text = String(entry?.text || '').trim();
  const attachments = entry?.attachments?.length || 0;

  let what = text;
  if (!what && attachments) what = `${attachments} attachment${attachments > 1 ? 's' : ''}`;
  if (!what && entry?.type) what = String(entry.type).toLowerCase();

  if (previewMode === 'sender') return sender || 'New message';
  if (!what) return sender || 'New message';
  if (!sender || entry?.isSender) return what;
  return `${sender}: ${what}`;
}

module.exports = { shouldNotify, notificationBody };
