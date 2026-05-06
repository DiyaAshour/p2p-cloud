const fs = require('node:fs');

const p = 'electron/main.js';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

function replaceOnce(from, to) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  }
}

replaceOnce(
  "import { app, BrowserWindow, ipcMain, shell } from 'electron';",
  "import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';"
);

const start = s.indexOf("ipcMain.handle('p2p:download', async (_event, payload = {}) => {");
const end = s.indexOf("\nipcMain.handle('p2p:delete'", start);

if (start !== -1 && end !== -1) {
  const streamingHandler = `ipcMain.handle('p2p:download', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const node = ensureTransport({});
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this wallet');

  const orderedChunks = [...(manifest.chunks || [])].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  if (!orderedChunks.length) throw new Error('File manifest has no chunks');

  const downloadConcurrency = clampConcurrency(payload.downloadConcurrency, DOWNLOAD_CONCURRENCY, 8);
  createProgress('download', {
    fileName: manifest.name,
    totalBytes: Number(manifest.storedSize || manifest.size || 0),
    totalChunks: orderedChunks.length,
    concurrency: downloadConcurrency,
  });

  const suggestedName = path.basename(String(manifest.name || 'download.bin'));
  const saveResult = await dialog.showSaveDialog(mainWindow, { defaultPath: suggestedName });
  if (saveResult.canceled || !saveResult.filePath) {
    finishProgress('download', 'cancelled');
    return { ok: false, cancelled: true, file: manifest, progress: transferProgress.download };
  }

  const tempDir = path.join(app.getPath('temp'), 'chunknet-downloads');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, String(Date.now()) + '-' + crypto.randomUUID() + '.chunknet-download');
  const encryptedOut = fs.createWriteStream(tempPath);
  const encryptedHash = crypto.createHash('sha256');

  const writeBuffer = (stream, buffer) => new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off('drain', onDrain);
      reject(error);
    };
    const onDrain = () => {
      stream.off('error', onError);
      resolve();
    };
    stream.once('error', onError);
    if (stream.write(buffer)) onDrain();
    else stream.once('drain', onDrain);
  });

  const closeStream = (stream) => new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });

  const fetchChunkBuffer = async (meta) => {
    const local = node.getLocalChunk?.(meta.hash) || node.localChunks?.get(meta.hash);
    let chunk = local;
    if (!chunk) {
      try {
        chunk = await node.fetchChunkFromNetwork(meta.hash);
      } catch (error) {
        console.warn('[p2p:download] network fetch failed, trying safety peer:', error?.message || error);
        chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId);
      }
    }
    node.storeLocalChunk?.(chunk);
    const buffer = Buffer.from(chunk.data, 'base64');
    if (hashBufferHex(buffer) !== meta.hash) throw new Error('Chunk integrity failed: ' + meta.hash);
    return buffer;
  };

  try {
    for (let offset = 0; offset < orderedChunks.length; offset += downloadConcurrency) {
      const batch = orderedChunks.slice(offset, offset + downloadConcurrency);
      const batchBuffers = await Promise.all(batch.map(fetchChunkBuffer));
      for (const buffer of batchBuffers) {
        encryptedHash.update(buffer);
        await writeBuffer(encryptedOut, buffer);
        updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 });
      }
    }
    await closeStream(encryptedOut);

    const actualHash = encryptedHash.digest('hex');
    if (manifest.hash && actualHash !== manifest.hash) {
      finishProgress('download', 'error', 'Downloaded chunks do not match the file manifest');
      throw new Error('Downloaded chunks do not match this file manifest. Refresh files, repair, or re-upload this file.');
    }

    if (manifest.isEncrypted) {
      if (!manifest.encryption || manifest.encryption.algorithm !== ENCRYPTION_ALGORITHM) throw new Error('Encrypted file metadata is missing or unsupported');
      if (manifest.encryption.keySource !== ENCRYPTION_KEY_SOURCE) throw new Error('This file was encrypted with an older key source. Re-upload it with Drive Password encryption.');
      const key = deriveDriveKey({ ownerWallet: manifest.ownerWallet, drivePassword: drivePasswordFromPayload(payload), salt: manifest.encryption.salt });
      const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(manifest.encryption.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, 'base64'));
      await new Promise((resolve, reject) => {
        const input = fs.createReadStream(tempPath);
        const output = fs.createWriteStream(saveResult.filePath);
        input.on('error', reject);
        decipher.on('error', (error) => {
          const reason = String(error?.message || error);
          if (reason.includes('authenticate data') || reason.includes('Unsupported state')) {
            reject(new Error('Encrypted file authentication failed. The chunks matched the manifest, but the encryption metadata/password/wallet did not authenticate.'));
          } else {
            reject(error);
          }
        });
        output.on('error', reject);
        output.on('finish', resolve);
        input.pipe(decipher).pipe(output);
      });
    } else {
      fs.copyFileSync(tempPath, saveResult.filePath);
    }

    finishProgress('download');
    return { ok: true, file: manifest, savedPath: saveResult.filePath, progress: transferProgress.download };
  } catch (error) {
    try { encryptedOut.destroy?.(); } catch {}
    finishProgress('download', 'error', error?.message || String(error));
    throw error;
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
});`;

  s = s.slice(0, start) + streamingHandler + s.slice(end);
  changed = true;
}

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-download-memory] patched large-file streaming download');
} else {
  console.log('[patch-download-memory] no patch needed or target not found');
}
