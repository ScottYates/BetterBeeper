/**
 * What the app knows about whether a message of ours went out.
 *
 * `sendStatus` has two shapes, and they come from different places:
 *
 * - The app's own flag, on the bubble it puts on screen before the send round
 *   trip comes back: 'pending' while it is in flight, 'sent' once it is back,
 *   and 'failed' when the send did not go through.
 * - The bridge's delivery receipt, which is an object:
 *   `{ status: 'SUCCESS', timestamp, deliveredToUsers }`.
 *
 * The bridge started sending that receipt on 2026-11-24. Code that compared
 * the field with the string 'sent' stopped recognising its own messages: every
 * message of the user's own came back as "not confirmed", so the up arrow had
 * nothing at all to open, and the bubble grew a second tick beside the read
 * receipt with no colour on it.
 *
 * So the shape is read here, once, and everything else asks this module.
 *
 * The receipts this was written against are the ones in the app's own store:
 * `SUCCESS` for a message that went out, and `FAIL_RETRIABLE` for one that
 * did not.
 */

/** The message is on its way and nobody has confirmed it. */
export const PENDING = 'pending';
/** The message went out. */
export const SENT = 'sent';
/** The message did not go out. */
export const FAILED = 'failed';

/** The receipt status the bridge sends for a message that went out. */
const DELIVERED = 'SUCCESS';

/**
 * The state of a message of ours: pending, sent, or failed.
 *
 * A message with no status of its own came from Beeper - every real message
 * from the bridge looks like that - so it has been sent.
 */
export function sendState(message) {
  const status = message?.sendStatus;

  // No status of its own: the message came from Beeper, so Beeper has it.
  if (status === undefined || status === null) return SENT;

  // The app's own flag on the optimistic bubble.
  if (typeof status === 'string') {
    if (status === SENT) return SENT;
    if (status === FAILED) return FAILED;
    // 'pending', and anything nobody has seen: not sent yet.
    return PENDING;
  }

  // The bridge's delivery receipt.
  if (typeof status === 'object') {
    const code = String(status.status || '').toUpperCase();
    if (code === DELIVERED) return SENT;
    if (code.startsWith('FAIL')) return FAILED;
    // The bridge has it and is still trying to deliver it.
    return PENDING;
  }

  return PENDING;
}

/**
 * Has Beeper got this message?
 *
 * A message that only exists on this device is one the app put on screen
 * before the send round trip came back, and Beeper has never heard of its id
 * - so an edit would be sent for a message that does not exist. The same is
 * true of one whose send failed.
 */
export function confirmedByBeeper(message) {
  return sendState(message) === SENT;
}
