/**
 * Does coming back to the window count as having read what is on screen?
 *
 * The render path only marks a thread read when the document has focus at the
 * moment it runs. That is right while you are reading, and wrong the moment you
 * are not: a message that arrived while the window was in the background was
 * rendered with focus false, so it was declined, and nothing afterwards
 * re-rendered, so nothing ever re-asked. Coming back to the window is exactly
 * when the answer changes, and it has to be asked explicitly.
 *
 * Kept separate and pure for the same reason as unread.js: the rule is four
 * conditions, and four conditions written twice is how one of them drifts.
 */

/**
 * @param windowFocused     document.hasFocus()
 * @param windowVisible     document.visibilityState === 'visible'
 * @param hasOpenChat       a chat is open in the thread
 * @param lastMessageUnread the newest message in it is still marked unread
 * @param markReadEnabled   the "mark a chat as read when I open it" setting
 */
export function shouldMarkOnReturn({
  windowFocused = false,
  windowVisible = false,
  hasOpenChat = false,
  lastMessageUnread = false,
  markReadEnabled = true,
} = {}) {
  // Not looking at it is the whole question. This runs on focus and on
  // visibility, and either can arrive while the other half is still untrue.
  if (!windowFocused || !windowVisible) return false;

  // Only the chat that is open. A chat you have not opened has nothing on screen
  // to have read, and marking those would quietly swallow unread counts across
  // the whole account every time you alt-tab back.
  if (!hasOpenChat) return false;

  // Same setting that governs marking on open: someone who turned that off does
  // not want a return to the window quietly reading things either.
  if (!markReadEnabled) return false;

  return Boolean(lastMessageUnread);
}

export default shouldMarkOnReturn;