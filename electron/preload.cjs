const { contextBridge, ipcRenderer } = require('electron');

console.log('[preload] LOADED');

contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  isElectron: true,
});
