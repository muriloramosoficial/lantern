'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore } = require('../src/main/settings');
const { createMemorySecretBox } = require('../src/main/secrets');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-test-'));
  const secretBox = createMemorySecretBox();
  const store = new SettingsStore({ dir, secretBox });
  store.load();
  return { store, dir, secretBox };
}

const validProvider = (overrides = {}) => ({
  name: 'Gateway',
  kind: 'openai-compatible',
  baseUrl: 'https://gateway.example.com/v1',
  model: 'big-model',
  apiKey: 'sk-secret-value',
  ...overrides,
});

test('a new install starts with zero providers', () => {
  const { store } = freshStore();
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.providers, []);
  assert.equal(snapshot.activeProviderId, null);
  assert.equal(snapshot.workspace, null);
});

test('adding a provider never exposes the key to the renderer', () => {
  const { store } = freshStore();
  const result = store.addProvider(validProvider());
  assert.equal(result.ok, true);
  assert.equal(result.provider.hasKey, true);
  assert.equal(result.provider.apiKey, undefined);

  const snapshot = store.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('sk-secret-value'), 'snapshot must not contain the raw key');

  const stored = store.activeProviderWithSecret();
  assert.equal(stored.apiKey, 'sk-secret-value');
  assert.equal(stored.provider.apiKey, undefined);
});

test('duplicate names and invalid input are rejected', () => {
  const { store } = freshStore();
  assert.equal(store.addProvider(validProvider()).ok, true);

  const duplicate = store.addProvider(validProvider({ baseUrl: 'https://other.example.com/v1' }));
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join(' '), /already exists/i);

  const invalid = store.addProvider({ name: '', baseUrl: 'nope', model: '' });
  assert.equal(invalid.ok, false);
  assert.equal(store.snapshot().providers.length, 1);
});

test('the first provider becomes active and activation can move', () => {
  const { store } = freshStore();
  const first = store.addProvider(validProvider({ name: 'One' })).provider;
  const second = store.addProvider(validProvider({ name: 'Two' })).provider;

  assert.equal(store.snapshot().activeProviderId, first.id);
  assert.equal(store.setActiveProvider(second.id).ok, true);
  assert.equal(store.snapshot().activeProviderId, second.id);
  assert.equal(store.setActiveProvider('missing-id').ok, false);
});

test('updating without a key keeps the stored secret', () => {
  const { store } = freshStore();
  const created = store.addProvider(validProvider()).provider;

  const updated = store.updateProvider(created.id, { model: 'smaller-model', apiKey: undefined });
  assert.equal(updated.ok, true);
  assert.equal(updated.provider.model, 'smaller-model');
  assert.equal(store.activeProviderWithSecret().apiKey, 'sk-secret-value');

  const rotated = store.updateProvider(created.id, { apiKey: 'sk-rotated' });
  assert.equal(rotated.ok, true);
  assert.equal(store.activeProviderWithSecret().apiKey, 'sk-rotated');
});

test('removing the active provider promotes another one', () => {
  const { store } = freshStore();
  const first = store.addProvider(validProvider({ name: 'One' })).provider;
  const second = store.addProvider(validProvider({ name: 'Two' })).provider;

  store.setActiveProvider(second.id);
  assert.equal(store.removeProvider(second.id).ok, true);
  assert.equal(store.snapshot().activeProviderId, first.id);
  assert.equal(store.removeProvider('nope').ok, false);
});

test('settings survive a restart and are written atomically', () => {
  const { store, dir, secretBox } = freshStore();
  const created = store.addProvider(validProvider()).provider;
  store.setWorkspace(dir);
  store.setUi({ theme: 'light' });

  const reloaded = new SettingsStore({ dir, secretBox });
  reloaded.load();

  const snapshot = reloaded.snapshot();
  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.providers[0].id, created.id);
  assert.equal(snapshot.workspace, path.resolve(dir));
  assert.equal(snapshot.ui.theme, 'light');
  assert.equal(reloaded.activeProviderWithSecret().apiKey, 'sk-secret-value');

  const leftovers = fs.readdirSync(dir).filter((file) => file.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a corrupted settings file falls back to defaults instead of crashing', () => {
  const { store, dir } = freshStore();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json', 'utf8');

  const reloaded = new SettingsStore({ dir, secretBox: createMemorySecretBox() });
  reloaded.load();
  assert.deepEqual(reloaded.snapshot().providers, []);
});

test('the store reports how keys are protected locally', () => {
  const { store, dir, secretBox } = freshStore();
  const snapshot = store.snapshot();
  assert.equal(snapshot.keyStorage, 'plain');
  assert.equal(snapshot.keyStorageSecure, secretBox.available);
  assert.equal(snapshot.settingsPath, path.join(dir, 'settings.json'));
});
