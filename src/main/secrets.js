'use strict';

/**
 * Local secret storage.
 *
 * API keys never leave the machine and are never sent anywhere except the
 * provider endpoint the user configured. When Electron's safeStorage is
 * available the key is sealed with the OS keychain (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux); otherwise it is kept as plain text
 * inside the app's own settings file and the UI says so explicitly.
 */
function createSecretBox(electron) {
  const safeStorage = electron && electron.safeStorage;
  let available = false;

  try {
    available = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  } catch {
    available = false;
  }

  return {
    available,
    scheme: available ? 'safeStorage' : 'plain',

    seal(plaintext) {
      const value = String(plaintext);
      if (!value) return null;
      if (available) {
        return { scheme: 'safeStorage', data: safeStorage.encryptString(value).toString('base64') };
      }
      return { scheme: 'plain', data: value };
    },

    open(stored) {
      if (!stored || typeof stored !== 'object') return '';
      if (stored.scheme === 'safeStorage') {
        if (!available) return '';
        try {
          return safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
        } catch {
          return '';
        }
      }
      return typeof stored.data === 'string' ? stored.data : '';
    },
  };
}

/** In-memory box used by tests and by non-Electron tooling. */
function createMemorySecretBox() {
  const map = new Map();
  return {
    available: false,
    scheme: 'plain',
    seal(plaintext) {
      const token = `mem_${Math.random().toString(36).slice(2)}`;
      map.set(token, String(plaintext));
      return { scheme: 'mem', data: token };
    },
    open(stored) {
      if (!stored || typeof stored !== 'object') return '';
      if (stored.scheme === 'mem') return map.get(stored.data) || '';
      return typeof stored.data === 'string' ? stored.data : '';
    },
  };
}

module.exports = { createSecretBox, createMemorySecretBox };
