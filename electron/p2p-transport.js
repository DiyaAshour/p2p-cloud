import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const DEFAULT_PORT = Number(process.env.P2P_TRANSPORT_PORT || 8787);
const DEFAULT_HOST = process.env.P2P_TRANSPORT_HOST || '0.0.0.0';
const CHUNK_REQUEST_TIMEOUT_MS = Number(process.env.P2P_CHUNK_REQUEST_TIMEOUT_MS || 15000);

export class P2PTransportNode {
  constructor({ peerId, port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
    this.peerId = peerId || `electron-peer-${crypto.randomUUID()}`;
    this.port = port;
    this.host = host;
    this.server = null;
    this.uiClients = new Set();
    this.peerSockets = new Map();
    this.peerInfo = new Map();
    this.localChunks = new Map();
    this.pendingChunkRequests = new Map();
  }

  start() {
    if (this.server) {
      return { peerId: this.peerId, port: this.port, host: this.host };
    }

    this.server = new WebSocketServer({ host: this.host, port: this.port });

    this.server.on('connection', (socket) => {
      socket.isAlive = true;
      socket.role = 'unknown';

      socket.on('pong', () => {
        socket.isAlive = true;
      });

      socket.on('message', (raw) => {
        this.handleSocketMessage(socket, raw);
      });

      socket.on('close', () => {
        this.uiClients.delete(socket);
        for (const [peerId, peerSocket] of this.peerSockets.entries()) {
          if (peerSocket === socket) {
            this.peerSockets.delete(peerId);
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
      });
    });

    this.heartbeat = setInterval(() => {
      this.server?.clients.forEach((socket) => {
        if (socket.isAlive === false) {
          socket.terminate();
          return;
        }
        socket.isAlive = false;
        socket.ping();
      });
    }, 30000);

    console.log(`[p2p-transport] listening on ws://${this.host}:${this.port} as ${this.peerId}`);
    return { peerId: this.peerId, port: this.port, host: this.host };
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const pending of this.pendingChunkRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('P2P node stopped'));
    }
    this.pendingChunkRequests.clear();
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

  connectPeer({ peerId, url }) {
    if (!peerId || !url) throw new Error('peerId and url are required');

    const existing = this.peerSockets.get(peerId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      return { peerId, status: 'connected', url };
    }

    const socket = new WebSocket(url);
    socket.role = 'peer';
    socket.remotePeerId = peerId;

    socket.on('open', () => {
      this.peerSockets.set(peerId, socket);
      this.peerInfo.set(peerId, { peerId, url, status: 'connected', lastSeen: Date.now() });
      this.send(socket, {
        type: 'peer:hello',
        fromPeerId: this.peerId,
        toPeerId: peerId,
        payload: { peerId: this.peerId, url: `ws://127.0.0.1:${this.port}` },
      });
      this.broadcastToUi({ type: 'peer:connected', peerId, url });
    });

    socket.on('message', (raw) => this.handleSocketMessage(socket, raw));
    socket.on('close', () => {
      this.peerSockets.delete(peerId);
      this.peerInfo.set(peerId, { peerId, url, status: 'disconnected', lastSeen: Date.now() });
      this.broadcastToUi({ type: 'peer:disconnected', peerId });
    });
    socket.on('error', (error) => {
      this.broadcastToUi({ type: 'peer:error', peerId, error: error.message });
    });

    return { peerId, status: 'connecting', url };
  }

  putChunkOnNetwork(chunk, replicaPeerIds = this.connectedPeerIds()) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');
    if (!replicaPeerIds.length) throw new Error('No connected P2P peers available');

    for (const peerId of replicaPeerIds) {
      const socket = this.peerSockets.get(peerId);
      if (socket?.readyState !== WebSocket.OPEN) continue;
      this.send(socket, {
        id: crypto.randomUUID(),
        type: 'chunk:put',
        fromPeerId: this.peerId,
        toPeerId: peerId,
        createdAt: Date.now(),
        payload: { chunk },
      });
    }

    return { ok: true, replicas: replicaPeerIds };
  }

  fetchChunkFromNetwork(chunkHash) {
    const localChunk = this.localChunks.get(chunkHash);
    if (localChunk) return Promise.resolve(localChunk);

    const peers = this.connectedPeerIds();
    if (!peers.length) return Promise.reject(new Error('No connected P2P peers available'));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingChunkRequests.delete(chunkHash);
        reject(new Error(`Chunk not found on the network: ${chunkHash}`));
      }, CHUNK_REQUEST_TIMEOUT_MS);

      this.pendingChunkRequests.set(chunkHash, { resolve, reject, timeout });

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

    if (message.type === 'ui:hello') {
      socket.role = 'ui';
      this.uiClients.add(socket);
      this.send(socket, {
        type: 'ui:ready',
        peerId: this.peerId,
        peers: Array.from(this.peerInfo.values()),
      });
      return;
    }

    if (message.type === 'peer:hello') {
      socket.role = 'peer';
      socket.remotePeerId = message.fromPeerId;
      this.peerSockets.set(message.fromPeerId, socket);
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
        this.localChunks.set(chunk.hash, chunk);
        this.broadcastToUi({ type: 'chunk:stored', chunkHash: chunk.hash, fromPeerId: message.fromPeerId });
      }
      return;
    }

    if (message.type === 'chunk:get') {
      const chunkHash = message.payload?.chunkHash;
      const chunk = this.localChunks.get(chunkHash);
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
      const pending = chunk?.hash ? this.pendingChunkRequests.get(chunk.hash) : null;
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingChunkRequests.delete(chunk.hash);
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
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

export function startP2PTransport(options = {}) {
  const node = new P2PTransportNode(options);
  node.start();
  return node;
}
