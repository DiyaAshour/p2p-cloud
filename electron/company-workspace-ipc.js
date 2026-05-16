import { app, ipcMain } from 'electron';
import path from 'node:path';
import { createCompanyWorkspaceStore } from './company-workspace-store.js';

let store = null;

function dataDir() {
  return path.join(app.getPath('userData'), 'native-p2p-storage');
}

function companyStore() {
  if (!store) store = createCompanyWorkspaceStore({ dataDir: dataDir() });
  return store;
}

function activeWalletAddress() {
  const handlers = ipcMain._invokeHandlers;
  const walletStatus = handlers?.get?.('wallet:status');
  return walletStatus ? walletStatus({}, {}).then((status) => status?.address || '') : Promise.resolve('');
}

function installCompanyWorkspaceIpc() {
  try { ipcMain.removeHandler('company:state'); } catch {}
  ipcMain.handle('company:state', async () => companyStore().state());

  try { ipcMain.removeHandler('company:deviceIdentity'); } catch {}
  ipcMain.handle('company:deviceIdentity', async (_event, payload = {}) => companyStore().getOrCreateIdentity(payload));

  try { ipcMain.removeHandler('company:createWorkspace'); } catch {}
  ipcMain.handle('company:createWorkspace', async (_event, payload = {}) => {
    const ownerWallet = payload.ownerWallet || await activeWalletAddress();
    return companyStore().createWorkspace({ ...payload, ownerWallet });
  });

  try { ipcMain.removeHandler('company:deleteWorkspace'); } catch {}
  ipcMain.handle('company:deleteWorkspace', async (_event, payload = {}) => companyStore().deleteWorkspace(payload));

  try { ipcMain.removeHandler('company:inviteMember'); } catch {}
  ipcMain.handle('company:inviteMember', async (_event, payload = {}) => companyStore().inviteMember(payload));

  try { ipcMain.removeHandler('company:changeMemberRole'); } catch {}
  ipcMain.handle('company:changeMemberRole', async (_event, payload = {}) => companyStore().changeMemberRole(payload));

  try { ipcMain.removeHandler('company:removeMember'); } catch {}
  ipcMain.handle('company:removeMember', async (_event, payload = {}) => companyStore().removeMember(payload));

  try { ipcMain.removeHandler('company:addFile'); } catch {}
  ipcMain.handle('company:addFile', async (_event, payload = {}) => companyStore().addFile(payload));

  try { ipcMain.removeHandler('company:updateFile'); } catch {}
  ipcMain.handle('company:updateFile', async (_event, payload = {}) => companyStore().updateFile(payload));

  console.log('[company] workspace IPC installed');
}

installCompanyWorkspaceIpc();
