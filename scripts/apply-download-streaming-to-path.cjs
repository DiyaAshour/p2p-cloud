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

  if (!s.includes('function readChunkBuffer(')) {
    s = s.replace(
      "function readChunkPayload(hash) { const p = chunkPath(hash); if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); }",
      "function readChunkPayload(hash) { const p = chunkPath(hash); if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); }\nfunction readChunkBuffer(hash) { const chunk = readChunkPayload(hash); if (!chunk?.data) return null; return Buffer.from(chunk.data, 'base64'); }"
    );
  }

  const oldDownloadToPath = "ipcMain.handle('p2p:downloadToPath', async (_event, payload = {}) => { const result = await ipcMain.emit; return { ok: false, skipped: true }; });";
  const newDownloadToPath = "ipcMain.handle('p2p:downloadToPath', async (_event, payload = {}) => { assertVerifiedWallet(); const node = ensureTransport({}); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const ordered = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index); const save = await dialog.showSaveDialog(mainWindow, { title: 'Save downloaded file', defaultPath: safeName(manifest.name || 'download.bin') }); if (save.canceled || !save.filePath) return { ok: true, cancelled: true }; createProgress('download', { fileName: manifest.name, totalBytes: Number(manifest.storedSize || manifest.size || 0), totalChunks: ordered.length, concurrency: DOWNLOAD_CONCURRENCY }); const tempPath = path.join(app.getPath('temp'), 'chunknet-download-' + crypto.randomUUID() + '.bin'); const out = fs.createWriteStream(tempPath); try { for (const meta of ordered) { let buffer = readChunkBuffer(meta.hash); if (!buffer) { const chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId); buffer = Buffer.from(chunk.data, 'base64'); } await new Promise((resolve, reject) => out.write(buffer, (error) => error ? reject(error) : resolve())); updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 }); } await new Promise((resolve, reject) => out.end((error) => error ? reject(error) : resolve())); if (manifest.isEncrypted) { const encrypted = fs.readFileSync(tempPath); const plain = decryptPrivateBuffer(encrypted, manifest, payload.drivePassword); fs.writeFileSync(save.filePath, plain); try { fs.unlinkSync(tempPath); } catch {} } else { fs.renameSync(tempPath, save.filePath); } finishProgress('download'); return { ok: true, file: manifest, path: save.filePath, progress: transferProgress.download }; } catch (error) { try { out.destroy(); } catch {} try { fs.unlinkSync(tempPath); } catch {} finishProgress('download', 'error', error?.message || String(error)); throw error; } });";

  if (s.includes(oldDownloadToPath)) s = s.replace(oldDownloadToPath, newDownloadToPath);
  return s;
});

patch('client/src/NativeP2PAppStable.tsx', (source) => {
  let s = source;
  s = s.replace('  | "p2p:download"\n  | "p2p:delete"', '  | "p2p:download"\n  | "p2p:downloadToPath"\n  | "p2p:delete"');

  const oldBlock = 'const downloadFile = (file: P2PFile) => runBusy(async () => {\n    if (!bridge) return;\n    const password = file.isEncrypted ? getDrivePassword() : null;\n    const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password });\n    const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "application/octet-stream" });\n    const url = URL.createObjectURL(blob);\n    const anchor = document.createElement("a");\n    anchor.href = url;\n    anchor.download = result.file.name;\n    document.body.appendChild(anchor);\n    anchor.click();\n    anchor.remove();\n    URL.revokeObjectURL(url);\n  });';
  const newBlock = 'const downloadFile = (file: P2PFile) => runBusy(async () => {\n    if (!bridge) return;\n    const password = file.isEncrypted ? getDrivePassword() : null;\n    const result = await bridge.invoke<{ ok?: boolean; cancelled?: boolean; path?: string }>("p2p:downloadToPath", { hash: file.hash, drivePassword: password });\n    if (result?.cancelled) return;\n    toast.success(result?.path ? `Downloaded to ${result.path}` : "Download complete");\n  });';
  s = s.replace(oldBlock, newBlock);
  return s;
});

console.log('[download-streaming] complete');
