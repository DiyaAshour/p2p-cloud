import { ipcMain } from 'electron';
import { getTransferProgress } from './transfer-progress-state.js';

let installed = false;

function install() {
  if (installed) return false;

  const oldHandler = ipcMain._invokeHandlers?.get?.('p2p:networkSummary');
  if (!oldHandler) return false;

  try { ipcMain.removeHandler('p2p:networkSummary'); } catch {}

  ipcMain.handle('p2p:networkSummary', async (event, payload = {}) => {
    const result = await oldHandler(event, payload);
    const shared = getTransferProgress();

    return {
      ...(result || {}),
      transferProgress: {
        ...(result?.transferProgress || {}),
        upload: shared.upload || result?.transferProgress?.upload || null,
        download: shared.download || result?.transferProgress?.download || null,
      },
    };
  });

  installed = true;
  console.log('[transfer-progress] networkSummary merge installed');
  return true;
}

install();
setTimeout(install, 1000);
setTimeout(install, 3000);
