const { contextBridge, ipcRenderer } = require('electron');

console.log('[preload] LOADED');

const allowedChannels = new Set([
  'p2p:start',
  'p2p:listFiles',
  'p2p:upload',
  'p2p:uploadFiles',
  'p2p:uploadPath',
  'p2p:download',
  'p2p:downloadToPath',
  'p2p:delete',
  'p2p:networkSummary',
  'p2p:bootstrapNow',
  'p2p:connectPeer',
  'p2p:repair',
  'p2p:prepareProof',
  'p2p:pauseTransfer',
  'p2p:resumeTransfer',
  'p2p:cancelTransfer',
  'wallet:status',
  'wallet:connect',
  'wallet:disconnect',
  'wallet:setPlan',
  'electron:openDevTools',
  'electron:diagnostics',
  'system:open-external',
  'system:pickFiles',
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

contextBridge.exposeInMainWorld('__P2P_PRELOAD_LOADED__', true);
