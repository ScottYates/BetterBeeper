/**
 * Keeping the sidebar's preview line honest when a chat changes.
 *
 * This is pure logic with no DOM and no bridge, so it can be exercised by
 * tools/chat-preview-check.mjs against real frames instead of being read and
 * believed. That matters here, because the bug this replaced was invisible to
 * every other kind of check: nothing threw, every field parsed, the API
 * surface was unchanged, and the sidebar simply kept showing yesterday's
 * message.
 *
 * The cause was a shape difference between two endpoints. Beeper's
 * `GET /v1/chats` answers with ListChatsOutput, whose items are ChatWithPreview
 * and so carry a `preview` message. `GET /v1/chats/{chatID}` answers with the
 * plain Chat schema, which has no `preview` field at all. Measured against
 * 4.3.160: all 100 list items had one, and no getChat response did.
 *
 * So the refresh after a `message.upserted` frame merged a preview-less object
 * over the cached chat, which left the OLD preview in place. rowSignature
 * includes the preview text, so the signature did not change, so the row was
 * never rebuilt, and the message you were looking at in the thread never
 * reached the list beside it until the 60 second inbox refresh happened to
 * land.
 */

/**
 * Beeper's own ordering for a message.
 *
 * `sortKey` is the monotonic key it sorts threads by and rides on every
 * message. `timestamp` is the fallback for the rare entry that arrives without
 * one; comparing it as a string is safe because Beeper sends ISO 8601 with a
 * fixed timezone, so the ordering is the same either way.
 */
export function messageOrderKey(message) {
  return String(message?.sortKey || message?.timestamp || '');
}

/**
 * The newest message in a `message.upserted` frame that the thread would draw,
 * or null when the frame carries nothing worth previewing.
 *
 * A frame is a batch and can carry several messages, so this cannot simply
 * take the last entry. Deleted and hidden messages are skipped for the same
 * reason chatPreviewText skips them: a preview line pointing at something the
 * user cannot see is the sidebar describing a conversation that is not on
 * screen.
 */
export function newestPreviewEntry(frame) {
  let newest = null;
  for (const entry of frame?.entries || []) {
    if (!entry?.id) continue;
    if (entry.isDeleted || entry.isHidden) continue;
    if (!newest || messageOrderKey(entry) > messageOrderKey(newest)) newest = entry;
  }
  return newest;
}

/**
 * The cached chat with a fresh `getChat` response merged over it.
 *
 * The only thing this adds is the preview. A field the incoming object does not
 * have cannot participate in a spread, so `fresh` cannot overwrite the cached
 * preview whether it is spread before or after this line - which is precisely
 * why the bug was so quiet. The merge ran, every other field updated, and the
 * preview was silently left exactly as it was. Writing it explicitly is the
 * whole fix.
 *
 * With no preview entry - a `chat.upserted` frame carries no messages - the
 * cached preview is left alone, which is right: the list endpoint is the only
 * thing that has ever supplied one.
 */
export function mergeChatSummary(existing, fresh, previewEntry, chatID) {
  const merged = { ...existing, ...fresh };
  if (previewEntry) merged.preview = { ...previewEntry, chatID: previewEntry.chatID || chatID };
  return merged;
}