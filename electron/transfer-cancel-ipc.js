import { ipcMain } from 'electron';
import { requestTransferCancel, getTransferProgress } from './transfer-progress-state.js';

try { ipcMain.removeHandler('p2p:cancelTransfer'); } catch {}

ipcMain.handle('p2p:cancelTransfer', async (_event, payload = {}) => {
  const type = String(payload.type || '').toLowerCase();
  if (type !== 'upload' && type !== 'download') {
    throw new Error('Invalid transfer type');
  }

  const progress = requestTransferCancel(type);
  return {
    ok: true,
    type,
    progress,
    transferProgress: getTransferProgress(),
  };
});

console.log('[transfer-cancel] installed p2p:cancelTransfer handler');
