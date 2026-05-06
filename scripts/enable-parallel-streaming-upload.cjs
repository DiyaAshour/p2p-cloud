const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const rel = path.join('electron', 'main.js');
const file = path.join(root, rel);
let src = fs.readFileSync(file, 'utf8');

const startNeedle = 'async function uploadFilePathPayload(payload = {}) {';
const endNeedle = '\nfunction writeStreamBuffer(stream, buffer) {';
const start = src.indexOf(startNeedle);
const end = src.indexOf(endNeedle, start);

if (start === -1 || end === -1) {
  console.log('[parallel-upload] uploadFilePathPayload block not found; skipping');
  process.exit(0);
}

if (src.slice(start, end).includes("uploadMode: 'parallel-stream-path-v2'")) {
  console.log('[parallel-upload] already applied');
  process.exit(0);
}

const replacement = `async function uploadFilePathPayload(payload = {}) {
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
  const pendingUploads = new Set();
  const streamUploadConcurrency = Math.max(1, Math.min(12, Number(payload.uploadConcurrency || process.env.P2P_STREAM_UPLOAD_CONCURRENCY || UPLOAD_CONCURRENCY || 4)));
  let chunkIndex = 0;
  let storedSize = 0;
  let cipher = null;
  let encryption = null;

  async function enqueueStoredChunk(data, index, progressBytes) {
    if (!Buffer.isBuffer(data) || data.length === 0) return;
    const task = (async () => {
      const meta = await storeUploadChunkForManifest({ node, data, index, ownerWallet, privateFile, fileReplicas });
      if (meta) chunkResults[index] = meta;
      updateProgress('upload', { bytesDelta: progressBytes, chunkDelta: 1 });
    })();
    pendingUploads.add(task);
    task.finally(() => pendingUploads.delete(task));
    if (pendingUploads.size >= streamUploadConcurrency) await Promise.race(pendingUploads);
  }

  if (privateFile) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveDriveKey({ ownerWallet, drivePassword, salt });
    cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    encryption = { version: 5, algorithm: ENCRYPTION_ALGORITHM, keySource: ENCRYPTION_KEY_SOURCE, kdf: KDF_ALGORITHM, kdfIterations: KDF_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: null, originalHash: null, originalSize: stat.size, mode: 'parallel-stream-file' };
  }

  const estimatedChunks = Math.max(1, Math.ceil(stat.size / CHUNK_SIZE_BYTES));
  createProgress('upload', { fileName, totalBytes: stat.size, totalChunks: estimatedChunks, concurrency: streamUploadConcurrency });

  try {
    const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES });
    for await (const plainChunk of stream) {
      const plainBuffer = Buffer.from(plainChunk);
      originalHash.update(plainBuffer);
      const storedData = privateFile ? cipher.update(plainBuffer) : plainBuffer;
      if (storedData.length > 0) {
        storedHash.update(storedData);
        storedSize += storedData.length;
        await enqueueStoredChunk(storedData, chunkIndex, plainBuffer.length);
        chunkIndex += 1;
      }
    }

    if (privateFile) {
      const finalData = cipher.final();
      if (finalData.length > 0) {
        storedHash.update(finalData);
        storedSize += finalData.length;
        await enqueueStoredChunk(finalData, chunkIndex, 0);
        chunkIndex += 1;
      }
      encryption.authTag = cipher.getAuthTag().toString('base64');
      encryption.originalHash = originalHash.digest('hex');
    } else {
      originalHash.digest('hex');
    }

    await Promise.all(Array.from(pendingUploads));
  } catch (error) {
    finishProgress('upload', 'error', error?.message || String(error));
    throw error;
  }

  const orderedChunkResults = chunkResults.filter(Boolean).sort((a, b) => a.index - b.index);
  if (!orderedChunkResults.length) throw new Error('Empty files are not supported yet');
  const tree = buildMerkleTree(orderedChunkResults.map((chunk) => chunk.hash));
  const chunksWithProof = orderedChunkResults.map((chunk) => ({ ...chunk, proof: getMerkleProof(tree, chunk.index) }));
  const finalStoredHash = storedHash.digest('hex');
  const manifest = { id: ownerWallet + ':' + finalStoredHash, name: fileName, size: stat.size, storedSize, hash: finalStoredHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption, mimeType, chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunksWithProof.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: unique(Array.from(fileReplicas)), chunks: chunksWithProof, uploadMode: 'parallel-stream-path-v2', uploadConcurrency: streamUploadConcurrency };

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

src = src.slice(0, start) + replacement + src.slice(end);
fs.writeFileSync(file, src, 'utf8');
console.log('[parallel-upload] patched electron/main.js');
