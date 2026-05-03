import { app, BrowserWindow, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';
import { startP2PTransport } from './p2p-transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);

let mainWindow = null;
let transportNode = null;
let dataDir = null;
let manifestsPath = null;
let manifests = [];

function ensureDataDir() {
  if (dataDir && manifestsPath) return;
  dataDir = path.join(app.getPath('userData'), 'native-p2p-storage');
  manifestsPath = path.join(dataDir, 'manifests.json');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(manifestsPath)) fs.writeFileSync(manifestsPath, '[]', 'utf8');
}

function loadManifests() {
  ensureDataDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestsPath, 'utf8'));
    manifests = Array.isArray(parsed) ? parsed : [];
  } catch {
    manifests = [];
  }
}

function persistManifests() {
  ensureDataDir();
  fs.writeFileSync(manifestsPath, JSON.stringify(manifests, null, 2), 'utf8');
}

function ensureTransport(options = {}) {
  if (!transportNode) transportNode = startP2PTransport(options);
  return transportNode;
}

function hashBufferHex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function splitIntoChunks(buffer) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE_BYTES) {
    const data = buffer.slice(offset, offset + CHUNK_SIZE_BYTES);
    chunks.push({
      index: chunks.length,
      size: data.length,
      data,
      hash: hashBufferHex(data),
    });
  }
  return chunks;
}

function findManifest(payload = {}) {
  const hash = String(payload.hash || '');
  const rootHash = String(payload.rootHash || '');
  return manifests.find((manifest) => manifest.hash === hash || manifest.rootHash === rootHash);
}

function networkSummary() {
  const node = ensureTransport({});
  const peers = Array.from(node.peerInfo.values());
  const connectedPeerIds = node.connectedPeerIds();
  const totalBytes = manifests.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const totalChunks = manifests.reduce((sum, file) => sum + Number(file.chunks?.length || 0), 0);
  const underReplicatedChunks = manifests.reduce((sum, file) => {
    return sum + (file.chunks || []).filter((chunk) => {
      const replicaCount = new Set([node.peerId, ...(chunk.replicas || [])]).size;
      return replicaCount < TARGET_REPLICAS;
    }).length;
  }, 0);

  return {
    ok: true,
    peerId: node.peerId,
    port: node.port,
    host: node.host,
    listenUrl: `ws://127.0.0.1:${node.port}`,
    peers,
    connectedPeerIds,
    connectedPeers: connectedPeerIds.length,
    peerCount: connectedPeerIds.length,
    targetReplicas: TARGET_REPLICAS,
    totalFiles: manifests.length,
    files: manifests.length,
    encryptedFiles: manifests.filter((file) => file.isEncrypted).length,
    publicFiles: manifests.filter((file) => !file.isEncrypted).length,
    totalBytes,
    totalMB: totalBytes / 1024 / 1024,
    totalChunks,
    underReplicatedChunks,
  };
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

  if (process.env.NODE_ENV === 'production') {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'public', 'index.html'));
  } else {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000');
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('p2p:start', async (_event, options = {}) => {
  ensureDataDir();
  loadManifests();
  ensureTransport(options);
  return networkSummary();
});

ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => {
  const query = String(payload.query || '').trim().toLowerCase();
  if (!query) return manifests;
  return manifests.filter((file) => {
    return [file.name, file.hash, file.rootHash].some((value) => String(value || '').toLowerCase().includes(query));
  });
});

ipcMain.handle('p2p:upload', async (_event, payload = {}) => {
  const node = ensureTransport({});
  if (!payload.bytes) throw new Error('File bytes are required');

  const buffer = Buffer.from(payload.bytes);
  const chunks = splitIntoChunks(buffer);
  const tree = buildMerkleTree(chunks.map((chunk) => chunk.hash));
  const fileHash = hashBufferHex(buffer);

  const manifest = {
    id: fileHash,
    name: String(payload.name || 'file'),
    size: buffer.length,
    hash: fileHash,
    rootHash: tree.root,
    uploadedAt: new Date().toISOString(),
    isEncrypted: Boolean(payload.isEncrypted),
    mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream',
    chunkSize: CHUNK_SIZE_BYTES,
    totalChunks: chunks.length,
    ownerNodeId: node.peerId,
    replicas: [node.peerId],
    chunks: [],
  };

  const connectedPeerIds = node.connectedPeerIds();
  for (const chunk of chunks) {
    const chunkPayload = {
      hash: chunk.hash,
      data: chunk.data.toString('base64'),
      index: chunk.index,
      size: chunk.size,
    };

    node.localChunks.set(chunk.hash, chunkPayload);
    const targets = connectedPeerIds.slice(0, TARGET_REPLICAS - 1);
    let replicas = [node.peerId];
    if (targets.length) {
      const result = node.putChunkOnNetwork(chunkPayload, targets);
      replicas = Array.from(new Set([...replicas, ...(result.replicas || [])]));
    }

    manifest.chunks.push({
      index: chunk.index,
      hash: chunk.hash,
      size: chunk.size,
      replicas,
      proof: getMerkleProof(tree, chunk.index),
    });
  }

  manifests = manifests.filter((entry) => entry.hash !== manifest.hash);
  manifests.push(manifest);
  persistManifests();
  return { ok: true, file: manifest, summary: networkSummary() };
});

ipcMain.handle('p2p:download', async (_event, payload = {}) => {
  const node = ensureTransport({});
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found');

  const buffers = [];
  for (const chunkMeta of [...manifest.chunks].sort((a, b) => a.index - b.index)) {
    const localChunk = node.localChunks.get(chunkMeta.hash);
    const chunk = localChunk || await node.fetchChunkFromNetwork(chunkMeta.hash);
    const chunkBuffer = Buffer.from(chunk.data, 'base64');
    if (hashBufferHex(chunkBuffer) !== chunkMeta.hash) throw new Error(`Chunk integrity failed: ${chunkMeta.hash}`);
    buffers.push(chunkBuffer);
  }

  const fileBuffer = Buffer.concat(buffers);
  if (hashBufferHex(fileBuffer) !== manifest.hash) throw new Error('File integrity failed');
  return { ok: true, file: manifest, bytes: Array.from(fileBuffer) };
});

ipcMain.handle('p2p:delete', async (_event, payload = {}) => {
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found');
  manifests = manifests.filter((entry) => entry.hash !== manifest.hash);
  persistManifests();
  return { ok: true, summary: networkSummary() };
});

ipcMain.handle('p2p:networkSummary', async () => networkSummary());

ipcMain.handle('p2p:bootstrapNow', async () => ({ ok: true, summary: networkSummary() }));

ipcMain.handle('p2p:connectPeer', async (_event, payload = {}) => {
  const peerId = String(payload.peerId || '').trim();
  const url = String(payload.url || '').trim();
  if (!peerId) throw new Error('peerId is required');
  if (!/^wss?:\/\//i.test(url)) throw new Error('peer URL must start with ws:// or wss://');
  const result = ensureTransport({}).connectPeer({ peerId, url });
  return { ok: true, ...result, summary: networkSummary() };
});

ipcMain.handle('p2p:repair', async () => {
  const node = ensureTransport({});
  const report = manifests.flatMap((file) => {
    return (file.chunks || []).map((chunk) => {
      const replicas = Array.from(new Set([node.peerId, ...(chunk.replicas || [])]));
      return {
        file: file.name,
        rootHash: file.rootHash,
        chunkIndex: chunk.index,
        chunkHash: chunk.hash,
        healthyReplicas: replicas,
        targetReplicas: TARGET_REPLICAS,
        underReplicated: replicas.length < TARGET_REPLICAS,
      };
    });
  });

  return { ok: true, report, summary: networkSummary() };
});

ipcMain.handle('p2p:prepareProof', async (_event, payload = {}) => {
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found');
  const chunkIndex = Number(payload.chunkIndex ?? 0);
  const chunk = manifest.chunks.find((item) => item.index === chunkIndex) || manifest.chunks[0];
  if (!chunk) throw new Error('No chunks available for proof');

  return {
    ok: true,
    proof: {
      rootHash: manifest.rootHash,
      chunkIndex: chunk.index,
      leaf: chunk.hash,
      merkleProof: chunk.proof,
      preparedAt: new Date().toISOString(),
    },
  };
});

app.whenReady().then(() => {
  ensureDataDir();
  loadManifests();
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
  persistManifests();
  if (transportNode) transportNode.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
