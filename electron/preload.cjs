const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, func) => {
      ipcRenderer.on(channel, (_event, ...args) => func(...args));
    },
    once: (channel, func) => {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  },
});
