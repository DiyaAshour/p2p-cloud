const fs = require('node:fs');
const path = require('node:path');

const runtimeFiles = [
  path.join(process.cwd(), 'electron', 'main.js'),
  path.join(process.cwd(), 'electron', 'main-stable.js'),
];

function findHandlerEnd(source, start) {
  let quote = null;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  let parens = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') parens += 1;
    if (ch === ')') {
      parens -= 1;
      if (parens === 0 && source[i + 1] === ';') return i + 2;
    }
  }
  return -1;
}

function replaceIpcHandler(source, channel, handler) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = source.indexOf(marker);
  if (start === -1) return source;
  const end = findHandlerEnd(source, start);
  if (end === -1) return source;
  return `${source.slice(0, start)}${handler}${source.slice(end)}`;
}

const renameHandler = String.raw`ipcMain.handle('p2p:renameItem', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const item = findOwnedManifestItemById(payload.itemId || payload.id || payload.hash || payload.rootHash || payload.folderId);
  if (!item) throw new Error('Item not found');
  const name = sanitizeFolderName(payload.name);
  const oldName = String(item.name || '').trim();
  const oldNameLower = oldName.toLowerCase();
  item.name = name;
  item.updatedAt = new Date().toISOString();
  const changedFiles = [];
  if (manifestItemIsFolder(item)) {
    Object.assign(item, { kind: FOLDER_MANIFEST_KIND, isFolder: true, visibility: 'private', isPublic: false, isEncrypted: false, chunks: [], chunkSize: 0, totalChunks: 0, size: 0, storedSize: 0 });
    const folderId = String(item.folderId || item.id || '');
    for (const candidate of walletManifests()) {
      if (manifestItemIsFolder(candidate)) continue;
      const candidateParentId = normalizeParentFolderId(candidate.parentFolderId || candidate.folderId);
      const candidateParentIdLower = candidateParentId.toLowerCase();
      const candidateFolderName = manifestFolderNameLower(candidate);
      if ((folderId && candidateParentId === folderId) || (oldNameLower && (candidateFolderName === oldNameLower || candidateParentIdLower === oldNameLower))) {
        candidate.folderId = folderId;
        candidate.parentFolderId = folderId;
        candidate.folderName = name;
        candidate.folder = name;
        candidate.updatedAt = new Date().toISOString();
        changedFiles.push(candidate);
      }
    }
  }
  persistManifests();
  await syncPush(item);
  for (const file of changedFiles) await syncPush(file);
  await syncPull();
  return { ok: true, item, renamedFiles: changedFiles.length };
});`;

const deleteHandler = String.raw`ipcMain.handle('p2p:deleteItem', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const item = findOwnedManifestItemById(payload.itemId || payload.id || payload.hash || payload.rootHash || payload.folderId);
  if (!item) throw new Error('Item not found');

  if (!manifestItemIsFolder(item)) {
    const removedIds = new Set(manifestItemIds(item));
    const beforeCount = manifests.length;
    manifests = manifests.filter((candidate) => !manifestItemMatchesAnyId(candidate, removedIds));
    persistManifests();
    await syncDelete(manifestDeleteOwnerIdentity(), item.hash || item.rootHash || item.folderId);
    return { ok: true, deleted: beforeCount - manifests.length, movedFiles: 0, deletedFiles: 1, removedIds: Array.from(removedIds) };
  }

  const rootIds = manifestItemIds(item);
  const removedFolderIds = new Set(rootIds);
  const removedFolderNames = new Set([manifestOwnNameLower(item)].filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of walletFolderManifests()) {
      const folderIds = manifestItemIds(folder);
      const parentId = normalizeParentFolderId(folder.parentFolderId);
      const parentIdLower = parentId.toLowerCase();
      if ((parentId && removedFolderIds.has(parentId)) || (parentIdLower && removedFolderNames.has(parentIdLower))) {
        for (const id of folderIds) {
          if (!removedFolderIds.has(id)) { removedFolderIds.add(id); changed = true; }
        }
        const folderName = manifestOwnNameLower(folder);
        if (folderName && !removedFolderNames.has(folderName)) { removedFolderNames.add(folderName); changed = true; }
      }
    }
  }

  const foldersToRemove = [];
  const filesInside = [];
  for (const candidate of walletManifests()) {
    if (manifestItemIsFolder(candidate)) {
      if (manifestItemIds(candidate).some((id) => removedFolderIds.has(id)) || removedFolderNames.has(manifestOwnNameLower(candidate))) foldersToRemove.push(candidate);
      continue;
    }
    const candidateParentId = normalizeParentFolderId(candidate.parentFolderId || candidate.folderId);
    const candidateParentIdLower = candidateParentId.toLowerCase();
    const candidateFolderName = manifestFolderNameLower(candidate);
    if ((candidateParentId && removedFolderIds.has(candidateParentId)) || (candidateFolderName && removedFolderNames.has(candidateFolderName)) || (candidateParentIdLower && removedFolderNames.has(candidateParentIdLower))) {
      filesInside.push(candidate);
    }
  }

  const disposition = String(payload.fileDisposition || 'move').trim().toLowerCase();
  const deleteFiles = disposition === 'delete';
  const targetFolder = deleteFiles ? null : assertValidMoveTarget(item, payload.targetFolderId ?? payload.parentFolderId ?? null);
  if (targetFolder && manifestItemIds(targetFolder).some((id) => removedFolderIds.has(id))) throw new Error('Cannot move files into a folder that is being deleted');

  const removedItems = deleteFiles ? [...foldersToRemove, ...filesInside] : foldersToRemove;
  const removedIds = new Set(removedItems.flatMap((removed) => manifestItemIds(removed)));
  const beforeCount = manifests.length;
  manifests = manifests.filter((candidate) => !manifestItemMatchesAnyId(candidate, removedIds));

  let movedFiles = 0;
  if (!deleteFiles) {
    const targetFolderId = targetFolder ? String(targetFolder.folderId || targetFolder.id || '') : '';
    const targetFolderName = targetFolder?.name || '';
    for (const file of filesInside) {
      file.parentFolderId = targetFolderId;
      file.folderId = targetFolderId;
      file.folderName = targetFolderName;
      file.folder = targetFolderName;
      file.updatedAt = new Date().toISOString();
      movedFiles += 1;
    }
  }

  persistManifests();
  for (const removed of removedItems) await syncDelete(manifestDeleteOwnerIdentity(), removed.hash || removed.rootHash || removed.folderId);
  if (!deleteFiles) for (const file of filesInside) await syncPush(file);

  return {
    ok: true,
    deleted: beforeCount - manifests.length,
    movedFiles,
    deletedFiles: deleteFiles ? filesInside.length : 0,
    removedIds: Array.from(removedIds),
    targetFolderId: targetFolder ? String(targetFolder.folderId || targetFolder.id || '') : '',
  };
});`;

for (const file of runtimeFiles) {
  if (!fs.existsSync(file)) continue;
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  src = replaceIpcHandler(src, 'p2p:renameItem', renameHandler);
  src = replaceIpcHandler(src, 'p2p:deleteItem', deleteHandler);
  if (src !== before) {
    fs.writeFileSync(file, src, 'utf8');
    console.log(`[folder-legacy-name-links] patched legacy name-linked manifests in ${file}`);
  }
}
