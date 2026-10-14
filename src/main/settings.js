'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateProvider, kindOf } = require('./providers');

const SETTINGS_VERSION = 1;
const MAX_PROVIDERS = 40;

function defaults() {
  return {
    version: SETTINGS_VERSION,
    activeProviderId: null,
    workspace: null,
    // Providers are created by the user only. Lantern never scans the machine
    // for credentials or configuration belonging to other tools.
    providers: [],
    ui: { theme: 'system', showSystemPrompt: false },
  };
}

function newId() {
  return crypto.randomUUID();
}

/**
 * Settings live in a single JSON file inside the app's own userData folder.
 * Writes are atomic (temp file + rename) so a crash cannot corrupt the file.
 */
class SettingsStore {
  constructor({ dir, secretBox, fileName = 'settings.json' }) {
    if (!dir) throw new Error('SettingsStore needs a directory');
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.secretBox = secretBox;
    this.data = defaults();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        ...defaults(),
        ...parsed,
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        ui: { ...defaults().ui, ...(parsed.ui || {}) },
      };
    } catch {
      this.data = defaults();
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Redacted view: safe to send to the renderer. Never contains a secret. */
  publicProvider(provider) {
    const kind = kindOf(provider.kind);
    return {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      kindLabel: kind.label,
      baseUrl: provider.baseUrl,
      apiPath: provider.apiPath,
      model: provider.model,
      maxTokens: provider.maxTokens,
      temperature: provider.temperature,
      stream: provider.stream !== false,
      extraHeaders: provider.extraHeaders || {},
      hasKey: Boolean(provider.apiKey && provider.apiKey.data),
      keyScheme: provider.apiKey ? provider.apiKey.scheme : null,
      requiresKey: kind.requiresKey,
    };
  }

  /**
   * Main-process only: the JSON-safe provider definition plus its decrypted
   * key, returned apart so the definition can be logged or reused safely.
   */
  providerWithSecret(id) {
    const stored = this.data.providers.find((row) => row.id === id);
    if (!stored) return null;
    return {
      provider: this.publicProvider(stored),
      apiKey: stored.apiKey ? this.secretBox.open(stored.apiKey) : '',
      id: stored.id,
    };
  }

  activeProviderWithSecret() {
    const id = this.data.activeProviderId || (this.data.providers[0] && this.data.providers[0].id);
    if (!id) return null;
    return this.providerWithSecret(id);
  }

  listProviders() {
    return this.data.providers.map((provider) => ({
      ...this.publicProvider(provider),
      active: provider.id === this.data.activeProviderId,
    }));
  }

  addProvider(input) {
    if (this.data.providers.length >= MAX_PROVIDERS) {
      return { ok: false, errors: [`Provider limit reached (${MAX_PROVIDERS}).`] };
    }
    const { ok, errors, provider } = validateProvider(input);
    if (!ok) return { ok: false, errors };

    const duplicate = this.data.providers.find(
      (row) => row.name.toLowerCase() === provider.name.toLowerCase(),
    );
    if (duplicate) return { ok: false, errors: [`A provider named "${provider.name}" already exists.`] };

    const record = { id: newId(), ...provider, apiKey: this.secretBox.seal(input.apiKey || '') };
    this.data.providers.push(record);
    if (!this.data.activeProviderId) this.data.activeProviderId = record.id;
    this.save();
    return { ok: true, errors: [], provider: this.publicProvider(record) };
  }

  updateProvider(id, patch) {
    const index = this.data.providers.findIndex((row) => row.id === id);
    if (index === -1) return { ok: false, errors: ['Provider not found.'] };

    const current = this.data.providers[index];
    const merged = {
      ...current,
      ...patch,
      kind: patch.kind || current.kind,
      name: patch.name !== undefined ? patch.name : current.name,
      baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : current.baseUrl,
      extraHeaders: patch.extraHeaders !== undefined ? patch.extraHeaders : current.extraHeaders || {},
    };

    const { ok, errors, provider } = validateProvider(merged);
    if (!ok) return { ok: false, errors };

    this.data.providers[index] = {
      ...provider,
      id,
      apiKey:
        patch.apiKey === undefined || patch.apiKey === null
          ? current.apiKey
          : this.secretBox.seal(patch.apiKey),
    };
    this.save();
    return { ok: true, errors: [], provider: this.publicProvider(this.data.providers[index]) };
  }

  removeProvider(id) {
    const before = this.data.providers.length;
    this.data.providers = this.data.providers.filter((row) => row.id !== id);
    if (this.data.providers.length === before) return { ok: false, errors: ['Provider not found.'] };
    if (this.data.activeProviderId === id) {
      this.data.activeProviderId = this.data.providers[0] ? this.data.providers[0].id : null;
    }
    this.save();
    return { ok: true, errors: [] };
  }

  setActiveProvider(id) {
    if (!this.data.providers.some((row) => row.id === id)) {
      return { ok: false, errors: ['Provider not found.'] };
    }
    this.data.activeProviderId = id;
    this.save();
    return { ok: true, errors: [] };
  }

  setWorkspace(dir) {
    this.data.workspace = dir ? path.resolve(dir) : null;
    this.save();
    return { ok: true, errors: [], workspace: this.data.workspace };
  }

  setUi(patch) {
    this.data.ui = { ...this.data.ui, ...(patch || {}) };
    this.save();
    return this.data.ui;
  }

  snapshot() {
    return {
      version: this.data.version,
      activeProviderId: this.data.activeProviderId,
      workspace: this.data.workspace,
      ui: this.data.ui,
      providers: this.listProviders(),
      keyStorage: this.secretBox ? this.secretBox.scheme : 'plain',
      keyStorageSecure: Boolean(this.secretBox && this.secretBox.available),
      settingsPath: this.file,
    };
  }
}

module.exports = { SettingsStore, defaults, SETTINGS_VERSION, MAX_PROVIDERS };
