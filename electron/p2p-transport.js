import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PORT = Number(process.env.P2P_TRANSPORT_PORT || 8787);
const DEFAULT_HOST = process.env.P2P_TRANSPORT_HOST || '0.0.0.0';
const CHUNK_REQUEST_TIMEOUT_MS = Number(process.env.P2P_CHUNK_REQUEST_TIMEOUT_MS || 15000);
const MAX_MESSAGE_BYTES = Number(process.env.P2P_MAX_MESSAGE_BYTES || 8 * 1024 * 1024);
const MAX_CHUNK_BYTES = Number(process.env.P2P_MAX_CHUNK_BYTES || 5 * 1024 * 1024);
const MAX_MESSAGES_PER_MINUTE = Number(process.env.P2P_MAX_MESSAGES_PER_MINUTE || 240);
const P2P_SHARED_SECRET = process.env.P2P_SHARED_SECRET || '';
const STRICT_AUTH = process.env.P2P_STRICT_AUTH === '1' || Boolean(P2P_SHARED_SECRET);
const ALLOWED_PEER_MESSAGES = new Set(['peer:hello', 'chunk:put', 'chunk:stored-ack', 'chunk:get', 'chunk:found', 'manifest:broadcast', 'network:broadcast']);

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().filter((key) => key !== 'signature').map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function hmac(message) {
  if (!P2P_SHARED_SECRET) return '';
  return crypto.createHmac('sha256', P2P_SHARED_SECRET).update(canonicalJson(message)).digest('hex');
}

function timingSafeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isHexHash(value = '') {
  return /^[a-fA-F0-9]{64}$/.test(String(value));
}

function decodeChunkData(chunk) {
  const data = Buffer.from(String(chunk?.data || ''), 'base64');
  if (!data.length) throw new Error('Chunk data is empty');
  if (data.length > MAX_CHUNK_BYTES) throw new Error('Chunk exceeds maximum size');
  if (Number(chunk.size || data.length) !== data.length) throw new Error('Chunk size mismatch');
  if (!isHexHash(chunk.hash)) throw new Error('Invalid chunk hash format');
  if (sha256Hex(data) !== String(chunk.hash).toLowerCase()) throw new Error('Chunk hash mismatch');
  return data;
}

export class P2PTransportNode {
  constructor({ peerId, port = DEFAULT_PORT, host = DEFAULT_HOST, publicUrl = null, chunkStoreDir = null } = {}) {
    this.peerId = peerId || `electron-peer-${crypto.randomUUID()}`;
    this.port = port;
    this.host = host;
    this.publicUrl = publicUrl || null;
    this.chunkStoreDir = chunkStoreDir || null;
    this.server = null;
    this.uiClients = new Set();
    this.peerSockets = new Map();
    this.peerInfo = new Map();
    this.localChunks = new Map();
    this.chunkReplicas = new Map();
    this.pendingChunkRequests = new Map();
    this.ensureChunkStore();
  }

  ensureChunkStore() {
    if (!this.chunkStoreDir) return;
    fs.mkdirSync(this.chunkStoreDir, { recursive: true });
  }

  chunkPath(chunkHash) {
    if (!this.chunkStoreDir || !chunkHash) return null;
    const safe = String(chunkHash).replace(/[^a-fA-F0-9]/g, '');
    if (!isHexHash(safe)) throw new Error('Invalid chunk path hash');
    return path.join(this.chunkStoreDir, `${safe.toLowerCase()}.json`);
  }

  signMessage(message) {
    const unsigned = { ...message };
    delete unsigned.signature;
    const signature = hmac(unsigned);
    return signature ? { ...unsigned, signature } : unsigned;
  }

  verifyMessage(message) {
    if (!STRICT_AUTH) return true;
    if (!message?.signature) throw new Error('Missing P2P message signature');
    const expected = hmac(message);
    if (!timingSafeEqual(expected, message.signature)) throw new Error('Invalid P2P message signature');
    return true;
  }

  checkRateLimit(socket) {
    const now = Date.now();
    if (!socket.rateWindowStartedAt || now - socket.rateWindowStartedAt > 60_000) {
      socket.rateWindowStartedAt = now;
      socket.rateCount = 0;
    }
    socket.rateCount += 1;
    if (socket.rateCount > MAX_MESSAGES_PER_MINUTE) throw new Error('P2P rate limit exceeded');
  }

  storeLocalChunk(chunk) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');
    decodeChunkData(chunk);
    const normalized = { ...chunk, hash: String(chunk.hash).toLowerCase(), size: Number(chunk.size || 0) };
    this.localChunks.set(normalized.hash, normalized);
    const filePath = this.chunkPath(normalized.hash);
    if (filePath) {
      this.ensureChunkStore();
      fs.writeFileSync(filePath, JSON.stringify({ ...normalized, storedAt: new Date().toISOString() }), 'utf8');
    }
    return normalized;
  }

  getLocalChunk(chunkHash) {
    const hash = String(chunkHash || '').toLowerCase();
    if (!isHexHash(hash)) return null;
    const memoryChunk = this.localChunks.get(hash);
    if (memoryChunk) return memoryChunk;
    let filePath;
    try { filePath = this.chunkPath(hash); } catch { return null; }
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
      const chunk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (chunk?.hash) {
        const verified = this.storeLocalChunk(chunk);
        return verified;
      }
    } catch {}
    return null;
  }

  start() {
    if (this.server) return { peerId: this.peerId, port: this.port, host: this.host, publicUrl: this.publicUrl };
    this.server = new WebSocketServer({ host: this.host, port: this.port, maxPayload: MAX_MESSAGE_BYTES });
    this.server.on('connection', (socket) => {
      socket.isAlive = true;
      socket.role = 'unknown';
      socket.authenticated = !STRICT_AUTH;
      socket.on('pong', () => { socket.isAlive = true; });
      socket.on('message', (raw) => this.handleSocketMessage(socket, raw));
      socket.on('close', () => this.forgetSocket(socket));
      this.send(socket, { type: 'transport:ready', peerId: this.peerId, port: this.port, publicUrl: this.publicUrl, auth: STRICT_AUTH ? 'hmac-required' : 'opportunistic' });
    });
    this.heartbeat = setInterval(() => {
      this.server?.clients.forEach((socket) => {
        if (socket.isAlive === false) { socket.terminate(); return; }
        socket.isAlive = false;
        socket.ping();
      });
    }, 30000);
    console.log(`[p2p-transport] listening on ws://${this.host}:${this.port} as ${this.peerId}`);
    if (this.publicUrl) console.log(`[p2p-transport] advertising ${this.publicUrl}`);
    if (this.chunkStoreDir) console.log(`[p2p-transport] chunk store ${this.chunkStoreDir}`);
    if (STRICT_AUTH) console.log('[p2p-transport] strict HMAC peer authentication enabled');
    return { peerId: this.peerId, port: this.port, host: this.host, publicUrl: this.publicUrl };
  }

  forgetSocket(socket) {
    this.uiClients.delete(socket);
    for (const [peerId, peerSocket] of this.peerSockets.entries()) {
      if (peerSocket === socket) {
        this.peerSockets.delete(peerId);
        this.peerInfo.set(peerId, { ...(this.peerInfo.get(peerId) || { peerId }), status: 'disconnected', lastSeen: Date.now() });
        this.broadcastToUi({ type: 'peer:disconnected', peerId });
      }
    }
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const pending of this.pendingChunkRequests.values()) { clearTimeout(pending.timeout); pending.reject(new Error('P2P node stopped')); }
    this.pendingChunkRequests.clear();
    for (const socket of this.peerSockets.values()) socket.close();
    for (const socket of this.uiClients.values()) socket.close();
    this.server?.close();
    this.server = null;
  }

  connectedPeerIds() {
    return Array.from(this.peerSockets.entries()).filter(([, socket]) => socket.readyState === WebSocket.OPEN && socket.authenticated !== false).map(([peerId]) => peerId);
  }

  healthyReplicaIds(chunkHash) {
    const known = this.chunkReplicas.get(String(chunkHash || '').toLowerCase()) || new Set();
    const online = new Set(this.connectedPeerIds());
    return Array.from(known).filter((peerId) => online.has(peerId));
  }

  selectReplicaTargets({ exclude = [], limit = 3 } = {}) {
    const excluded = new Set(exclude);
    return this.connectedPeerIds().filter((peerId) => !excluded.has(peerId)).slice(0, limit);
  }

  connectPeer({ peerId, url }) {
    if (!peerId || !url) throw new Error('peerId and url are required');
    if (peerId === this.peerId) return { peerId, status: 'self', url };
    const existing = this.peerSockets.get(peerId);
    if (existing && existing.readyState === WebSocket.OPEN) return { peerId, status: 'connected', url };
    this.peerInfo.set(peerId, { peerId, url, status: 'connecting', lastSeen: Date.now() });
    const socket = new WebSocket(url, { maxPayload: MAX_MESSAGE_BYTES });
    socket.role = 'peer';
    socket.remotePeerId = peerId;
    socket.authenticated = !STRICT_AUTH;
    socket.on('open', () => {
      this.peerSockets.set(peerId, socket);
      this.send(socket, this.signMessage({ type: 'peer:hello', fromPeerId: this.peerId, toPeerId: peerId, createdAt: Date.now(), payload: { peerId: this.peerId, url: this.publicUrl || `ws://127.0.0.1:${this.port}` } }));
    });
    socket.on('message', (raw) => this.handleSocketMessage(socket, raw));
    socket.on('close', () => { this.peerSockets.delete(peerId); this.peerInfo.set(peerId, { peerId, url, status: 'disconnected', lastSeen: Date.now() }); this.broadcastToUi({ type: 'peer:disconnected', peerId }); });
    socket.on('error', (error) => { this.peerInfo.set(peerId, { peerId, url, status: 'error', error: error.message, lastSeen: Date.now() }); this.broadcastToUi({ type: 'peer:error', peerId, url, error: error.message }); });
    return { peerId, status: 'connecting', url };
  }

  putChunkOnNetwork(chunk, replicaPeerIds = this.connectedPeerIds()) {
    const verifiedChunk = this.storeLocalChunk(chunk);
    const targets = replicaPeerIds.filter((peerId) => this.peerSockets.get(peerId)?.readyState === WebSocket.OPEN);
    if (!targets.length) throw new Error('No connected P2P peers available');
    const replicaSet = this.chunkReplicas.get(verifiedChunk.hash) || new Set();
    for (const peerId of targets) {
      const socket = this.peerSockets.get(peerId);
      this.send(socket, this.signMessage({ id: crypto.randomUUID(), type: 'chunk:put', fromPeerId: this.peerId, toPeerId: peerId, createdAt: Date.now(), payload: { chunk: verifiedChunk } }));
      replicaSet.add(peerId);
    }
    this.chunkReplicas.set(verifiedChunk.hash, replicaSet);
    return { ok: true, replicas: Array.from(replicaSet) };
  }

  fetchChunkFromNetwork(chunkHash) {
    const hash = String(chunkHash || '').toLowerCase();
    if (!isHexHash(hash)) return Promise.reject(new Error('Invalid chunk hash'));
    const localChunk = this.getLocalChunk(hash);
    if (localChunk) return Promise.resolve(localChunk);
    const knownReplicas = this.healthyReplicaIds(hash);
    const peers = knownReplicas.length ? knownReplicas : this.connectedPeerIds();
    if (!peers.length) return Promise.reject(new Error('No connected P2P peers available'));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingChunkRequests.delete(hash); reject(new Error(`Chunk not found on the network: ${hash}`)); }, CHUNK_REQUEST_TIMEOUT_MS);
      this.pendingChunkRequests.set(hash, { resolve, reject, timeout });
      for (const peerId of peers) {
        const socket = this.peerSockets.get(peerId);
        if (socket?.readyState !== WebSocket.OPEN) continue;
        this.send(socket, this.signMessage({ id: crypto.randomUUID(), type: 'chunk:get', fromPeerId: this.peerId, toPeerId: peerId, createdAt: Date.now(), payload: { chunkHash: hash } }));
      }
    });
  }

  handleSocketMessage(socket, raw) {
    try {
      this.checkRateLimit(socket);
      if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) throw new Error('P2P message too large');
      const message = JSON.parse(raw.toString());
      if (!message?.type) throw new Error('Missing P2P message type');

      if (message.type === 'ui:hello') {
        socket.role = 'ui';
        this.uiClients.add(socket);
        this.send(socket, { type: 'ui:ready', peerId: this.peerId, peers: Array.from(this.peerInfo.values()) });
        return;
      }

      if (!ALLOWED_PEER_MESSAGES.has(message.type)) throw new Error(`Unsupported P2P message type: ${message.type}`);
      this.verifyMessage(message);

      if (message.type === 'peer:hello') {
        if (!message.fromPeerId || String(message.fromPeerId).length > 128) throw new Error('Invalid peer id');
        socket.role = 'peer';
        socket.authenticated = true;
        socket.remotePeerId = message.fromPeerId;
        this.peerSockets.set(message.fromPeerId, socket);
        this.peerInfo.set(message.fromPeerId, { peerId: message.fromPeerId, url: message.payload?.url, status: 'connected', lastSeen: Date.now(), authenticated: true });
        this.broadcastToUi({ type: 'peer:connected', peerId: message.fromPeerId, url: message.payload?.url });
        return;
      }

      if (STRICT_AUTH && !socket.authenticated) throw new Error('Peer is not authenticated');

      if (message.type === 'chunk:put') {
        const chunk = message.payload?.chunk;
        const stored = this.storeLocalChunk(chunk);
        this.send(socket, this.signMessage({ id: crypto.randomUUID(), type: 'chunk:stored-ack', fromPeerId: this.peerId, toPeerId: message.fromPeerId, createdAt: Date.now(), payload: { chunkHash: stored.hash } }));
        this.broadcastToUi({ type: 'chunk:stored', chunkHash: stored.hash, fromPeerId: message.fromPeerId });
        return;
      }

      if (message.type === 'chunk:stored-ack') {
        const chunkHash = String(message.payload?.chunkHash || '').toLowerCase();
        if (isHexHash(chunkHash) && message.fromPeerId) {
          const replicaSet = this.chunkReplicas.get(chunkHash) || new Set();
          replicaSet.add(message.fromPeerId);
          this.chunkReplicas.set(chunkHash, replicaSet);
        }
        return;
      }

      if (message.type === 'chunk:get') {
        const chunkHash = String(message.payload?.chunkHash || '').toLowerCase();
        if (!isHexHash(chunkHash)) throw new Error('Invalid chunk request hash');
        const chunk = this.getLocalChunk(chunkHash);
        if (chunk) {
          this.send(socket, this.signMessage({ id: crypto.randomUUID(), type: 'chunk:found', fromPeerId: this.peerId, toPeerId: message.fromPeerId, createdAt: Date.now(), payload: { chunk } }));
          return;
        }
        this.forwardOrDeliver(socket, message);
        return;
      }

      if (message.type === 'chunk:found') {
        const chunk = message.payload?.chunk;
        const verified = chunk?.hash ? this.storeLocalChunk(chunk) : null;
        if (verified?.hash && message.fromPeerId) {
          const replicaSet = this.chunkReplicas.get(verified.hash) || new Set();
          replicaSet.add(message.fromPeerId);
          this.chunkReplicas.set(verified.hash, replicaSet);
        }
        const pending = verified?.hash ? this.pendingChunkRequests.get(verified.hash) : null;
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingChunkRequests.delete(verified.hash);
          pending.resolve(verified);
          return;
        }
        this.forwardOrDeliver(socket, message);
        return;
      }

      if (message.type === 'manifest:broadcast' || message.type === 'network:broadcast') {
        this.forwardOrDeliver(socket, message);
      }
    } catch (error) {
      this.send(socket, { type: 'error', error: error?.message || 'P2P message rejected' });
      if (/signature|auth|rate limit|too large|unsupported/i.test(error?.message || '')) socket.close();
    }
  }

  forwardOrDeliver(sourceSocket, message) {
    const signed = this.signMessage(message);
    if (signed.toPeerId && signed.toPeerId !== this.peerId) {
      const peerSocket = this.peerSockets.get(signed.toPeerId);
      if (peerSocket?.readyState === WebSocket.OPEN) { this.send(peerSocket, signed); return; }
    }
    this.broadcastToUi(signed);
    if (!signed.toPeerId) {
      for (const peerSocket of this.peerSockets.values()) {
        if (peerSocket !== sourceSocket && peerSocket.readyState === WebSocket.OPEN) this.send(peerSocket, signed);
      }
    }
  }

  broadcastToUi(message) {
    for (const socket of this.uiClients) if (socket.readyState === WebSocket.OPEN) this.send(socket, message);
  }

  send(socket, message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

export function startP2PTransport(options = {}) {
  const node = new P2PTransportNode(options);
  node.start();
  return node;
}
