import { ipcMain } from 'electron';
import { pushWalletManifest } from './manifest-sync.js';
import { FOLDER_MANIFEST_KIND, UI_PREFS_MANIFEST_KIND } from './core/config.js';
import { activeIdentity, normalizeIdentity } from './core/identity.js';
import { readWallet, readManifests, writeManifests } from './core/storage-json.js';

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

function cleanId(value = '') {
  return String(value || '').replace(/^folder:/, '').trim();
}

function folderIds(folder = {}) {
  return [
    folder.folderId,
    folder.id,
    folder.hash,
    folder.rootHash,
    cleanId(folder.id),
    cleanId(folder.hash),
    cleanId(folder.rootHash),
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

async function syncPushSafe(manifest = {}) {
  try {
    await pushWalletManifest(manifest);
  } catch (error) {
    console.warn('[list-files-normalize] manifest sync push failed:', error?.message || error);
  }
}

async function normalizeStoredFolderLabels() {
  const wallet = readWallet();
  if (!wallet?.connected || !wallet?.verified) return { changed: 0, files: [] };
  const ownerWallet = activeIdentity(wallet);
  if (!ownerWallet) return { changed: 0, files: [] };

  const manifests = readManifests();
  const folders = manifests.filter((item) => isFolderManifest(item) && ownerMatches(item, ownerWallet));
  const files = manifests.filter((item) =>
    ownerMatches(item, ownerWallet) &&
    !isFolderManifest(item) &&
    !isUiPrefsManifest(item) &&
    !isDeleteTombstone(item)
  );

  const folderById = new Map();
  const folderByName = new Map();

  for (const folder of folders) {
    const name = String(folder.name || '').trim();
    if (name) folderByName.set(name.toLowerCase(), folder);
    for (const id of folderIds(folder)) folderById.set(id, folder);
  }

  const changed = [];
  for (const file of files) {
    const rawId = cleanId(file.parentFolderId || file.folderId || '');
    const rawName = String(file.folderName || file.folder || '').trim();
    const folder =
      (rawId && (folderById.get(rawId) || folderById.get(`folder:${rawId}`))) ||
      (rawName && folderByName.get(rawName.toLowerCase())) ||
      null;

    const nextFolderId = folder ? cleanId(folder.folderId || folder.id || folder.hash || folder.rootHash || '') : '';
    const nextFolderName = folder ? String(folder.name || '') : '';

    if (
      String(file.folderId || '') !== nextFolderId ||
      String(file.parentFolderId || '') !== nextFolderId ||
      String(file.folderName || '') !== nextFolderName ||
      String(file.folder || '') !== nextFolderName
    ) {
      file.folderId = nextFolderId;
      file.parentFolderId = nextFolderId;
      file.folderName = nextFolderName;
      file.folder = nextFolderName;
      file.updatedAt = new Date().toISOString();
      changed.push(file);
    }
  }

  if (changed.length) {
    writeManifests(manifests);
    for (const file of changed) await syncPushSafe(file);
    console.log('[list-files-normalize] normalized stale folder labels', changed.length);
  }

  return { changed: changed.length, files };
}

function installListFilesNormalizeWrapper() {
  const existing = ipcMain._invokeHandlers?.get?.('p2p:listFiles');
  if (!existing) {
    console.warn('[list-files-normalize] original p2p:listFiles handler not found; skipping wrapper');
    return;
  }

  try { ipcMain.removeHandler('p2p:listFiles'); } catch {}

  ipcMain.handle('p2p:listFiles', async (event, payload = {}) => {
    await normalizeStoredFolderLabels();
    const result = await existing(event, payload);
    if (!Array.isArray(result)) return result;

    const wallet = readWallet();
    const ownerWallet = activeIdentity(wallet);
    const manifests = readManifests();
    const folders = manifests.filter((item) => isFolderManifest(item) && ownerMatches(item, ownerWallet));
    const folderById = new Map();
    const folderByName = new Map();

    for (const folder of folders) {
      const name = String(folder.name || '').trim();
      if (name) folderByName.set(name.toLowerCase(), folder);
      for (const id of folderIds(folder)) folderById.set(id, folder);
    }

    return result
      .filter((file) => !isFolderManifest(file) && !isUiPrefsManifest(file) && !isDeleteTombstone(file))
      .map((file) => {
        const rawId = cleanId(file.parentFolderId || file.folderId || '');
        const rawName = String(file.folderName || file.folder || '').trim();
        const folder =
          (rawId && (folderById.get(rawId) || folderById.get(`folder:${rawId}`))) ||
          (rawName && folderByName.get(rawName.toLowerCase())) ||
          null;
        if (!folder) return file;
        const folderId = cleanId(folder.folderId || folder.id || folder.hash || folder.rootHash || '');
        const folderName = String(folder.name || '');
        return { ...file, folderId, parentFolderId: folderId, folderName, folder: folderName };
      });
  });

  console.log('[list-files-normalize] p2p:listFiles folder normalization wrapper installed');
}

installListFilesNormalizeWrapper();
