const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const preloadPath = path.join(root, 'electron', 'preload.cjs');

function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function write(file, src) { fs.writeFileSync(file, src, 'utf8'); }
function warn(label) { console.warn('[patch-drive-folder-compat] skipped:', label); }

let main = read(mainPath);
if (main) {
  if (!main.includes('function findFolderByName')) {
    main = main.replace(
      "function findFolderById(folderId = '') { return walletFolderManifests().find((folder) => folder.folderId === String(folderId || '')); }\n",
      "function findFolderById(folderId = '') { return walletFolderManifests().find((folder) => folder.folderId === String(folderId || '')); }\nfunction findFolderByName(name = '') { return walletFolderManifests().find((folder) => String(folder.name || '').toLowerCase() === String(name || '').toLowerCase()); }\n"
    );
  }

  if (!main.includes("ipcMain.handle('drive:getFolders'")) {
    const insertionPoint = "ipcMain.handle('p2p:listFiles'";
    if (!main.includes(insertionPoint)) {
      warn('p2p:listFiles insertion point');
    } else {
      const handlers = `
ipcMain.handle('drive:getFolders', async () => {
  assertFolderIdentity();
  await syncPull();
  const folders = walletFolderManifests();
  const byId = new Map(folders.map((folder) => [folder.folderId, folder]));
  const fileFolders = {};
  for (const file of walletFileManifests()) {
    const folder = file.folderId ? byId.get(file.folderId) : findFolderByName(file.folder || file.folderName || '');
    if (folder) fileFolders[file.hash] = folder.name;
    else if (file.folder || file.folderName) fileFolders[file.hash] = file.folder || file.folderName;
  }
  return { ok: true, folders: folders.map((folder) => ({ id: folder.folderId, name: folder.name, parentId: byId.get(folder.parentFolderId || '')?.name || '' })), fileFolders };
});

ipcMain.handle('drive:saveFolders', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const ownerWallet = folderOwnerIdentity();
  const incomingFolders = Array.isArray(payload.folders) ? payload.folders : [];
  const incomingFileFolders = payload.fileFolders && typeof payload.fileFolders === 'object' ? payload.fileFolders : {};
  const folderByName = new Map(walletFolderManifests().map((folder) => [String(folder.name || '').toLowerCase(), folder]));

  for (const item of incomingFolders) {
    const name = sanitizeFolderName(item.name || item.id);
    if (!folderByName.has(name.toLowerCase())) {
      const folderId = folderIdFromName(name);
      const folder = { kind: FOLDER_MANIFEST_KIND, id: `${ownerWallet}:folder:${folderId}`, hash: `folder:${folderId}`, rootHash: `folder:${folderId}`, folderId, name, parentFolderId: '', ownerWallet, ownerNodeId: ensureTransport({}).peerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), size: 0, storedSize: 0, totalChunks: 0, chunks: [], replicas: [], isEncrypted: false, visibility: 'private', isPublic: false, isFolder: true };
      manifests.push(folder);
      folderByName.set(name.toLowerCase(), folder);
      await syncPush(folder);
    }
  }

  for (const item of incomingFolders) {
    const folder = folderByName.get(String(item.name || item.id || '').toLowerCase());
    if (!folder) continue;
    const parent = item.parentId ? folderByName.get(String(item.parentId).toLowerCase()) : null;
    const nextParentId = parent?.folderId || '';
    if (folder.parentFolderId !== nextParentId) {
      assertFolderNotDescendant(folder.folderId, nextParentId);
      folder.parentFolderId = nextParentId;
      folder.updatedAt = new Date().toISOString();
      await syncPush(folder);
    }
  }

  const keepNames = new Set(incomingFolders.map((item) => String(item.name || item.id || '').toLowerCase()).filter(Boolean));
  if (keepNames.size) {
    for (const folder of [...walletFolderManifests()]) {
      if (!keepNames.has(String(folder.name || '').toLowerCase())) {
        manifests = manifests.filter((m) => !(m.kind === FOLDER_MANIFEST_KIND && m.folderId === folder.folderId));
        await syncDelete(folderOwnerIdentity(), folder.hash);
      }
    }
  }

  for (const [hash, folderName] of Object.entries(incomingFileFolders)) {
    const file = walletFileManifests().find((candidate) => candidate.hash === hash || candidate.rootHash === hash);
    if (!file) continue;
    const folder = folderName ? folderByName.get(String(folderName).toLowerCase()) : null;
    file.folderId = folder?.folderId || '';
    file.folderName = folder?.name || String(folderName || '');
    file.folder = file.folderName;
    file.updatedAt = new Date().toISOString();
    await syncPush(file);
  }

  persistManifests();
  await syncPull();
  return { ok: true, folders: walletFolderManifests(), fileFolders: incomingFileFolders };
});
`;
      main = main.replace(insertionPoint, `${handlers}\n${insertionPoint}`);
    }
  }
  write(mainPath, main);
}

let preload = read(preloadPath);
if (preload) {
  for (const channel of ['drive:getFolders', 'drive:saveFolders']) {
    if (!preload.includes(`'${channel}'`)) {
      preload = preload.replace("  'p2p:listFiles',\n", `  'p2p:listFiles',\n  '${channel}',\n`);
    }
  }
  write(preloadPath, preload);
}

console.log('[patch-drive-folder-compat] drive folder IPC compatibility enabled.');
