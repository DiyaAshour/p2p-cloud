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
const MAX_CHUNK_BYTES = Number(process.env.STORAGE_PEER_MAX_CHUNK_BYTES || 2 * 1024 * 1024);
const MAX_MESSAGE_BYTES = Number(
  process.env.STORAGE_PEER_MAX_MESSAGE_BYTES || Math.ceil(MAX_CHUNK_BYTES * 1.45) + 8192
);

const MAX_PUTS_PER_MINUTE = Number(process.env.STORAGE_PEER_MAX_PUTS_PER_MINUTE || 240);
const MAX_GETS_PER_MINUTE = Number(process.env.STORAGE_PEER_MAX_GETS_PER_MINUTE || 600);
const MAX_DELETES_PER_MINUTE = Number(process.env.STORAGE_PEER_MAX_DELETES_PER_MINUTE || 240);

// اختياري:
// إذا حطيت STORAGE_PEER_DELETE_TOKEN بالسيرفر، لازم العميل يرسل نفس التوكن.
// إذا تركته فاضي، الحذف يشتغل بدون token.
const STORAGE_PEER_DELETE_TOKEN = String(
  process.env.STORAGE_PEER_DELETE_TOKEN ||
  process.env.P2P_SAFETY_PEER_DELETE_TOKEN ||
  ''
).trim();

const PUBLIC_DISPLAY_URL = 'Network route';
const PUBLIC_ROLE = 'safety-peer';

const NODE_NAMES = [
  'Atlas Node', 'Orion Node', 'Nova Node', 'Vega Node', 'Astra Node', 'Luna Node',
  'Cosmo Node', 'Nexus Node', 'Pulse Node', 'Echo Node', 'Vertex Node', 'Nimbus Node',
  'Falcon Node', 'Cedar Node', 'Summit Node', 'Harbor Node'
];

function stableName(seed = '') {
  const hash = crypto.createHash('sha256').update(seed).digest();
  return NODE_NAMES[hash[0] % NODE_NAMES.length];
}

function ensureDirs() {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_PATH)) fs.writeFileSync(INDEX_PATH, '{}', 'utf8');
}

function newPeerId() {
  return `${stableName(crypto.randomUUID()).toLowerCase().replace(/\s+/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
}

function loadPeerId() {
  ensureDirs();

  if (fs.existsSync(PEER_ID_PATH)) {
    const existing = fs.readFileSync(PEER_ID_PATH, 'utf8').trim();
    if (existing && !existing.startsWith('aws-storage-peer')) return existing;
  }

  const peerId = newPeerId();
  fs.writeFileSync(PEER_ID_PATH, peerId, 'utf8');
  return peerId;
}

const PEER_ID = loadPeerId();
const PEER_NAME = stableName(PEER_ID);
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

function normalizeChunkHash(hash = '') {
  const clean = String(hash || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(clean)) {
    throw new Error('Invalid chunk hash');
  }

  return clean;
}

function chunkPath(hash) {
  const clean = normalizeChunkHash(hash);
  return path.join(CHUNKS_DIR, `${clean}.json`);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function peerBucket(socket, type) {
  const now = Date.now();

  const key =
    type === 'get'
      ? 'getRate'
      : type === 'delete'
        ? 'deleteRate'
        : 'putRate';

  const limit =
    type === 'get'
      ? MAX_GETS_PER_MINUTE
      : type === 'delete'
        ? MAX_DELETES_PER_MINUTE
        : MAX_PUTS_PER_MINUTE;

  const current = socket[key] || { startedAt: now, count: 0 };

  if (now - current.startedAt > 60_000) {
    current.startedAt = now;
    current.count = 0;
  }

  current.count += 1;
  socket[key] = current;

  if (current.count > limit) {
    throw new Error(`Rate limit exceeded for chunk:${type}`);
  }
}

function validateChunk(chunk) {
  if (!chunk?.hash || !chunk?.data) {
    throw new Error('chunk.hash and chunk.data are required');
  }

  const hash = normalizeChunkHash(chunk.hash);

  if (typeof chunk.data !== 'string') {
    throw new Error('chunk.data must be base64');
  }

  const data = Buffer.from(chunk.data, 'base64');

  if (!data.length) {
    throw new Error('chunk.data is empty');
  }

  if (data.length > MAX_CHUNK_BYTES) {
    throw new Error(`chunk too large: ${data.length} bytes`);
  }

  if (sha256Hex(data) !== hash) {
    throw new Error('chunk hash mismatch');
  }

  const size = Number(chunk.size || data.length);

  if (!Number.isFinite(size) || size < 0 || size !== data.length) {
    throw new Error('chunk size mismatch');
  }

  const index = Number(chunk.index || 0);

  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Invalid chunk index');
  }

  return {
    hash,
    data: chunk.data,
    index,
    size,
    ownerWallet: String(chunk.ownerWallet || '').toLowerCase(),
    encrypted: Boolean(chunk.encrypted),
  };
}

function storeChunk(chunk, fromPeerId = '') {
  const clean = validateChunk(chunk);
  const index = readIndex();

  const record = {
    ...clean,
    storedAt: new Date().toISOString(),
    fromPeerId,
  };

  fs.writeFileSync(chunkPath(record.hash), JSON.stringify(record), 'utf8');

  index[record.hash] = {
    hash: record.hash,
    size: record.size,
    ownerWallet: record.ownerWallet,
    encrypted: record.encrypted,
    storedAt: record.storedAt,
    fromPeerId,
  };

  writeIndex(index);

  return record;
}

function loadChunk(hash) {
  const file = chunkPath(hash);

  if (!fs.existsSync(file)) return null;

  try {
    const chunk = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateChunk(chunk);
    return chunk;
  } catch {
    return null;
  }
}

function deleteChunk(hash, expectedOwnerWallet = '') {
  const clean = normalizeChunkHash(hash);
  const index = readIndex();
  const record = index[clean] || null;

  const expectedOwner = String(expectedOwnerWallet || '').toLowerCase();

  // حماية بسيطة: إذا العميل أرسل ownerWallet، لا نحذف chunk لمالك مختلف.
  if (
    record?.ownerWallet &&
    expectedOwner &&
    String(record.ownerWallet).toLowerCase() !== expectedOwner
  ) {
    throw new Error('Chunk owner mismatch');
  }

  const file = chunkPath(clean);
  const existed = fs.existsSync(file);

  if (existed) {
    fs.unlinkSync(file);
  }

  if (index[clean]) {
    delete index[clean];
    writeIndex(index);
  }

  return {
    hash: clean,
    existed,
  };
}

function assertDeleteAllowed(payload = {}) {
  if (!STORAGE_PEER_DELETE_TOKEN) return;

  const token = String(
    payload.deleteToken ||
    payload.adminToken ||
    payload.token ||
    ''
  ).trim();

  if (!token || token !== STORAGE_PEER_DELETE_TOKEN) {
    throw new Error('Invalid storage peer delete token');
  }
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function handlePeerMessage(socket, raw) {
  if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
    send(socket, { type: 'error', error: 'Message too large' });
    socket.close(1009, 'Message too large');
    return;
  }

  let message;

  try {
    message = JSON.parse(raw.toString());
  } catch {
    send(socket, { type: 'error', error: 'Invalid JSON message' });
    return;
  }

  if (message.fromPeerId) {
    socket.remotePeerId = String(message.fromPeerId).slice(0, 128);
    peers.set(socket.remotePeerId, socket);
  }

  if (message.type === 'peer:hello') {
    socket.remotePeerId = String(message.fromPeerId || '').slice(0, 128);
    peers.set(socket.remotePeerId, socket);

    send(socket, {
      type: 'peer:hello',
      fromPeerId: PEER_ID,
      toPeerId: message.fromPeerId,
      payload: {
        peerId: PEER_ID,
        displayName: PEER_NAME,
        url: PUBLIC_DISPLAY_URL,
        role: PUBLIC_ROLE,
      },
    });

    console.log('[storage-peer] connected peer', message.fromPeerId);
    return;
  }

  if (message.type === 'chunk:put') {
    try {
      peerBucket(socket, 'put');

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
    try {
      peerBucket(socket, 'get');

      const chunkHash = normalizeChunkHash(message.payload?.chunkHash || '');
      const chunk = loadChunk(chunkHash);

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
    } catch (error) {
      send(socket, {
        id: crypto.randomUUID(),
        type: 'chunk:error',
        fromPeerId: PEER_ID,
        toPeerId: message.fromPeerId,
        createdAt: Date.now(),
        error: error?.message || 'Failed to read chunk',
      });
    }

    return;
  }

  if (message.type === 'chunk:delete') {
    try {
      peerBucket(socket, 'delete');
      assertDeleteAllowed(message.payload || {});

      const chunkHash = normalizeChunkHash(message.payload?.chunkHash || '');
      const ownerWallet = String(message.payload?.ownerWallet || '').toLowerCase();

      const result = deleteChunk(chunkHash, ownerWallet);

      send(socket, {
        id: crypto.randomUUID(),
        type: result.existed ? 'chunk:deleted' : 'chunk:not-found',
        fromPeerId: PEER_ID,
        toPeerId: message.fromPeerId,
        createdAt: Date.now(),
        payload: { chunkHash: result.hash },
      });

      console.log(
        '[storage-peer]',
        result.existed ? 'deleted chunk' : 'delete skipped missing chunk',
        result.hash,
        'for',
        message.fromPeerId || 'unknown'
      );
    } catch (error) {
      send(socket, {
        id: crypto.randomUUID(),
        type: 'chunk:error',
        fromPeerId: PEER_ID,
        toPeerId: message.fromPeerId,
        createdAt: Date.now(),
        error: error?.message || 'Failed to delete chunk',
      });
    }

    return;
  }
}

function registerWithBootstrap() {
  if (bootstrapSocket?.readyState === WebSocket.OPEN) {
    const payload = {
      type: 'peer:register',
      peerId: PEER_ID,
      url: PUBLIC_URL,
      role: PUBLIC_ROLE,
      displayName: PEER_NAME,
    };

    bootstrapSocket.send(JSON.stringify(payload));

    bootstrapSocket.send(JSON.stringify({
      type: 'peer:heartbeat',
      peerId: PEER_ID,
      url: PUBLIC_URL,
      role: PUBLIC_ROLE,
      displayName: PEER_NAME,
    }));

    console.log('[storage-peer] registered with bootstrap', PUBLIC_URL, 'as', PEER_NAME);
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

const server = new WebSocketServer({
  host: HOST,
  port: PORT,
  maxPayload: MAX_MESSAGE_BYTES,
});

server.on('connection', (socket) => {
  socket.isAlive = true;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => handlePeerMessage(socket, raw));

  socket.on('close', () => {
    if (socket.remotePeerId) peers.delete(socket.remotePeerId);
  });

  send(socket, {
    type: 'transport:ready',
    peerId: PEER_ID,
    port: PORT,
    publicUrl: PUBLIC_DISPLAY_URL,
    role: PUBLIC_ROLE,
    displayName: PEER_NAME,
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
console.log(`[storage-peer] displayName: ${PEER_NAME}`);
console.log(`[storage-peer] listening on ws://${HOST}:${PORT}`);
console.log(`[storage-peer] advertising ${PUBLIC_URL}`);
console.log(`[storage-peer] chunks: ${CHUNKS_DIR}`);
console.log(`[storage-peer] max chunk bytes: ${MAX_CHUNK_BYTES}`);
console.log(`[storage-peer] delete support: enabled`);
console.log(`[storage-peer] delete protection: ${STORAGE_PEER_DELETE_TOKEN ? 'token-required' : 'token-not-set'}`);
