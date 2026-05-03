import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startP2PTransport } from './p2p-transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let transportNode = null;
let manifests = [];

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000');
}

function ensureTransport() {
  if (!transportNode) {
    transportNode = startP2PTransport({});
  }
  return transportNode;
}

function splitIntoChunks(buffer, chunkSize = 1024 * 1024) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const slice = buffer.slice(i, i + chunkSize);
    const hash = crypto.createHash('sha256').update(slice).digest('hex');
    chunks.push({ hash, data: slice.toString('base64'), index: chunks.length });
  }
  return chunks;
}

ipcMain.handle('p2p:upload', async (_event, payload) => {
  const node = ensureTransport();

  const { name, bytes, isEncrypted, mimeType } = payload;
  const buffer = Buffer.from(bytes);

  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const chunks = splitIntoChunks(buffer);

  if (!node.connectedPeerIds().length) {
    throw new Error('No P2P peers connected');
  }

  for (const chunk of chunks) {
    node.putChunkOnNetwork({ hash: chunk.hash, data: chunk.data });
  }

  const manifest = {
    name,
    size: buffer.length,
    hash: fileHash,
    uploadedAt: new Date().toISOString(),
    isEncrypted,
    mimeType,
    chunks: chunks.map((c) => ({ hash: c.hash, index: c.index })),
  };

  manifests.push(manifest);

  return { file: manifest };
});

ipcMain.handle('p2p:listFiles', async () => {
  return manifests;
});

ipcMain.handle('p2p:download', async (_event, { hash }) => {
  const node = ensureTransport();
  const manifest = manifests.find((m) => m.hash === hash);
  if (!manifest) return null;

  const buffers = [];

  for (const chunkMeta of manifest.chunks.sort((a, b) => a.index - b.index)) {
    const chunk = await node.fetchChunkFromNetwork(chunkMeta.hash);
    buffers.push(Buffer.from(chunk.data, 'base64'));
  }

  const fileBuffer = Buffer.concat(buffers);
  return { bytes: Array.from(fileBuffer) };
});

ipcMain.handle('p2p:delete', async (_event, { hash }) => {
  manifests = manifests.filter((m) => m.hash !== hash);
  return { ok: true };
});

ipcMain.handle('p2p:stats', async () => {
  const totalBytes = manifests.reduce((s, f) => s + f.size, 0);
  const encryptedFiles = manifests.filter((f) => f.isEncrypted).length;

  return {
    totalFiles: manifests.length,
    encryptedFiles,
    publicFiles: manifests.length - encryptedFiles,
    totalBytes,
    totalMB: totalBytes / 1024 / 1024,
  };
});

app.whenReady().then(() => {
  ensureTransport();
  createMainWindow();
});
