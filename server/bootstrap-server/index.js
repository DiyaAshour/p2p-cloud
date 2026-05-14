import { WebSocketServer } from "ws";

const PORT = Number(process.env.P2P_BOOTSTRAP_PORT || 8788);
const HOST = process.env.P2P_BOOTSTRAP_HOST || "0.0.0.0";
const MAX_BOOTSTRAP_PEERS = Number(process.env.P2P_BOOTSTRAP_MAX_PEERS || 5000);
const MAX_PEERS_PER_RESPONSE = Number(process.env.P2P_BOOTSTRAP_RESPONSE_LIMIT || 64);
const MAX_MESSAGES_PER_MINUTE = Number(process.env.P2P_BOOTSTRAP_MESSAGES_PER_MINUTE || 120);
const PEER_TTL_MS = Number(process.env.P2P_BOOTSTRAP_PEER_TTL_MS || 10 * 60 * 1000);
const MAX_PAYLOAD_BYTES = Number(process.env.P2P_BOOTSTRAP_MAX_PAYLOAD_BYTES || 64 * 1024);

const peers = new Map();
const socketPeerIds = new WeakMap();
const rateLimits = new WeakMap();

function now() {
  return Date.now();
}

function safeSend(socket, message) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(message));
}

function isRateLimited(socket) {
  const current = rateLimits.get(socket) || { windowStart: now(), count: 0 };
  if (now() - current.windowStart >= 60_000) {
    current.windowStart = now();
    current.count = 0;
  }
  current.count += 1;
  rateLimits.set(socket, current);
  return current.count > MAX_MESSAGES_PER_MINUTE;
}

function prunePeers() {
  const cutoff = now() - PEER_TTL_MS;
  for (const [peerId, peer] of peers.entries()) {
    if (!peer.socket || peer.socket.readyState !== 1 || peer.lastSeen < cutoff) {
      peers.delete(peerId);
    }
  }
}

function selectPeersFor(peerId) {
  prunePeers();
  return Array.from(peers.values())
    .filter((peer) => peer.peerId !== peerId)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_PEERS_PER_RESPONSE)
    .map((peer) => ({ peerId: peer.peerId, url: peer.url, lastSeen: peer.lastSeen }));
}

function broadcastNewPeer(newPeer) {
  for (const peer of peers.values()) {
    if (peer.peerId === newPeer.peerId || peer.socket?.readyState !== 1) continue;
    safeSend(peer.socket, {
      type: "bootstrap:new-peer",
      peer: { peerId: newPeer.peerId, url: newPeer.url, lastSeen: newPeer.lastSeen },
    });
  }
}

const server = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_PAYLOAD_BYTES });

server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    if (raw?.length > MAX_PAYLOAD_BYTES) {
      socket.close(1009, "bootstrap message too large");
      return;
    }
    if (isRateLimited(socket)) {
      safeSend(socket, { type: "bootstrap:error", error: "rate limited" });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      safeSend(socket, { type: "bootstrap:error", error: "invalid json" });
      return;
    }

    if (msg.type === "peer:register") {
      if (!msg.peerId || !msg.url) {
        safeSend(socket, { type: "bootstrap:error", error: "peerId and url are required" });
        return;
      }

      prunePeers();
      if (!peers.has(msg.peerId) && peers.size >= MAX_BOOTSTRAP_PEERS) {
        safeSend(socket, { type: "bootstrap:error", error: "bootstrap peer cap reached" });
        socket.close(1013, "bootstrap peer cap reached");
        return;
      }

      const peer = { peerId: msg.peerId, url: msg.url, socket, lastSeen: now() };
      peers.set(msg.peerId, peer);
      socketPeerIds.set(socket, msg.peerId);

      safeSend(socket, {
        type: "bootstrap:peers",
        peers: selectPeersFor(msg.peerId),
        limits: { maxPeersPerResponse: MAX_PEERS_PER_RESPONSE, peerTtlMs: PEER_TTL_MS },
      });

      broadcastNewPeer(peer);
      return;
    }

    if (msg.type === "peer:heartbeat") {
      const peerId = socketPeerIds.get(socket) || msg.peerId;
      const peer = peers.get(peerId);
      if (peer) {
        peer.lastSeen = now();
        safeSend(socket, { type: "bootstrap:pong", peerId, peers: selectPeersFor(peerId) });
      }
    }
  });

  socket.on("close", () => {
    const peerId = socketPeerIds.get(socket);
    if (peerId && peers.get(peerId)?.socket === socket) peers.delete(peerId);
  });
});

setInterval(prunePeers, Math.min(PEER_TTL_MS, 60_000));

console.log(`Global Bootstrap running on ws://${HOST}:${PORT}`);
console.log("Bootstrap limits", { MAX_BOOTSTRAP_PEERS, MAX_PEERS_PER_RESPONSE, MAX_MESSAGES_PER_MINUTE, PEER_TTL_MS });
