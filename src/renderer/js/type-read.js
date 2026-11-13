/**
 * Does typing in a chat count as having read it?
 *
 * A message that arrives in the chat you are looking at is marked read when it
 * is rendered - but only if the document had focus at that moment. A message
 * that arrives while the window was elsewhere is left unread, deliberately,
 * because nobody was looking at it then.
 *
 * The gap this closes: the moment you start typing in that chat, you are
 * looking at it. You are not reading it in the sense of scrolling back, but
 * you have the conversation in front of you and you are answering in it, and
 * the message that arrived is on the screen. Typing is the user saying "I am
 * here and I have this open", and the app is not listening for it.
 *
 * It is also the only signal that survives a badge that should not have been
 * there. A message that arrives while the window has focus is marked read,
 * and then the sidebar is refreshed from the server - and the server's answer
 * can still carry the old count, because the mark had not reached it yet when
 * the refresh was issued. The badge comes back on a chat that is open and on
 * screen. Typing in it clears it, because the user has now answered in that
 * chat and a badge saying there is something unread in it is wrong.
 *
 * Kept separate and pure for the same reason as focus-read.js and unread.js:
 * the rule is three conditions, and three conditions written twice is how one
 * of them drifts.
 */

/**
 * @param hasOpenChat       a chat is open in the thread
 * @param chatUnread        that chat still has unread messages
 * @param markReadEnabled   the "mark a chat as read when I open it" setting
 */
export function shouldMarkOnTyping({
  hasOpenChat = false,
  chatUnread = false,
  markReadEnabled = true,
} = {}) {
  // Only the chat that is open. There is nowhere else to type.
  if (!hasOpenChat) return false;

  // Same setting that governs marking on open and on return: someone who
  // turned that off does not want the app deciding what they have read.
  if (!markReadEnabled) return false;

  // Nothing to mark if the chat is already read.
  return Boolean(chatUnread);
}

export default shouldMarkOnTyping;
