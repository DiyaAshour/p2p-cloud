const { contextBridge, ipcRenderer } = require('electron');
const { IPC_CHANNELS, isAllowedIpcChannel, isRetryableIpcChannel } = require('./ipc-contract.cjs');

console.log('[preload] LOADED');

const allowedChannels = new Set(IPC_CHANNELS);

function assertAllowedChannel(channel) {
  if (!isAllowedIpcChannel(channel)) {
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
  const retryable = isRetryableIpcChannel(channel);
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
  allowedChannels: Array.from(allowedChannels),
});

contextBridge.exposeInMainWorld('__P2P_PRELOAD_LOADED__', true);
