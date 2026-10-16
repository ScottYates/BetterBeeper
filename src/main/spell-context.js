/**
 * What the right-click menu should contain, given what was clicked.
 *
 * Chromium spellchecks the message thread - the squiggles are real and have been
 * all along - but right-clicking one did nothing. The reason is not a bug in the
 * spellchecker: Electron shows no context menu by default on any platform, and
 * the app had no `context-menu` handler either, so there was nothing to pop up.
 * The image menu in the thread is a renderer-side popover and is unrelated.
 *
 * So this decides what belongs on the menu, and context-menu.js builds it. The
 * split is the usual one in this repo: the rule is testable without Electron,
 * and the wiring is not.
 *
 * No imports, so a check can exercise it in plain Node.
 */

/** Beyond this the list stops being a menu and starts being a dictionary. */
const MAX_SUGGESTIONS = 8;

/**
 * Menu entries as {id, label} pairs, with 'sep' for a divider.
 *
 * Returns an empty list when there is nothing sensible to offer, which the
 * caller treats as "show nothing at all". An empty popup is worse than none:
 * it is a thing that appeared in response to a click and then vanished.
 */
export function spellContextItems(params) {
  const items = [];
  if (!params || typeof params !== 'object') return items;

  const word = typeof params.misspelledWord === 'string' ? params.misspelledWord.trim() : '';
  const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : [];

  if (word) {
    for (const suggestion of suggestions.slice(0, MAX_SUGGESTIONS)) {
      if (typeof suggestion !== 'string' || !suggestion) continue;
      items.push({ id: 'replace', label: suggestion, replaces: suggestion });
    }
    // Offered even with no suggestions: a word the dictionary has never seen is
    // exactly the one a person most likely wants to teach it.
    items.push({ id: 'add-word', label: `Add "${word}" to dictionary`, word });
    items.push({ id: 'sep' });
  }

  // The standard text actions. Cut and paste only mean anything where there is
  // an editable field - the composer - and copy only where something is selected.
  if (params.isEditable) items.push({ id: 'cut', label: 'Cut' });
  if (params.selectionText) items.push({ id: 'copy', label: 'Copy' });
  if (params.isEditable) items.push({ id: 'paste', label: 'Paste' });
  if (params.isEditable || params.selectionText || word) items.push({ id: 'sep' });
  items.push({ id: 'select-all', label: 'Select all' });

  return items;
}

/**
 * Should a menu be shown for this click at all?
 *
 * The important case is the negative one. A right-click on an image, on empty
 * space, or on a button is already answered by the app's own popovers, and a
 * native menu popping up on top of one of those is the app arguing with itself.
 * So anything that is not text-related is left alone.
 */
export function shouldShowContextMenu(params) {
  if (!params || typeof params !== 'object') return false;
  if (typeof params.misspelledWord === 'string' && params.misspelledWord.trim()) return true;
  if (params.isEditable === true) return true;
  return typeof params.selectionText === 'string' && params.selectionText.length > 0;
}

/**
 * Trailing separators are noise: when nothing follows a divider, all it does is
 * put a line at the bottom of the menu.
 */
export function trimSeparators(items) {
  const out = (items || []).slice();
  while (out.length && out[out.length - 1].id === 'sep') out.pop();
  return out;
}