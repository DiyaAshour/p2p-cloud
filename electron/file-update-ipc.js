import { ipcMain } from 'electron';
import crypto from 'node:crypto';
import { pushWalletManifest } from './manifest-sync.js';
import { FOLDER_MANIFEST_KIND } from './core/config.js';
import { activeIdentity, assertVerifiedIdentity, normalizeIdentity } from './core/identity.js';
import { readWallet, readManifests, writeManifests } from './core/storage-json.js';

function node() {
  return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null;
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function safeId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function folderIdFromName(name = '', ownerWallet = '') {
  const base = safeId(name);
  if (base) return base;
  return crypto.createHash('sha256').update(`${ownerWallet}:${name}`).digest('hex').slice(0, 32);
}

function isFolderManifest(item = {}) {
  return (
    item.kind === FOLDER_MANIFEST_KIND ||
    item.kind === 'folder' ||
    item.type === 'folder' ||
    item.isFolder === true ||
    String(item.hash || '').startsWith('folder:')
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

function manifestIds(item = {}) {
  return unique([
    item.id,
    item.itemId,
    item.fileId,
    item.hash,
    item.rootHash,
    item.name,
  ].map((value) => String(value || '').trim()));
}

function findFileManifest(manifests = [], payload = {}, ownerWallet = '') {
  const wanted = new Set(
    [payload.hash, payload.rootHash, payload.id, payload.itemId, payload.fileId]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  if (!wanted.size) throw new Error('File hash or id is required');

  return manifests.find((item) =>
    !isFolderManifest(item) &&
    !isDeleteTombstone(item) &&
    ownerMatches(item, ownerWallet) &&
    manifestIds(item).some((id) => wanted.has(id))
  ) || null;
}

function findFolderById(manifests = [], folderId = '', ownerWallet = '') {
  const clean = String(folderId || '').replace(/^folder:/, '').trim();
  if (!clean) return null;
  return manifests.find((item) => {
    if (!isFolderManifest(item) || !ownerMatches(item, ownerWallet)) return false;
    return [item.folderId, item.id, item.hash, item.rootHash]
      .map((value) => String(value || '').replace(/^folder:/, '').trim())
      .includes(clean);
  }) || null;
}

function findFolderByName(manifests = [], name = '', ownerWallet = '') {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return null;
  return manifests.find((item) =>
    isFolderManifest(item) &&
    ownerMatches(item, ownerWallet) &&
    String(item.name || '').trim().toLowerCase() === clean
  ) || null;
}

function createFolderManifest(name = '', ownerWallet = '') {
  const folderName = String(name || '').trim();
  if (!folderName) throw new Error('Folder name is required');
  const folderId = folderIdFromName(folderName, ownerWallet);
  const now = new Date().toISOString();
  return {
    kind: FOLDER_MANIFEST_KIND,
    type: 'folder',
    id: `${ownerWallet}:folder:${folderId}`,
    hash: `folder:${folderId}`,
    rootHash: `folder:${folderId}`,
    folderId,
    name: folderName,
    parentFolderId: '',
    ownerWallet,
    ownerNodeId: node()?.peerId || 'desktop-client',
    createdAt: now,
    updatedAt: now,
    size: 0,
    storedSize: 0,
    totalChunks: 0,
    chunks: [],
    replicas: [],
    isEncrypted: false,
    visibility: 'private',
    isPublic: false,
    isFolder: true,
  };
}

async function syncPushSafe(manifest = {}) {
  try {
    await pushWalletManifest(manifest);
  } catch (error) {
    console.warn('[file-update] manifest sync push failed:', error?.message || error);
  }
}

async function updateFile(payload = {}) {
  const wallet = readWallet();
  assertVerifiedIdentity(wallet);
  const ownerWallet = activeIdentity(wallet);
  const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {};

  const current = readManifests();
  const file = findFileManifest(current, payload, ownerWallet);
  if (!file) throw new Error('File not found for this identity');

  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const nextName = String(patch.name || '').trim();
    if (!nextName) throw new Error('File name is required');
    file.name = nextName;
  }

  const wantsFolderId = Object.prototype.hasOwnProperty.call(patch, 'folderId');
  const wantsFolderName = Object.prototype.hasOwnProperty.call(patch, 'folderName') || Object.prototype.hasOwnProperty.call(patch, 'folder');

  if (wantsFolderId || wantsFolderName) {
    const requestedFolderId = String(patch.folderId || '').replace(/^folder:/, '').trim();
    const requestedFolderName = String(patch.folderName ?? patch.folder ?? '').trim();

    if (!requestedFolderId && !requestedFolderName) {
      file.folderId = '';
      file.parentFolderId = '';
      file.folderName = '';
      file.folder = '';
    } else {
      let folder = requestedFolderId ? findFolderById(current, requestedFolderId, ownerWallet) : null;
      if (!folder && requestedFolderName) folder = findFolderByName(current, requestedFolderName, ownerWallet);
      if (!folder && requestedFolderName) {
        folder = createFolderManifest(requestedFolderName, ownerWallet);
        current.push(folder);
        await syncPushSafe(folder);
      }
      if (!folder) throw new Error(`Target folder not found: ${requestedFolderId || requestedFolderName}`);

      file.folderId = folder.folderId || String(folder.hash || '').replace(/^folder:/, '');
      file.parentFolderId = file.folderId;
      file.folderName = folder.name || requestedFolderName;
      file.folder = file.folderName;
    }
  }

  file.updatedAt = new Date().toISOString();
  writeManifests(current);
  await syncPushSafe(file);

  return { ok: true, file };
}

try { ipcMain.removeHandler('p2p:updateFile'); } catch {}
ipcMain.handle('p2p:updateFile', async (_event, payload = {}) => updateFile(payload));

console.log('[file-update] p2p:updateFile IPC installed');
