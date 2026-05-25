import { ipcMain } from 'electron';
import { FOLDER_MANIFEST_KIND, UI_PREFS_MANIFEST_KIND } from './core/config.js';
import { activeIdentity, normalizeIdentity } from './core/identity.js';
import { readWallet, readManifests } from './core/storage-json.js';

function isFolderManifest(item = {}) {
  return (
    item.kind === FOLDER_MANIFEST_KIND ||
    item.kind === 'folder' ||
    item.type === 'folder' ||
    item.isFolder === true ||
    String(item.hash || '').startsWith('folder:') ||
    String(item.rootHash || '').startsWith('folder:')
  );
}

function isUiPrefsManifest(item = {}) {
  return (
    item.kind === UI_PREFS_MANIFEST_KIND ||
    item.type === 'ui-prefs' ||
    String(item.hash || '').startsWith('ui:prefs:') ||
    String(item.rootHash || '').startsWith('ui:prefs:') ||
    String(item.id || '').startsWith('ui:prefs:')
  );
}

function isDeleteTombstone(item = {}) {
  return (
    item.type === 'delete-tombstone-v1' ||
    item.kind === 'delete-tombstone' ||
    item.isTombstone === true ||
    String(item.id || '').startsWith('tombstone:')
  );
}

function ownerMatches(item = {}, ownerWallet = '') {
  return normalizeIdentity(item.ownerWallet || item.owner || item.wallet || '') === ownerWallet;
}

function walletCounts() {
  const wallet = readWallet();
  const ownerWallet = activeIdentity(wallet);
  if (!wallet?.connected || !wallet?.verified || !ownerWallet) {
    return null;
  }

  const manifests = readManifests().filter((item) => ownerMatches(item, ownerWallet));
  const folders = manifests.filter(isFolderManifest);
  const files = manifests.filter((item) => !isFolderManifest(item) && !isUiPrefsManifest(item) && !isDeleteTombstone(item));

  return {
    files,
    folders,
    totalFiles: files.length,
    totalFolders: folders.length,
    encryptedFiles: files.filter((file) => file.isEncrypted).length,
    publicFiles: files.filter((file) => !file.isEncrypted).length,
    totalBytes: files.reduce((sum, file) => sum + Number(file.size || 0), 0),
    totalChunks: files.reduce((sum, file) => sum + Number(file.chunks?.length || file.totalChunks || 0), 0),
  };
}

function installNetworkSummaryNormalizeWrapper() {
  const existing = ipcMain._invokeHandlers?.get?.('p2p:networkSummary');
  if (!existing) {
    console.warn('[network-summary-normalize] original p2p:networkSummary handler not found; skipping wrapper');
    return;
  }

  try { ipcMain.removeHandler('p2p:networkSummary'); } catch {}

  ipcMain.handle('p2p:networkSummary', async (event, payload = {}) => {
    const summary = await existing(event, payload);
    if (!summary || typeof summary !== 'object') return summary;

    const counts = walletCounts();
    if (!counts) return summary;

    return {
      ...summary,
      totalFiles: counts.totalFiles,
      totalFolders: counts.totalFolders,
      encryptedFiles: counts.encryptedFiles,
      publicFiles: counts.publicFiles,
      totalBytes: counts.totalBytes,
      totalChunks: counts.totalChunks,
    };
  });

  console.log('[network-summary-normalize] p2p:networkSummary folder-safe wrapper installed');
}

installNetworkSummaryNormalizeWrapper();
