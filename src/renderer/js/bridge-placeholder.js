/**
 * The placeholder Beeper's bridge puts in when it cannot fetch an attachment.
 *
 * When a bridge fails to download an attachment it does not send the message
 * without it: it sends the message with the failure written into the text.
 * Google's Voice bridge does it like this:
 *
 *   Failed to download attachment
 *
 *   here is what the voice message said
 *
 * The transcript follows, so the bubble reads as if the sender had typed
 * "Failed to download attachment" and then said something else. They did not:
 * the voice message's audio could not be fetched, and the bridge said so in
 * the only place it had.
 *
 * Measured on this account: four such messages, all Google Voice, every one
 * of them a voice message whose audio Google refused to serve (HTTP 400)
 * when Beeper's bridge asked for it. The bytes are not on this machine and
 * cannot be fetched from here - the failure is upstream of this app, and the
 * most this app can do is not pretend the words belong to the sender.
 *
 * So the placeholder is taken off the text and shown as what it is - an
 * attachment that is missing - and the words that follow are shown as the
 * message.
 */

/** The text the bridge puts at the front of the message. */
export const PLACEHOLDER = 'Failed to download attachment';

/**
 * Split the bridge's placeholder off the front of a message.
 *
 * Returns `{ missing, text }`: `missing` is true when the placeholder was
 * there, and `text` is the rest of the message.
 *
 * The placeholder only counts as one when something follows it. A message
 * that is exactly the placeholder, with nothing after it, is somebody's
 * message, and it is shown as it was written.
 */
export function splitBridgePlaceholder(raw) {
  const text = String(raw ?? '');
  if (!text.startsWith(PLACEHOLDER)) return { missing: false, text };

  const rest = text.slice(PLACEHOLDER.length);
  // The bridge puts a blank line after the placeholder. Anything else is a
  // line somebody typed that happens to start the same way.
  if (!rest.startsWith('\n')) return { missing: false, text };

  return { missing: true, text: rest.replace(/^\n+/, '') };
}
