const fs = require('node:fs');

const p = 'electron/main.js';
let s = fs.readFileSync(p, 'utf8');
let changed = false;
function r(from, to) { if (s.includes(from)) { s = s.replace(from, to); changed = true; } }

r("  | \"wallet:disconnect\"", "  | \"wallet:disconnect\"\n  | \"drive:getFolders\"\n  | \"drive:saveFolders\"");

const marker = "ipcMain.handle('p2p:start'";
if (!s.includes("ipcMain.handle('drive:getFolders'")) {
  const block = `
function driveFoldersManifest(owner = activeWallet()) {
  const id = normalizeWallet(owner);
  return manifests.find((m) => m && m.type === 'drive-folders-v1' && normalizeWallet(m.ownerWallet) === id) || null;
}
function sanitizeDriveFolders(payload = {}) {
  const folders = Array.isArray(payload.folders) ? payload.folders.filter((f) => f && typeof f === 'object').map((f) => ({
    id: String(f.id || f.name || '').trim(),
    name: String(f.name || f.id || '').trim(),
    parentId: f.parentId ? String(f.parentId) : null,
    deleted: Boolean(f.deleted),
    updatedAt: f.updatedAt || new Date().toISOString(),
  })).filter((f) => f.id && f.name) : [];
  const fileFolders = payload.fileFolders && typeof payload.fileFolders === 'object' ? payload.fileFolders : {};
  return { folders, fileFolders };
}
function buildDriveFoldersManifest(payload = {}) {
  const ownerWallet = activeWallet();
  const clean = sanitizeDriveFolders(payload);
  return {
    id: ownerWallet + ':__drive_folders_v1__',
    type: 'drive-folders-v1',
    hash: '__drive_folders_v1__',
    name: '__drive_folders_v1__',
    ownerWallet,
    isEncrypted: false,
    visibility: 'private',
    isPublic: false,
    size: 0,
    storedSize: 0,
    totalChunks: 0,
    chunks: [],
    folders: clean.folders,
    fileFolders: clean.fileFolders,
    updatedAt: new Date().toISOString(),
  };
}
ipcMain.handle('drive:getFolders', async () => {
  assertVerifiedWallet();
  await syncPull();
  const manifest = driveFoldersManifest();
  return { ok: true, folders: manifest?.folders || [], fileFolders: manifest?.fileFolders || {}, updatedAt: manifest?.updatedAt || null };
});
ipcMain.handle('drive:saveFolders', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const manifest = buildDriveFoldersManifest(payload);
  manifests = manifests.filter((m) => !(m && m.type === 'drive-folders-v1' && normalizeWallet(m.ownerWallet) === activeWallet()));
  manifests.push(manifest);
  persistManifests();
  await syncPush(manifest);
  return { ok: true, folders: manifest.folders, fileFolders: manifest.fileFolders, updatedAt: manifest.updatedAt };
});

`;
  const idx = s.indexOf(marker);
  if (idx === -1) throw new Error('p2p:start marker not found');
  s = s.slice(0, idx) + block + s.slice(idx);
  changed = true;
}

if (changed) { fs.writeFileSync(p, s, 'utf8'); console.log('[patch-drive-folder-sync-ipc] installed drive folder sync IPC'); }
else console.log('[patch-drive-folder-sync-ipc] already applied');
