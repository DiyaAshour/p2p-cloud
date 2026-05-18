const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const runtimeFiles = [
  path.join(root, 'electron', 'main.js'),
  path.join(root, 'electron', 'main-stable.js'),
];

function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function write(file, value) { fs.writeFileSync(file, value, 'utf8'); }

const aliasHandlers = String.raw`
function manifestItemId(item = {}) { return String(item.id || item.rootHash || item.hash || item.folderId || ''); }
function findOwnedManifestItemById(itemId = '') {
  const id = String(itemId || '');
  return walletManifests().find((item) => manifestItemId(item) === id || item.id === id || item.hash === id || item.rootHash === id || item.folderId === id);
}
function normalizeParentFolderId(value) { return value === null || value === undefined || value === '' ? '' : String(value); }
function manifestItemIsFolder(item = {}) { return item.kind === FOLDER_MANIFEST_KIND || item.isFolder === true || String(item.hash || '').startsWith('folder:'); }
function itemChildrenOf(parentFolderId = '') { const parent = normalizeParentFolderId(parentFolderId); return walletManifests().filter((item) => normalizeParentFolderId(item.parentFolderId || item.folderId) === parent); }
function assertValidMoveTarget(item, targetFolderId) {
  const target = normalizeParentFolderId(targetFolderId);
  if (!target) return null;
  const targetFolder = findFolderById(target) || findOwnedManifestItemById(target);
  if (!targetFolder || !manifestItemIsFolder(targetFolder)) throw new Error('Target folder not found');
  if (normalizeWallet(targetFolder.ownerWallet) !== activeWallet()) throw new Error('Target folder owner mismatch');
  if (manifestItemIsFolder(item)) {
    const sourceId = String(item.folderId || item.id || '');
    if (target === sourceId || manifestItemId(item) === target) throw new Error('Cannot move folder into itself');
    assertFolderNotDescendant(sourceId, target);
  }
  return targetFolder;
}

ipcMain.handle('p2p:renameItem', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const item = findOwnedManifestItemById(payload.itemId || payload.id || payload.hash || payload.rootHash || payload.folderId);
  if (!item) throw new Error('Item not found');
  const name = sanitizeFolderName(payload.name);
  item.name = name;
  item.updatedAt = new Date().toISOString();
  if (manifestItemIsFolder(item)) Object.assign(item, { kind: FOLDER_MANIFEST_KIND, isFolder: true, visibility: 'private', isPublic: false, isEncrypted: false, chunks: [], chunkSize: 0, totalChunks: 0, size: 0, storedSize: 0 });
  persistManifests();
  await syncPush(item);
  await syncPull();
  return { ok: true, item };
});

ipcMain.handle('p2p:moveItem', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const item = findOwnedManifestItemById(payload.itemId || payload.id || payload.hash || payload.rootHash || payload.folderId);
  if (!item) throw new Error('Item not found');
  const targetFolder = assertValidMoveTarget(item, payload.targetFolderId ?? payload.parentFolderId ?? payload.folderId ?? null);
  const nextParentId = targetFolder ? String(targetFolder.folderId || targetFolder.id) : '';
  item.parentFolderId = nextParentId;
  if (!manifestItemIsFolder(item)) {
    item.folderId = nextParentId;
    item.folderName = targetFolder?.name || '';
    item.folder = item.folderName;
  }
  item.updatedAt = new Date().toISOString();
  persistManifests();
  await syncPush(item);
  await syncPull();
  return { ok: true, item };
});

ipcMain.handle('p2p:deleteItem', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const item = findOwnedManifestItemById(payload.itemId || payload.id || payload.hash || payload.rootHash || payload.folderId);
  if (!item) throw new Error('Item not found');
  if (!manifestItemIsFolder(item)) {
    manifests = manifests.filter((m) => !(walletOwnsManifest(m) && manifestItemId(m) === manifestItemId(item)));
    persistManifests();
    await syncDelete(activeWallet(), item.hash);
    await syncPull();
    return { ok: true, deleted: 1 };
  }
  const rootId = String(item.folderId || item.id || '');
  const removedFolderIds = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of walletFolderManifests()) {
      const folderId = String(folder.folderId || folder.id || '');
      if (!removedFolderIds.has(folderId) && removedFolderIds.has(normalizeParentFolderId(folder.parentFolderId))) {
        removedFolderIds.add(folderId);
        changed = true;
      }
    }
  }
  const removedItems = walletManifests().filter((candidate) => {
    if (manifestItemIsFolder(candidate)) return removedFolderIds.has(String(candidate.folderId || candidate.id || ''));
    return removedFolderIds.has(normalizeParentFolderId(candidate.parentFolderId || candidate.folderId));
  });
  manifests = manifests.filter((candidate) => !removedItems.some((removed) => walletOwnsManifest(candidate) && manifestItemId(candidate) === manifestItemId(removed)));
  persistManifests();
  for (const removed of removedItems) await syncDelete(activeWallet(), removed.hash);
  await syncPull();
  return { ok: true, deleted: removedItems.length };
});
`;

for (const file of runtimeFiles) {
  let src = read(file);
  if (!src) continue;
  const before = src;
  if (!src.includes("ipcMain.handle('p2p:renameItem'")) {
    if (src.includes("ipcMain.handle('p2p:prepareProof'")) {
      src = src.replace("ipcMain.handle('p2p:prepareProof'", `${aliasHandlers}\nipcMain.handle('p2p:prepareProof'`);
    } else if (src.includes("app.whenReady()")) {
      src = src.replace("app.whenReady()", `${aliasHandlers}\napp.whenReady()`);
    }
  }
  if (src !== before) write(file, src);
}

console.log('[patch-manifest-folder-item-aliases] safe p2p item aliases installed without touching chunks or encryption.');
