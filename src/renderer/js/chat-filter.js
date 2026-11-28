/**
 * Filtering the chat list by what is typed.
 *
 * A filter over the list that is already on screen, not a search: it
 * narrows what you can see, and it does not go and ask Beeper about chats
 * and messages this window has never seen. The search behind the magnifier
 * is that thing, and it keeps its own box.
 *
 * No DOM and no account, so the rule can be checked on its own.
 */

import { decodeEntities } from './entities.js';

/**
 * The name of a chat, as the list draws it.
 *
 * Titles arrive from the same bridges as message text, so they can arrive
 * HTML-escaped as well. The list draws the decoded name, and the filter
 * matches what the list draws - a filter that cannot find a name that is
 * on screen is a filter that looks broken.
 */
export function filterName(chat) {
  return decodeEntities(String(chat?.title || '')).trim().toLowerCase();
}

/**
 * Does this chat's name contain what was typed?
 *
 * A substring, so "ben" finds "Benji" and the "Ben" in "Ben's chat". The
 * comparison ignores case, because a name is a name.
 */
export function matchesFilter(chat, needle) {
  const want = String(needle || '').trim().toLowerCase();
  if (!want) return true;
  return filterName(chat).includes(want);
}

/**
 * The chats that match, in the order they were given.
 *
 * The order is not touched: the list is filtered, not re-sorted, so the
 * pinned chats stay at the top and the rest stay in activity order.
 */
export function filterChats(chats, needle) {
  const list = chats || [];
  const want = String(needle || '').trim();
  if (!want) return [...list];
  return list.filter((chat) => matchesFilter(chat, want));
}

/**
 * Is this keystroke one that starts a chat filter?
 *
 * A printable character, with no modifier held, and not typed into a field:
 * a keystroke that is going somewhere else belongs to whatever it is going
 * to. A key of more than one character is a name - Shift, ArrowLeft, F5 -
 * rather than something to filter by.
 *
 * The event is only read, never changed, so this can be driven with a plain
 * object rather than a real key event.
 */
export function isFilterableKey(event) {
  if (!event) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!event.key || event.key.length !== 1) return false;
  const target = event.target;
  if (target) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false;
    if (target.isContentEditable) return false;
  }
  return true;
}
