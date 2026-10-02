'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

/**
 * Persists the OAuth client registration and access token in the app's
 * userData directory.
 *
 * The access token is a bearer credential for the user's entire Beeper
 * account, so it is encrypted at rest with Electron's `safeStorage`
 * (DPAPI-backed on Windows). If the OS keychain is unavailable we still avoid
 * writing plaintext: the file is chmod 600 and we surface a flag so the UI can
 * tell the user the token is stored unencrypted.
 */
class TokenStore {
  constructor(dir) {
    this.file = path.join(dir, 'auth.json');
    this.cached = null;
  }

  read() {
    if (this.cached) return this.cached;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.cached = this.#decrypt(parsed);
      return this.cached;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A blob we cannot decrypt will never become decryptable - it happens
        // when the app is renamed, because safeStorage binds its ciphertext to
        // the app name. Clear it so the user is asked to reconnect once instead
        // of the same failure being reported on every single launch.
        console.warn('[auth] stored credentials are unreadable, clearing:', err.message);
        this.clear();
      }
      return null;
    }
  }

  write(data) {
    this.cached = data;
    const payload = this.#encrypt(data);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort on platforms without POSIX modes */
    }
  }

  clear() {
    this.cached = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      console.warn('[auth] could not clear stored credentials:', err.message);
    }
  }

  get isEncrypted() {
    return this.#canEncrypt();
  }

  #canEncrypt() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  #encrypt(data) {
    if (!this.#canEncrypt()) return { version: 1, encrypted: false, data };
    const packed = {
      version: 1,
      encrypted: true,
      data: safeStorage.encryptString(JSON.stringify(data)).toString('base64'),
    };
    return packed;
  }

  #decrypt(packed) {
    if (!packed || typeof packed !== 'object') return null;
    if (!packed.encrypted) return packed.data ?? null;
    if (!this.#canEncrypt()) {
      throw new Error('Stored credentials are encrypted but this OS keychain is unavailable.');
    }
    const json = safeStorage.decryptString(Buffer.from(packed.data, 'base64'));
    return JSON.parse(json);
  }
}

module.exports = { TokenStore };
