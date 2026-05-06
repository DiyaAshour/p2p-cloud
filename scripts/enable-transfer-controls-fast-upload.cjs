const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function write(rel, content) { fs.writeFileSync(path.join(root, rel), content, 'utf8'); console.log(`[transfer-controls] patched ${rel}`); }

function patchPreload() {
  const rel = 'electron/preload.cjs';
  let src = read(rel);
  for (const channel of ['p2p:pauseTransfer', 'p2p:resumeTransfer', 'p2p:cancelTransfer']) {
    if (!src.includes(`'${channel}'`)) src = src.replace("  'p2p:networkSummary',\n", `  'p2p:networkSummary',\n  '${channel}',\n`);
  }
  write(rel, src);
}

function patchMain() {
  const rel = 'electron/main.js';
  let src = read(rel);

  if (src.includes("const SAFETY_UPLOAD_MAX_QUEUE = Math.max(0, Number(process.env.P2P_SAFETY_UPLOAD_MAX_QUEUE || 32));")) {
    src = src.replace("const SAFETY_UPLOAD_MAX_QUEUE = Math.max(0, Number(process.env.P2P_SAFETY_UPLOAD_MAX_QUEUE || 32));", "const SAFETY_UPLOAD_MAX_QUEUE = Math.max(0, Number(process.env.P2P_SAFETY_UPLOAD_MAX_QUEUE || 8));");
  }
  if (src.includes("const SAFETY_UPLOAD_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.P2P_SAFETY_UPLOAD_CONCURRENCY || 2)));")) {
    src = src.replace("const SAFETY_UPLOAD_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.P2P_SAFETY_UPLOAD_CONCURRENCY || 2)));", "const SAFETY_UPLOAD_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.P2P_SAFETY_UPLOAD_CONCURRENCY || 1)));");
  }

  if (!src.includes('let transferControl =')) {
    src = src.replace(
      'let transferProgress = { upload: null, download: null };',
      `let transferProgress = { upload: null, download: null };
let transferControl = { upload: { paused: false, canceled: false }, download: { paused: false, canceled: false } };
let backgroundSafetyQueue = [];
let backgroundSafetyRunning = 0;
const SAFETY_UPLOAD_MODE = String(process.env.P2P_UPLOAD_SAFETY_MODE || 'background').toLowerCase();
const SAFETY_UPLOAD_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.P2P_SAFETY_UPLOAD_CONCURRENCY || 1)));
const SAFETY_UPLOAD_MAX_QUEUE = Math.max(0, Number(process.env.P2P_SAFETY_UPLOAD_MAX_QUEUE || 8));`
    );
  }

  if (!src.includes('function resetTransferControl(kind)')) {
    const helpers = `
function resetTransferControl(kind) {
  transferControl[kind] = { paused: false, canceled: false };
}
function setTransferPaused(kind, paused) {
  if (!transferControl[kind]) transferControl[kind] = { paused: false, canceled: false };
  transferControl[kind].paused = Boolean(paused);
  if (transferProgress[kind]?.active) transferProgress[kind] = { ...transferProgress[kind], phase: paused ? 'paused' : 'running', updatedAt: new Date().toISOString() };
  return { ok: true, kind, paused: transferControl[kind].paused, canceled: transferControl[kind].canceled };
}
function setTransferCanceled(kind) {
  if (!transferControl[kind]) transferControl[kind] = { paused: false, canceled: false };
  transferControl[kind].canceled = true;
  transferControl[kind].paused = false;
  if (kind === 'upload') backgroundSafetyQueue = [];
  finishProgress(kind, 'canceled', 'Canceled by user');
  return { ok: true, kind, paused: false, canceled: true };
}
function assertTransferNotCanceled(kind) {
  if (transferControl[kind]?.canceled) throw new Error('Transfer canceled');
}
async function waitIfTransferPaused(kind) {
  while (transferControl[kind]?.paused && !transferControl[kind]?.canceled) await new Promise((resolve) => setTimeout(resolve, 100));
  assertTransferNotCanceled(kind);
}
function scheduleBackgroundSafetyPut(chunkPayload, peerId) {
  if (SAFETY_UPLOAD_MODE === 'off' || transferControl.upload?.canceled) return false;
  if (SAFETY_UPLOAD_MAX_QUEUE > 0 && backgroundSafetyQueue.length >= SAFETY_UPLOAD_MAX_QUEUE) return false;
  backgroundSafetyQueue.push({ chunkPayload, peerId });
  drainBackgroundSafetyQueue();
  return true;
}
function drainBackgroundSafetyQueue() {
  while (!transferControl.upload?.canceled && backgroundSafetyRunning < SAFETY_UPLOAD_CONCURRENCY && backgroundSafetyQueue.length > 0) {
    const job = backgroundSafetyQueue.shift();
    backgroundSafetyRunning += 1;
    putChunkToSafetyPeer(job.chunkPayload, job.peerId)
      .catch((error) => console.warn('[safety-peer] background upload failed:', job.chunkPayload.hash, error?.message || error))
      .finally(() => { backgroundSafetyRunning -= 1; drainBackgroundSafetyQueue(); });
  }
}
`;
    src = src.replace('\nasync function mapWithConcurrency', `${helpers}\nasync function mapWithConcurrency`);
  }

  if (!src.includes('async function storeUploadChunkFastForManifest')) {
    const fastStore = `
async function storeUploadChunkFastForManifest({ node, data, index, ownerWallet, privateFile, fileReplicas }) {
  assertTransferNotCanceled('upload');
  if (!Buffer.isBuffer(data) || data.length === 0) return null;
  const hash = hashBufferHex(data);
  const chunkPayload = { hash, data: data.toString('base64'), index, size: data.length, ownerWallet, encrypted: privateFile };
  const replicas = replicateChunk(node, chunkPayload, [node.peerId], TARGET_REPLICAS);
  const scheduledSafety = scheduleBackgroundSafetyPut(chunkPayload, node.peerId);
  if (scheduledSafety) replicas.push('aws-safety-peer-pending');
  for (const peerId of replicas || []) fileReplicas.add(peerId);
  return { index, hash, size: data.length, replicas: unique(replicas) };
}
`;
    const insertAt = src.indexOf('async function uploadFilePathPayload(payload = {})');
    if (insertAt !== -1) src = src.slice(0, insertAt) + fastStore + '\n' + src.slice(insertAt);
  }

  const startNeedle = 'async function uploadFilePathPayload(payload = {}) {';
  const endNeedle = '\nfunction writeStreamBuffer(stream, buffer) {';
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start);
  if (start !== -1 && end !== -1) {
    const current = src.slice(start, end);
    if (!current.includes("uploadMode: 'parallel-stream-path-v4'")) {
      const replacement = `async function uploadFilePathPayload(payload = {}) {
  resetTransferControl('upload');
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
  const streamUploadConcurrency = Math.max(1, Math.min(8, Number(payload.uploadConcurrency || process.env.P2P_STREAM_UPLOAD_CONCURRENCY || 4)));
  let chunkIndex = 0;
  let storedSize = 0;
  let cipher = null;
  let encryption = null;
  let stream = null;

  async function enqueueStoredChunk(data, index, progressBytes) {
    assertTransferNotCanceled('upload');
    await waitIfTransferPaused('upload');
    const task = (async () => {
      await waitIfTransferPaused('upload');
      const meta = await storeUploadChunkFastForManifest({ node, data, index, ownerWallet, privateFile, fileReplicas });
      assertTransferNotCanceled('upload');
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
    encryption = { version: 7, algorithm: ENCRYPTION_ALGORITHM, keySource: ENCRYPTION_KEY_SOURCE, kdf: KDF_ALGORITHM, kdfIterations: KDF_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: null, originalHash: null, originalSize: stat.size, mode: 'parallel-stream-file-fast-safety-v4' };
  }

  createProgress('upload', { fileName, totalBytes: stat.size, totalChunks: Math.max(1, Math.ceil(stat.size / CHUNK_SIZE_BYTES)), concurrency: streamUploadConcurrency });

  try {
    stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES });
    for await (const plainChunk of stream) {
      assertTransferNotCanceled('upload');
      await waitIfTransferPaused('upload');
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

    assertTransferNotCanceled('upload');
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
    } else originalHash.digest('hex');

    await Promise.all(Array.from(pendingUploads));
    assertTransferNotCanceled('upload');
  } catch (error) {
    try { stream?.destroy?.(); } catch {}
    backgroundSafetyQueue = [];
    const message = error?.message || String(error);
    finishProgress('upload', message.includes('canceled') || message.includes('canceled') ? 'canceled' : 'error', message);
    throw error;
  }

  const orderedChunkResults = chunkResults.filter(Boolean).sort((a, b) => a.index - b.index);
  if (!orderedChunkResults.length) throw new Error('Empty files are not supported yet');
  const tree = buildMerkleTree(orderedChunkResults.map((chunk) => chunk.hash));
  const chunksWithProof = orderedChunkResults.map((chunk) => ({ ...chunk, proof: getMerkleProof(tree, chunk.index) }));
  const finalStoredHash = storedHash.digest('hex');
  const manifest = { id: ownerWallet + ':' + finalStoredHash, name: fileName, size: stat.size, storedSize, hash: finalStoredHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption, mimeType, chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunksWithProof.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: unique(Array.from(fileReplicas)), chunks: chunksWithProof, uploadMode: 'parallel-stream-path-v4', uploadConcurrency: streamUploadConcurrency, safetyMode: SAFETY_UPLOAD_MODE };

  manifests = manifests.filter((m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
  manifests.push(manifest);
  persistManifests();
  persistWallet();
  await syncPush(manifest);
  try { await syncPull(); } catch (error) { console.warn('[manifest-sync] upload pull skipped:', error?.message || error); }
  finishProgress('upload');
  return { ok: true, file: manifest, summary: networkSummary(), sync: lastSyncStatus, progress: transferProgress.upload };
}
`;
      src = src.slice(0, start) + replacement + src.slice(end);
    }
  }

  if (!src.includes("ipcMain.handle('p2p:pauseTransfer'")) {
    src = src.replace("ipcMain.handle('p2p:networkSummary',", "ipcMain.handle('p2p:pauseTransfer', async (_event, payload = {}) => setTransferPaused(String(payload.kind || 'upload'), true));\nipcMain.handle('p2p:resumeTransfer', async (_event, payload = {}) => setTransferPaused(String(payload.kind || 'upload'), false));\nipcMain.handle('p2p:cancelTransfer', async (_event, payload = {}) => setTransferCanceled(String(payload.kind || 'upload')));\n\nipcMain.handle('p2p:networkSummary',");
  }

  write(rel, src);
}

function patchOverlay() {
  const rel = 'client/src/TransferProgressOverlay.tsx';
  let src = read(rel);

  src = src.replace("import { Download, Upload, XCircle } from 'lucide-react';", "import { Download, Pause, Play, Upload, X, XCircle } from 'lucide-react';");
  src = src.replace("invoke: <T>(channel: 'p2p:networkSummary') => Promise<T>;", "invoke: <T>(channel: 'p2p:networkSummary' | 'p2p:pauseTransfer' | 'p2p:resumeTransfer' | 'p2p:cancelTransfer', payload?: unknown) => Promise<T>;");

  if (!src.includes('function transferAction')) {
    const actionFn = `
async function transferAction(type: 'upload' | 'download', action: 'pause' | 'resume' | 'cancel') {
  const bridge = getProgressBridge();
  if (!bridge) return;
  const channel = action === 'pause' ? 'p2p:pauseTransfer' : action === 'resume' ? 'p2p:resumeTransfer' : 'p2p:cancelTransfer';
  await bridge.invoke(channel, { kind: type });
}
`;
    src = src.replace("function progressLabel(type: 'upload' | 'download') {", `${actionFn}\nfunction progressLabel(type: 'upload' | 'download') {`);
  }

  if (!src.includes("aria-label={`Cancel ${type}`}")) {
    const anchor = `      {progress.error && (`;
    const buttons = `      {type === 'upload' && progress.active && !isError && (
        <div className="mt-3 flex justify-end gap-2">
          {progress.phase === 'paused' ? (
            <button type="button" aria-label={\`Resume \${type}\`} onClick={() => void transferAction(type, 'resume')} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-800"><Play className="size-3" />Resume</button>
          ) : (
            <button type="button" aria-label={\`Pause \${type}\`} onClick={() => void transferAction(type, 'pause')} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-800"><Pause className="size-3" />Pause</button>
          )}
          <button type="button" aria-label={\`Cancel \${type}\`} onClick={() => void transferAction(type, 'cancel')} className="inline-flex items-center gap-1 rounded-lg border border-red-800 px-2 py-1 text-xs text-red-200 hover:bg-red-950"><X className="size-3" />Cancel</button>
        </div>
      )}

`;
    src = src.replace(anchor, buttons + anchor);
  }

  write(rel, src);
}

patchPreload();
patchMain();
patchOverlay();
console.log('[transfer-controls] done');
