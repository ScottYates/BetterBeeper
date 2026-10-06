'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  markReadOnOpen: true,
  sendOnEnter: true,
  theme: 'system',

  // Text size, as a page-zoom factor. 1 is the size the UI was designed at.
  textScale: 1,

  sidebarWidth: 300,
  windowBounds: null,
  // Whether the window was maximized when it closed. The bounds alone are not
  // enough: getNormalBounds() is the pre-maximize rectangle.
  windowMaximized: false,
  // chatID -> the user's pin choice. Beeper's own isPinned does not apply, so
  // the choice is kept here. See the note in renderer/js/state.js.
  pinnedChats: {},

  // chatIDs archived in this app where Beeper ignored the request. Only the
  // built-in "Note to self" chat needs this. See the note in renderer/js/state.js.
  archivedChats: [],

  // messageIDs this app has hidden or deleted for the user only. Beeper is
  // never told, so the other devices and the other people in the chat keep
  // seeing the message. See the note in renderer/js/state.js.
  hiddenMessages: [],
  deletedMessages: [],

  // Desktop notifications.
  notifyEnabled: true,
  // 'full' = sender and message text, 'sender' = who wrote, 'none' = "New message"
  notifyPreview: 'full',
  notifyMutedChats: false,
  notifySound: true,
  notifyWhenFocused: false,

  // Check GitHub for a newer release once a day and *ask* before downloading
  // anything. There is no silent path: the user always confirms first.
  autoUpdates: true,
};

/**
 * Keys the removed assistant used to write, dropped on every read and every
 * save. `apiKey` is the plaintext fallback older builds used when safeStorage
 * was unavailable, so it is a real secret sitting in the clear and must not
 * linger; the rest are just dead configuration that would only mislead.
 *
 * This list is deliberately explicit. The alternative - stripping anything not
 * in DEFAULTS - would also throw away settings written by a *newer* build,
 * which is a much worse failure than leaving a stale model name on disk.
 */
const RETIRED = ['apiKeyEnc', 'apiKey', 'hasApiKey', 'model', 'provider', 'baseUrl', 'baseUrlOverride', 'maxTokens'];

/**
 * App settings. Nothing here is sensitive any more: the one value that was,
 * the assistant's API key, is read as retired and never returned.
 */
class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
  }

  /** The file exactly as stored, including keys nothing reads any more. */
  raw() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  read() {
    // A key from an earlier version is dropped on the way out rather than
    // read, decrypted and carried around. It has no reader any more, and a
    // secret sitting decrypted in a settings object is a liability, not a
    // feature. The stale values stay on disk until write() below removes them.
    const stored = this.raw();
    for (const key of RETIRED) delete stored[key];
    return { ...DEFAULTS, ...stored };
  }

  write(patch) {
    // Built from raw() rather than from read() on purpose. Both produce the
    // same object today, but only this one says what it is doing: the retired
    // keys are removed from the file on the way out. Sourced from read(), the
    // removal would be an incidental side effect of read()'s stripping, which
    // is the kind of thing that quietly stops being true.
    const stored = this.raw();
    for (const key of RETIRED) delete stored[key];
    const payload = { ...DEFAULTS, ...stored, ...patch };

    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);

    return this.read();
  }
}

module.exports = { SettingsStore, DEFAULTS };
