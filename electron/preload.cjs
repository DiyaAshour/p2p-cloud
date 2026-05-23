const { contextBridge, ipcRenderer } = require('electron');

console.log('[preload] LOADED');

const allowedChannels = new Set([
  'p2p:start',
  'p2p:listFiles',
  'p2p:listFolders',

  'drive:getFolders',
  'drive:saveFolders',

  'p2p:createFolder',
  'p2p:deleteFolder',
  'p2p:deleteItem',
  'p2p:renameItem',
  'p2p:moveItem',
  'p2p:moveFile',
  'p2p:renameFolder',
  'p2p:moveFolder',

  'p2p:uploadFiles',
  'p2p:uploadFolder',
  'p2p:uploadPath',

  'p2p:downloadToPath',

  'p2p:updateFile',
  'p2p:delete',

  'p2p:getUiPrefs',
  'p2p:setUiPrefs',

  'p2p:networkSummary',
  'p2p:bootstrapNow',
  'p2p:connectPeer',
  'p2p:repair',
  'p2p:protectionRetryNow',
  'p2p:pauseProtectionRetry',
  'p2p:resumeProtectionRetry',
  'p2p:protectionRetryStatus',
  'p2p:applyDeleteTombstones',
  'p2p:listTombstones',
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingHandler(error) {
  return String(error?.message || error || '').includes('No handler registered');
}

async function invokeWithRuntimeRetry(channel, payload) {
  assertAllowedChannel(channel);
  const retryable = channel.startsWith('p2p:') || channel.startsWith('wallet:') || channel.startsWith('seed:') || channel.startsWith('company:') || channel.startsWith('drive:');
  const attempts = retryable ? 30 : 1;
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await ipcRenderer.invoke(channel, payload);
    } catch (error) {
      lastError = error;
      if (!retryable || !isMissingHandler(error)) throw error;
      await sleep(250);
    }
  }
  throw lastError;
}

contextBridge.exposeInMainWorld('electron', {
  invoke: invokeWithRuntimeRetry,
  isElectron: true,
  platform: process.platform,
});

contextBridge.exposeInMainWorld('__P2P_PRELOAD_LOADED__', true);
