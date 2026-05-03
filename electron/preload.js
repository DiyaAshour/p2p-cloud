import { contextBridge, ipcRenderer } from 'electron';

const allowedChannels = new Set([
  'p2p:start',
  'p2p:listFiles',
  'p2p:upload',
  'p2p:download',
  'p2p:delete',
  'p2p:networkSummary',
  'p2p:bootstrapNow',
  'p2p:connectPeer',
  'p2p:repair',
  'p2p:prepareProof',
]);

function assertAllowedChannel(channel) {
  if (!allowedChannels.has(channel)) {
    throw new Error(`Blocked unsafe IPC channel: ${channel}`);
  }
}

contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, payload) => {
    assertAllowedChannel(channel);
    return ipcRenderer.invoke(channel, payload);
  },
  isElectron: true,
  platform: process.platform,
});
