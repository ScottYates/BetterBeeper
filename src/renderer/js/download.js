/**
 * What a message's menu should offer for getting its attachments out.
 *
 * The thread draws three kinds of attachment and each already has its own way
 * out: a file row is the button, an image has Save in its right-click menu, and
 * a video carries its own save button. That is the point - saving one file is
 * always a single deliberate click on the file itself.
 *
 * What is left for the message menu is the case none of those cover: getting
 * everything a message carries, in one go, without hunting. So this decides
 * between a singular and a plural entry and nothing else.
 *
 * Kept separate and pure for the same reason as share.js and unread.js: the
 * naming rule is a number, a comparison and a string, and it is much easier to
 * get right once than to keep right in two places.
 */

/**
 * The attachments on a message that could actually be handed to a save dialog.
 *
 * Beeper's message objects come off the wire and occasionally carry a null in
 * the array; a null has no filename and nothing to resolve, and offering to save
 * it would put a dead entry in a menu. Filtering here means the count in a
 * label and the number of dialogs that actually open are the same number.
 */
export function downloadableAttachments(message) {
  const list = message?.attachments;
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && typeof a === 'object');
}

/**
 * The label for saving everything on a message.
 *
 * "Download attachment" for one, "Download all (4)" for several. The count is
 * in the label on purpose: the menu entry fires N save dialogs in a row, and
 * somebody who picked it by accident can cancel the first one and stop.
 */
export function downloadLabel(count) {
  const n = Number(count) || 0;
  if (n <= 1) return 'Download attachment';
  return `Download all (${n})`;
}

/**
 * Menu entries for a message's attachments, as {kind, label} pairs.
 *
 * Returns an empty list rather than a hidden or disabled entry when there is
 * nothing to save: an item that is always greyed out is worse than an absent
 * one, because it invites a click that cannot do anything.
 */
export function downloadMenuItems(message) {
  const count = downloadableAttachments(message).length;
  if (count === 0) return [];
  return [{ kind: 'all', label: downloadLabel(count), count }];
}

/**
 * The title for the small save button drawn over a video.
 *
 * Videos are the one inline kind with no right-click route: the app's image menu
 * is wired to <img> only, so a video would otherwise have exactly one way out,
 * which is the full message menu and therefore several clicks away.
 */
export function videoSaveTitle(attachment) {
  const name = attachment?.fileName || attachment?.name || 'video';
  return `Save ${name}`;
}

/** The accessible name for the same button, when there is no filename. */
export function videoSaveLabel(attachment) {
  return attachment?.fileName || attachment?.name || 'Save video';
}
