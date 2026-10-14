'use strict';

/**
 * The only bridge between the renderer and the machine.
 * Nothing here exposes Node, the filesystem or the network directly: every
 * call goes through a named IPC channel handled in the main process.
 */

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();

ipcRenderer.on('chat:delta', (_event, payload) => {
  for (const listener of listeners) listener(payload);
});

contextBridge.exposeInMainWorld('lantern', {
  info: () => ipcRenderer.invoke('app:info'),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setUi: (patch) => ipcRenderer.invoke('settings:setUi', patch),
  },

  providers: {
    kinds: () => ipcRenderer.invoke('providers:kinds'),
    list: async () => (await ipcRenderer.invoke('settings:get')).providers,
    add: (input) => ipcRenderer.invoke('providers:add', input),
    update: (id, patch) => ipcRenderer.invoke('providers:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('providers:remove', id),
    activate: (id) => ipcRenderer.invoke('providers:activate', id),
    test: (payload) => ipcRenderer.invoke('providers:test', payload),
    models: (id) => ipcRenderer.invoke('providers:models', id),
  },

  workspace: {
    choose: () => ipcRenderer.invoke('workspace:choose'),
    list: () => ipcRenderer.invoke('workspace:list'),
    read: (relPath) => ipcRenderer.invoke('workspace:read', relPath),
  },

  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    abort: () => ipcRenderer.invoke('chat:abort'),
    onDelta: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
});
