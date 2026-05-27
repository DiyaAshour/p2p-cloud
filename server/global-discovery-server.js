import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';

const PORT = Number(process.env.P2P_BOOTSTRAP_PORT || process.env.GLOBAL_DISCOVERY_PORT || 8788);
const HOST = process.env.P2P_BOOTSTRAP_HOST || process.env.GLOBAL_DISCOVERY_HOST || '0.0.0.0';
const HEARTBEAT_TTL_MS = Number(process.env.P2P_BOOTSTRAP_PEER_TTL_MS || 90_000);
const MAX_MESSAGE_BYTES = Number(process.env.P2P_BOOTSTRAP_MAX_MESSAGE_BYTES || 512 * 1024);
const MAX_PEERS = Number(process.env.P2P_BOOTSTRAP_MAX_PEERS || 10_000);

const peers = new Map();
const socketsByPeerId = new Map();

function nowIso() {
  return new Date().toISOString();
}

function safeString(value = '', max = 256) {
  return String(value || '').trim().slice(0, max);
}

function safePeer(peer = {}) {
  return {
    peerId: safeString(peer.peerId, 128),
    url: safeString(peer.url, 512),
    role: safeString(peer.role || 'desktop-peer', 64),
    displayName: safeString(peer.displayName || '', 128),
    identity: safeString(peer.identity || '', 128),
    capabilities: peer.capabilities && typeof peer.capabilities === 'object' ? peer.capabilities : {},
    relay: Boolean(peer.relay),
    firstSeenAt: peer.firstSeenAt || nowIso(),
    lastSeenAt: peer.lastSeenAt || nowIso(),
  };
}

function publicPeer(peer) {
  const { socket, ...rest } = peer;
  return rest;
}

function peerList(excludePeerId = '') {
  pruneDeadPeers();
  return Array.from(peers.values())
    .filter((peer) => peer.peerId && peer.peerId !== excludePeerId)
    .map(publicPeer)
    .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
    .slice(0, 250);
}

function send(socket, message) {
  if (socket?.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(message, exceptPeerId = '') {
  for (const [peerId, socket] of socketsByPeerId.entries()) {
    if (peerId !== exceptPeerId) send(socket, message);
  }
}

function pruneDeadPeers() {
  const cutoff = Date.now() - HEARTBEAT_TTL_MS;
  for (const [peerId, peer] of peers.entries()) {
    const last = new Date(peer.lastSeenAt || 0).getTime();
    const socket = socketsByPeerId.get(peerId);
    const socketOpen = socket?.readyState === socket?.OPEN;
    if (!socketOpen && (!last || last < cutoff)) {
      peers.delete(peerId);
      socketsByPeerId.delete(peerId);
    }
  }
}

function registerPeer(socket, payload = {}) {
  if (peers.size >= MAX_PEERS && !peers.has(payload.peerId)) {
    throw new Error('bootstrap peer registry is full');
  }

  const peerId = safeString(payload.peerId || payload.fromPeerId, 128);
  if (!peerId) throw new Error('peerId is required');

  const previous = peers.get(peerId) || {};
  const next = safePeer({
    ...previous,
    peerId,
    url: payload.url || payload.publicUrl || previous.url || '',
    role: payload.role || previous.role || 'desktop-peer',
    displayName: payload.displayName || previous.displayName || '',
    identity: payload.identity || previous.identity || '',
    capabilities: payload.capabilities || previous.capabilities || {},
    relay: true,
    firstSeenAt: previous.firstSeenAt || nowIso(),
    lastSeenAt: nowIso(),
  });

  socket.peerId = peerId;
  next.socket = socket;
  peers.set(peerId, next);
  socketsByPeerId.set(peerId, socket);

  send(socket, {
    id: payload.id || crypto.randomUUID(),
    type: 'peer:registered',
    peerId,
    payload: { self: publicPeer(next), peers: peerList(peerId) },
    createdAt: Date.now(),
  });

  broadcast({ type: 'peer:online', payload: publicPeer(next), createdAt: Date.now() }, peerId);
  return next;
}

function handleMessage(socket, raw) {
  if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
    send(socket, { type: 'error', error: 'Message too large' });
    socket.close(1009, 'Message too large');
    return;
  }

  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    send(socket, { type: 'error', error: 'Invalid JSON' });
    return;
  }

  try {
    if (message.type === 'peer:register' || message.type === 'peer:heartbeat') {
      registerPeer(socket, { ...message, ...(message.payload || {}) });
      return;
    }

    if (message.type === 'peer:list' || message.type === 'bootstrap:list') {
      const peerId = safeString(message.peerId || message.fromPeerId || socket.peerId, 128);
      send(socket, {
        id: message.id || crypto.randomUUID(),
        type: 'peer:list',
        payload: { peers: peerList(peerId) },
        createdAt: Date.now(),
      });
      return;
    }

    if (message.type === 'relay:send') {
      const fromPeerId = safeString(message.fromPeerId || socket.peerId, 128);
      const toPeerId = safeString(message.toPeerId || message.payload?.toPeerId, 128);
      const target = socketsByPeerId.get(toPeerId);
      if (!fromPeerId || !toPeerId) throw new Error('relay requires fromPeerId and toPeerId');
      if (!target || target.readyState !== target.OPEN) throw new Error('target peer is not connected to relay');

      send(target, {
        id: message.id || crypto.randomUUID(),
        type: 'relay:message',
        fromPeerId,
        toPeerId,
        payload: message.payload?.message || message.payload || {},
        createdAt: Date.now(),
      });
      send(socket, {
        id: message.id || crypto.randomUUID(),
        type: 'relay:sent',
        fromPeerId,
        toPeerId,
        createdAt: Date.now(),
      });
      return;
    }

    send(socket, { type: 'error', error: `Unsupported bootstrap message: ${message.type || 'unknown'}` });
  } catch (error) {
    send(socket, { type: 'error', id: message.id || crypto.randomUUID(), error: error?.message || String(error), createdAt: Date.now() });
  }
}

const server = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_MESSAGE_BYTES });

server.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', (raw) => handleMessage(socket, raw));
  socket.on('close', () => {
    const peerId = socket.peerId;
    if (peerId) {
      socketsByPeerId.delete(peerId);
      const peer = peers.get(peerId);
      if (peer) {
        peer.lastSeenAt = nowIso();
        delete peer.socket;
        peers.set(peerId, peer);
      }
      broadcast({ type: 'peer:offline', peerId, createdAt: Date.now() }, peerId);
    }
  });
  send(socket, { type: 'bootstrap:ready', createdAt: Date.now(), payload: { port: PORT, ttlMs: HEARTBEAT_TTL_MS } });
});

setInterval(() => {
  pruneDeadPeers();
  for (const socket of server.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000).unref?.();

console.log(`[global-discovery] listening on ws://${HOST}:${PORT}`);
console.log(`[global-discovery] peer TTL ${HEARTBEAT_TTL_MS}ms`);
