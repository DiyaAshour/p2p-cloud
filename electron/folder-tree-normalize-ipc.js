import { ipcMain } from 'electron';
import { pushWalletManifest } from './manifest-sync.js';
import { FOLDER_MANIFEST_KIND } from './core/config.js';
import { activeIdentity, normalizeIdentity } from './core/identity.js';
import { readWallet, readManifests, writeManifests } from './core/storage-json.js';

function cleanId(value = '') {
  return String(value || '').replace(/^folder:/, '').trim();
}

function normName(value = '') {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\s+/g, ' ');
}

function splitPath(value = '') {
  return normName(value).split('/').map((part) => part.trim()).filter(Boolean);
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

function ownerMatches(item = {}, ownerWallet = '') {
  return normalizeIdentity(item.ownerWallet || item.owner || item.wallet || '') === ownerWallet;
}

function folderIdOf(folder = {}) {
  return cleanId(folder.folderId || folder.id || folder.hash || folder.rootHash || folder.name);
}

function aliasValues(folder = {}) {
  const folderId = folderIdOf(folder);
  return [
    folder.folderId,
    folder.id,
    folder.hash,
    folder.rootHash,
    folderId,
    folderId ? `folder:${folderId}` : '',
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function ensureFolderShape(folder = {}) {
  const folderId = folderIdOf(folder);
  folder.kind = FOLDER_MANIFEST_KIND;
  folder.type = 'folder';
  folder.isFolder = true;
  folder.folderId = folderId;
  folder.id = folder.id || `${folder.ownerWallet || ''}:folder:${folderId}`;
  folder.hash = folder.hash || `folder:${folderId}`;
  folder.rootHash = folder.rootHash || `folder:${folderId}`;
  folder.parentFolderId = cleanId(folder.parentFolderId || folder.parentId || '');
  folder.visibility = 'private';
  folder.isPublic = false;
  folder.isEncrypted = false;
  folder.chunks = [];
  folder.chunkSize = 0;
  folder.totalChunks = 0;
  folder.size = 0;
  folder.storedSize = 0;
  return folder;
}

function buildAliasMap(folders = []) {
  const map = new Map();
  for (const folder of folders) {
    const id = folderIdOf(folder);
    if (!id) continue;
    for (const alias of aliasValues(folder)) {
      map.set(alias, id);
      map.set(cleanId(alias), id);
    }
  }
  return map;
}

function folderPathFromParents(folder = {}, folderById = new Map()) {
  const names = [];
  const seen = new Set();
  let cursor = folder;
  while (cursor) {
    const id = folderIdOf(cursor);
    if (!id || seen.has(id)) break;
    seen.add(id);
    names.unshift(normName(cursor.name || id));
    const parentId = cleanId(cursor.parentFolderId || '');
    cursor = parentId ? folderById.get(parentId) : null;
  }
  return names.join(' / ');
}

function explicitPath(folder = {}) {
  const raw = folder.folderPath || folder.path || folder.fullPath || folder.relativePath || '';
  const parts = splitPath(raw);
  const name = normName(folder.name || '');
  if (!parts.length) return '';
  if (name && parts[parts.length - 1]?.toLowerCase() !== name.toLowerCase()) parts.push(name);
  return parts.join(' / ');
}

function normalizeFolderTreeInMemory(manifests = [], ownerWallet = '') {
  const folders = manifests
    .filter((item) => isFolderManifest(item) && ownerMatches(item, ownerWallet))
    .map(ensureFolderShape)
    .filter((folder) => folder.folderId);

  const aliasMap = buildAliasMap(folders);
  const folderById = new Map(folders.map((folder) => [folder.folderId, folder]));
  let changed = false;

  // Pass 1: canonicalize parent ids that arrived as hash/rootHash/folder:<id>.
  for (const folder of folders) {
    const before = JSON.stringify(folder);
    const rawParent = cleanId(folder.parentFolderId || folder.parentId || '');
    const canonicalParent = rawParent ? (aliasMap.get(rawParent) || aliasMap.get(`folder:${rawParent}`) || rawParent) : '';

    if (canonicalParent && !folderById.has(canonicalParent)) {
      // Unknown parent: keep blank instead of showing under a broken phantom id.
      folder.parentFolderId = '';
      folder.parentMissing = rawParent;
    } else {
      folder.parentFolderId = canonicalParent;
      if (folder.parentMissing) delete folder.parentMissing;
    }

    if (!folder.path) folder.path = explicitPath(folder) || folderPathFromParents(folder, folderById);
    if (!folder.folderPath) folder.folderPath = folder.path;
    if (JSON.stringify(folder) !== before) changed = true;
  }

  // Pass 2: infer missing parent from explicit path if present.
  const byPath = new Map();
  for (const folder of folders) {
    const path = explicitPath(folder) || folderPathFromParents(folder, folderById);
    if (path) byPath.set(path.toLowerCase(), folder.folderId);
  }

  for (const folder of folders) {
    if (folder.parentFolderId) continue;
    const path = explicitPath(folder);
    const parts = splitPath(path);
    if (parts.length <= 1) continue;
    const parentPath = parts.slice(0, -1).join(' / ').toLowerCase();
    const parentId = byPath.get(parentPath);
    if (parentId && parentId !== folder.folderId) {
      folder.parentFolderId = parentId;
      folder.path = parts.join(' / ');
      folder.folderPath = folder.path;
      changed = true;
    }
  }

  // Pass 3: final path refresh after parent normalization.
  for (const folder of folders) {
    const nextPath = folderPathFromParents(folder, folderById);
    if (nextPath && (folder.path !== nextPath || folder.folderPath !== nextPath)) {
      folder.path = nextPath;
      folder.folderPath = nextPath;
      changed = true;
    }
  }

  return { folders, changed };
}

async function syncChangedFolders(folders = []) {
  for (const folder of folders) {
    try { await pushWalletManifest(folder); }
    catch (error) { console.warn('[folder-tree-normalize] sync push failed:', error?.message || error); }
  }
}

function installFolderTreeNormalizeWrapper() {
  const existing = ipcMain._invokeHandlers?.get?.('p2p:listFolders');
  if (!existing) {
    console.warn('[folder-tree-normalize] original p2p:listFolders handler not found; skipping wrapper');
    return;
  }

  try { ipcMain.removeHandler('p2p:listFolders'); } catch {}

  ipcMain.handle('p2p:listFolders', async (event, payload = {}) => {
    const wallet = readWallet();
    const ownerWallet = activeIdentity(wallet);
    if (!wallet?.connected || !wallet?.verified || !ownerWallet) {
      return existing(event, payload);
    }

    const manifests = readManifests();
    const { folders, changed } = normalizeFolderTreeInMemory(manifests, ownerWallet);

    if (changed) {
      writeManifests(manifests);
      await syncChangedFolders(folders);
      console.log('[folder-tree-normalize] normalized cross-device folder parents', folders.length);
    }

    // Still call the original handler so its own side effects stay intact, but return
    // the normalized tree so the left sidebar never flattens nested folders.
    try { await existing(event, payload); } catch {}
    return folders.sort((a, b) => String(a.path || a.name || '').localeCompare(String(b.path || b.name || '')));
  });

  console.log('[folder-tree-normalize] p2p:listFolders cross-device tree wrapper installed');
}

installFolderTreeNormalizeWrapper();
