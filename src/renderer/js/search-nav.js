/**
 * Stepping through a list of matches.
 *
 * Both searches step the same way: forward is down, back is up, and both wrap
 * at the ends. The rule lives here, apart from either search, so the two
 * cannot drift apart - the conversation's own search and the sidebar's.
 *
 * It is here rather than in one of them because a rule that belongs to a
 * feature is a rule the other feature cannot use, and these two would then
 * answer the same question two different ways.
 */

/**
 * The index to step to.
 *
 * Wrapping at both ends, because a search that stops at the last hit makes
 * the user press the key again to find out there is nothing more.
 */
export function nextIndex(current, total, step) {
  if (!total) return -1;
  if (current < 0) return step < 0 ? total - 1 : 0;
  const next = current + (step < 0 ? -1 : 1);
  if (next < 0) return total - 1;
  if (next >= total) return 0;
  return next;
}
