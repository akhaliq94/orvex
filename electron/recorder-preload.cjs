'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = new Set(['orvex:rec-chunk', 'orvex:rec-error', 'orvex:rec-done']);

contextBridge.exposeInMainWorld('recorderIpc', {
  send(channel, payload) {
    if (ALLOWED.has(channel)) ipcRenderer.send(channel, payload);
  },
});
