const fs = require('node:fs');

function patch(file, fn) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    console.log(`[download-streaming] patched ${file}`);
  } else {
    console.log(`[download-streaming] ok ${file}`);
  }
}

patch('electron/main-stable.js', (source) => {
  let s = source;

  if (!s.includes('let transferCancelTokens =')) {
    s = s.replace(
      'let transferProgress = { upload: null, download: null };',
      'let transferProgress = { upload: null, download: null };\nlet transferCancelTokens = { upload: false, download: false };'
    );
  }

  if (!s.includes('function isTransferCancelled(')) {
    s = s.replace(
      "function finishProgress(kind, phase = 'complete', error = null) { const progress = transferProgress[kind]; if (!progress) return; updateProgress(kind, { phase, error }); transferProgress[kind] = { ...transferProgress[kind], active: false, phase, error }; }",
      "function finishProgress(kind, phase = 'complete', error = null) { const progress = transferProgress[kind]; if (!progress) return; updateProgress(kind, { phase, error }); transferProgress[kind] = { ...transferProgress[kind], active: false, phase, error, cancelled: phase === 'cancelled' }; }\nfunction isTransferCancelled(kind) { return Boolean(transferCancelTokens?.[kind]); }\nfunction throwIfTransferCancelled(kind) { if (isTransferCancelled(kind)) throw new Error(kind === 'upload' ? '__TRANSFER_CANCELLED_UPLOAD__' : '__TRANSFER_CANCELLED_DOWNLOAD__'); }"
    );
  }

  s = s.replace(
    "function createProgress(kind, { fileName, totalBytes, totalChunks, concurrency }) { const now = Date.now(); transferProgress[kind] = { active: true, phase: 'running', fileName, totalBytes, transferredBytes: 0, percent: 0, speedBytesPerSecond: 0, etaSeconds: null, chunksDone: 0, totalChunks, concurrency, startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), error: null }; }",
    "function createProgress(kind, { fileName, totalBytes, totalChunks, concurrency }) { const now = Date.now(); transferCancelTokens[kind] = false; transferProgress[kind] = { active: true, phase: 'running', fileName, totalBytes, transferredBytes: 0, percent: 0, speedBytesPerSecond: 0, etaSeconds: null, chunksDone: 0, totalChunks, concurrency, startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), error: null, cancellable: true, cancelled: false }; }"
  );

  if (!s.includes('throwIfTransferCancelled(\'upload\');')) {
    s = s.replace(
      'for (let index = 0, offset = 0; offset < storedSize; index += 1, offset += CHUNK_SIZE_BYTES) {',
      "for (let index = 0, offset = 0; offset < storedSize; index += 1, offset += CHUNK_SIZE_BYTES) {\n      throwIfTransferCancelled('upload');"
    );
    s = s.replace(
      'updateProgress(\'upload\', { bytesDelta: size, chunkDelta: 1 });',
      "updateProgress('upload', { bytesDelta: size, chunkDelta: 1 });\n      throwIfTransferCancelled('upload');"
    );
  }

  s = s.replace(
    "} catch (error) { finishProgress('upload', 'error', error?.message || String(error)); throw error; }",
    "} catch (error) { if (error?.message === '__TRANSFER_CANCELLED_UPLOAD__') { finishProgress('upload', 'cancelled', null); throw error; } finishProgress('upload', 'error', error?.message || String(error)); throw error; }"
  );

  s = s.replace(
    /ipcMain\.handle\('p2p:uploadFiles',[\s\S]*?\);\n(?=ipcMain\.handle\('p2p:uploadPath')/,
    "ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => { const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose files to store', properties: ['openFile', 'multiSelections'] }); if (result.canceled || !result.filePaths?.length) return { ok: true, cancelled: true, files: [] }; const files = []; try { for (const filePath of result.filePaths) { throwIfTransferCancelled('upload'); const uploaded = await uploadFilePathStreaming(filePath, payload); if (uploaded) files.push(uploaded); } return { ok: true, files, summary: networkSummary(), progress: transferProgress.upload }; } catch (error) { if (error?.message === '__TRANSFER_CANCELLED_UPLOAD__') return { ok: true, cancelled: true, files, summary: networkSummary(), progress: transferProgress.upload }; throw error; } });\n"
  );

  if (!s.includes("ipcMain.handle('p2p:cancelTransfer'")) {
    s = s.replace(
      "ipcMain.handle('p2p:networkSummary', async () => networkSummary());",
      "ipcMain.handle('p2p:networkSummary', async () => networkSummary());\nipcMain.handle('p2p:cancelTransfer', async (_event, payload = {}) => { const type = String(payload.type || 'upload') === 'download' ? 'download' : 'upload'; transferCancelTokens[type] = true; const progress = transferProgress[type]; if (progress) transferProgress[type] = { ...progress, active: false, phase: 'cancelled', cancelled: true, updatedAt: new Date().toISOString() }; return { ok: true, type, cancelled: true, progress: transferProgress[type] }; });"
    );
  }

  if (!s.includes('function readChunkBuffer(')) {
    s = s.replace(
      "function readChunkPayload(hash) { const p = chunkPath(hash); if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); }",
      "function readChunkPayload(hash) { const p = chunkPath(hash); if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); }\nfunction readChunkBuffer(hash) { const chunk = readChunkPayload(hash); if (!chunk?.data) return null; return Buffer.from(chunk.data, 'base64'); }"
    );
  }

  // Keep a hard guard for the old IPC path so no UI can accidentally use RAM-heavy downloads.
  s = s.replace(
    /ipcMain\.handle\('p2p:download',[\s\S]*?\);\n(?=ipcMain\.handle\('p2p:downloadToPath')/,
    "ipcMain.handle('p2p:download', async () => { throw new Error('Legacy p2p:download is disabled. Use p2p:downloadToPath.'); });\n"
  );

  const newDownloadToPath = "ipcMain.handle('p2p:downloadToPath', async (_event, payload = {}) => { assertVerifiedWallet(); const node = ensureTransport({}); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const ordered = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index); const save = await dialog.showSaveDialog(mainWindow, { title: 'Save downloaded file', defaultPath: safeName(manifest.name || 'download.bin') }); if (save.canceled || !save.filePath) return { ok: true, cancelled: true }; createProgress('download', { fileName: manifest.name, totalBytes: Number(manifest.storedSize || manifest.size || 0), totalChunks: ordered.length, concurrency: DOWNLOAD_CONCURRENCY }); const tempPath = path.join(app.getPath('temp'), 'chunknet-download-' + crypto.randomUUID() + '.bin'); const out = fs.createWriteStream(tempPath); try { for (const meta of ordered) { throwIfTransferCancelled('download'); let buffer = readChunkBuffer(meta.hash); if (!buffer) { const chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId); buffer = Buffer.from(chunk.data, 'base64'); } await new Promise((resolve, reject) => out.write(buffer, (error) => error ? reject(error) : resolve())); updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 }); throwIfTransferCancelled('download'); } await new Promise((resolve, reject) => out.end((error) => error ? reject(error) : resolve())); if (manifest.isEncrypted) { const encrypted = fs.readFileSync(tempPath); const plain = decryptPrivateBuffer(encrypted, manifest, payload.drivePassword); fs.writeFileSync(save.filePath, plain); try { fs.unlinkSync(tempPath); } catch {} } else { fs.renameSync(tempPath, save.filePath); } finishProgress('download'); return { ok: true, file: manifest, path: save.filePath, progress: transferProgress.download }; } catch (error) { try { out.destroy(); } catch {} try { fs.unlinkSync(tempPath); } catch {} if (error?.message === '__TRANSFER_CANCELLED_DOWNLOAD__') { finishProgress('download', 'cancelled', null); return { ok: true, cancelled: true, file: manifest, progress: transferProgress.download }; } finishProgress('download', 'error', error?.message || String(error)); throw error; } });";

  s = s.replace(/ipcMain\.handle\('p2p:downloadToPath',[\s\S]*?\);\n(?=ipcMain\.handle\('p2p:delete')/, newDownloadToPath + '\n');
  return s;
});

patch('client/src/NativeP2PAppStable.tsx', (source) => {
  let s = source;

  // Remove the legacy p2p:download type from the stable UI and add downloadToPath.
  s = s.replace('  | "p2p:download"\n', '');
  if (!s.includes('  | "p2p:downloadToPath"')) {
    s = s.replace('  | "p2p:delete"', '  | "p2p:downloadToPath"\n  | "p2p:delete"');
  }
  s = s.replace(/type DownloadResult = \{ ok: boolean; file: P2PFile; bytes: number\[\] \};\n/, '');

  s = s.replace(
    /const downloadFile = \(file: P2PFile\) => runBusy\(async \(\) => \{[\s\S]*?\n\s*\}\);\n\n  const deleteFile = /,
    'const downloadFile = (file: P2PFile) => runBusy(async () => {\n    if (!bridge) return;\n    const password = file.isEncrypted ? getDrivePassword() : null;\n    const result = await bridge.invoke<{ ok?: boolean; cancelled?: boolean; path?: string }>("p2p:downloadToPath", { hash: file.hash, drivePassword: password });\n    if (result?.cancelled) return;\n    toast.success(result?.path ? `Downloaded to ${result.path}` : "Download complete");\n  });\n\n  const deleteFile = '
  );

  return s;
});

// The old React file is now only a shim, so Vite can never compile stale broken JSX from it.
patch('client/src/NativeP2PApp.tsx', () => 'export { default } from "./NativeP2PAppStable";\n');

console.log('[download-streaming] complete');
