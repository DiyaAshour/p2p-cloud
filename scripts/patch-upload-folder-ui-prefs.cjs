const fs = require('node:fs');

const file = 'electron/main-stable.js';

function insertBefore(source, marker, guard, block) {
  if (source.includes(guard)) return source;

  const index = source.indexOf(marker);
  if (index < 0) {
    throw new Error(`Marker not found: ${marker}`);
  }

  return source.slice(0, index) + block.trim() + '\n\n' + source.slice(index);
}

if (!fs.existsSync(file)) {
  console.log('[upload-folder-ui-prefs] skip missing', file);
  process.exit(0);
}

let source = fs.readFileSync(file, 'utf8');

if (!source.includes("const UI_PREFS_KIND = 'ui:prefs';")) {
  source = source.replace(
    "const FOLDER_MANIFEST_KIND = 'folder';",
    "const FOLDER_MANIFEST_KIND = 'folder';\nconst UI_PREFS_KIND = 'ui:prefs';"
  );
}

const uiPrefsBlock = `
// === UI Preferences (synced across devices via manifest) ===
function getUiPrefsManifest() {
  const identity = activeWallet();
  if (!identity) return null;

  return manifests.find(
    (m) =>
      m.kind === UI_PREFS_KIND &&
      normalizeWallet(m.ownerWallet) === normalizeWallet(identity)
  ) || null;
}

ipcMain.handle('p2p:getUiPrefs', async () => {
  loadWallet();
  loadManifests();

  if (!walletState.connected || !walletState.verified) return {};

  try {
    await syncPull();
  } catch {}

  return getUiPrefsManifest()?.prefs || {};
});

ipcMain.handle('p2p:setUiPrefs', async (_event, prefs = {}) => {
  loadWallet();
  loadManifests();

  if (!walletState.connected || !walletState.verified) return { ok: false };

  const identity = activeWallet();
  const existing = getUiPrefsManifest();
  const now = new Date().toISOString();
  const hash = 'ui:prefs:' + normalizeWallet(identity);

  if (existing) {
    Object.assign(existing, {
      prefs: { ...(existing.prefs || {}), ...(prefs || {}) },
      updatedAt: now,
    });
  } else {
    manifests.push({
      kind: UI_PREFS_KIND,
      hash,
      rootHash: hash,
      id: normalizeWallet(identity) + ':' + hash,
      ownerWallet: normalizeWallet(identity),
      prefs: prefs || {},
      createdAt: now,
      updatedAt: now,
    });
  }

  persistManifests();

  try {
    await syncPush(getUiPrefsManifest());
  } catch {}

  return { ok: true };
});
`;

const uiPrefsMarker = source.includes("ipcMain.handle('p2p:moveFile'")
  ? "ipcMain.handle('p2p:moveFile'"
  : "ipcMain.handle('p2p:updateFile'";

source = insertBefore(
  source,
  uiPrefsMarker,
  "ipcMain.handle('p2p:getUiPrefs'",
  uiPrefsBlock
);

const uploadFolderBlock = `
function walkUploadFolderFiles(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkUploadFolderFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function walkUploadFolderDirs(dir) {
  const dirs = [dir];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      dirs.push(...walkUploadFolderDirs(fullPath));
    }
  }

  return dirs;
}

async function ensureUploadFolderManifest(rootDir, dirPath, baseParentFolderId, pathToFolderId) {
  if (pathToFolderId.has(dirPath)) {
    return pathToFolderId.get(dirPath);
  }

  const relativeParts = path
    .relative(path.dirname(rootDir), dirPath)
    .split(path.sep)
    .filter(Boolean);

  let parentFolderId = String(baseParentFolderId || '');

  for (let i = 0; i < relativeParts.length; i += 1) {
    const partialAbsPath = path.join(
      path.dirname(rootDir),
      ...relativeParts.slice(0, i + 1)
    );

    if (pathToFolderId.has(partialAbsPath)) {
      parentFolderId = pathToFolderId.get(partialAbsPath);
      continue;
    }

    const name = sanitizeFolderName(relativeParts[i]);

    let folder = walletFolderManifests().find(
      (candidate) =>
        String(candidate.parentFolderId || '') === parentFolderId &&
        String(candidate.name || '').toLowerCase() === name.toLowerCase()
    );

    if (!folder) {
      const folderId = folderIdFromName(name);
      const ownerWallet = folderOwnerIdentity();

      folder = {
        kind: FOLDER_MANIFEST_KIND,
        isFolder: true,
        visibility: 'private',
        isPublic: false,
        id: ownerWallet + ':folder:' + folderId,
        hash: 'folder:' + folderId,
        rootHash: 'folder:' + folderId,
        folderId,
        name,
        parentFolderId,
        ownerWallet,
        ownerNodeId: ensureTransport({}).peerId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        size: 0,
        storedSize: 0,
        totalChunks: 0,
        chunkSize: 0,
        chunks: [],
        replicas: [],
        encryption: null,
        isEncrypted: false,
      };

      manifests.push(folder);
      persistManifests();

      try {
        await syncPush(folder);
      } catch {}
    }

    pathToFolderId.set(partialAbsPath, folder.folderId);
    parentFolderId = folder.folderId;
  }

  return parentFolderId;
}

ipcMain.handle('p2p:uploadFolder', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();

  if (typeof uploadFilePathStreaming !== 'function') {
    throw new Error('Streaming upload helper is missing. Run pnpm run prepare:final first.');
  }

  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Upload folder',
    properties: ['openDirectory'],
  });

  if (picked.canceled || !picked.filePaths?.length) {
    return { ok: true, cancelled: true, files: [] };
  }

  const rootDir = picked.filePaths[0];
  const dirs = walkUploadFolderDirs(rootDir);
  const files = walkUploadFolderFiles(rootDir);
  const pathToFolderId = new Map();
  const uploaded = [];
  const baseParentFolderId = String(payload.folderId || payload.parentFolderId || '');

  if (baseParentFolderId && !findFolderById(baseParentFolderId)) {
    throw new Error('Target parent folder not found');
  }

  // مهم: احفظ الفولدر نفسه وكل الفولدرات الداخلية حتى لو ما فيها ملفات
  for (const dirPath of dirs) {
    await ensureUploadFolderManifest(
      rootDir,
      dirPath,
      baseParentFolderId,
      pathToFolderId
    );
  }

  try {
    for (const filePath of files) {
      throwIfTransferCancelled('upload');

      const targetFolderId = await ensureUploadFolderManifest(
        rootDir,
        path.dirname(filePath),
        baseParentFolderId,
        pathToFolderId
      );

      const manifest = await uploadFilePathStreaming(filePath, {
        ...payload,
        folderId: targetFolderId || '',
        parentFolderId: targetFolderId || '',
      });

      if (manifest) uploaded.push(manifest);
    }

    await syncPull();

    return {
      ok: true,
      cancelled: false,
      files: uploaded,
      summary: networkSummary(),
      sync: lastSyncStatus,
      progress: transferProgress.upload,
    };
  } catch (error) {
    if (error?.message === '__TRANSFER_CANCELLED_UPLOAD__') {
      return {
        ok: true,
        cancelled: true,
        files: uploaded,
        summary: networkSummary(),
        sync: lastSyncStatus,
        progress: transferProgress.upload,
      };
    }

    throw error;
  }
});
`;

const uploadFolderMarker = source.includes("ipcMain.handle('p2p:downloadToPath'")
  ? "ipcMain.handle('p2p:downloadToPath'"
  : "ipcMain.handle('p2p:networkSummary'";

source = insertBefore(
  source,
  uploadFolderMarker,
  "ipcMain.handle('p2p:uploadFolder'",
  uploadFolderBlock
);

fs.writeFileSync(file, source, 'utf8');

console.log('[upload-folder-ui-prefs] ensured IPC handlers', {
  hasUploadFolder: source.includes("ipcMain.handle('p2p:uploadFolder'"),
  hasGetUiPrefs: source.includes("ipcMain.handle('p2p:getUiPrefs'"),
  hasSetUiPrefs: source.includes("ipcMain.handle('p2p:setUiPrefs'"),
  hasWalkUploadFolderDirs: source.includes('function walkUploadFolderDirs('),
});
