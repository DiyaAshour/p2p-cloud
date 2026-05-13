import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PORT = Number(process.env.P2P_TRANSPORT_PORT || 8787);
const DEFAULT_HOST = process.env.P2P_TRANSPORT_HOST || '0.0.0.0';
const CHUNK_REQUEST_TIMEOUT_MS = Number(process.env.P2P_CHUNK_REQUEST_TIMEOUT_MS || 15000);
const CHUNK_STORE_ACK_TIMEOUT_MS = Number(process.env.P2P_CHUNK_STORE_ACK_TIMEOUT_MS || 5000);
const PEER_SUSPECT_AFTER_MS = Number(process.env.P2P_PEER_SUSPECT_AFTER_MS || 5 * 60 * 1000);
const PEER_DEAD_AFTER_MS = Number(process.env.P2P_PEER_DEAD_AFTER_MS || 30 * 60 * 1000);
const MIN_REPLICA_HEALTH_SCORE = Number(process.env.P2P_MIN_REPLICA_HEALTH_SCORE || 35);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function emptyPeerHealth(peerId) {
  return {
    peerId,
    score: 50,
    state: 'new',
    successes: 0,
    failures: 0,
    storedChunks: 0,
    fetchedChunks: 0,
    lastSeen: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastLatencyMs: null,
    lastError: null,
  };
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
    this.peerHealth = new Map();
    this.localChunks = new Map();
    this.chunkReplicas = new Map();
    this.pendingChunkRequests = new Map();
    this.pendingChunkAcks = new Map();
    this.ensureChunkStore();
  }

  ensureChunkStore() {
    if (!this.chunkStoreDir) return;
    fs.mkdirSync(this.chunkStoreDir, { recursive: true });
  }

  chunkPath(chunkHash) {
    if (!this.chunkStoreDir || !chunkHash) return null;
    const safe = String(chunkHash).replace(/[^a-fA-F0-9]/g, '');
    return path.join(this.chunkStoreDir, `${safe}.json`);
  }

  storeLocalChunk(chunk) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');
    this.localChunks.set(chunk.hash, chunk);
    const filePath = this.chunkPath(chunk.hash);
    if (filePath) {
      this.ensureChunkStore();
      fs.writeFileSync(filePath, JSON.stringify({ ...chunk, storedAt: new Date().toISOString() }), 'utf8');
    }
    return chunk;
  }

  getLocalChunk(chunkHash) {
    const memoryChunk = this.localChunks.get(chunkHash);
    if (memoryChunk) return memoryChunk;
    const filePath = this.chunkPath(chunkHash);
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
      const chunk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (chunk?.hash) {
        this.localChunks.set(chunk.hash, chunk);
        return chunk;
      }
    } catch {}
    return null;
  }

  getPeerHealth(peerId) {
    if (!peerId) return null;
    const current = this.peerHealth.get(peerId) || emptyPeerHealth(peerId);
    const now = Date.now();
    const info = this.peerInfo.get(peerId) || {};
    const lastSeen = current.lastSeen || info.lastSeen || null;
    let state = current.state;

    if (this.peerSockets.get(peerId)?.readyState === WebSocket.OPEN) state = 'healthy';
    else if (lastSeen && now - lastSeen > PEER_DEAD_AFTER_MS) state = 'dead';
    else if (lastSeen && now - lastSeen > PEER_SUSPECT_AFTER_MS) state = 'suspect';
    else if (info.status === 'error') state = 'suspect';
    else if (info.status === 'disconnected') state = 'offline';

    const agedPenalty = state === 'dead' ? 45 : state === 'suspect' ? 20 : state === 'offline' ? 10 : 0;
    const failurePenalty = Math.min(40, current.failures * 8);
    const successBonus = Math.min(35, current.successes * 4 + current.storedChunks * 2 + current.fetchedChunks * 2);
    const latencyPenalty = current.lastLatencyMs ? Math.min(15, Math.floor(current.lastLatencyMs / 1000)) : 0;
    const connectedBonus = state === 'healthy' ? 25 : 0;
    const score = clamp(50 + successBonus + connectedBonus - failurePenalty - agedPenalty - latencyPenalty, 0, 100);
    const next = { ...current, state, score, lastSeen };
    this.peerHealth.set(peerId, next);
    return next;
  }

  markPeerOnline(peerId) {
    if (!peerId || peerId === this.peerId) return;
    const now = Date.now();
    const current = this.getPeerHealth(peerId) || emptyPeerHealth(peerId);
    this.peerHealth.set(peerId, { ...current, state: 'healthy', lastSeen: now, lastError: null });
  }

  markPeerOffline(peerId, error = null) {
    if (!peerId || peerId === this.peerId) return;
    const now = Date.now();
    const current = this.getPeerHealth(peerId) || emptyPeerHealth(peerId);
    this.peerHealth.set(peerId, {
      ...current,
      state: error ? 'suspect' : 'offline',
      lastSeen: current.lastSeen || now,
      lastFailureAt: error ? now : current.lastFailureAt,
      failures: error ? current.failures + 1 : current.failures,
      lastError: error ? String(error) : current.lastError,
    });
  }

  notePeerSuccess(peerId, type = 'generic', latencyMs = null) {
    if (!peerId || peerId === this.peerId) return;
    const now = Date.now();
    const current = this.getPeerHealth(peerId) || emptyPeerHealth(peerId);
    this.peerHealth.set(peerId, {
      ...current,
      state: 'healthy',
      successes: current.successes + 1,
      storedChunks: type === 'store' ? current.storedChunks + 1 : current.storedChunks,
      fetchedChunks: type === 'fetch' ? current.fetchedChunks + 1 : current.fetchedChunks,
      lastSeen: now,
      lastSuccessAt: now,
      lastLatencyMs: latencyMs ?? current.lastLatencyMs,
      lastError: null,
    });
  }

  notePeerFailure(peerId, error = null) {
    if (!peerId || peerId === this.peerId) return;
    const now = Date.now();
    const current = this.getPeerHealth(peerId) || emptyPeerHealth(peerId);
    const nextFailures = current.failures + 1;
    this.peerHealth.set(peerId, {
      ...current,
      state: nextFailures >= 3 ? 'suspect' : current.state,
      failures: nextFailures,
      lastFailureAt: now,
      lastError: error ? String(error) : current.lastError,
    });
  }

  isPeerHealthy(peerId, minScore = MIN_REPLICA_HEALTH_SCORE) {
    const health = this.getPeerHealth(peerId);
    return Boolean(health && health.state !== 'dead' && health.score >= minScore);
  }

  sortedConnectedPeerIds() {
    return this.connectedPeerIds().sort((a, b) => {
      const ah = this.getPeerHealth(a);
      const bh = this.getPeerHealth(b);
      return (bh?.score || 0) - (ah?.score || 0);
    });
  }

  peerHealthSummary() {
    const peers = new Set([...this.peerInfo.keys(), ...this.peerHealth.keys(), ...this.connectedPeerIds()]);
    return Array.from(peers).map((peerId) => ({ ...(this.peerInfo.get(peerId) || { peerId }), health: this.getPeerHealth(peerId) }));
  }

  start() {
    if (this.server) {
      return { peerId: this.peerId, port: this.port, host: this.host, publicUrl: this.publicUrl };
    }

    this.server = new WebSocketServer({ host: this.host, port: this.port });

    this.server.on('connection', (socket) => {
      socket.isAlive = true;
      socket.role = 'unknown';

      socket.on('pong', () => {
        socket.isAlive = true;
        if (socket.remotePeerId) this.markPeerOnline(socket.remotePeerId);
      });

      socket.on('message', (raw) => {
        this.handleSocketMessage(socket, raw);
      });

      socket.on('close', () => {
        this.uiClients.delete(socket);
        for (const [peerId, peerSocket] of this.peerSockets.entries()) {
          if (peerSocket === socket) {
            this.peerSockets.delete(peerId);
            this.markPeerOffline(peerId);
            this.peerInfo.set(peerId, {
              ...(this.peerInfo.get(peerId) || { peerId }),
              status: 'disconnected',
              lastSeen: Date.now(),
            });
            this.broadcastToUi({ type: 'peer:disconnected', peerId });
          }
        }
      });

      this.send(socket, {
        type: 'transport:ready',
        peerId: this.peerId,
        port: this.port,
        publicUrl: this.publicUrl,
      });
    });

    this.heartbeat = setInterval(() => {
      this.server?.clients.forEach((socket) => {
        if (socket.isAlive === false) {
          if (socket.remotePeerId) this.markPeerOffline(socket.remotePeerId, 'heartbeat timeout');
          socket.terminate();
          return;
        }
        socket.isAlive = false;
        socket.ping();
      });
    }, 30000);

    console.log(`[p2p-transport] listening on ws://${this.host}:${this.port} as ${this.peerId}`);
    if (this.publicUrl) console.log(`[p2p-transport] advertising ${this.publicUrl}`);
    if (this.chunkStoreDir) console.log(`[p2p-transport] chunk store ${this.chunkStoreDir}`);
    return { peerId: this.peerId, port: this.port, host: this.host, publicUrl: this.publicUrl };
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const pending of this.pendingChunkRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('P2P node stopped'));
    }
    this.pendingChunkRequests.clear();
    for (const pending of this.pendingChunkAcks.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, peerId: pending.peerId, chunkHash: pending.chunkHash, error: 'P2P node stopped' });
    }
    this.pendingChunkAcks.clear();
    for (const socket of this.peerSockets.values()) socket.close();
    for (const socket of this.uiClients.values()) socket.close();
    this.server?.close();
    this.server = null;
  }

  connectedPeerIds() {
    return Array.from(this.peerSockets.entries())
      .filter(([, socket]) => socket.readyState === WebSocket.OPEN)
      .map(([peerId]) => peerId);
  }

  healthyReplicaIds(chunkHash) {
    const known = this.chunkReplicas.get(chunkHash) || new Set();
    const online = new Set(this.connectedPeerIds());
    return Array.from(known).filter((peerId) => online.has(peerId) && this.isPeerHealthy(peerId));
  }

  selectReplicaTargets({ exclude = [], limit = 3 } = {}) {
    const excluded = new Set(exclude);
    return this.sortedConnectedPeerIds()
      .filter((peerId) => !excluded.has(peerId) && this.isPeerHealthy(peerId))
      .slice(0, limit);
  }

  connectPeer({ peerId, url }) {
    if (!peerId || !url) throw new Error('peerId and url are required');
    if (peerId === this.peerId) return { peerId, status: 'self', url };

    const existing = this.peerSockets.get(peerId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      this.markPeerOnline(peerId);
      return { peerId, status: 'connected', url };
    }

    this.peerInfo.set(peerId, { peerId, url, status: 'connecting', lastSeen: Date.now() });
    const socket = new WebSocket(url);
    socket.role = 'peer';
    socket.remotePeerId = peerId;

    socket.on('open', () => {
      this.peerSockets.set(peerId, socket);
      this.markPeerOnline(peerId);
      this.peerInfo.set(peerId, { peerId, url, status: 'connected', lastSeen: Date.now() });
      this.send(socket, {
        type: 'peer:hello',
        fromPeerId: this.peerId,
        toPeerId: peerId,
        payload: { peerId: this.peerId, url: this.publicUrl || `ws://127.0.0.1:${this.port}` },
      });
      this.broadcastToUi({ type: 'peer:connected', peerId, url });
    });

    socket.on('message', (raw) => this.handleSocketMessage(socket, raw));
    socket.on('close', () => {
      this.peerSockets.delete(peerId);
      this.markPeerOffline(peerId);
      this.peerInfo.set(peerId, { peerId, url, status: 'disconnected', lastSeen: Date.now() });
      this.broadcastToUi({ type: 'peer:disconnected', peerId });
    });
    socket.on('error', (error) => {
      this.markPeerOffline(peerId, error.message);
      this.peerInfo.set(peerId, { peerId, url, status: 'error', error: error.message, lastSeen: Date.now() });
      this.broadcastToUi({ type: 'peer:error', peerId, url, error: error.message });
    });

    return { peerId, status: 'connecting', url };
  }

  async putChunkOnNetwork(chunk, replicaPeerIds = this.selectReplicaTargets({ limit: 3 })) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');
    const targets = replicaPeerIds.filter((peerId) => this.peerSockets.get(peerId)?.readyState === WebSocket.OPEN && this.isPeerHealthy(peerId));
    if (!targets.length) throw new Error('No healthy connected P2P peers available');

    const replicaSet = this.chunkReplicas.get(chunk.hash) || new Set();
    const ackPromises = [];

    for (const peerId of targets) {
      const socket = this.peerSockets.get(peerId);
      const messageId = crypto.randomUUID();
      const fallbackKey = `${chunk.hash}:${peerId}`;
      const startedAt = Date.now();

      const ackPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingChunkAcks.delete(messageId);
          this.pendingChunkAcks.delete(fallbackKey);
          this.notePeerFailure(peerId, 'chunk:stored-ack timeout');
          resolve({ ok: false, peerId, chunkHash: chunk.hash, error: 'chunk:stored-ack timeout' });
        }, CHUNK_STORE_ACK_TIMEOUT_MS);

        const pending = { resolve, timeout, peerId, chunkHash: chunk.hash, startedAt };
        this.pendingChunkAcks.set(messageId, pending);
        this.pendingChunkAcks.set(fallbackKey, pending);
      });

      ackPromises.push(ackPromise);

      this.send(socket, {
        id: messageId,
        type: 'chunk:put',
        fromPeerId: this.peerId,
        toPeerId: peerId,
        createdAt: Date.now(),
        payload: { chunk },
      });
    }

    const ackResults = await Promise.all(ackPromises);
    const stored = [];
    const failed = [];

    for (const result of ackResults) {
      if (result?.ok && result.peerId) {
        replicaSet.add(result.peerId);
        stored.push(result.peerId);
      } else if (result?.peerId) {
        failed.push(result);
        this.notePeerFailure(result.peerId, result.error);
      }
    }

    this.chunkReplicas.set(chunk.hash, replicaSet);
    if (failed.length) {
      console.warn('[p2p-transport] chunk replica ack failed:', chunk.hash, failed.map((entry) => `${entry.peerId}:${entry.error}`).join(', '));
    }
    return { ok: true, replicas: stored, failedReplicas: failed, allKnownReplicas: Array.from(replicaSet) };
  }

  fetchChunkFromNetwork(chunkHash) {
    const localChunk = this.getLocalChunk(chunkHash);
    if (localChunk) return Promise.resolve(localChunk);

    const knownReplicas = this.healthyReplicaIds(chunkHash);
    const peers = knownReplicas.length ? knownReplicas : this.sortedConnectedPeerIds().filter((peerId) => this.isPeerHealthy(peerId));
    if (!peers.length) return Promise.reject(new Error('No healthy connected P2P peers available'));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingChunkRequests.delete(chunkHash);
        for (const peerId of peers) this.notePeerFailure(peerId, `Chunk not found on the network: ${chunkHash}`);
        reject(new Error(`Chunk not found on the network: ${chunkHash}`));
      }, CHUNK_REQUEST_TIMEOUT_MS);

      this.pendingChunkRequests.set(chunkHash, { resolve, reject, timeout, requestedFrom: peers, startedAt: Date.now() });

      for (const peerId of peers) {
        const socket = this.peerSockets.get(peerId);
        if (socket?.readyState !== WebSocket.OPEN) continue;
        this.send(socket, {
          id: crypto.randomUUID(),
          type: 'chunk:get',
          fromPeerId: this.peerId,
          toPeerId: peerId,
          createdAt: Date.now(),
          payload: { chunkHash },
        });
      }
    });
  }

  handleSocketMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.send(socket, { type: 'error', error: 'Invalid JSON message' });
      return;
    }

    if (message.fromPeerId && message.fromPeerId !== this.peerId) this.markPeerOnline(message.fromPeerId);

    if (message.type === 'ui:hello') {
      socket.role = 'ui';
      this.uiClients.add(socket);
      this.send(socket, {
        type: 'ui:ready',
        peerId: this.peerId,
        peers: this.peerHealthSummary(),
      });
      return;
    }

    if (message.type === 'peer:hello') {
      socket.role = 'peer';
      socket.remotePeerId = message.fromPeerId;
      this.peerSockets.set(message.fromPeerId, socket);
      this.markPeerOnline(message.fromPeerId);
      this.peerInfo.set(message.fromPeerId, {
        peerId: message.fromPeerId,
        url: message.payload?.url,
        status: 'connected',
        lastSeen: Date.now(),
      });
      this.broadcastToUi({ type: 'peer:connected', peerId: message.fromPeerId, url: message.payload?.url });
      return;
    }

    if (message.type === 'transport:connect-peer') {
      try {
        const result = this.connectPeer(message.payload);
        this.send(socket, { type: 'transport:connect-peer:result', payload: result });
      } catch (error) {
        this.send(socket, { type: 'transport:connect-peer:error', error: error.message });
      }
      return;
    }

    if (message.type === 'chunk:put') {
      const chunk = message.payload?.chunk;
      if (chunk?.hash) {
        this.storeLocalChunk(chunk);
        this.notePeerSuccess(message.fromPeerId, 'store');
        this.send(socket, {
          id: crypto.randomUUID(),
          type: 'chunk:stored-ack',
          fromPeerId: this.peerId,
          toPeerId: message.fromPeerId,
          createdAt: Date.now(),
          payload: { chunkHash: chunk.hash, ackTo: message.id || null },
        });
        this.broadcastToUi({ type: 'chunk:stored', chunkHash: chunk.hash, fromPeerId: message.fromPeerId });
      }
      return;
    }

    if (message.type === 'chunk:stored-ack') {
      const chunkHash = message.payload?.chunkHash;
      const ackTo = message.payload?.ackTo;
      const fromPeerId = message.fromPeerId;
      if (chunkHash && fromPeerId) {
        const replicaSet = this.chunkReplicas.get(chunkHash) || new Set();
        replicaSet.add(fromPeerId);
        this.chunkReplicas.set(chunkHash, replicaSet);
      }

      const ackKey = ackTo || (chunkHash && fromPeerId ? `${chunkHash}:${fromPeerId}` : null);
      const pending = ackKey ? this.pendingChunkAcks.get(ackKey) : null;
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingChunkAcks.delete(ackKey);
        if (chunkHash && fromPeerId) this.pendingChunkAcks.delete(`${chunkHash}:${fromPeerId}`);
        if (ackTo) this.pendingChunkAcks.delete(ackTo);
        this.notePeerSuccess(fromPeerId, 'store', Date.now() - (pending.startedAt || Date.now()));
        pending.resolve({ ok: true, peerId: fromPeerId, chunkHash });
      }
      return;
    }

    if (message.type === 'chunk:get') {
      const chunkHash = message.payload?.chunkHash;
      const chunk = this.getLocalChunk(chunkHash);
      if (chunk) {
        this.send(socket, {
          id: crypto.randomUUID(),
          type: 'chunk:found',
          fromPeerId: this.peerId,
          toPeerId: message.fromPeerId,
          createdAt: Date.now(),
          payload: { chunk },
        });
        return;
      }
      this.forwardOrDeliver(socket, message);
      return;
    }

    if (message.type === 'chunk:found') {
      const chunk = message.payload?.chunk;
      if (chunk?.hash && message.fromPeerId) {
        const replicaSet = this.chunkReplicas.get(chunk.hash) || new Set();
        replicaSet.add(message.fromPeerId);
        this.chunkReplicas.set(chunk.hash, replicaSet);
      }
      const pending = chunk?.hash ? this.pendingChunkRequests.get(chunk.hash) : null;
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingChunkRequests.delete(chunk.hash);
        this.storeLocalChunk(chunk);
        this.notePeerSuccess(message.fromPeerId, 'fetch', Date.now() - (pending.startedAt || Date.now()));
        for (const peerId of pending.requestedFrom || []) {
          if (peerId !== message.fromPeerId) this.notePeerSuccess(peerId, 'generic');
        }
        pending.resolve(chunk);
        return;
      }
      this.forwardOrDeliver(socket, message);
      return;
    }

    if (message.type === 'manifest:broadcast' || message.type === 'network:broadcast') {
      this.forwardOrDeliver(socket, message);
      return;
    }

    this.broadcastToUi(message);
  }

  forwardOrDeliver(sourceSocket, message) {
    if (message.toPeerId && message.toPeerId !== this.peerId) {
      const peerSocket = this.peerSockets.get(message.toPeerId);
      if (peerSocket?.readyState === WebSocket.OPEN) {
        this.send(peerSocket, message);
        return;
      }
    }

    this.broadcastToUi(message);

    if (!message.toPeerId) {
      for (const peerSocket of this.peerSockets.values()) {
        if (peerSocket !== sourceSocket && peerSocket.readyState === WebSocket.OPEN) {
          this.send(peerSocket, message);
        }
      }
    }
  }

  broadcastToUi(message) {
    for (const socket of this.uiClients) {
      if (socket.readyState === WebSocket.OPEN) {
        this.send(socket, message);
      }
    }
  }

  send(socket, message) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

export function startP2PTransport(options = {}) {
  const node = new P2PTransportNode(options);
  node.start();
  return node;
}
