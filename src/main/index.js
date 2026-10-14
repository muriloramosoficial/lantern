'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore } = require('./settings');
const { createSecretBox } = require('./secrets');
const providers = require('./providers');
const workspace = require('./workspace');

// `npm run smoke` boots the app hidden against a throwaway profile, so it can
// never read or write the real settings, keys or tasks.
const SMOKE_MODE = process.argv.includes('--smoke');
if (SMOKE_MODE) {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-smoke-')));
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are Lantern, a focused coding assistant running on the user\'s own machine.',
  'Answer in the language the user writes in.',
  'Be concrete: show the exact change, command or snippet that solves the problem.',
  'When workspace files are attached, rely on them instead of guessing.',
].join(' ');

let mainWindow = null;
let store = null;
const activeRequests = new Map();

function logLine(message) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${message}\n`;
    fs.appendFileSync(path.join(dir, 'lantern.log'), line, 'utf8');
  } catch {
    // Logging must never break the app.
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#111318',
    title: 'Lantern',
    show: !SMOKE_MODE,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!SMOKE_MODE) mainWindow.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  if (SMOKE_MODE) {
    mainWindow.webContents.once('did-finish-load', () => {
      require('./smoke')
        .runSmoke({ mainWindow, store, app })
        .catch((error) => {
          console.error(error);
          app.exit(1);
        });
    });
  }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: 'Lantern',
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    settingsPath: store.file,
    userDataPath: app.getPath('userData'),
    keyStorage: store.snapshot().keyStorage,
    keyStorageSecure: store.snapshot().keyStorageSecure,
  }));

  ipcMain.handle('settings:get', () => store.snapshot());
  ipcMain.handle('settings:setUi', (_event, patch) => store.setUi(patch));

  ipcMain.handle('providers:kinds', () => Object.values(providers.KINDS));

  ipcMain.handle('providers:add', (_event, input) => store.addProvider(input || {}));
  ipcMain.handle('providers:update', (_event, { id, patch }) => store.updateProvider(id, patch || {}));
  ipcMain.handle('providers:remove', (_event, id) => store.removeProvider(id));
  ipcMain.handle('providers:activate', (_event, id) => store.setActiveProvider(id));

  ipcMain.handle('providers:test', async (_event, { id, draft }) => {
    if (draft) {
      const { ok, errors, provider } = providers.validateProvider(draft);
      if (!ok) return { ok: false, error: errors.join(' ') };
      return providers.testConnection({ provider, apiKey: draft.apiKey || '' });
    }
    const target = store.providerWithSecret(id);
    if (!target) return { ok: false, error: 'Provider not found.' };
    return providers.testConnection({ provider: target.provider, apiKey: target.apiKey });
  });

  ipcMain.handle('providers:models', async (_event, id) => {
    const target = store.providerWithSecret(id);
    if (!target) return { ok: false, error: 'Provider not found.' };
    try {
      const models = await providers.listModels({ provider: target.provider, apiKey: target.apiKey });
      return { ok: true, models };
    } catch (error) {
      return { ok: false, error: error.message, detail: error.body || '' };
    }
  });

  ipcMain.handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a workspace folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    store.setWorkspace(result.filePaths[0]);
    return { ok: true, workspace: store.data.workspace };
  });

  ipcMain.handle('workspace:list', () => {
    if (!store.data.workspace) return { ok: false, error: 'No workspace selected.' };
    try {
      return { ok: true, tree: workspace.listTree(store.data.workspace) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('workspace:read', (_event, relPath) => {
    if (!store.data.workspace) return { ok: false, error: 'No workspace selected.' };
    try {
      return { ok: true, file: workspace.readTextFile(store.data.workspace, relPath) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('chat:send', async (event, payload) => {
    const { providerId, messages = [], attachments = [], systemPrompt = '' } = payload || {};
    const target = providerId ? store.providerWithSecret(providerId) : store.activeProviderWithSecret();
    if (!target) {
      return { ok: false, error: 'No provider configured yet. Open Settings and add one.' };
    }
    if (!Array.isArray(messages) || !messages.length) {
      return { ok: false, error: 'Nothing to send.' };
    }

    const controller = new AbortController();
    activeRequests.set(event.sender.id, controller);
    const started = Date.now();

    let context = { files: [], notes: [], chars: 0 };
    if (attachments.length) {
      if (!store.data.workspace) {
        context = { files: [], notes: ['No workspace selected, attachments ignored.'], chars: 0 };
      } else {
        try {
          context = workspace.buildContext(store.data.workspace, attachments);
        } catch (error) {
          logLine(`context error: ${error.message}`);
        }
      }
    }

    const composedSystem = [systemPrompt || DEFAULT_SYSTEM_PROMPT, workspace.formatContextBlock(context)]
      .filter(Boolean)
      .join('\n\n');

    try {
      const result = await providers.chat({
        provider: target.provider,
        apiKey: target.apiKey,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        systemPrompt: composedSystem,
        signal: controller.signal,
        onDelta: (text) => {
          if (!event.sender.isDestroyed()) event.sender.send('chat:delta', { text });
        },
      });

      logLine(`chat ok provider=${target.provider.name} chars=${result.text.length} ms=${Date.now() - started}`);
      return {
        ok: true,
        text: result.text,
        usage: result.usage,
        ms: Date.now() - started,
        provider: target.provider.name,
        attached: context.files.map((file) => file.path),
        contextNotes: context.notes,
      };
    } catch (error) {
      if (error.name === 'AbortError') return { ok: false, aborted: true, error: 'Stopped by user.' };
      logLine(`chat failed provider=${target.provider.name} error=${error.message}`);
      return { ok: false, error: error.message, status: error.status || 0, detail: error.body || '' };
    } finally {
      activeRequests.delete(event.sender.id);
    }
  });

  ipcMain.handle('chat:abort', (event) => {
    const controller = activeRequests.get(event.sender.id);
    if (!controller) return { ok: false, error: 'Nothing running.' };
    controller.abort();
    return { ok: true };
  });
}

app.setName('Lantern');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const secretBox = createSecretBox({ safeStorage });
    store = new SettingsStore({ dir: app.getPath('userData'), secretBox });
    store.load();
    logLine(`start version=${app.getVersion()} keyStorage=${secretBox.scheme}`);

    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

process.on('uncaughtException', (error) => {
  logLine(`uncaught: ${error.stack || error.message}`);
});
