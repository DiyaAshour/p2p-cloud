import { ipcMain } from 'electron';
import { applyIncomingTombstones } from './delete-tombstone-sync.js';

function installTombstoneAfterPull(channel) {
  const oldHandler = ipcMain._invokeHandlers?.get?.(channel);
  if (!oldHandler || oldHandler.__tombstoneAfterPullPatched) return false;

  try { ipcMain.removeHandler(channel); } catch {}

  const patched = async (event, payload = {}) => {
    const result = await oldHandler(event, payload);
    try {
      applyIncomingTombstones([]);
    } catch (error) {
      console.warn('[tombstone-sync-pull] apply after', channel, 'failed:', error?.message || error);
    }
    return result;
  };

  Object.defineProperty(patched, '__tombstoneAfterPullPatched', {
    value: true,
    enumerable: false,
    configurable: false,
  });

  ipcMain.handle(channel, patched);
  return true;
}

function install() {
  const patched = [
    installTombstoneAfterPull('p2p:listFiles'),
    installTombstoneAfterPull('p2p:networkSummary'),
  ].filter(Boolean).length;

  if (patched) console.log('[tombstone-sync-pull] installed after-pull tombstone application hooks', { patched });
}

install();
setTimeout(install, 1000);
setTimeout(install, 3000);
