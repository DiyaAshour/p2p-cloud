const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const preloadPath = path.join(root, 'electron', 'preload.cjs');

function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function write(file, src) { fs.writeFileSync(file, src, 'utf8'); }
function warn(label) { console.warn('[patch-p2p-update-file-compat] skipped:', label); }

let main = read(mainPath);
if (main) {
  if (!main.includes("ipcMain.handle('p2p:updateFile'")) {
    const insertionPoint = "ipcMain.handle('p2p:listFiles'";
    if (!main.includes(insertionPoint)) {
      warn('p2p:listFiles insertion point');
    } else {
      const handler = String.raw`
ipcMain.handle('p2p:updateFile', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const hash = String(payload.hash || payload.rootHash || '');
  const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {};
  const manifest = walletFileManifests().find((file) => file.hash === hash || file.rootHash === hash);
  if (!manifest) throw new Error('File not found for this identity');

  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const nextName = String(patch.name || '').trim();
    if (!nextName) throw new Error('File name is required');
    manifest.name = nextName;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'folder')) {
    const folderName = String(patch.folder || '').trim();
    if (!folderName) {
      manifest.folderId = '';
      manifest.folderName = '';
      manifest.folder = '';
    } else {
      let folder = findFolderByName(folderName);
      if (!folder) {
        const ownerWallet = folderOwnerIdentity();
        const folderId = folderIdFromName(folderName);
        folder = { kind: FOLDER_MANIFEST_KIND, id: ownerWallet + ':folder:' + folderId, hash: 'folder:' + folderId, rootHash: 'folder:' + folderId, folderId, name: folderName, parentFolderId: '', ownerWallet, ownerNodeId: ensureTransport({}).peerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), size: 0, storedSize: 0, totalChunks: 0, chunks: [], replicas: [], isEncrypted: false, visibility: 'private', isPublic: false, isFolder: true };
        manifests.push(folder);
        await syncPush(folder);
      }
      manifest.folderId = folder.folderId;
      manifest.folderName = folder.name;
      manifest.folder = folder.name;
    }
  }

  manifest.updatedAt = new Date().toISOString();
  persistManifests();
  await syncPush(manifest);
  await syncPull();
  return { ok: true, file: manifest };
});
`;
      main = main.replace(insertionPoint, `${handler}\n${insertionPoint}`);
    }
  }
  write(mainPath, main);
}

let preload = read(preloadPath);
if (preload) {
  if (!preload.includes("'p2p:updateFile'")) {
    preload = preload.replace("  'p2p:listFiles',\n", "  'p2p:listFiles',\n  'p2p:updateFile',\n");
  }
  write(preloadPath, preload);
}

console.log('[patch-p2p-update-file-compat] p2p:updateFile compatibility enabled.');
