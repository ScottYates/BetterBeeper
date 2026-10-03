'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

const DEFAULTS = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  apiKey: '',
  maxTokens: 2048,
  baseUrlOverride: '',
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
};

/**
 * App settings. The AI API key is the only sensitive value here, so it is
 * encrypted with the OS keychain; everything else is plain JSON.
 */
class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
  }

  read() {
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      stored = {};
    }

    let apiKey = DEFAULTS.apiKey;
    if (stored.apiKeyEnc) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyEnc, 'base64'));
        }
      } catch {
        apiKey = '';
      }
    } else if (typeof stored.apiKey === 'string') {
      apiKey = stored.apiKey;
    }

    const { apiKeyEnc, apiKey: _legacy, ...rest } = stored;
    return {
      ...DEFAULTS,
      ...rest,
      apiKey,
      hasApiKey: Boolean(apiKey),
      apiKey: undefined,
    };
  }

  write(patch) {
    const current = this.read();
    const next = { ...current, ...patch };

    const payload = { ...next };
    delete payload.hasApiKey;

    if (patch.apiKey !== undefined) {
      if (patch.apiKey) {
        payload.apiKeyEnc = safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(String(patch.apiKey)).toString('base64')
          : undefined;
        payload.apiKey = safeStorage.isEncryptionAvailable() ? undefined : String(patch.apiKey);
      } else {
        delete payload.apiKeyEnc;
        delete payload.apiKey;
      }
    }

    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);

    return this.read();
  }
}

module.exports = { SettingsStore, DEFAULTS };
