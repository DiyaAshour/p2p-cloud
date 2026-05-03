import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startP2PTransport } from './p2p-transport.js';
import { buildMerkleTree, getMerkleProof, verifyMerkleProof } from './merkle-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);
const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

let mainWindow = null;
let transportNode = null;
let manifests = [];
let proofQueue = [];
let dataDir = null;
let manifestsPath = null;
let proofsPath = null;

function loadJsonArray(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(`[p2p-storage] failed to load ${filePath}:`, error.message);
    return [];
  }
}

function writeJsonArray(filePath, value) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function persistState() {
  writeJsonArray(manifestsPath, manifests);
  writeJsonArray(proofsPath, proofQueue);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
  if (process.env.NODE_ENV === 'production') {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    mainWindow.loadURL(devUrl);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function ensureTransport(options = {}) {
  if (!transportNode) transportNode = startP2PTransport(options);
  return transportNode;
}

function hashBufferHex(buffer) {
  return `0x${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function splitIntoChunks(buffer, chunkSize = CHUNK_SIZE_BYTES) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const data = buffer.slice(i, i + chunkSize);
    chunks.push({
      index: chunks.length,
      size: data.length,
      data,
      hash: hashBufferHex(data),
    });
  }
  return chunks;
}

function findManifestByRoot(rootHash) {
  return manifests.find((manifest) => String(manifest.rootHash).toLowerCase() === String(rootHash).toLowerCase());
}

function currentStorageBytes() {
  return manifests.reduce((sum, file) => sum + Number(file.size || 0), 0);
}

function getNetworkSummary() {
  const node = ensureTransport({});
  const totalBytes = currentStorageBytes();
  const encryptedFiles = manifests.filter((file) => file.isEncrypted).length;
  const totalChunks = manifests.reduce((sum, file) => sum + Number(file.chunks?.length || 0), 0);
  const underReplicatedChunks = manifests.reduce((sum, file) => {
    return sum + (file.chunks || []).filter((chunk) => node.healthyReplicaIds(chunk.hash).length < TARGET_REPLICAS).length;
  }, 0);

  const connectedPeers = node.connectedPeerIds();

  return {
    ok: true,
    peerId: node.peerId,
    port: node.port,
    host: node.host,
    listenUrl: `ws://127.0.0.1:${node.port}`,
    peers: Array.from(node.peerInfo.values()),
    connectedPeerIds: connectedPeers,
    connectedPeers: connectedPeers.length,
    targetReplicas: TARGET_REPLICAS,
    files: manifests.length,
    totalFiles: manifests.length,
    encryptedFiles,
    publicFiles: manifests.length - encryptedFiles,
    totalBytes,
    totalMB: totalBytes / 1024 / 1024,
    totalChunks,
    underReplicatedChunks,
    queuedProofs: proofQueue.length,
    freeQuotaBytes: FREE_QUOTA_BYTES,
    freeQuotaRemainingBytes: Math.max(0, FREE_QUOTA_BYTES - totalBytes),
    readyForRealUpload: connectedPeers.length > 0,
  };
}

function buildProofPayload({ dealId, rootHash, challengeIndex }) {
  const manifest = findManifestByRoot(rootHash);
  if (!manifest) throw new Error(`manifest not found for root ${rootHash}`);

  const chunk = manifest.chunks.find((item) => item.index === Number(challengeIndex));
  if (!chunk) throw new Error(`chunk index not found: ${challengeIndex}`);

  const valid = verifyMerkleProof(manifest.rootHash, chunk.hash, chunk.proof);
  if (!valid) throw new Error('local merkle proof verification failed');

  return {
    dealId: Number(dealId),
    chunkIndex: Number(challengeIndex),
    rootHash: manifest.rootHash,
    leaf: chunk.hash,
    merkleProof: chunk.proof,
    contractCall: {
      method: 'submitProof',
      args: [Number(dealId), Number(challengeIndex), chunk.hash, chunk.proof],
    },
  };
}

ipcMain.handle('p2p:start', async (_event, options = {}) => {
  ensureTransport(options);
  return getNetworkSummary();
});

ipcMain.handle('p2p:status', async () => getNetworkSummary());
ipcMain.handle('p2p:networkSummary', async () => getNetworkSummary());

ipcMain.handle('p2p:connectPeer', async (_event, payload = {}) => {
  const node = ensureTransport({});
  const peerId = String(payload.peerId || '').trim();
  const url = String(payload.url || '').trim();

  if (!peerId) throw new Error('peerId is required');
  if (!/^wss?:\/\//i.test(url)) throw new Error('peer URL must start with ws:// or wss://');

  const result = node.connectPeer({ peerId, url });
  return { ...result, summary: getNetworkSummary() };
});

ipcMain.handle('p2p:upload', async (_event, payload) => {
  const node = ensureTransport({});
  const buffer = Buffer.from(payload.bytes);
  const walletAddress = String(payload.walletAddress || '').trim();

  if (!walletAddress) {
    throw new Error('Wallet connection is required before uploading to the real P2P network');
  }

  if (!node.connectedPeerIds().length) {
    throw new Error('No P2P peers connected. Open Network tab and connect a real peer first.');
  }

  if (currentStorageBytes() + buffer.length > FREE_QUOTA_BYTES && !payload.planId) {
    throw new Error('Free quota is 5GB. Connect a paid storage plan before uploading more data.');
  }

  const chunks = splitIntoChunks(buffer);
  const leaves = chunks.map((chunk) => chunk.hash);
  const tree = buildMerkleTree(leaves);
  const fileHash = hashBufferHex(buffer);

  const manifest = {
    name: payload.name,
    size: buffer.length,
    hash: fileHash,
    rootHash: tree.root,
    totalChunks: chunks.length,
    uploadedAt: new Date().toISOString(),
    isEncrypted: Boolean(payload.isEncrypted),
    mimeType: payload.mimeType || 'application/octet-stream',
    chunkSize: CHUNK_SIZE_BYTES,
    targetReplicas: TARGET_REPLICAS,
    ownerWallet: walletAddress,
    chunks: [],
  };

  for (const chunk of chunks) {
    const proof = getMerkleProof(tree, chunk.index);
    const targets = node.selectReplicaTargets({ limit: TARGET_REPLICAS });
    const result = node.putChunkOnNetwork(
      { hash: chunk.hash, data: chunk.data.toString('base64'), index: chunk.index, size: chunk.size },
      targets
    );

    manifest.chunks.push({
      hash: chunk.hash,
      index: chunk.index,
      size: chunk.size,
      proof,
      replicas: result.replicas || targets,
    });
  }

  manifests = manifests.filter((entry) => entry.rootHash !== manifest.rootHash);
  manifests.push(manifest);
  persistState();

  return { file: manifest, rootHash: manifest.rootHash, totalChunks: manifest.totalChunks, summary: getNetworkSummary() };
});

ipcMain.handle('p2p:listFiles', async () => manifests);

ipcMain.handle('p2p:download', async (_event, { rootHash, hash }) => {
  const node = ensureTransport({});
  const manifest = rootHash ? findManifestByRoot(rootHash) : manifests.find((item) => item.hash === hash);
  if (!manifest) return null;

  const buffers = [];
  for (const chunkMeta of [...manifest.chunks].sort((a, b) => a.index - b.index)) {
    const chunk = await node.fetchChunkFromNetwork(chunkMeta.hash);
    const chunkBuffer = Buffer.from(chunk.data, 'base64');
    if (hashBufferHex(chunkBuffer).toLowerCase() !== chunkMeta.hash.toLowerCase()) {
      throw new Error(`chunk integrity failed: ${chunkMeta.hash}`);
    }
    buffers.push(chunkBuffer);
  }

  const fileBuffer = Buffer.concat(buffers);
  if (hashBufferHex(fileBuffer).toLowerCase() !== manifest.hash.toLowerCase()) {
    throw new Error('file integrity failed');
  }

  return { bytes: Array.from(fileBuffer), file: manifest };
});

ipcMain.handle('p2p:getProof', async (_event, { rootHash, root, index }) => {
  const manifest = findManifestByRoot(rootHash || root);
  if (!manifest) throw new Error('manifest not found');
  const chunk = manifest.chunks.find((item) => item.index === Number(index));
  if (!chunk) throw new Error('chunk not found');
  return { rootHash: manifest.rootHash, index: chunk.index, hash: chunk.hash, proof: chunk.proof };
});

ipcMain.handle('p2p:prepareProof', async (_event, challenge) => {
  const payload = buildProofPayload(challenge);
  proofQueue = proofQueue.filter((item) => !(item.dealId === payload.dealId && item.chunkIndex === payload.chunkIndex));
  proofQueue.push({ ...payload, createdAt: new Date().toISOString(), status: 'ready' });
  persistState();
  return payload;
});

ipcMain.handle('p2p:queueChallenge', async (_event, challenge) => {
  const payload = buildProofPayload(challenge);
  proofQueue.push({ ...payload, createdAt: new Date().toISOString(), status: 'ready' });
  persistState();
  return { ok: true, proof: payload };
});

ipcMain.handle('p2p:proofQueue', async () => proofQueue);

ipcMain.handle('p2p:delete', async (_event, { rootHash, hash }) => {
  manifests = manifests.filter((item) => item.rootHash !== rootHash && item.hash !== hash);
  persistState();
  return { ok: true, summary: getNetworkSummary() };
});

ipcMain.handle('p2p:repair', async () => {
  const node = ensureTransport({});
  const report = [];

  for (const file of manifests) {
    for (const chunk of file.chunks || []) {
      const healthyReplicas = node.healthyReplicaIds(chunk.hash);
      report.push({
        file: file.name,
        rootHash: file.rootHash,
        chunkIndex: chunk.index,
        chunkHash: chunk.hash,
        healthyReplicas,
        targetReplicas: TARGET_REPLICAS,
        underReplicated: healthyReplicas.length < TARGET_REPLICAS,
      });
    }
  }

  return { ok: true, report, summary: getNetworkSummary() };
});

ipcMain.handle('p2p:stats', async () => getNetworkSummary());

ipcMain.handle('system:open-external', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error('Only http/https URLs can be opened');
  }
  await shell.openExternal(url);
  return { ok: true };
});

app.whenReady().then(() => {
  dataDir = path.join(app.getPath('userData'), 'p2p-storage');
  manifestsPath = path.join(dataDir, 'manifests.json');
  proofsPath = path.join(dataDir, 'proof-queue.json');
  manifests = loadJsonArray(manifestsPath);
  proofQueue = loadJsonArray(proofsPath);

  ensureTransport({});
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((error) => {
  console.error('Electron failed:', error);
  app.exit(1);
});

app.on('before-quit', () => {
  persistState();
  if (transportNode) transportNode.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
