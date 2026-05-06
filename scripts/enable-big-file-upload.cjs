const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
  console.log(`[big-file-upload] patched ${rel}`);
}

function replaceOnce(content, search, replacement, label) {
  if (!content.includes(search)) {
    if (content.includes(replacement)) {
      console.log(`[big-file-upload] ${label} already applied`);
      return content;
    }
    throw new Error(`Could not find patch target: ${label}`);
  }
  return content.replace(search, replacement);
}

function replaceRegex(content, regex, replacement, label) {
  if (regex.test(content)) return content.replace(regex, replacement);
  if (content.includes(replacement.slice(0, 120))) {
    console.log(`[big-file-upload] ${label} already applied`);
    return content;
  }
  throw new Error(`Could not find patch target: ${label}`);
}

function patchPreload() {
  const rel = 'electron/preload.cjs';
  let src = read(rel);
  src = replaceOnce(src, "  'p2p:upload',\n", "  'p2p:upload',\n  'p2p:uploadPath',\n", 'allow p2p:uploadPath');
  src = replaceOnce(src, "  'system:open-external',\n", "  'system:open-external',\n  'system:pickFiles',\n", 'allow system:pickFiles');
  write(rel, src);
}

function patchMain() {
  const rel = 'electron/main.js';
  let src = read(rel);

  src = replaceOnce(
    src,
    "import { app, BrowserWindow, ipcMain, shell } from 'electron';",
    "import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';",
    'import Electron dialog'
  );

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
    throw new Error(\`Safety peer upload failed for chunk \${hash}: \${error?.message || error}\`);
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
    encryption = {
      version: 4,
      algorithm: ENCRYPTION_ALGORITHM,
      keySource: ENCRYPTION_KEY_SOURCE,
      kdf: KDF_ALGORITHM,
      kdfIterations: KDF_ITERATIONS,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: null,
      originalHash: null,
      originalSize: stat.size,
    };
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
  const manifest = {
    id: \`${ownerWallet}:\${finalStoredHash}\`,
    name: fileName,
    size: stat.size,
    storedSize,
    hash: finalStoredHash,
    rootHash: tree.root,
    uploadedAt: new Date().toISOString(),
    isEncrypted: privateFile,
    visibility: privateFile ? 'private' : 'public',
    isPublic: !privateFile,
    encryption,
    mimeType,
    chunkSize: CHUNK_SIZE_BYTES,
    totalChunks: chunksWithProof.length,
    ownerNodeId: node.peerId,
    ownerWallet,
    planId: walletState.planId,
    replicas: unique(Array.from(fileReplicas)),
    chunks: chunksWithProof,
    uploadMode: 'stream-path-v1',
  };

  manifests = manifests.filter((m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
  manifests.push(manifest);
  persistManifests();
  persistWallet();
  await syncPush(manifest);
  await syncPull();
  finishProgress('upload');
  return { ok: true, file: manifest, summary: networkSummary(), sync: lastSyncStatus, progress: transferProgress.upload };
}
`;

  src = replaceOnce(src, "\nfunction ensureDataDir() {", `${helpers}\nfunction ensureDataDir() {`, 'add streaming upload helpers');

  src = replaceOnce(
    src,
    "ipcMain.handle('system:open-external', async (_event, payload = {}) => { const url = String(payload.url || ''); if (!/^https?:\\/\\//i.test(url)) throw new Error('Invalid external URL'); await shell.openExternal(url); return { ok: true }; });\n",
    "ipcMain.handle('system:open-external', async (_event, payload = {}) => { const url = String(payload.url || ''); if (!/^https?:\\/\\//i.test(url)) throw new Error('Invalid external URL'); await shell.openExternal(url); return { ok: true }; });\nipcMain.handle('system:pickFiles', async () => { const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] }); if (result.canceled) return { ok: false, files: [] }; return { ok: true, files: result.filePaths.map((filePath) => { const stat = fs.statSync(filePath); return { path: filePath, name: path.basename(filePath), size: stat.size, mimeType: 'application/octet-stream' }; }) }; });\n",
    'add native file picker'
  );

  src = replaceOnce(src, "\n});\n\nipcMain.handle('p2p:download'", "\n});\n\nipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => uploadFilePathPayload(payload));\n\nipcMain.handle('p2p:download'", 'register p2p:uploadPath');

  write(rel, src);
}

function patchNativeApp() {
  const rel = 'client/src/NativeP2PApp.tsx';
  let src = read(rel);

  src = replaceOnce(src, '"p2p:upload" | "p2p:download"', '"p2p:upload" | "p2p:uploadPath" | "p2p:download"', 'add uploadPath channel type');
  src = replaceOnce(src, '"electron:openDevTools" | "electron:diagnostics";', '"electron:openDevTools" | "electron:diagnostics" | "system:pickFiles";', 'add pickFiles channel type');
  src = replaceOnce(src, 'type WalletPlan = { id: string; name: string; quotaBytes: number; priceUsd: number; locked?: boolean };', 'type WalletPlan = { id: string; name: string; quotaBytes: number; priceUsd: number; locked?: boolean };\ntype NativePickedFile = { path: string; name: string; size: number; mimeType?: string };', 'add native picked file type');
  src = replaceOnce(src, '  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);', '  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);\n  const [nativeSelectedFiles, setNativeSelectedFiles] = useState<NativePickedFile[]>([]);', 'add native selected files state');
  src = replaceOnce(src, '  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles]);', '  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0) + nativeSelectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles, nativeSelectedFiles]);', 'include native files in quota preview');

  const pickFn = `
  const pickLargeFiles = () => runBusy(async () => {
    if (!walletConnected) throw new Error("Connect your wallet before uploading");
    const result = await bridge.invoke<{ ok: boolean; files: NativePickedFile[] }>("system:pickFiles");
    const picked = Array.isArray(result.files) ? result.files : [];
    if (!picked.length) return;
    setNativeSelectedFiles((current) => [...current, ...picked]);
    toast.success(`${picked.length} large file(s) ready to upload`);
  });
`;
  src = replaceOnce(src, '  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => setSelectedFiles(Array.from(event.target.files || []));\n', `  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => setSelectedFiles(Array.from(event.target.files || []));\n${pickFn}`, 'add native picker function');

  const uploadReplacement = '  const uploadFiles = () => runBusy(async () => { if (!walletConnected) throw new Error("Connect your wallet before uploading"); if (uploadWouldExceedQuota) throw new Error("Storage quota exceeded. Upgrade your plan."); if (!selectedFiles.length && !nativeSelectedFiles.length) throw new Error("Select at least one file"); const password = getDrivePassword(); const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; const uploadedHashes: string[] = []; for (const file of selectedFiles) { const result = await bridge.invoke<{ file?: P2PFile }>("p2p:upload", { name: file.name, mimeType: file.type || "application/octet-stream", isEncrypted, drivePassword: password, bytes: await file.arrayBuffer() }); if (result?.file?.hash) uploadedHashes.push(result.file.hash); } for (const file of nativeSelectedFiles) { const result = await bridge.invoke<{ file?: P2PFile }>("p2p:uploadPath", { path: file.path, name: file.name, mimeType: file.mimeType || "application/octet-stream", isEncrypted, drivePassword: password }); if (result?.file?.hash) uploadedHashes.push(result.file.hash); } if (targetFolder && uploadedHashes.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploadedHashes.map((hash) => [hash, targetFolder])) })); setSelectedFiles([]); setNativeSelectedFiles([]); toast.success("Files stored safely"); await refreshAll(); });';
  src = replaceRegex(src, /  const uploadFiles = \(\) => runBusy\(async \(\) => \{ if \(!walletConnected\).*?await refreshAll\(\); \}\);/s, uploadReplacement, 'route native selected files through p2p:uploadPath');

  src = replaceOnce(
    src,
    '<Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} />',
    '<div className="grid gap-2 sm:grid-cols-2"><Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} /><Button type="button" variant="outline" onClick={pickLargeFiles} disabled={!walletConnected || busy}><HardDrive className="size-4" />Choose large files</Button></div>',
    'add large file picker button'
  );

  src = replaceOnce(
    src,
    '{selectedFiles.length > 0 && <div className="grid gap-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:grid-cols-2 lg:grid-cols-3">',
    '{nativeSelectedFiles.length > 0 && <div className="rounded-2xl border border-emerald-900 bg-emerald-950/30 p-4 text-sm text-emerald-100"><p className="font-medium">Large files selected</p><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{nativeSelectedFiles.map((file, index) => <div key={`${file.path}-${index}`} className="truncate rounded-xl bg-zinc-950/70 p-3">{file.name} · {formatBytes(file.size)}</div>)}</div></div>}{selectedFiles.length > 0 && <div className="grid gap-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:grid-cols-2 lg:grid-cols-3">',
    'show selected large files'
  );

  write(rel, src);
}

function main() {
  patchPreload();
  patchMain();
  patchNativeApp();
  console.log('\n[big-file-upload] done. Run: pnpm run check && pnpm run electron:dev');
}

main();
