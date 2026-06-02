import { WebSocketServer } from "ws";

const PORT = Number(process.env.P2P_BOOTSTRAP_PORT || 8788);
const HOST = process.env.P2P_BOOTSTRAP_HOST || "0.0.0.0";
const MAX_BOOTSTRAP_PEERS = Number(process.env.P2P_BOOTSTRAP_MAX_PEERS || 50000);
const MAX_PEERS_PER_RESPONSE = Number(process.env.P2P_BOOTSTRAP_RESPONSE_LIMIT || 64);
const MAX_PEERS_PER_RESPONSE_HARD = Number(process.env.P2P_BOOTSTRAP_RESPONSE_LIMIT_HARD || 256);
const MAX_MESSAGES_PER_MINUTE = Number(process.env.P2P_BOOTSTRAP_MESSAGES_PER_MINUTE || 120);
const PEER_TTL_MS = Number(process.env.P2P_BOOTSTRAP_PEER_TTL_MS || 10 * 60 * 1000);
const MAX_PAYLOAD_BYTES = Number(process.env.P2P_BOOTSTRAP_MAX_PAYLOAD_BYTES || 64 * 1024);
const MAX_PEER_ID_LENGTH = Number(process.env.P2P_BOOTSTRAP_MAX_PEER_ID_LENGTH || 128);
const MAX_URL_LENGTH = Number(process.env.P2P_BOOTSTRAP_MAX_URL_LENGTH || 256);
const ALLOWED_ROLES = new Set(["peer", "desktop-peer", "storage-peer", "safety-peer", "bootstrap-peer"]);

const peers = new Map();
const socketPeerIds = new WeakMap();
const rateLimits = new WeakMap();

function now() { return Date.now(); }
function safeSend(socket, message) { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }
function safeNumber(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }

function isRateLimited(socket) {
  const current = rateLimits.get(socket) || { windowStart: now(), count: 0 };
  if (now() - current.windowStart >= 60_000) { current.windowStart = now(); current.count = 0; }
  current.count += 1;
  rateLimits.set(socket, current);
  return current.count > MAX_MESSAGES_PER_MINUTE;
}

function normalizePeerId(peerId = "") {
  const value = String(peerId || "").trim();
  if (!value || value.length > MAX_PEER_ID_LENGTH) throw new Error("Invalid peerId length");
  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) throw new Error("Invalid peerId format");
  return value;
}
function normalizeRole(role = "peer") {
  const value = String(role || "peer").trim().toLowerCase();
  if (!ALLOWED_ROLES.has(value)) throw new Error("Invalid peer role");
  return value;
}
function normalizeRegion(region = "global") {
  const value = String(region || "global").trim().toLowerCase().replace(/[^a-z0-9._:-]/g, "").slice(0, 48);
  return value || "global";
}
function normalizePeerUrl(url = "") {
  const value = String(url || "").trim();
  if (!value || value.length > MAX_URL_LENGTH) throw new Error("Invalid peer url length");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Invalid peer url"); }
  if (!["ws:", "wss:"].includes(parsed.protocol)) throw new Error("Peer url must use ws:// or wss://");
  if (!parsed.hostname || parsed.username || parsed.password) throw new Error("Peer url must not include credentials");
  if (parsed.hash || parsed.search) throw new Error("Peer url must not include query or hash");
  if (parsed.pathname && parsed.pathname !== "/") throw new Error("Peer url path is not allowed");
  const port = Number(parsed.port || (parsed.protocol === "wss:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid peer url port");
  return parsed.toString().replace(/\/$/, "");
}
function normalizeDisplayName(displayName = "") { return String(displayName || "").trim().slice(0, 80); }
function normalizeStorage(storage = {}) {
  const source = storage && typeof storage === "object" ? storage : {};
  return {
    acceptingChunks: source.acceptingChunks !== false,
    pressure: Boolean(source.pressure),
    nodeMode: String(source.nodeMode || "standard").slice(0, 40),
    freeBytes: Math.max(0, safeNumber(source.freeBytes, 0)),
    remainingSharedBytes: Math.max(0, safeNumber(source.remainingSharedBytes, 0)),
    maxSharedStorageBytes: Math.max(0, safeNumber(source.maxSharedStorageBytes, 0)),
    usedBytes: Math.max(0, safeNumber(source.usedBytes, 0)),
  };
}
function normalizeDiscoveryQuery(msg = {}) {
  return {
    region: normalizeRegion(msg.region || msg.discovery?.region || "global"),
    cursor: clamp(msg.cursor || msg.discovery?.cursor || 0, 0, MAX_BOOTSTRAP_PEERS),
    limit: clamp(msg.limit || msg.discovery?.limit || MAX_PEERS_PER_RESPONSE, 1, MAX_PEERS_PER_RESPONSE_HARD),
    minRemainingBytes: Math.max(0, safeNumber(msg.minRemainingBytes || msg.discovery?.minRemainingBytes, 0)),
  };
}
function sanitizePeerMessage(msg = {}) {
  const peerId = normalizePeerId(msg.peerId);
  const url = normalizePeerUrl(msg.url);
  const role = normalizeRole(msg.role || "peer");
  const displayName = normalizeDisplayName(msg.displayName || role);
  const region = normalizeRegion(msg.region || msg.discovery?.region || process.env.P2P_BOOTSTRAP_DEFAULT_REGION || "global");
  const storage = normalizeStorage(msg.storage || msg.capacity || {});
  return { peerId, url, role, displayName, region, storage };
}
function publicPeer(peer) {
  return { peerId: peer.peerId, url: peer.url, role: peer.role, displayName: peer.displayName, region: peer.region, storage: peer.storage, lastSeen: peer.lastSeen };
}
function prunePeers() {
  const cutoff = now() - PEER_TTL_MS;
  for (const [peerId, peer] of peers.entries()) if (!peer.socket || peer.socket.readyState !== 1 || peer.lastSeen < cutoff) peers.delete(peerId);
}
function peerScore(peer, query = {}) {
  const sameRegion = peer.region === query.region ? 1000000000000 : 0;
  const roleBonus = peer.role === "storage-peer" ? 100000000 : peer.role === "safety-peer" ? 80000000 : 0;
  const acceptingBonus = peer.storage?.acceptingChunks !== false && !peer.storage?.pressure ? 50000000 : -50000000;
  const capacity = Math.min(40000000, Math.floor(safeNumber(peer.storage?.remainingSharedBytes, 0) / (1024 * 1024)));
  return sameRegion + roleBonus + acceptingBonus + capacity + safeNumber(peer.lastSeen, 0);
}
function selectPeersFor(peerId, query = {}) {
  prunePeers();
  const cursor = clamp(query.cursor, 0, MAX_BOOTSTRAP_PEERS);
  const limit = clamp(query.limit, 1, MAX_PEERS_PER_RESPONSE_HARD);
  const candidates = Array.from(peers.values())
    .filter((peer) => peer.peerId !== peerId)
    .filter((peer) => !query.minRemainingBytes || safeNumber(peer.storage?.remainingSharedBytes, 0) >= query.minRemainingBytes)
    .sort((a, b) => peerScore(b, query) - peerScore(a, query));
  const page = candidates.slice(cursor, cursor + limit).map(publicPeer);
  const nextCursor = cursor + limit < candidates.length ? cursor + limit : null;
  return { peers: page, nextCursor, total: candidates.length, limit, region: query.region };
}
function broadcastNewPeer(newPeer) {
  for (const peer of peers.values()) {
    if (peer.peerId === newPeer.peerId || peer.socket?.readyState !== 1) continue;
    if (peer.region !== newPeer.region && peers.size > MAX_PEERS_PER_RESPONSE) continue;
    safeSend(peer.socket, { type: "bootstrap:new-peer", peer: publicPeer(newPeer) });
  }
}

const server = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_PAYLOAD_BYTES });

server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    if (raw?.length > MAX_PAYLOAD_BYTES) { socket.close(1009, "bootstrap message too large"); return; }
    if (isRateLimited(socket)) { safeSend(socket, { type: "bootstrap:error", error: "rate limited" }); return; }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { safeSend(socket, { type: "bootstrap:error", error: "invalid json" }); return; }

    if (msg.type === "peer:register") {
      let cleanPeer;
      try { cleanPeer = sanitizePeerMessage(msg); } catch (error) { safeSend(socket, { type: "bootstrap:error", error: error?.message || "invalid peer registration" }); return; }
      prunePeers();
      if (!peers.has(cleanPeer.peerId) && peers.size >= MAX_BOOTSTRAP_PEERS) { safeSend(socket, { type: "bootstrap:error", error: "bootstrap peer cap reached" }); socket.close(1013, "bootstrap peer cap reached"); return; }
      const previous = peers.get(cleanPeer.peerId) || {};
      const peer = { ...previous, ...cleanPeer, socket, lastSeen: now() };
      peers.set(cleanPeer.peerId, peer);
      socketPeerIds.set(socket, cleanPeer.peerId);
      const query = normalizeDiscoveryQuery(msg);
      const page = selectPeersFor(cleanPeer.peerId, query);
      safeSend(socket, { type: "bootstrap:peers", ...page, limits: { maxPeersPerResponse: MAX_PEERS_PER_RESPONSE, hardLimit: MAX_PEERS_PER_RESPONSE_HARD, peerTtlMs: PEER_TTL_MS, maxBootstrapPeers: MAX_BOOTSTRAP_PEERS } });
      broadcastNewPeer(peer);
      return;
    }

    if (msg.type === "peer:heartbeat") {
      let peerId;
      try { peerId = normalizePeerId(socketPeerIds.get(socket) || msg.peerId); } catch { safeSend(socket, { type: "bootstrap:error", error: "invalid heartbeat peerId" }); return; }
      const peer = peers.get(peerId);
      if (peer) {
        peer.lastSeen = now();
        if (msg.storage || msg.capacity) peer.storage = normalizeStorage(msg.storage || msg.capacity || peer.storage || {});
        if (msg.region) peer.region = normalizeRegion(msg.region);
        const page = selectPeersFor(peerId, normalizeDiscoveryQuery(msg));
        safeSend(socket, { type: "bootstrap:pong", peerId, ...page });
      }
      return;
    }

    if (msg.type === "peer:discover") {
      let peerId;
      try { peerId = normalizePeerId(socketPeerIds.get(socket) || msg.peerId); } catch { safeSend(socket, { type: "bootstrap:error", error: "invalid discover peerId" }); return; }
      safeSend(socket, { type: "bootstrap:peers", ...selectPeersFor(peerId, normalizeDiscoveryQuery(msg)) });
    }
  });

  socket.on("close", () => {
    const peerId = socketPeerIds.get(socket);
    if (peerId && peers.get(peerId)?.socket === socket) peers.delete(peerId);
  });
});

setInterval(prunePeers, Math.min(PEER_TTL_MS, 60_000));

console.log(`Global Bootstrap running on ws://${HOST}:${PORT}`);
console.log("Bootstrap limits", { MAX_BOOTSTRAP_PEERS, MAX_PEERS_PER_RESPONSE, MAX_PEERS_PER_RESPONSE_HARD, MAX_MESSAGES_PER_MINUTE, PEER_TTL_MS, MAX_PAYLOAD_BYTES, MAX_PEER_ID_LENGTH, MAX_URL_LENGTH });
