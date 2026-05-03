import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startP2PTransport } from './p2p-transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const REPAIR_INTERVAL_MS = Number(process.env.P2P_REPAIR_INTERVAL_MS || 30000);
const BOOTSTRAP_INTERVAL_MS = Number(process.env.P2P_BOOTSTRAP_INTERVAL_MS || 30000);
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);
const BOOTSTRAP_URL = (process.env.P2P_BOOTSTRAP_URL || '').replace(/\/+$/, '');
const PUBLIC_WS_URL = (process.env.P2P_PUBLIC_WS_URL || '').replace(/\/+$/, '');

let mainWindow = null;
let transportNode = null;
let repairTimer = null;
let bootstrapTimer = null;
let repairRunning = false;
let bootstrapRunning = false;
let manifests = [];

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
  if (!transportNode) {
    transportNode = startP2PTransport(options);
  }
  return transportNode;
}

function nodePublicUrl(node) {
  if (PUBLIC_WS_URL) return PUBLIC_WS_URL;
  return `ws://127.0.0.1:${node.port}`;
}

async function bootstrapDiscover() {
  if (!BOOTSTRAP_URL || bootstrapRunning) return { ok: false, skipped: true };
  bootstrapRunning = true;

  try {
    const node = ensureTransport({});
    const response = await fetch(`${BOOTSTRAP_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: node.peerId,
        url: nodePublicUrl(node),
      }),
    });

    if (!response.ok) throw new Error(`bootstrap returned ${response.status}`);
    const data = await response.json();
    const peers = Array.isArray(data.peers) ? data.peers : [];

    let connected = 0;
    for (const peer of peers) {
      if (!peer?.peerId || !peer?.url || peer.peerId === node.peerId) continue;
      try {
        node.connectPeer({ peerId: peer.peerId, url: peer.url });
        connected += 1;
      } catch (error) {
        console.warn('[bootstrap] connect failed', peer.peerId, error instanceof Error ? error.message : error);
      }
    }

    return { ok: true, discovered: peers.length, attemptedConnections: connected };
  } finally {
    bootstrapRunning = false;
  }
}

function startBootstrapLoop() {
  if (bootstrapTimer || !BOOTSTRAP_URL) return;
  bootstrapDiscover().catch((error) => console.warn('[bootstrap] initial failed', error instanceof Error ? error.message : error));
  bootstrapTimer = setInterval(() => {
    bootstrapDiscover().catch((error) => console.warn('[bootstrap] cycle failed', error instanceof Error ? error.message : error));
  }, BOOTSTRAP_INTERVAL_MS);
  bootstrapTimer.unref?.();
}

function splitIntoChunks(buffer, chunkSize = CHUNK_SIZE_BYTES) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const slice = buffer.slice(i, i + chunkSize);
    const hash = crypto.createHash('sha256').update(slice).digest('hex');
    chunks.push({ hash, data: slice.toString('base64'), index: chunks.length, size: slice.length });
  }
  return chunks;
}

function chooseReplicaTargets(node, chunkHash) {
  const existingReplicas = node.healthyReplicaIds(chunkHash);
  return node.selectReplicaTargets({
    exclude: existingReplicas,
    limit: Math.max(0, TARGET_REPLICAS - existingReplicas.length),
  });
}

async function repairOneChunk(node, chunkMeta) {
  const healthyReplicas = node.healthyReplicaIds(chunkMeta.hash);
  if (healthyReplicas.length >= TARGET_REPLICAS) {
    chunkMeta.replicas = healthyReplicas;
    return { repaired: false, healthyReplicas };
  }

  const targets = chooseReplicaTargets(node, chunkMeta.hash);
  if (!targets.length) {
    chunkMeta.replicas = healthyReplicas;
    return { repaired: false, healthyReplicas, reason: 'not enough peers' };
  }

  const chunk = await node.fetchChunkFromNetwork(chunkMeta.hash);
  const result = node.putChunkOnNetwork(chunk, targets);
  const replicas = Array.from(new Set([...healthyReplicas, ...(result.replicas || [])]));
  chunkMeta.replicas = replicas;

  return { repaired: true, healthyReplicas: replicas };
}

async function repairNetwork() {
  const node = ensureTransport({});
  if (repairRunning) return { ok: true, skipped: true };

  repairRunning = true;
  let repairedChunks = 0;
  let underReplicatedChunks = 0;

  try {
    for (const manifest of manifests) {
      for (const chunkMeta of manifest.chunks || []) {
        const healthy = node.healthyReplicaIds(chunkMeta.hash);
        if (healthy.length < TARGET_REPLICAS) {
          underReplicatedChunks += 1;
          try {
            const result = await repairOneChunk(node, chunkMeta);
            if (result.repaired) repairedChunks += 1;
          } catch (error) {
            console.warn('[p2p-repair] failed chunk', chunkMeta.hash, error instanceof Error ? error.message : error);
          }
        } else {
          chunkMeta.replicas = healthy;
        }
      }
    }

    return { ok: true, repairedChunks, underReplicatedChunks };
  } finally {
    repairRunning = false;
  }
}

function startRepairLoop() {
  if (repairTimer) return;
  repairTimer = setInterval(() => {
    repairNetwork().catch((error) => {
      console.warn('[p2p-repair] cycle failed', error instanceof Error ? error.message : error);
    });
  }, REPAIR_INTERVAL_MS);
  repairTimer.unref?.();
}\n
ipcMain.handle('p2p:start', async (_event, options = {}) => {
  const node = ensureTransport(options);
  startBootstrapLoop();
  startRepairLoop();
  return { ok: true, peerId: node.peerId, port: node.port, host: node.host, bootstrapUrl: BOOTSTRAP_URL || null };
});

ipcMain.handle('p2p:bootstrap', async () => bootstrapDiscover());

ipcMain.handle('p2p:status', async () => {
  const node = ensureTransport({});
  return {
    ok: true,
    peerId: node.peerId,
    port: node.port,
    host: node.host,
    publicUrl: nodePublicUrl(node),
    bootstrapUrl: BOOTSTRAP_URL || null,
    peers: Array.from(node.peerInfo.values()),
    targetReplicas: TARGET_REPLICAS,
    files: manifests.length,
  };
});

ipcMain.handle('p2p:repair', async () => repairNetwork());

ipcMain.handle('p2p:upload', async (_event, payload) => {
  const node = ensureTransport({});

  const { name, bytes, isEncrypted, mimeType } = payload;
  const buffer = Buffer.from(bytes);

  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const chunks = splitIntoChunks(buffer);

  if (!node.connectedPeerIds().length) {
    throw new Error('No P2P peers connected');
  }

  const manifest = {
    name,
    size: buffer.length,
    hash: fileHash,
    uploadedAt: new Date().toISOString(),
    isEncrypted,
    mimeType,
    chunkSize: CHUNK_SIZE_BYTES,
    targetReplicas: TARGET_REPLICAS,
    chunks: [],
  };

  for (const chunk of chunks) {
    const targets = node.selectReplicaTargets({ limit: TARGET_REPLICAS });
    const result = node.putChunkOnNetwork({ hash: chunk.hash, data: chunk.data, size: chunk.size }, targets);
    manifest.chunks.push({
      hash: chunk.hash,
      index: chunk.index,
      size: chunk.size,
      replicas: result.replicas || targets,
    });
  }

  manifests = manifests.filter((entry) => entry.hash !== fileHash);
  manifests.push(manifest);

  return { file: manifest };
});

ipcMain.handle('p2p:listFiles', async () => manifests);

ipcMain.handle('p2p:download', async (_event, { hash }) => {
  const node = ensureTransport({});
  const manifest = manifests.find((m) => m.hash === hash);
  if (!manifest) return null;

  const buffers = [];

  for (const chunkMeta of [...manifest.chunks].sort((a, b) => a.index - b.index)) {
    const chunk = await node.fetchChunkFromNetwork(chunkMeta.hash);
    const chunkBuffer = Buffer.from(chunk.data, 'base64');
    const actualHash = crypto.createHash('sha256').update(chunkBuffer).digest('hex');
    if (actualHash !== chunkMeta.hash) {
      throw new Error(`Chunk integrity check failed: ${chunkMeta.hash}`);
    }
    buffers.push(chunkBuffer);
  }

  const fileBuffer = Buffer.concat(buffers);
  const actualFileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  if (actualFileHash !== manifest.hash) {
    throw new Error('File integrity check failed');
  }

  return { bytes: Array.from(fileBuffer) };
});

ipcMain.handle('p2p:delete', async (_event, { hash }) => {
  manifests = manifests.filter((m) => m.hash !== hash);
  return { ok: true };
});

ipcMain.handle('p2p:stats', async () => {
  const node = ensureTransport({});
  const totalBytes = manifests.reduce((s, f) => s + f.size, 0);
  const encryptedFiles = manifests.filter((f) => f.isEncrypted).length;
  const totalChunks = manifests.reduce((sum, file) => sum + (file.chunks?.length || 0), 0);
  const underReplicatedChunks = manifests.reduce((sum, file) => {
    return sum + (file.chunks || []).filter((chunk) => node.healthyReplicaIds(chunk.hash).length < TARGET_REPLICAS).length;
  }, 0);

  return {
    totalFiles: manifests.length,
    encryptedFiles,
    publicFiles: manifests.length - encryptedFiles,
    totalBytes,
    totalMB: totalBytes / 1024 / 1024,
    totalChunks,
    underReplicatedChunks,
    targetReplicas: TARGET_REPLICAS,
    connectedPeers: node.connectedPeerIds().length,
  };
});

ipcMain.handle('system:open-external', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error('Only http/https URLs can be opened');
  }
  await shell.openExternal(url);
  return { ok: true };
});

app.whenReady().then(() => {
  ensureTransport({});
  startBootstrapLoop();
  startRepairLoop();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((error) => {
  console.error('Electron failed:', error);
  app.exit(1);
});

app.on('before-quit', () => {
  if (repairTimer) clearInterval(repairTimer);
  if (bootstrapTimer) clearInterval(bootstrapTimer);
  if (transportNode) transportNode.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
