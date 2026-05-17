const fs = require('node:fs');

const mainPath = 'electron/main.js';
let main = fs.readFileSync(mainPath, 'utf8');
let changed = false;

function replaceOnce(from, to) {
  if (main.includes(from)) {
    main = main.replace(from, to);
    changed = true;
  }
}

replaceOnce(
  "import { app, BrowserWindow, ipcMain, shell } from 'electron';",
  "import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';"
);
replaceOnce(
  "import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';",
  "import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';"
);

if (!main.includes("ipcMain.handle('p2p:uploadFiles'")) {
  const insertBefore = "\nipcMain.handle('p2p:download'";
  const idx = main.indexOf(insertBefore);
  if (idx === -1) throw new Error('[patch-native-upload-streaming] cannot find insertion point before p2p:download');

  const handler = `
function normalizeFolderPath(folder = '') {
  return String(folder || '').replace(/\\\\/g, '/').split('/').map((part) => part.trim()).filter(Boolean).join('/');
}

async function uploadFilePathStreaming(filePath, payload = {}) {
  const node = ensureTransport({});
  assertVerifiedWallet();
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Selected path is not a file: ' + filePath);
  assertWalletUploadAllowed(stat.size);

  const ownerWallet = activeWallet();
  const privateFile = payload.isEncrypted !== false;
  const drivePassword = privateFile ? drivePasswordFromPayload(payload) : null;
  const folder = normalizeFolderPath(payload.folderPath || '');
  const baseName = path.basename(filePath);
  const displayName = folder ? path.join(folder, baseName).replace(/\\\\/g, '/') : baseName;
  const mimeType = payload.mimeType || 'application/octet-stream';
  const uploadConcurrency = clampConcurrency(payload.uploadConcurrency, UPLOAD_CONCURRENCY, 8);

  const tempDir = path.join(app.getPath('temp'), 'chunknet-uploads');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, String(Date.now()) + '-' + crypto.randomUUID() + '.chunknet-upload');

  createProgress('upload', { fileName: displayName, totalBytes: stat.size, totalChunks: 1, concurrency: uploadConcurrency });

  let encryption = null;
  let storedSize = stat.size;
  let originalHash = '';
  const originalHasher = crypto.createHash('sha256');

  try {
    if (privateFile) {
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const key = deriveDriveKey({ ownerWallet, drivePassword, salt });
      const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
      await new Promise((resolve, reject) => {
        const input = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES });
        const output = fs.createWriteStream(tempPath);
        input.on('data', (chunk) => {
          originalHasher.update(chunk);
          updateProgress('upload', { bytesDelta: chunk.length, chunkDelta: 0 });
        });
        input.on('error', reject);
        cipher.on('error', reject);
        output.on('error', reject);
        output.on('finish', resolve);
        input.pipe(cipher).pipe(output);
      });
      originalHash = originalHasher.digest('hex');
      storedSize = fs.statSync(tempPath).size;
      encryption = {
        version: 4,
        algorithm: ENCRYPTION_ALGORITHM,
        keySource: ENCRYPTION_KEY_SOURCE,
        kdf: KDF_ALGORITHM,
        kdfIterations: KDF_ITERATIONS,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        originalHash,
        originalSize: stat.size,
      };
    } else {
      await new Promise((resolve, reject) => {
        const input = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES });
        const output = fs.createWriteStream(tempPath);
        input.on('data', (chunk) => {
          originalHasher.update(chunk);
          updateProgress('upload', { bytesDelta: chunk.length, chunkDelta: 0 });
        });
        input.on('error', reject);
        output.on('error', reject);
        output.on('finish', resolve);
        input.pipe(output);
      });
      originalHash = originalHasher.digest('hex');
      storedSize = fs.statSync(tempPath).size;
    }

    const storedHash = crypto.createHash('sha256');
    const chunkHashes = [];
    const chunkMetas = [];
    let index = 0;
    const readFd = fs.openSync(tempPath, 'r');
    try {
      const scratch = Buffer.allocUnsafe(CHUNK_SIZE_BYTES);
      let bytesRead;
      while ((bytesRead = fs.readSync(readFd, scratch, 0, CHUNK_SIZE_BYTES, null)) > 0) {
        const data = Buffer.from(scratch.subarray(0, bytesRead));
        storedHash.update(data);
        const hash = hashBufferHex(data);
        chunkHashes.push(hash);
        chunkMetas.push({ index, size: data.length, data, hash });
        index += 1;
      }
    } finally {
      fs.closeSync(readFd);
    }

    const tree = buildMerkleTree(chunkHashes);
    const fileReplicas = new Set([node.peerId]);
    const chunkResults = new Array(chunkMetas.length);
    transferProgress.upload.totalChunks = chunkMetas.length;
    transferProgress.upload.chunksDone = 0;
    transferProgress.upload.transferredBytes = 0;

    await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {
      const chunkPayload = { hash: chunk.hash, data: chunk.data.toString('base64'), index: chunk.index, size: chunk.size, ownerWallet, encrypted: privateFile };
      const replicas = replicateChunk(node, chunkPayload, [node.peerId], TARGET_REPLICAS);
      try {
        await putChunkToSafetyPeer(chunkPayload, node.peerId);
        replicas.push('aws-safety-peer');
      } catch (error) {
        throw new Error('Safety peer upload failed for chunk ' + chunk.hash + ': ' + (error?.message || error));
      }
      chunkResults[chunk.index] = { index: chunk.index, hash: chunk.hash, size: chunk.size, replicas: unique(replicas), proof: getMerkleProof(tree, chunk.index) };
      for (const peerId of chunkResults[chunk.index].replicas || []) fileReplicas.add(peerId);
      updateProgress('upload', { bytesDelta: chunk.size, chunkDelta: 1 });
      chunk.data = null;
    });

    const manifest = {
      id: ownerWallet + ':' + storedHash.digest('hex'),
      name: displayName,
      folder,
      size: stat.size,
      storedSize,
      hash: null,
      rootHash: tree.root,
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isEncrypted: privateFile,
      visibility: privateFile ? 'private' : 'public',
      isPublic: !privateFile,
      encryption,
      mimeType,
      chunkSize: CHUNK_SIZE_BYTES,
      totalChunks: chunkResults.length,
      ownerNodeId: node.peerId,
      ownerWallet,
      planId: walletState.planId,
      replicas: unique(Array.from(fileReplicas)),
      chunks: chunkResults,
    };
    manifest.hash = manifest.id.split(':')[1];

    manifests = manifests.filter((m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
    manifests.push(manifest);
    persistManifests();
    persistWallet();
    await syncPush(manifest);
    await syncPull();
    finishProgress('upload');
    return manifest;
  } catch (error) {
    finishProgress('upload', 'error', error?.message || String(error));
    throw error;
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select files to upload to Chunknet',
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths?.length) return { ok: false, cancelled: true, files: [] };
  const files = [];
  for (const filePath of result.filePaths) files.push(await uploadFilePathStreaming(filePath, payload));
  return { ok: true, files, summary: networkSummary(), sync: lastSyncStatus, progress: transferProgress.upload };
});

ipcMain.handle('p2p:updateFile', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this wallet');
  if (!walletOwnsManifest(manifest)) throw new Error('Only the owner can update this file metadata');
  const patch = payload.patch || {};
  if (Object.prototype.hasOwnProperty.call(patch, 'folder')) manifest.folder = normalizeFolderPath(patch.folder || '');
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) manifest.name = String(patch.name || manifest.name).trim() || manifest.name;
  manifest.updatedAt = new Date().toISOString();
  manifests = manifests.map((m) => (walletOwnsManifest(m) && m.hash === manifest.hash ? manifest : m));
  persistManifests();
  await syncPush(manifest);
  return { ok: true, file: manifest, summary: networkSummary() };
});
`;
  main = main.slice(0, idx) + handler + main.slice(idx);
  changed = true;
}

if (main.includes("ipcMain.handle('p2p:uploadFiles'") && !main.includes("ipcMain.handle('p2p:updateFile'")) {
  const insertBefore = "\nipcMain.handle('p2p:download'";
  const idx = main.indexOf(insertBefore);
  if (idx !== -1) {
    const updateHandler = `
function normalizeFolderPath(folder = '') {
  return String(folder || '').replace(/\\\\/g, '/').split('/').map((part) => part.trim()).filter(Boolean).join('/');
}

ipcMain.handle('p2p:updateFile', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this wallet');
  if (!walletOwnsManifest(manifest)) throw new Error('Only the owner can update this file metadata');
  const patch = payload.patch || {};
  if (Object.prototype.hasOwnProperty.call(patch, 'folder')) manifest.folder = normalizeFolderPath(patch.folder || '');
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) manifest.name = String(patch.name || manifest.name).trim() || manifest.name;
  manifest.updatedAt = new Date().toISOString();
  manifests = manifests.map((m) => (walletOwnsManifest(m) && m.hash === manifest.hash ? manifest : m));
  persistManifests();
  await syncPush(manifest);
  return { ok: true, file: manifest, summary: networkSummary() };
});
`;
    main = main.slice(0, idx) + updateHandler + main.slice(idx);
    changed = true;
  }
}

if (main.includes('const manifest = {') && !main.includes('folder,')) {
  main = main.replace('      name: displayName,\n      size: stat.size,', '      name: displayName,\n      folder,\n      size: stat.size,');
  changed = true;
}

if (changed) {
  fs.writeFileSync(mainPath, main, 'utf8');
  console.log('[patch-native-upload-streaming] installed native streaming upload with network folders');
} else {
  console.log('[patch-native-upload-streaming] native streaming upload already installed');
}
