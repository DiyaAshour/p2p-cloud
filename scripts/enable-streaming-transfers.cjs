const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
  console.log(`[streaming-transfers] patched ${rel}`);
}

function ensureAfter(src, anchor, line, label) {
  if (src.includes(line)) {
    console.log(`[streaming-transfers] ${label} already applied`);
    return src;
  }
  if (!src.includes(anchor)) {
    console.log(`[streaming-transfers] ${label} anchor not found; skipping`);
    return src;
  }
  return src.replace(anchor, anchor + line);
}

function replaceBlockBetween(src, startNeedle, endNeedle, replacement, label) {
  if (src.includes(replacement)) {
    console.log(`[streaming-transfers] ${label} already applied`);
    return src;
  }
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start);
  if (start === -1 || end === -1) {
    console.log(`[streaming-transfers] ${label} block not found; skipping`);
    return src;
  }
  return src.slice(0, start) + replacement + '\n  ' + src.slice(end);
}

function patchPreload() {
  const rel = 'electron/preload.cjs';
  let src = read(rel);
  src = ensureAfter(src, "  'p2p:upload',\n", "  'p2p:uploadPath',\n", 'allow uploadPath');
  src = ensureAfter(src, "  'p2p:download',\n", "  'p2p:downloadToPath',\n", 'allow downloadToPath');
  src = ensureAfter(src, "  'system:open-external',\n", "  'system:pickFiles',\n", 'allow pickFiles');
  write(rel, src);
}

function patchMain() {
  const rel = 'electron/main.js';
  let src = read(rel);

  if (src.includes("import { app, BrowserWindow, ipcMain, shell } from 'electron';")) {
    src = src.replace("import { app, BrowserWindow, ipcMain, shell } from 'electron';", "import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';");
  }

  const helpers = `
async function storeUploadChunkForManifest({ node, data, index, ownerWallet, privateFile, fileReplicas }) {
  if (!Buffer.isBuffer(data) || data.length === 0) return null;
  const hash = hashBufferHex(data);
  const chunkPayload = { hash, data: data.toString('base64'), index, size: data.length, ownerWallet, encrypted: privateFile };
  const replicas = replicateChunk(node, chunkPayload, [node.peerId], TARGET_REPLICAS);
  try {
    await putChunkToSafetyPeer(chunkPayload, node.peerId);
    replicas.push('aws-safety-peer');
  } catch (error) {
    throw new Error('Safety peer upload failed for chunk ' + hash + ': ' + (error?.message || error));
  }
  for (const peerId of replicas || []) fileReplicas.add(peerId);
  return { index, hash, size: data.length, replicas: unique(replicas) };
}

async function uploadFilePathPayload(payload = {}) {
  const node = ensureTransport({});
  const filePath = path.resolve(String(payload.path || payload.filePath || ''));
  if (!filePath || !fs.existsSync(filePath)) throw new Error('File path not found');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Selected path is not a file');
  assertWalletUploadAllowed(stat.size);

  const ownerWallet = activeWallet();
  const privateFile = Boolean(payload.isEncrypted);
  const drivePassword = privateFile ? drivePasswordFromPayload(payload) : null;
  const fileName = String(payload.name || path.basename(filePath) || 'file');
  const mimeType = payload.mimeType ? String(payload.mimeType) : 'application/octet-stream';
  const originalHash = crypto.createHash('sha256');
  const storedHash = crypto.createHash('sha256');
  const fileReplicas = new Set([node.peerId]);
  const chunkResults = [];
  let chunkIndex = 0;
  let storedSize = 0;
  let cipher = null;
  let encryption = null;

  if (privateFile) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveDriveKey({ ownerWallet, drivePassword, salt });
    cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    encryption = { version: 5, algorithm: ENCRYPTION_ALGORITHM, keySource: ENCRYPTION_KEY_SOURCE, kdf: KDF_ALGORITHM, kdfIterations: KDF_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: null, originalHash: null, originalSize: stat.size, mode: 'stream-file' };
  }

  const estimatedChunks = Math.max(1, Math.ceil(stat.size / CHUNK_SIZE_BYTES));
  createProgress('upload', { fileName, totalBytes: stat.size, totalChunks: estimatedChunks, concurrency: 1 });

  try {
    const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES });
    for await (const plainChunk of stream) {
      const plainBuffer = Buffer.from(plainChunk);
      originalHash.update(plainBuffer);
      const storedData = privateFile ? cipher.update(plainBuffer) : plainBuffer;
      if (storedData.length > 0) {
        storedHash.update(storedData);
        storedSize += storedData.length;
        const meta = await storeUploadChunkForManifest({ node, data: storedData, index: chunkIndex, ownerWallet, privateFile, fileReplicas });
        if (meta) chunkResults.push(meta);
        chunkIndex += 1;
      }
      updateProgress('upload', { bytesDelta: plainBuffer.length, chunkDelta: 1 });
    }

    if (privateFile) {
      const finalData = cipher.final();
      if (finalData.length > 0) {
        storedHash.update(finalData);
        storedSize += finalData.length;
        const meta = await storeUploadChunkForManifest({ node, data: finalData, index: chunkIndex, ownerWallet, privateFile, fileReplicas });
        if (meta) chunkResults.push(meta);
      }
      encryption.authTag = cipher.getAuthTag().toString('base64');
      encryption.originalHash = originalHash.digest('hex');
    } else {
      originalHash.digest('hex');
    }
  } catch (error) {
    finishProgress('upload', 'error', error?.message || String(error));
    throw error;
  }

  if (!chunkResults.length) throw new Error('Empty files are not supported yet');
  const tree = buildMerkleTree(chunkResults.map((chunk) => chunk.hash));
  const chunksWithProof = chunkResults.map((chunk) => ({ ...chunk, proof: getMerkleProof(tree, chunk.index) }));
  const finalStoredHash = storedHash.digest('hex');
  const manifest = { id: ownerWallet + ':' + finalStoredHash, name: fileName, size: stat.size, storedSize, hash: finalStoredHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption, mimeType, chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunksWithProof.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: unique(Array.from(fileReplicas)), chunks: chunksWithProof, uploadMode: 'stream-path-v1' };

  manifests = manifests.filter((m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
  manifests.push(manifest);
  persistManifests();
  persistWallet();
  await syncPush(manifest);
  await syncPull();
  finishProgress('upload');
  return { ok: true, file: manifest, summary: networkSummary(), sync: lastSyncStatus, progress: transferProgress.upload };
}

function writeStreamBuffer(stream, buffer) {
  if (!buffer || buffer.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => stream.write(buffer, (error) => error ? reject(error) : resolve()));
}

async function resolveStoredChunkBuffer(node, meta) {
  const local = node.getLocalChunk?.(meta.hash) || node.localChunks?.get(meta.hash);
  let chunk = local;
  if (!chunk) {
    try {
      chunk = await node.fetchChunkFromNetwork(meta.hash);
    } catch (error) {
      console.warn('[p2p:downloadToPath] network fetch failed, trying safety peer:', error?.message || error);
      chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId);
    }
  }
  node.storeLocalChunk?.(chunk);
  const buffer = Buffer.from(chunk.data, 'base64');
  if (hashBufferHex(buffer) !== meta.hash) throw new Error('Chunk integrity failed: ' + meta.hash);
  return buffer;
}

async function downloadFileToPathPayload(payload = {}) {
  assertVerifiedWallet();
  await syncPull();
  const node = ensureTransport({});
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this wallet');

  const saveResult = await dialog.showSaveDialog(mainWindow, { title: 'Save downloaded file', defaultPath: manifest.name || 'download.bin' });
  if (saveResult.canceled || !saveResult.filePath) return { ok: false, canceled: true };

  const outputPath = saveResult.filePath;
  const tempPath = outputPath + '.chunknet-download';
  const orderedChunks = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index);
  createProgress('download', { fileName: manifest.name, totalBytes: Number(manifest.storedSize || manifest.size || 0), totalChunks: orderedChunks.length, concurrency: 1 });

  let output = null;
  let decipher = null;
  let plainHash = null;

  try {
    if (manifest.isEncrypted) {
      if (!manifest?.encryption || manifest.encryption.algorithm !== ENCRYPTION_ALGORITHM) throw new Error('Encrypted file metadata is missing or unsupported');
      if (manifest.encryption.keySource !== ENCRYPTION_KEY_SOURCE) throw new Error('This file was encrypted with an older key source. Re-upload it with Drive Password encryption.');
      const key = deriveDriveKey({ ownerWallet: manifest.ownerWallet, drivePassword: drivePasswordFromPayload(payload), salt: manifest.encryption.salt });
      decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(manifest.encryption.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, 'base64'));
      plainHash = crypto.createHash('sha256');
    }

    output = fs.createWriteStream(tempPath);
    for (const meta of orderedChunks) {
      const storedBuffer = await resolveStoredChunkBuffer(node, meta);
      const plainBuffer = decipher ? decipher.update(storedBuffer) : storedBuffer;
      if (plainHash && plainBuffer.length) plainHash.update(plainBuffer);
      await writeStreamBuffer(output, plainBuffer);
      updateProgress('download', { bytesDelta: storedBuffer.length, chunkDelta: 1 });
    }

    if (decipher) {
      const finalBuffer = decipher.final();
      if (finalBuffer.length) {
        plainHash.update(finalBuffer);
        await writeStreamBuffer(output, finalBuffer);
      }
      const expectedHash = manifest.encryption?.originalHash;
      if (expectedHash && plainHash.digest('hex') !== expectedHash) throw new Error('Private file integrity failed after decrypt');
    }

    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
    fs.renameSync(tempPath, outputPath);
    finishProgress('download');
    return { ok: true, path: outputPath, file: { name: manifest.name, hash: manifest.hash, size: manifest.size } };
  } catch (error) {
    try { output?.destroy?.(); } catch {}
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    finishProgress('download', 'error', error?.message || String(error));
    if (String(error?.message || error).includes('authenticate')) throw new Error('Could not decrypt this file. Check Drive Password, wallet address, or re-upload the file if it was uploaded during a failed large transfer.');
    throw error;
  }
}
`;

  if (!src.includes('async function uploadFilePathPayload')) {
    const idx = src.indexOf('\nfunction ensureDataDir() {');
    if (idx >= 0) src = src.slice(0, idx) + helpers + src.slice(idx);
    else console.log('[streaming-transfers] main helper insert point not found; skipping');
  }

  if (!src.includes("ipcMain.handle('system:pickFiles'")) {
    src = src.replace("ipcMain.handle('system:open-external', async (_event, payload = {}) => { const url = String(payload.url || ''); if (!/^https?:\\/\\//i.test(url)) throw new Error('Invalid external URL'); await shell.openExternal(url); return { ok: true }; });",
      "ipcMain.handle('system:open-external', async (_event, payload = {}) => { const url = String(payload.url || ''); if (!/^https?:\\/\\//i.test(url)) throw new Error('Invalid external URL'); await shell.openExternal(url); return { ok: true }; });\nipcMain.handle('system:pickFiles', async () => { const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] }); if (result.canceled) return { ok: false, files: [] }; return { ok: true, files: result.filePaths.map((filePath) => { const stat = fs.statSync(filePath); return { path: filePath, name: path.basename(filePath), size: stat.size, mimeType: 'application/octet-stream' }; }) }; });");
  }

  if (!src.includes("ipcMain.handle('p2p:uploadPath'")) {
    src = src.replace("ipcMain.handle('p2p:download', async (_event, payload = {}) => {",
      "ipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => uploadFilePathPayload(payload));\n\nipcMain.handle('p2p:download', async (_event, payload = {}) => {");
  }
  if (!src.includes("ipcMain.handle('p2p:downloadToPath'")) {
    src = src.replace("ipcMain.handle('p2p:delete'", "ipcMain.handle('p2p:downloadToPath', async (_event, payload = {}) => downloadFileToPathPayload(payload));\n\nipcMain.handle('p2p:delete'");
  }

  write(rel, src);
}

function patchNativeApp() {
  const rel = 'client/src/NativeP2PApp.tsx';
  let src = read(rel);

  src = ensureAfter(src, '"p2p:upload" | ', '"p2p:uploadPath" | ', 'channel uploadPath');
  src = ensureAfter(src, '"p2p:download" | ', '"p2p:downloadToPath" | ', 'channel downloadToPath');
  src = ensureAfter(src, '"electron:diagnostics"', ' | "system:pickFiles"', 'channel pickFiles');

  if (!src.includes('type NativePickedFile')) {
    src = src.replace('type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };', 'type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };\ntype NativePickedFile = { path: string; name: string; size: number; mimeType?: string };\ntype DownloadToPathResult = { ok: boolean; canceled?: boolean; path?: string };');
  }

  if (!src.includes('nativeSelectedFiles')) {
    src = src.replace('  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);', '  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);\n  const [nativeSelectedFiles, setNativeSelectedFiles] = useState<NativePickedFile[]>([]);');
    src = src.replace('  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles]);', '  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0) + nativeSelectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles, nativeSelectedFiles]);');
  }

  if (!src.includes('const pickNativeFiles')) {
    src = src.replace('  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => setSelectedFiles(Array.from(event.target.files || []));', '  const pickNativeFiles = () => runBusy(async () => { if (!walletConnected) throw new Error("Connect your wallet before uploading"); const result = await bridge.invoke<{ ok: boolean; files: NativePickedFile[] }>("system:pickFiles"); const picked = Array.isArray(result.files) ? result.files : []; if (!picked.length) return; setNativeSelectedFiles((current) => [...current, ...picked]); toast.success(String(picked.length) + " file(s) ready to upload"); });\n  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => { void pickNativeFiles(); event.target.value = ""; };');
  }

  const uploadReplacement = '  const uploadFiles = () => runBusy(async () => { if (!walletConnected) throw new Error("Connect your wallet before uploading"); if (uploadWouldExceedQuota) throw new Error("Storage quota exceeded. Upgrade your plan."); if (!nativeSelectedFiles.length && !selectedFiles.length) throw new Error("Select at least one file"); const password = getDrivePassword(); const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; const uploadedHashes: string[] = []; for (const file of nativeSelectedFiles) { const result = await bridge.invoke<{ file?: P2PFile }>("p2p:uploadPath", { path: file.path, name: file.name, mimeType: file.mimeType || "application/octet-stream", isEncrypted, drivePassword: password }); if (result?.file?.hash) uploadedHashes.push(result.file.hash); } for (const file of selectedFiles) { const result = await bridge.invoke<{ file?: P2PFile }>("p2p:upload", { name: file.name, mimeType: file.type || "application/octet-stream", isEncrypted, drivePassword: password, bytes: await file.arrayBuffer() }); if (result?.file?.hash) uploadedHashes.push(result.file.hash); } if (targetFolder && uploadedHashes.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploadedHashes.map((hash) => [hash, targetFolder])) })); setSelectedFiles([]); setNativeSelectedFiles([]); toast.success("Files stored safely"); await refreshAll(); });';
  src = replaceBlockBetween(src, '  const uploadFiles = () => runBusy(async () => {', 'const downloadFile = ', uploadReplacement, 'force uploadFiles');

  const downloadReplacement = 'const downloadFile = (file: P2PFile) => runBusy(async () => { const password = file.isEncrypted ? getDrivePassword() : null; const result = await bridge.invoke<DownloadToPathResult>("p2p:downloadToPath", { hash: file.hash, drivePassword: password }); if (!result.canceled) toast.success("Download saved to disk"); });';
  src = replaceBlockBetween(src, 'const downloadFile = ', 'const previewImage = ', downloadReplacement, 'force downloadFile');

  src = src.replace('<Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} />', '<Button type="button" variant="outline" onClick={pickNativeFiles} disabled={!walletConnected || busy}><HardDrive className="size-4" />Choose files</Button><Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} className="hidden" />');

  if (!src.includes('Files selected</p><div')) {
    src = src.replace('{selectedFiles.length > 0 && <div className="grid gap-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:grid-cols-2 lg:grid-cols-3">', '{nativeSelectedFiles.length > 0 && <div className="rounded-2xl border border-emerald-900 bg-emerald-950/30 p-4 text-sm text-emerald-100"><p className="font-medium">Files selected</p><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{nativeSelectedFiles.map((file, index) => <div key={`${file.path}-${index}`} className="truncate rounded-xl bg-zinc-950/70 p-3">{file.name} · {formatBytes(file.size)}</div>)}</div></div>}{selectedFiles.length > 0 && <div className="grid gap-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:grid-cols-2 lg:grid-cols-3">');
  }

  write(rel, src);
}

function main() {
  patchPreload();
  patchMain();
  patchNativeApp();
  console.log('\n[streaming-transfers] done. Run: pnpm run electron:dev');
}

main();
