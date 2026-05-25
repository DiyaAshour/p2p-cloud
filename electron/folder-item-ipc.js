import { ipcMain } from 'electron';
import { pushWalletManifest, deleteWalletManifest } from './manifest-sync.js';
import { FOLDER_MANIFEST_KIND } from './core/config.js';
import { activeIdentity, assertVerifiedIdentity, normalizeIdentity } from './core/identity.js';
import { readWallet, readManifests, writeManifests } from './core/storage-json.js';

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function cleanId(value = '') {
  return String(value || '').replace(/^folder:/, '').trim();
}

function normalizeName(value = '') {
  return String(value || '').trim();
}

function sanitizeName(value = '') {
  const name = normalizeName(value).replace(/[\\/:*?"<>|]/g, '_');
  if (!name) throw new Error('Name is required');
  return name;
}

function isFolderManifest(item = {}) {
  return (
    item.kind === FOLDER_MANIFEST_KIND ||
    item.kind === 'folder' ||
    item.type === 'folder' ||
    item.isFolder === true ||
    String(item.hash || '').startsWith('folder:') ||
    String(item.rootHash || '').startsWith('folder:') ||
    Boolean(item.folderId && !item.chunks?.length)
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
  const owner = normalizeIdentity(item.ownerWallet || item.owner || item.wallet || '');
  return !owner || owner === ownerWallet;
}

function manifestItemIds(item = {}) {
  const hash = String(item.hash || '').trim();
  const rootHash = String(item.rootHash || '').trim();
  return unique([
    item.itemId,
    item.id,
    item.fileId,
    item.folderId,
    hash,
    rootHash,
    hash.replace(/^folder:/, ''),
    rootHash.replace(/^folder:/, ''),
    item.name,
  ].map((value) => String(value || '').trim()));
}

function itemMatchesAnyId(item = {}, ids = new Set()) {
  const normalized = new Set(
    Array.from(ids || [])
      .flatMap((value) => [String(value || '').trim(), cleanId(value)])
      .filter(Boolean)
  );
  return manifestItemIds(item).some((id) => normalized.has(id) || normalized.has(cleanId(id)));
}

function itemLookupIds(payload = {}) {
  return unique([
    payload.itemId,
    payload.id,
    payload.hash,
    payload.rootHash,
    payload.folderId,
    payload.fileId,
    payload.folderPath,
    payload.name,
  ].map((value) => String(value || '').trim()));
}

function findOwnedItem(manifests = [], payload = {}, ownerWallet = '') {
  const ids = new Set(itemLookupIds(payload));
  if (!ids.size) return null;
  return manifests.find((item) =>
    !isDeleteTombstone(item) &&
    ownerMatches(item, ownerWallet) &&
    itemMatchesAnyId(item, ids)
  ) || null;
}

function fallbackFolderItem(payload = {}, ownerWallet = '') {
  const lookupId = String(
    payload.itemId ||
    payload.id ||
    payload.hash ||
    payload.rootHash ||
    payload.folderId ||
    payload.folderPath ||
    payload.name ||
    ''
  ).trim();

  const folderId = cleanId(lookupId);
  if (!folderId) return null;

  const name = String(payload.name || payload.folderName || payload.folderPath || folderId).trim();
  const now = new Date().toISOString();

  return ensureFolderShape({
    kind: FOLDER_MANIFEST_KIND,
    type: 'folder',
    isFolder: true,
    folderId,
    id: `${ownerWallet}:folder:${folderId}`,
    hash: `folder:${folderId}`,
    rootHash: `folder:${folderId}`,
    ownerWallet,
    name,
    parentFolderId: cleanId(payload.parentFolderId || ''),
    visibility: 'private',
    isPublic: false,
    isEncrypted: false,
    chunks: [],
    chunkSize: 0,
    totalChunks: 0,
    size: 0,
    storedSize: 0,
    createdAt: now,
    updatedAt: now,
    __fallbackFolder: true,
  });
}

function findOrFallbackOwnedItem(manifests = [], payload = {}, ownerWallet = '') {
  const item = findOwnedItem(manifests, payload, ownerWallet);
  if (item) return { item, isFallback: false };
  const fallback = fallbackFolderItem(payload, ownerWallet);
  return fallback ? { item: fallback, isFallback: true } : { item: null, isFallback: false };
}

function attachFallbackIfNeeded(manifests = [], item = {}, isFallback = false) {
  if (!isFallback || !item) return false;
  const ids = new Set(manifestItemIds(item));
  const exists = manifests.some((candidate) => itemMatchesAnyId(candidate, ids));
  if (!exists) {
    delete item.__fallbackFolder;
    manifests.push(item);
    return true;
  }
  return false;
}

function folderNameLower(item = {}) {
  return String(item.folderName || item.folder || '').trim().toLowerCase();
}

function ownNameLower(item = {}) {
  return String(item.name || '').trim().toLowerCase();
}

function parentFolderId(item = {}) {
  return cleanId(item.parentFolderId || item.folderId || '');
}

function findFolderByAny(manifests = [], folderId = '', ownerWallet = '') {
  const target = cleanId(folderId);
  if (!target) return null;
  return manifests.find((item) =>
    isFolderManifest(item) &&
    ownerMatches(item, ownerWallet) &&
    manifestItemIds(item).some((id) => cleanId(id) === target || id === target)
  ) || null;
}

function ensureFolderShape(folder = {}) {
  const folderId = cleanId(folder.folderId || folder.id || folder.hash || folder.rootHash || folder.name);
  return Object.assign(folder, {
    kind: FOLDER_MANIFEST_KIND,
    type: 'folder',
    isFolder: true,
    folderId,
    id: folder.id || `${folder.ownerWallet}:folder:${folderId}`,
    hash: folder.hash || `folder:${folderId}`,
    rootHash: folder.rootHash || `folder:${folderId}`,
    visibility: 'private',
    isPublic: false,
    isEncrypted: false,
    chunks: [],
    chunkSize: 0,
    totalChunks: 0,
    size: 0,
    storedSize: 0,
  });
}

function assertValidMoveTarget(item = {}, targetFolderId = '', manifests = [], ownerWallet = '') {
  const targetId = cleanId(targetFolderId);
  if (!targetId) return null;

  const targetFolder = findFolderByAny(manifests, targetId, ownerWallet);
  if (!targetFolder) throw new Error(`Target folder not found: ${targetId}`);

  if (!isFolderManifest(item)) return targetFolder;

  const sourceIds = new Set(manifestItemIds(item).map(cleanId).filter(Boolean));
  if (sourceIds.has(targetId)) throw new Error('Cannot move folder into itself');

  const folders = manifests.filter((candidate) => isFolderManifest(candidate) && ownerMatches(candidate, ownerWallet));
  let cursor = cleanId(targetFolder.parentFolderId || '');
  const seen = new Set();

  while (cursor) {
    if (sourceIds.has(cursor)) throw new Error('Cannot move folder inside its child');
    if (seen.has(cursor)) throw new Error('Folder tree cycle detected');
    seen.add(cursor);
    const parent = findFolderByAny(folders, cursor, ownerWallet);
    cursor = cleanId(parent?.parentFolderId || '');
  }

  return targetFolder;
}

async function syncPushSafe(manifest = {}) {
  try { await pushWalletManifest(manifest); }
  catch (error) { console.warn('[folder-item] manifest sync push failed:', error?.message || error); }
}

async function syncDeleteSafe(ownerWallet = '', hash = '') {
  try { await deleteWalletManifest(ownerWallet, hash); }
  catch (error) { console.warn('[folder-item] manifest sync delete failed:', error?.message || error); }
}

function loadContext() {
  const wallet = readWallet();
  assertVerifiedIdentity(wallet);
  return {
    wallet,
    ownerWallet: activeIdentity(wallet),
    manifests: readManifests(),
  };
}

async function renameItem(payload = {}) {
  const { ownerWallet, manifests } = loadContext();
  const { item, isFallback } = findOrFallbackOwnedItem(manifests, payload, ownerWallet);
  if (!item) throw new Error(`Item not found. payload=${JSON.stringify(payload)}`);
  attachFallbackIfNeeded(manifests, item, isFallback);

  const name = sanitizeName(payload.name);
  const oldNameLower = ownNameLower(item);
  item.name = name;
  item.updatedAt = new Date().toISOString();

  const changedFiles = [];
  if (isFolderManifest(item)) {
    ensureFolderShape(item);
    const folderId = cleanId(item.folderId || item.id || item.hash);
    for (const candidate of manifests) {
      if (isFolderManifest(candidate) || !ownerMatches(candidate, ownerWallet)) continue;
      const candidateParent = parentFolderId(candidate).toLowerCase();
      const candidateFolderName = folderNameLower(candidate);
      if ((folderId && cleanId(candidateParent) === folderId) || (oldNameLower && (candidateFolderName === oldNameLower || candidateParent === oldNameLower))) {
        candidate.folderId = folderId;
        candidate.parentFolderId = folderId;
        candidate.folderName = name;
        candidate.folder = name;
        candidate.updatedAt = new Date().toISOString();
        changedFiles.push(candidate);
      }
    }
  }

  writeManifests(manifests);
  await syncPushSafe(item);
  for (const file of changedFiles) await syncPushSafe(file);
  return { ok: true, item, renamedFiles: changedFiles.length };
}

async function moveItem(payload = {}) {
  const { ownerWallet, manifests } = loadContext();
  const { item, isFallback } = findOrFallbackOwnedItem(manifests, payload, ownerWallet);
  if (!item) throw new Error(`Item not found. payload=${JSON.stringify(payload)}`);
  attachFallbackIfNeeded(manifests, item, isFallback);

  const targetFolder = assertValidMoveTarget(item, payload.targetFolderId ?? payload.parentFolderId ?? payload.folderId ?? '', manifests, ownerWallet);
  const nextParentId = targetFolder ? cleanId(targetFolder.folderId || targetFolder.id || targetFolder.hash) : '';

  item.parentFolderId = nextParentId;
  if (!isFolderManifest(item)) {
    item.folderId = nextParentId;
    item.folderName = targetFolder?.name || '';
    item.folder = item.folderName;
  } else {
    ensureFolderShape(item);
  }

  item.updatedAt = new Date().toISOString();
  writeManifests(manifests);
  await syncPushSafe(item);
  return { ok: true, item };
}

async function deleteItem(payload = {}) {
  const { ownerWallet, manifests } = loadContext();
  const { item } = findOrFallbackOwnedItem(manifests, payload, ownerWallet);
  if (!item) throw new Error(`Item not found. payload=${JSON.stringify(payload)}`);

  if (!isFolderManifest(item)) {
    const removedIds = new Set(manifestItemIds(item));
    const beforeCount = manifests.length;
    const next = manifests.filter((candidate) => !itemMatchesAnyId(candidate, removedIds));
    writeManifests(next);
    await syncDeleteSafe(ownerWallet, item.hash || item.rootHash || item.folderId);
    return {
      ok: true,
      deleted: beforeCount - next.length,
      movedFiles: 0,
      deletedFiles: 1,
      removedIds: Array.from(removedIds),
    };
  }

  const rootIds = manifestItemIds(item);
  const removedFolderIds = new Set(rootIds.flatMap((id) => [id, cleanId(id)]).filter(Boolean));
  const removedFolderNames = new Set([ownNameLower(item)].filter(Boolean));

  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of manifests.filter((candidate) => isFolderManifest(candidate) && ownerMatches(candidate, ownerWallet))) {
      const folderIds = manifestItemIds(folder);
      const parent = parentFolderId(folder);
      const parentLower = parent.toLowerCase();
      if ((parent && removedFolderIds.has(parent)) || (parentLower && removedFolderNames.has(parentLower))) {
        for (const id of folderIds) {
          const clean = cleanId(id);
          if (id && !removedFolderIds.has(id)) { removedFolderIds.add(id); changed = true; }
          if (clean && !removedFolderIds.has(clean)) { removedFolderIds.add(clean); changed = true; }
        }
        const folderName = ownNameLower(folder);
        if (folderName && !removedFolderNames.has(folderName)) { removedFolderNames.add(folderName); changed = true; }
      }
    }
  }

  const foldersToRemove = [];
  const filesInside = [];

  for (const candidate of manifests) {
    if (!ownerMatches(candidate, ownerWallet)) continue;
    if (isFolderManifest(candidate)) {
      if (manifestItemIds(candidate).some((id) => removedFolderIds.has(id) || removedFolderIds.has(cleanId(id))) || removedFolderNames.has(ownNameLower(candidate))) {
        foldersToRemove.push(candidate);
      }
      continue;
    }
    const parent = parentFolderId(candidate);
    const parentLower = parent.toLowerCase();
    const candidateFolderName = folderNameLower(candidate);
    if ((parent && removedFolderIds.has(parent)) || (candidateFolderName && removedFolderNames.has(candidateFolderName)) || (parentLower && removedFolderNames.has(parentLower))) {
      filesInside.push(candidate);
    }
  }

  const disposition = String(payload.fileDisposition || 'move').trim().toLowerCase();
  const deleteFiles = disposition === 'delete';
  const targetFolder = deleteFiles ? null : assertValidMoveTarget(item, payload.targetFolderId ?? payload.parentFolderId ?? '', manifests, ownerWallet);

  if (targetFolder && manifestItemIds(targetFolder).some((id) => removedFolderIds.has(id) || removedFolderIds.has(cleanId(id)))) {
    throw new Error('Cannot move files into a folder that is being deleted');
  }

  const removedItems = deleteFiles ? [...foldersToRemove, ...filesInside] : foldersToRemove;
  const removedIds = new Set(removedItems.flatMap((removed) => manifestItemIds(removed)));
  const beforeCount = manifests.length;
  const next = manifests.filter((candidate) => !itemMatchesAnyId(candidate, removedIds));

  let movedFiles = 0;
  if (!deleteFiles) {
    const targetFolderId = targetFolder ? cleanId(targetFolder.folderId || targetFolder.id || targetFolder.hash) : '';
    const targetFolderName = targetFolder?.name || '';
    for (const file of filesInside) {
      file.parentFolderId = targetFolderId;
      file.folderId = targetFolderId;
      file.folderName = targetFolderName;
      file.folder = targetFolderName;
      file.updatedAt = new Date().toISOString();
      next.push(file);
      movedFiles += 1;
    }
  }

  writeManifests(next);
  for (const removed of removedItems) await syncDeleteSafe(ownerWallet, removed.hash || removed.rootHash || removed.folderId);
  if (!deleteFiles) for (const file of filesInside) await syncPushSafe(file);

  return {
    ok: true,
    deleted: beforeCount - next.length,
    movedFiles,
    deletedFiles: deleteFiles ? filesInside.length : 0,
    removedIds: Array.from(removedIds),
    targetFolderId: targetFolder ? cleanId(targetFolder.folderId || targetFolder.id || targetFolder.hash) : '',
  };
}

try { ipcMain.removeHandler('p2p:renameItem'); } catch {}
ipcMain.handle('p2p:renameItem', async (_event, payload = {}) => renameItem(payload));

try { ipcMain.removeHandler('p2p:moveItem'); } catch {}
ipcMain.handle('p2p:moveItem', async (_event, payload = {}) => moveItem(payload));

try { ipcMain.removeHandler('p2p:deleteItem'); } catch {}
ipcMain.handle('p2p:deleteItem', async (_event, payload = {}) => deleteItem(payload));

console.log('[folder-item] rename/move/delete item IPC installed with fallback lookup');
