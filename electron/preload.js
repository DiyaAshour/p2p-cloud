import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
});
