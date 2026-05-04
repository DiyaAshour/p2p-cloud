import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.STORAGE_PEER_PORT || process.env.P2P_TRANSPORT_PORT || 8787);
const HOST = process.env.STORAGE_PEER_HOST || '0.0.0.0';
const PUBLIC_URL = process.env.STORAGE_PEER_PUBLIC_URL || process.env.P2P_PUBLIC_URL || 'ws://54.166.171.208:8787';
const BOOTSTRAP_URL = process.env.P2P_BOOTSTRAP_URL || 'ws://54.166.171.208:8788';
const DATA_DIR = process.env.STORAGE_PEER_DATA_DIR || path.join(__dirname, '..', 'storage-peer-data');
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');
const INDEX_PATH = path.join(DATA_DIR, 'chunk-index.json');
const PEER_ID_PATH = path.join(DATA_DIR, 'peer-id.txt');
const HEARTBEAT_MS = Number(process.env.STORAGE_PEER_HEARTBEAT_MS || 30000);

function ensureDirs() {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_PATH)) fs.writeFileSync(INDEX_PATH, '{}', 'utf8');
}

function loadPeerId() {
  ensureDirs();
  if (fs.existsSync(PEER_ID_PATH)) {
    const existing = fs.readFileSync(PEER_ID_PATH, 'utf8').trim();
    if (existing) return existing;
  }
  const peerId = `aws-storage-peer-${crypto.randomUUID()}`;
  fs.writeFileSync(PEER_ID_PATH, peerId, 'utf8');
  return peerId;
}

const PEER_ID = loadPeerId();
const peers = new Map();
let bootstrapSocket = null;
let bootstrapTimer = null;

function readIndex() {
  ensureDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeIndex(index) {
  ensureDirs();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}

function chunkPath(hash) {
  return path.join(CHUNKS_DIR, `${String(hash).replace(/[^a-fA-F0-9]/g, '')}.json`);
}

function storeChunk(chunk, fromPeerId = '') {
  if (!chunk?.hash || !chunk?.data) throw new Error('chunk.hash and chunk.data are required');
  const index = readIndex();
  const clean = {
    hash: String(chunk.hash),
    data: String(chunk.data),
    index: Number(chunk.index || 0),
    size: Number(chunk.size || 0),
    ownerWallet: String(chunk.ownerWallet || '').toLowerCase(),
    storedAt: new Date().toISOString(),
    fromPeerId,
  };
  fs.writeFileSync(chunkPath(clean.hash), JSON.stringify(clean), 'utf8');
  index[clean.hash] = {
    hash: clean.hash,
    size: clean.size,
    ownerWallet: clean.ownerWallet,
    storedAt: clean.storedAt,
    fromPeerId,
  };
  writeIndex(index);
  return clean;
}

function loadChunk(hash) {
  const file = chunkPath(hash);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function handlePeerMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    send(socket, { type: 'error', error: 'Invalid JSON message' });
    return;
  }

  if (message.fromPeerId) {
    socket.remotePeerId = message.fromPeerId;
    peers.set(message.fromPeerId, socket);
  }

  if (message.type === 'peer:hello') {
    socket.remotePeerId = message.fromPeerId;
    peers.set(message.fromPeerId, socket);
    send(socket, {
      type: 'peer:hello',
      fromPeerId: PEER_ID,
      toPeerId: message.fromPeerId,
      payload: { peerId: PEER_ID, url: PUBLIC_URL, role: 'aws-storage-peer' },
    });
    console.log('[storage-peer] connected peer', message.fromPeerId);
    return;
  }

  if (message.type === 'chunk:put') {
    try {
      const chunk = storeChunk(message.payload?.chunk, message.fromPeerId || 'unknown');
      send(socket, {
        id: crypto.randomUUID(),
        type: 'chunk:stored-ack',
        fromPeerId: PEER_ID,
        toPeerId: message.fromPeerId,
        createdAt: Date.now(),
        payload: { chunkHash: chunk.hash },
      });
      console.log('[storage-peer] stored chunk', chunk.hash, 'from', message.fromPeerId || 'unknown');
    } catch (error) {
      send(socket, {
        id: crypto.randomUUID(),
        type: 'chunk:error',
        fromPeerId: PEER_ID,
        toPeerId: message.fromPeerId,
        createdAt: Date.now(),
        error: error?.message || 'Failed to store chunk',
      });
    }
    return;
  }

  if (message.type === 'chunk:get') {
    const chunkHash = message.payload?.chunkHash;
    const chunk = chunkHash ? loadChunk(chunkHash) : null;
    if (chunk) {
      send(socket, {
        id: crypto.randomUUID(),
        type: 'chunk:found',
        fromPeerId: PEER_ID,
        toPeerId: message.fromPeerId,
        createdAt: Date.now(),
        payload: { chunk },
      });
      console.log('[storage-peer] served chunk', chunkHash, 'to', message.fromPeerId || 'unknown');
      return;
    }
    send(socket, {
      id: crypto.randomUUID(),
      type: 'chunk:not-found',
      fromPeerId: PEER_ID,
      toPeerId: message.fromPeerId,
      createdAt: Date.now(),
      payload: { chunkHash },
    });
    console.log('[storage-peer] missing chunk', chunkHash);
  }
}

function registerWithBootstrap() {
  if (bootstrapSocket?.readyState === WebSocket.OPEN) {
    const payload = { type: 'peer:register', peerId: PEER_ID, url: PUBLIC_URL, role: 'aws-storage-peer' };
    bootstrapSocket.send(JSON.stringify(payload));
    bootstrapSocket.send(JSON.stringify({ type: 'peer:heartbeat', peerId: PEER_ID, url: PUBLIC_URL, role: 'aws-storage-peer' }));
    console.log('[storage-peer] registered with bootstrap', PUBLIC_URL);
  }
}

function connectBootstrap() {
  if (!BOOTSTRAP_URL) return;
  if (bootstrapSocket?.readyState === WebSocket.OPEN) {
    registerWithBootstrap();
    return;
  }
  bootstrapSocket = new WebSocket(BOOTSTRAP_URL);
  bootstrapSocket.on('open', () => {
    registerWithBootstrap();
    if (bootstrapTimer) clearInterval(bootstrapTimer);
    bootstrapTimer = setInterval(registerWithBootstrap, HEARTBEAT_MS);
  });
  bootstrapSocket.on('message', () => {});
  bootstrapSocket.on('close', () => {
    if (bootstrapTimer) clearInterval(bootstrapTimer);
    bootstrapSocket = null;
    setTimeout(connectBootstrap, 5000);
  });
  bootstrapSocket.on('error', (error) => {
    console.warn('[storage-peer] bootstrap error:', error?.message || error);
  });
}

ensureDirs();
const server = new WebSocketServer({ host: HOST, port: PORT });
server.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', (raw) => handlePeerMessage(socket, raw));
  socket.on('close', () => {
    if (socket.remotePeerId) peers.delete(socket.remotePeerId);
  });
  send(socket, {
    type: 'transport:ready',
    peerId: PEER_ID,
    port: PORT,
    publicUrl: PUBLIC_URL,
    role: 'aws-storage-peer',
  });
});

setInterval(() => {
  server.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
  });
}, HEARTBEAT_MS);

connectBootstrap();
console.log(`[storage-peer] peerId: ${PEER_ID}`);
console.log(`[storage-peer] listening on ws://${HOST}:${PORT}`);
console.log(`[storage-peer] advertising ${PUBLIC_URL}`);
console.log(`[storage-peer] chunks: ${CHUNKS_DIR}`);
