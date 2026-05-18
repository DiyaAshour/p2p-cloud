const fs = require('node:fs');

function patch(file, fn) {
  if (!fs.existsSync(file)) {
    console.log(`[streaming-final] skip missing ${file}`);
    return;
  }

  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);

  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    console.log(`[streaming-final] patched ${file}`);
  } else {
    console.log(`[streaming-final] ok ${file}`);
  }
}

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Start marker not found: ${startMarker}`);
  }

  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`End marker not found after ${startMarker}: ${endMarker}`);
  }

  return source.slice(0, start) + replacement.trim() + '\n\n' + source.slice(end);
}

function insertBefore(source, marker, guard, block) {
  if (source.includes(guard)) return source;

  const index = source.indexOf(marker);
  if (index < 0) {
    throw new Error(`Marker not found: ${marker}`);
  }

  return source.slice(0, index) + block.trim() + '\n\n' + source.slice(index);
}

patch('electron/main-stable.js', (source) => {
  let s = source;

  if (!s.includes('let transferCancelTokens =')) {
    s = s.replace(
      'let transferProgress = { upload: null, download: null };',
      "let transferProgress = { upload: null, download: null };\nlet transferCancelTokens = { upload: false, download: false };"
    );
  }

  const streamingHelpers = `
function isTransferCancelled(kind) {
  return Boolean(transferCancelTokens?.[kind]);
}

function throwIfTransferCancelled(kind) {
  if (isTransferCancelled(kind)) {
    throw new Error(kind === 'download' ? '__TRANSFER_CANCELLED_DOWNLOAD__' : '__TRANSFER_CANCELLED_UPLOAD__');
  }
}

function resetTransferCancel(kind) {
  transferCancelTokens[kind] = false;
}

function markProgressCancellable(kind) {
  if (transferProgress[kind]) {
    transferProgress[kind] = {
      ...transferProgress[kind],
      cancellable: true,
      cancelled: false,
    };
  }
}

function writeStreamChunk(stream, buffer) {
  if (!buffer || !buffer.length) return Promise.resolve();

  return new Promise((resolve, reject) => {
    stream.write(buffer, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function finishWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroyWriteStream(stream) {
  try {
    stream.destroy();
  } catch {}
}

function unlinkQuiet(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function renameFileAtomic(tempPath, finalPath) {
  try {
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
  } catch {}
  fs.renameSync(tempPath, finalPath);
}

function safeDownloadName(name = 'download') {
  if (typeof safeOutputName === 'function') return safeOutputName(name);
  return String(name || 'download').replace(/[\\\\/:*?"<>|]/g, '_');
}

function readLocalChunkObject(node, hash) {
  return node.getLocalChunk?.(hash) || node.localChunks?.get(hash) || null;
}

async function fetchChunkBufferForDownload(node, meta) {
  let chunk = readLocalChunkObject(node, meta.hash);

  if (!chunk) {
    try {
      chunk = await node.fetchChunkFromNetwork(meta.hash);
    } catch (error) {
      console.warn('[streaming-download] network fetch failed, trying safety peer:', error?.message || error);
      chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId);
    }
  }

  if (!chunk) {
    throw new Error(\`Chunk unavailable: \${meta.hash}\`);
  }

  node.storeLocalChunk?.(chunk);

  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk.data || ''), 'base64');

  if (hashBufferHex(buffer) !== meta.hash) {
    throw new Error(\`Chunk integrity failed: \${meta.hash}\`);
  }

  return buffer;
}

function resolveTargetFolder(payload = {}) {
  const targetFolderId = String(payload.folderId || payload.parentFolderId || '').trim();
  const targetFolderName = String(payload.folderName || payload.folderPath || '').trim();

  if (targetFolderId) {
    if (typeof findFolderByAny === 'function') return findFolderByAny(targetFolderId);
    if (typeof findFolderById === 'function') return findFolderById(targetFolderId);
  }

  if (targetFolderName && typeof findFolderByName === 'function') {
    return findFolderByName(targetFolderName);
  }

  return null;
}

async function uploadFilePathStreaming(filePath, payload = {}) {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();

  const node = ensureTransport({});
  const stat = fs.statSync(filePath);
  const originalSize = Number(stat.size || 0);

  assertWalletUploadAllowed(originalSize);

  const ownerWallet = activeWallet();
  const privateFile = Boolean(payload.isEncrypted);
  const drivePassword = privateFile ? drivePasswordFromPayload(payload) : null;

  const salt = privateFile ? crypto.randomBytes(16) : null;
  const iv = privateFile ? crypto.randomBytes(12) : null;
  const key = privateFile ? deriveDriveKey({ ownerWallet, drivePassword, salt }) : null;
  const cipher = privateFile ? crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv) : null;

  const originalHasher = crypto.createHash('sha256');
  const storedHasher = crypto.createHash('sha256');

  const fileName = path.basename(filePath);
  const expectedChunks = Math.max(1, Math.ceil(originalSize / CHUNK_SIZE_BYTES));
  const chunkResults = [];
  const fileReplicas = new Set([node.peerId]);

  let carry = Buffer.alloc(0);
  let index = 0;
  let storedSize = 0;

  resetTransferCancel('upload');

  createProgress('upload', {
    fileName,
    totalBytes: originalSize,
    totalChunks: expectedChunks,
    concurrency: 1,
  });

  markProgressCancellable('upload');

  async function flushChunk(data) {
    throwIfTransferCancelled('upload');

    const buffer = Buffer.from(data || Buffer.alloc(0));
    const hash = hashBufferHex(buffer);

    storedHasher.update(buffer);
    storedSize += buffer.length;

    const chunkPayload = {
      hash,
      data: buffer.toString('base64'),
      index,
      size: buffer.length,
      ownerWallet,
      encrypted: privateFile,
    };

    const replicas = replicateChunk(node, chunkPayload, [node.peerId], TARGET_REPLICAS);

    try {
      await putChunkToSafetyPeer(chunkPayload, node.peerId);
      replicas.push('aws-safety-peer');
    } catch (error) {
      throw new Error(\`Safety peer upload failed for chunk \${hash}: \${error?.message || error}\`);
    }

    for (const peerId of replicas || []) {
      fileReplicas.add(peerId);
    }

    chunkResults.push({
      index,
      hash,
      size: buffer.length,
      replicas: unique(replicas),
      proof: [],
    });

    index += 1;

    updateProgress('upload', {
      bytesDelta: privateFile ? 0 : buffer.length,
      chunkDelta: 1,
    });

    throwIfTransferCancelled('upload');
  }

  async function consumeOutput(output) {
    if (!output || !output.length) return;

    carry = carry.length ? Buffer.concat([carry, output]) : Buffer.from(output);

    while (carry.length >= CHUNK_SIZE_BYTES) {
      const chunk = carry.subarray(0, CHUNK_SIZE_BYTES);
      carry = carry.subarray(CHUNK_SIZE_BYTES);
      await flushChunk(chunk);
    }
  }

  try {
    for await (const part of fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES })) {
      throwIfTransferCancelled('upload');

      const plain = Buffer.from(part);
      originalHasher.update(plain);

      const out = privateFile ? cipher.update(plain) : plain;
      await consumeOutput(out);

      if (privateFile) {
        updateProgress('upload', {
          bytesDelta: plain.length,
          chunkDelta: 0,
        });
      }

      throwIfTransferCancelled('upload');
    }

    if (privateFile) {
      await consumeOutput(cipher.final());
    }

    if (carry.length || chunkResults.length === 0) {
      await flushChunk(carry);
      carry = Buffer.alloc(0);
    }

    const storedHash = storedHasher.digest('hex');
    const originalHash = originalHasher.digest('hex');

    const tree = buildMerkleTree(chunkResults.map((chunk) => chunk.hash));

    for (const chunk of chunkResults) {
      chunk.proof = getMerkleProof(tree, chunk.index);
    }

    const targetFolderId = String(payload.folderId || payload.parentFolderId || '').trim();
    const targetFolder = targetFolderId || payload.folderName || payload.folderPath
      ? resolveTargetFolder(payload)
      : null;

    if (targetFolderId && !targetFolder) {
      throw new Error(\`Target folder not found: \${targetFolderId}\`);
    }

    const encryption = privateFile
      ? {
          version: 5,
          algorithm: ENCRYPTION_ALGORITHM,
          keySource: ENCRYPTION_KEY_SOURCE,
          kdf: KDF_ALGORITHM,
          kdfIterations: KDF_ITERATIONS,
          salt: salt.toString('base64'),
          iv: iv.toString('base64'),
          authTag: cipher.getAuthTag().toString('base64'),
          originalHash,
          originalSize,
        }
      : null;

    const manifest = {
      id: \`\${ownerWallet}:\${storedHash}\`,
      name: fileName,
      size: originalSize,
      storedSize,
      hash: storedHash,
      rootHash: tree.root,
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isEncrypted: privateFile,
      visibility: privateFile ? 'private' : 'public',
      isPublic: !privateFile,
      encryption,
      mimeType: 'application/octet-stream',
      folderId: targetFolder?.folderId || '',
      parentFolderId: targetFolder?.folderId || '',
      folderName: targetFolder?.name || String(payload.folderPath || payload.folderName || ''),
      folder: targetFolder?.name || String(payload.folderPath || payload.folderName || ''),
      chunkSize: CHUNK_SIZE_BYTES,
      totalChunks: chunkResults.length,
      ownerNodeId: node.peerId,
      ownerWallet,
      planId: walletState.planId,
      replicas: unique(Array.from(fileReplicas)),
      chunks: chunkResults,
    };

    manifests = manifests.filter(
      (candidate) => !(normalizeWallet(candidate.ownerWallet) === ownerWallet && candidate.hash === manifest.hash)
    );

    manifests.push(manifest);
    persistManifests();
    persistWallet();

    await syncPush(manifest);

    finishProgress('upload');
    return manifest;
  } catch (error) {
    if (error?.message === '__TRANSFER_CANCELLED_UPLOAD__') {
      finishProgress('upload', 'cancelled', null);
      throw error;
    }

    finishProgress('upload', 'error', error?.message || String(error));
    throw error;
  }
}

async function downloadManifestToPathStreaming(manifest, savePath, payload = {}) {
  const node = ensureTransport({});
  const orderedChunks = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index);

  resetTransferCancel('download');

  createProgress('download', {
    fileName: manifest.name,
    totalBytes: Number(manifest.storedSize || manifest.size || 0),
    totalChunks: orderedChunks.length,
    concurrency: 1,
  });

  markProgressCancellable('download');

  const tempPath = \`\${savePath}.chunknet-part-\${crypto.randomUUID()}\`;
  const out = fs.createWriteStream(tempPath);

  const storedHasher = crypto.createHash('sha256');
  const plainHasher = crypto.createHash('sha256');

  let decipher = null;

  if (manifest.isEncrypted) {
    if (!manifest?.encryption || manifest.encryption.algorithm !== ENCRYPTION_ALGORITHM) {
      throw new Error('Encrypted file metadata is missing or unsupported');
    }

    if (manifest.encryption.keySource !== ENCRYPTION_KEY_SOURCE) {
      throw new Error(\`This file was encrypted with an older key source (\${manifest.encryption.keySource || 'unknown'}). Re-upload it with Drive Password encryption.\`);
    }

    const drivePassword = drivePasswordFromPayload(payload);
    const key = deriveDriveKey({
      ownerWallet: manifest.ownerWallet,
      drivePassword,
      salt: manifest.encryption.salt,
    });

    decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGORITHM,
      key,
      Buffer.from(manifest.encryption.iv, 'base64')
    );

    decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, 'base64'));
  }

  try {
    for (const meta of orderedChunks) {
      throwIfTransferCancelled('download');

      const encryptedChunk = await fetchChunkBufferForDownload(node, meta);
      storedHasher.update(encryptedChunk);

      const output = decipher ? decipher.update(encryptedChunk) : encryptedChunk;

      if (output.length) {
        if (decipher) plainHasher.update(output);
        await writeStreamChunk(out, output);
      }

      updateProgress('download', {
        bytesDelta: encryptedChunk.length,
        chunkDelta: 1,
      });

      throwIfTransferCancelled('download');
    }

    if (decipher) {
      const final = decipher.final();

      if (final.length) {
        plainHasher.update(final);
        await writeStreamChunk(out, final);
      }
    }

    await finishWriteStream(out);

    const storedHash = storedHasher.digest('hex');

    if (storedHash !== manifest.hash) {
      throw new Error('File integrity failed');
    }

    if (decipher && manifest.encryption.originalHash) {
      const plainHash = plainHasher.digest('hex');

      if (plainHash !== manifest.encryption.originalHash) {
        throw new Error('Private file integrity failed after decrypt');
      }
    }

    renameFileAtomic(tempPath, savePath);

    finishProgress('download');

    return {
      ok: true,
      cancelled: false,
      path: savePath,
      file: manifest,
      progress: transferProgress.download,
    };
  } catch (error) {
    destroyWriteStream(out);
    unlinkQuiet(tempPath);

    if (error?.message === '__TRANSFER_CANCELLED_DOWNLOAD__') {
      finishProgress('download', 'cancelled', null);
      return {
        ok: true,
        cancelled: true,
        file: manifest,
        progress: transferProgress.download,
      };
    }

    finishProgress('download', 'error', error?.message || String(error));
    throw error;
  }
}
`.trim();

  s = insertBefore(
    s,
    "ipcMain.handle('p2p:uploadFiles'",
    'function uploadFilePathStreaming(',
    streamingHelpers
  );

  const newUploadFiles = `
ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();

  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Upload files',
    properties: ['openFile', 'multiSelections'],
  });

  if (picked.canceled || !picked.filePaths?.length) {
    return { ok: true, cancelled: true, files: [] };
  }

  const uploaded = [];

  try {
    for (const filePath of picked.filePaths) {
      throwIfTransferCancelled('upload');

      const manifest = await uploadFilePathStreaming(filePath, payload);

      if (manifest) {
        uploaded.push(manifest);
      }
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

  const newDownloadToPath = `
ipcMain.handle('p2p:downloadToPath', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();
  await syncPull();

  const manifest = findManifest(payload);

  if (!manifest) {
    throw new Error('File not found for this wallet');
  }

  const save = await dialog.showSaveDialog(mainWindow, {
    title: 'Download file',
    defaultPath: path.join(app.getPath('downloads'), safeDownloadName(manifest.name || 'download')),
  });

  if (save.canceled || !save.filePath) {
    return { ok: true, cancelled: true };
  }

  return downloadManifestToPathStreaming(manifest, save.filePath, payload);
});
`;

  const newLegacyDownload = `
ipcMain.handle('p2p:download', async () => {
  throw new Error('Legacy p2p:download is disabled. Use p2p:downloadToPath.');
});
`;

  s = replaceBetween(
    s,
    "ipcMain.handle('p2p:uploadFiles'",
    "ipcMain.handle('p2p:downloadToPath'",
    newUploadFiles
  );

  s = replaceBetween(
    s,
    "ipcMain.handle('p2p:downloadToPath'",
    "ipcMain.handle('p2p:networkSummary'",
    newDownloadToPath
  );

  if (s.includes("ipcMain.handle('p2p:download'")) {
    s = replaceBetween(
      s,
      "ipcMain.handle('p2p:download'",
      "ipcMain.handle('p2p:delete'",
      newLegacyDownload
    );
  }

  if (!s.includes("ipcMain.handle('p2p:cancelTransfer'")) {
    const cancelHandler = `
ipcMain.handle('p2p:cancelTransfer', async (_event, payload = {}) => {
  const type = String(payload.type || 'upload') === 'download' ? 'download' : 'upload';

  transferCancelTokens[type] = true;

  const progress = transferProgress[type];

  if (progress) {
    transferProgress[type] = {
      ...progress,
      active: false,
      phase: 'cancelled',
      cancelled: true,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    ok: true,
    type,
    cancelled: true,
    progress: transferProgress[type],
  };
});
`;

    s = insertBefore(
      s,
      "ipcMain.handle('p2p:bootstrapNow'",
      "ipcMain.handle('p2p:cancelTransfer'",
      cancelHandler
    );
  }

  console.log('[streaming-final] checks', {
    hasUploadStreaming: s.includes('function uploadFilePathStreaming('),
    hasDownloadStreaming: s.includes('function downloadManifestToPathStreaming('),
    legacyDownloadDisabled: s.includes('Legacy p2p:download is disabled'),
    uploadReadFileSyncLeft: /readFileSync\\(filePath\\)/.test(s),
    downloadBufferConcatLeft: /Buffer\\.concat\\(buffers\\)/.test(s),
    downloadWriteFileSyncLeft: /writeFileSync\\(save\\.filePath/.test(s),
  });

  return s;
});

patch('client/src/NativeP2PAppStable.tsx', (source) => {
  let s = source;

  s = s.replace('  | "p2p:download"\\n', '');

  if (!s.includes('  | "p2p:downloadToPath"')) {
    s = s.replace('  | "p2p:delete"', '  | "p2p:downloadToPath"\\n  | "p2p:delete"');
  }

  s = s.replace(/type DownloadResult = \\{ ok: boolean; file: P2PFile; bytes: number\\[\\] \\};\\n/, '');

  s = s.replace(
    /const downloadFile = \\(file: P2PFile\\) => runBusy\\(async \\(\\) => \\{[\\s\\S]*?\\n\\s*\\}\\);\\n\\n  const deleteFile = /,
    'const downloadFile = (file: P2PFile) => runBusy(async () => {\\n    if (!bridge) return;\\n    const password = file.isEncrypted ? getDrivePassword() : null;\\n    const result = await bridge.invoke<{ ok?: boolean; cancelled?: boolean; path?: string }>("p2p:downloadToPath", { hash: file.hash, rootHash: file.rootHash, drivePassword: password });\\n    if (result?.cancelled) return;\\n    toast.success(result?.path ? `Downloaded to ${result.path}` : "Download complete");\\n  });\\n\\n  const deleteFile = '
  );

  return s;
});

patch('client/src/NativeP2PApp.tsx', () => 'export { default } from "./NativeP2PAppStable";\\n');

console.log('[streaming-final] complete');
