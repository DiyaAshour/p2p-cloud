import { ipcMain } from 'electron';
import crypto from 'node:crypto';
import { pushWalletManifest, deleteWalletManifest } from './manifest-sync.js';
import { FOLDER_MANIFEST_KIND, UI_PREFS_MANIFEST_KIND } from './core/config.js';
import { activeIdentity, assertVerifiedIdentity, normalizeIdentity } from './core/identity.js';
import { readWallet, readManifests, writeManifests } from './core/storage-json.js';

function cleanId(value = '') {
  return String(value || '').replace(/^folder:/, '').trim();
}

function safeId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeFolderName(value = '') {
  const name = String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ');
  if (!name) throw new Error('Folder name is required');
  if (name.length > 80) throw new Error('Folder name is too long');
  if (['all files', 'uncategorized'].includes(name.toLowerCase())) throw new Error('Reserved folder name');
  return name;
}

function folderIdFromName(name = '', ownerWallet = '') {
  const base = safeId(name);
  const entropy = crypto.randomBytes(8).toString('hex');
  return crypto.createHash('sha256').update(`${ownerWallet}:folder:${base}:${Date.now()}:${entropy}`).digest('hex').slice(0, 32);
}

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

function loadContext() {
  const wallet = readWallet();
  assertVerifiedIdentity(wallet);
  const ownerWallet = activeIdentity(wallet);
  return { wallet, ownerWallet, manifests: readManifests() };
}

function walletFolders(manifests = [], ownerWallet = '') {
  return manifests
    .filter((item) => isFolderManifest(item) && ownerMatches(item, ownerWallet))
    .map(ensureFolderShape);
}

function walletFiles(manifests = [], ownerWallet = '') {
  return manifests.filter((item) =>
    ownerMatches(item, ownerWallet) &&
    !isFolderManifest(item) &&
    !isUiPrefsManifest(item) &&
    !isDeleteTombstone(item)
  );
}

function ensureFolderShape(folder = {}) {
  const folderId = cleanId(folder.folderId || folder.id || folder.hash || folder.rootHash || folder.name);
  Object.assign(folder, {
    kind: FOLDER_MANIFEST_KIND,
    type: 'folder',
    isFolder: true,
    folderId,
    id: folder.id || `${folder.ownerWallet}:folder:${folderId}`,
    hash: folder.hash || `folder:${folderId}`,
    rootHash: folder.rootHash || `folder:${folderId}`,
    parentFolderId: cleanId(folder.parentFolderId || ''),
    visibility: 'private',
    isPublic: false,
    isEncrypted: false,
    chunks: [],
    chunkSize: 0,
    totalChunks: 0,
    size: 0,
    storedSize: 0,
  });
  return folder;
}

function findFolderById(manifests = [], folderId = '', ownerWallet = '') {
  const target = cleanId(folderId);
  if (!target) return null;
  return walletFolders(manifests, ownerWallet).find((folder) => folderIds(folder).some((id) => cleanId(id) === target || id === target)) || null;
}

function findFolderByName(manifests = [], name = '', ownerWallet = '') {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return null;
  return walletFolders(manifests, ownerWallet).find((folder) => String(folder.name || '').trim().toLowerCase() === clean) || null;
}

function assertFolderNotDescendant(manifests = [], ownerWallet = '', folderId = '', parentFolderId = '') {
  const sourceId = cleanId(folderId);
  let cursor = cleanId(parentFolderId);
  const seen = new Set();

  while (cursor) {
    if (cursor === sourceId) throw new Error('Cannot move folder inside itself or its child');
    if (seen.has(cursor)) throw new Error('Folder tree cycle detected');
    seen.add(cursor);
    const parent = findFolderById(manifests, cursor, ownerWallet);
    cursor = cleanId(parent?.parentFolderId || '');
  }
}

function duplicateFolderAtLevel(manifests = [], ownerWallet = '', name = '', parentFolderId = '', exceptFolderId = '') {
  const cleanName = String(name || '').trim().toLowerCase();
  const cleanParent = cleanId(parentFolderId);
  const except = cleanId(exceptFolderId);
  return walletFolders(manifests, ownerWallet).some((folder) =>
    cleanId(folder.folderId || folder.id || folder.hash) !== except &&
    cleanId(folder.parentFolderId || '') === cleanParent &&
    String(folder.name || '').trim().toLowerCase() === cleanName
  );
}

function findFile(manifests = [], payload = {}, ownerWallet = '') {
  const wanted = [payload.hash, payload.rootHash, payload.id, payload.itemId, payload.fileId]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!wanted.length) return null;
  return walletFiles(manifests, ownerWallet).find((file) =>
    wanted.some((id) => [file.hash, file.rootHash, file.id, file.itemId, file.fileId].map((value) => String(value || '').trim()).includes(id))
  ) || null;
}

async function syncPushSafe(manifest = {}) {
  try { await pushWalletManifest(manifest); }
  catch (error) { console.warn('[folder-crud] manifest sync push failed:', error?.message || error); }
}

async function syncDeleteSafe(ownerWallet = '', hash = '') {
  try { await deleteWalletManifest(ownerWallet, hash); }
  catch (error) { console.warn('[folder-crud] manifest sync delete failed:', error?.message || error); }
}

async function listFolders() {
  const { ownerWallet, manifests } = loadContext();
  let changed = false;
  const folders = walletFolders(manifests, ownerWallet);
  for (const folder of folders) {
    const before = JSON.stringify(folder);
    ensureFolderShape(folder);
    if (JSON.stringify(folder) !== before) changed = true;
  }
  if (changed) writeManifests(manifests);
  return folders.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

async function createFolder(payload = {}) {
  const { ownerWallet, manifests } = loadContext();
  const name = sanitizeFolderName(payload.name);
  const parentFolderId = cleanId(payload.parentFolderId || payload.folderId || '');

  if (parentFolderId && !findFolderById(manifests, parentFolderId, ownerWallet)) {
    throw new Error('Parent folder not found');
  }
  if (duplicateFolderAtLevel(manifests, ownerWallet, name, parentFolderId)) {
    throw new Error('Folder already exists here');
  }

  const folderId = folderIdFromName(name, ownerWallet);
  const now = new Date().toISOString();
  const folder = ensureFolderShape({
    kind: FOLDER_MANIFEST_KIND,
    type: 'folder',
    id: `${ownerWallet}:folder:${folderId}`,
    hash: `folder:${folderId}`,
    rootHash: `folder:${folderId}`,
    folderId,
    name,
    parentFolderId,
    ownerWallet,
    ownerNodeId: globalThis.__p2pTransportNode?.peerId || globalThis.__p2pNode?.peerId || 'desktop-client',
    createdAt: now,
    updatedAt: now,
  });

  manifests.push(folder);
  writeManifests(manifests);
  await syncPushSafe(folder);
  return { ok: true, folder, folders: await listFolders() };
}

async function renameFolder(payload = {}) {
  const { ownerWallet, manifests } = loadContext();
  const name = sanitizeFolderName(payload.name);
  const folder = findFolderById(manifests, payload.folderId || payload.id || payload.hash, ownerWallet) || findFolderByName(manifests, payload.oldName || '', ownerWallet);
  if (!folder) throw new Error('Folder not found');
  ensureFolderShape(folder);

  if (duplicateFolderAtLevel(manifests, ownerWallet, name, folder.parentFolderId, folder.folderId)) {
    throw new Error('Folder already exists here');
  }

  const oldName = String(folder.name || '').trim();
  folder.name = name;
  folder.updatedAt = new Date().toISOString();

  const changedFiles = [];
  for (const file of walletFiles(manifests, ownerWallet)) {
    const parentId = cleanId(file.parentFolderId || file.folderId || '');
    const fileFolderName = String(file.folderName || file.folder || '').trim().toLowerCase();
    if ((parentId && parentId === folder.folderId) || (oldName && fileFolderName === oldName.toLowerCase())) {
      file.folderId = folder.folderId;
      file.parentFolderId = folder.folderId;
      file.folderName = name;
      file.folder = name;
      file.updatedAt = new Date().toISOString();
      changedFiles.push(file);
    }
  }

  writeManifests(manifests);
  await syncPushSafe(folder);
  for (const file of changedFiles) await syncPushSafe(file);
  return { ok: true, folder, folders: await listFolders(), renamedFiles: changedFiles.length };
}

async function moveFolder(payload = {}) {
  const { ownerWallet, manifests } = loadContext();
  const folder = findFolderById(manifests, payload.folderId || payload.id || payload.hash, ownerWallet) || findFolderByName(manifests, payload.name || '', ownerWallet);
  if (!folder) throw new Error('Folder not found');
  ensureFolderShape(folder);

  const parentFolderId = cleanId(payload.parentFolderId || payload.targetFolderId || '');
  if (parentFolderId && !findFolderById(manifests, parentFolderId, ownerWallet)) {
    throw new Error('Target folder not found');
  }
  assertFolderNotDescendant(manifests, ownerWallet, folder.folderId, parentFolderId);
  if (duplicateFolderAtLevel(manifests, ownerWallet, folder.name, parentFolderId, folder.folderId)) {
    throw new Error('Folder already exists here');
  }

  folder.parentFolderId = parentFolderId;
  folder.updatedAt = new Date().toISOString();
  writeManifests(manifests);
  await syncPushSafe(folder);
  return { ok: true, folder, folders: await listFolders() };
}

async function deleteFolder(payload = {}) {
  const { ownerWallet, manifests } = loadContext();
  const folder = findFolderById(manifests, payload.folderId || payload.id || payload.hash, ownerWallet) || findFolderByName(manifests, payload.name || '', ownerWallet);
  if (!folder) throw new Error('Folder not found');
  ensureFolderShape(folder);

  const removed = new Set([folder.folderId, ...folderIds(folder).map(cleanId).filter(Boolean)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const child of walletFolders(manifests, ownerWallet)) {
      const childId = cleanId(child.folderId || child.id || child.hash);
      const parentId = cleanId(child.parentFolderId || '');
      if (!removed.has(childId) && removed.has(parentId)) {
        removed.add(childId);
        for (const id of folderIds(child).map(cleanId).filter(Boolean)) removed.add(id);
        changed = true;
      }
    }
  }

  const deleteFiles = String(payload.fileDisposition || 'move').trim().toLowerCase() === 'delete';
  const targetFolder = deleteFiles ? null : findFolderById(manifests, payload.targetFolderId || payload.parentFolderId || '', ownerWallet);
  const targetFolderId = targetFolder ? cleanId(targetFolder.folderId || targetFolder.id || targetFolder.hash) : '';
  const targetFolderName = targetFolder?.name || '';

  const removedFolders = walletFolders(manifests, ownerWallet).filter((candidate) => removed.has(cleanId(candidate.folderId || candidate.id || candidate.hash)));
  const touchedFiles = [];
  const removedFileIds = new Set();

  for (const file of walletFiles(manifests, ownerWallet)) {
    const parentId = cleanId(file.parentFolderId || file.folderId || '');
    const folderName = String(file.folderName || file.folder || '').trim().toLowerCase();
    const folderRemovedByName = removedFolders.some((f) => String(f.name || '').trim().toLowerCase() === folderName);
    if (removed.has(parentId) || folderRemovedByName) {
      if (deleteFiles) {
        for (const id of [file.id, file.hash, file.rootHash, file.fileId, file.itemId].filter(Boolean)) removedFileIds.add(String(id));
      } else {
        file.parentFolderId = targetFolderId;
        file.folderId = targetFolderId;
        file.folderName = targetFolderName;
        file.folder = targetFolderName;
        file.updatedAt = new Date().toISOString();
        touchedFiles.push(file);
      }
    }
  }

  const removedFolderIds = new Set(removedFolders.flatMap((f) => folderIds(f)));
  const next = manifests.filter((candidate) => {
    if (!ownerMatches(candidate, ownerWallet)) return true;
    if (isFolderManifest(candidate) && folderIds(candidate).some((id) => removedFolderIds.has(id) || removedFolderIds.has(cleanId(id)))) return false;
    if (deleteFiles) {
      const ids = [candidate.id, candidate.hash, candidate.rootHash, candidate.fileId, candidate.itemId].map((id) => String(id || '')).filter(Boolean);
      if (ids.some((id) => removedFileIds.has(id))) return false;
    }
    return true;
  });

  writeManifests(next);
  for (const removedFolder of removedFolders) await syncDeleteSafe(ownerWallet, removedFolder.hash || removedFolder.rootHash || removedFolder.folderId);
  if (deleteFiles) for (const id of removedFileIds) await syncDeleteSafe(ownerWallet, id);
  else for (const file of touchedFiles) await syncPushSafe(file);

  return {
    ok: true,
    removed: removedFolders.length,
    movedFiles: deleteFiles ? 0 : touchedFiles.length,
    deletedFiles: deleteFiles ? removedFileIds.size : 0,
    folders: await listFolders(),
  };
}

async function moveFile(payload = {}) {
  const { ownerWallet, manifests } = loadContext();
  const file = findFile(manifests, payload, ownerWallet);
  if (!file) throw new Error('File not found for this identity');

  const folderId = cleanId(payload.folderId || payload.targetFolderId || payload.parentFolderId || '');
  const folder = folderId ? findFolderById(manifests, folderId, ownerWallet) : (payload.folderName ? findFolderByName(manifests, payload.folderName, ownerWallet) : null);
  if (folderId && !folder) throw new Error('Target folder not found');

  file.folderId = folder ? cleanId(folder.folderId || folder.id || folder.hash) : '';
  file.parentFolderId = file.folderId;
  file.folderName = folder?.name || '';
  file.folder = file.folderName;
  file.updatedAt = new Date().toISOString();

  writeManifests(manifests);
  await syncPushSafe(file);
  return { ok: true, file };
}

for (const channel of ['p2p:listFolders', 'p2p:createFolder', 'p2p:renameFolder', 'p2p:moveFolder', 'p2p:deleteFolder', 'p2p:moveFile']) {
  try { ipcMain.removeHandler(channel); } catch {}
}

ipcMain.handle('p2p:listFolders', async () => listFolders());
ipcMain.handle('p2p:createFolder', async (_event, payload = {}) => createFolder(payload));
ipcMain.handle('p2p:renameFolder', async (_event, payload = {}) => renameFolder(payload));
ipcMain.handle('p2p:moveFolder', async (_event, payload = {}) => moveFolder(payload));
ipcMain.handle('p2p:deleteFolder', async (_event, payload = {}) => deleteFolder(payload));
ipcMain.handle('p2p:moveFile', async (_event, payload = {}) => moveFile(payload));

console.log('[folder-crud] folder CRUD IPC installed');
