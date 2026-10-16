/**
 * Wires the spell-check context menu to the real window.
 *
 * Electron shows no context menu of its own, on any platform, so a right-click
 * anywhere in the app does nothing unless something builds one. The thread's
 * image menu is a renderer popover and does not reach this; spell-check
 * suggestions and the composer text actions have no home at all without it.
 *
 * What decides the contents is spell-context.js, which is pure and tested. This
 * is only the part that needs Electron.
 */

const { Menu, MenuItem } = require('electron');
const { spellContextItems, shouldShowContextMenu, trimSeparators } = require('./spell-context');

/**
 * Turn one decision entry into a clickable item.
 *
 * `webContents` rather than the window, because these are document commands:
 * replaceMisspelling and the edit roles act on the focused frame, and the
 * composer keeps its own undo stack that way.
 */
function toMenuItem(webContents, entry) {
  if (entry.id === 'sep') return new MenuItem({ type: 'separator' });

  switch (entry.id) {
    case 'replace':
      return new MenuItem({
        label: entry.label,
        click: () => webContents.replaceMisspelling(entry.replaces),
      });
    case 'add-word':
      return new MenuItem({
        label: entry.label,
        click: () => webContents.session.addWordToSpellCheckerDictionary(entry.word),
      });
    default:
      // cut / copy / paste / select-all are all standard edit roles, which the
      // platform renders with the right accelerator and enabled/greyed state.
      return new MenuItem({ label: entry.label, role: entry.id });
  }
}

/**
 * Show a context menu for a right-click, when there is one worth showing.
 *
 * Returns whether a menu was actually built, so the caller can say so rather
 * than have a check assume one appeared.
 */
function showSpellContextMenu(webContents, params) {
  if (!shouldShowContextMenu(params)) return false;

  const items = trimSeparators(spellContextItems(params));
  if (!items.length) return false;

  const menu = Menu.buildFromTemplate(items.map((entry) => toMenuItem(webContents, entry)));
  menu.popup({ window: webContents.getOwnerBrowserWindow() || undefined });
  return true;
}

/**
 * Attach to a window's webContents. Safe to call once per window.
 */
function wireSpellContextMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    try {
      showSpellContextMenu(webContents, params);
    } catch {
      // A menu that cannot be built is not worth taking the click down for.
    }
  });
}

module.exports = { wireSpellContextMenu, showSpellContextMenu };