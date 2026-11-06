'use strict';

/**
 * electron/preload.js — minimal safe IPC bridge.
 *
 * contextIsolation stays on and Node stays off in the renderer; the UI can
 * only use the explicit invoke/on surface below. No raw ipcRenderer access.
 */

const { contextBridge, ipcRenderer } = require('electron');

const RECEIVE_CHANNELS = Object.freeze([
  'xorview:transcript',
  'xorview:context',
  'xorview:suggestion',
  'xorview:listening-change',
  'xorview:open-settings',
  'xorview:hotkey-error'
]);

contextBridge.exposeInMainWorld('xorview', {
  getSettings: () => ipcRenderer.invoke('xorview:settings-get'),
  saveSettings: (settings) => ipcRenderer.invoke('xorview:settings-set', settings),
  testConnection: (slot) => ipcRenderer.invoke('xorview:test-connection', slot),
  transcribeAudio: (payload) => ipcRenderer.invoke('xorview:transcribe-audio', payload),
  suggest: (payload) => ipcRenderer.invoke('xorview:suggest', payload),
  captureNow: () => ipcRenderer.invoke('xorview:capture-now'),
  setListening: (on) => ipcRenderer.invoke('xorview:set-listening', on),
  setClickThrough: (on) => ipcRenderer.invoke('xorview:set-click-through', on),
  toggle: () => ipcRenderer.invoke('xorview:toggle'),
  on: (channel, callback) => {
    if (!RECEIVE_CHANNELS.includes(channel) || typeof callback !== 'function') {
      return () => {};
    }
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
