import { contextBridge, ipcRenderer } from 'electron';

console.log('[preload.js] loaded');

const allowedChannels = new Set([
  'p2p:start',
  'p2p:listFiles',
  'drive:getFolders',
  'drive:saveFolders',
  'p2p:upload',
  'p2p:download',
  'p2p:uploadFiles',
  'p2p:uploadPath',
  'p2p:downloadToPath',
  'p2p:updateFile',
  'p2p:delete',
  'p2p:networkSummary',
  'p2p:bootstrapNow',
  'p2p:connectPeer',
  'p2p:repair',
  'p2p:protectionRetryNow',
  'p2p:prepareProof',
  'p2p:cancelTransfer',
  'wallet:status',
  'wallet:connect',
  'wallet:disconnect',
  'wallet:setPlan',
  'seed:create',
  'seed:login',
  'seed:recover',
  'company:state',
  'company:deviceIdentity',
  'company:createWorkspace',
  'company:deleteWorkspace',
  'company:inviteMember',
  'company:createJoinRequest',
  'company:approveJoinRequest',
  'company:exportWorkspaceAccess',
  'company:importWorkspaceAccess',
  'company:publishObject',
  'company:readObject',
  'company:tokenFromObject',
  'company:changeMemberRole',
  'company:removeMember',
  'company:addFile',
  'company:updateFile',
  'electron:openDevTools',
  'electron:diagnostics',
  'system:open-external',
]);

function assertAllowedChannel(channel) {
  if (!allowedChannels.has(channel)) {
    throw new Error(`Blocked unsafe IPC channel: ${channel}`);
  }
}

const electronBridge = {
  invoke: (channel, payload) => {
    assertAllowedChannel(channel);
    return ipcRenderer.invoke(channel, payload);
  },
  isElectron: true,
  platform: process.platform,
};

contextBridge.exposeInMainWorld('__P2P_PRELOAD_LOADED__', true);
contextBridge.exposeInMainWorld('electron', electronBridge);
