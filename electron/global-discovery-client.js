import { WebSocket } from 'ws';

const DEFAULT_BOOTSTRAP_URL = process.env.P2P_BOOTSTRAP_URL || process.env.P2P_GLOBAL_DISCOVERY_URL || '';
const HEARTBEAT_MS = Number(process.env.P2P_BOOTSTRAP_HEARTBEAT_MS || 30_000);
const DISCOVERY_INTERVAL_MS = Number(process.env.P2P_GLOBAL_DISCOVERY_INTERVAL_MS || 20_000);
const CONNECT_BATCH_LIMIT = Number(process.env.P2P_GLOBAL_DISCOVERY_CONNECT_BATCH || 8);

function nowIso() {
  return new Date().toISOString();
}

function safeUrl(url = '') {
  const value = String(url || '').trim();
  return /^wss?:\/\//i.test(value) ? value : '';
}

function isPrivateLanUrl(url = '') {
  return /^ws:\/\/(127\.|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(String(url || ''));
}

export function createGlobalDiscoveryClient({ node, getIdentity = () => '', getPublicUrl = () => '', bootstrapUrl = DEFAULT_BOOTSTRAP_URL } = {}) {
  if (!node) throw new Error('global discovery requires a P2P transport node');

  let socket = null;
  let heartbeatTimer = null;
  let discoveryTimer = null;
  let reconnectTimer = null;
  let running = false;
  let lastError = null;
  let lastRegisteredAt = null;
  let lastPeerListAt = null;
  let directConnectAttempts = 0;
  let directConnectSuccesses = 0;
  let knownPeers = [];

  const state = {
    enabled: Boolean(safeUrl(bootstrapUrl)),
    bootstrapUrl: safeUrl(bootstrapUrl),
    connected: false,
    registered: false,
    peerCount: 0,
    lastError: null,
    lastRegisteredAt: null,
    lastPeerListAt: null,
    directConnectAttempts: 0,
    directConnectSuccesses: 0,
    knownPeers: [],
  };

  function summary() {
    return {
      ...state,
      connected: socket?.readyState === WebSocket.OPEN,
      peerCount: knownPeers.length,
      lastError,
      lastRegisteredAt,
      lastPeerListAt,
      directConnectAttempts,
      directConnectSuccesses,
      knownPeers: knownPeers.slice(0, 50),
    };
  }

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function registrationPayload(type = 'peer:register') {
    return {
      type,
      peerId: node.peerId,
      url: safeUrl(getPublicUrl?.() || node.publicUrl || ''),
      role: 'desktop-peer',
      displayName: node.peerId,
      identity: String(getIdentity?.() || ''),
      capabilities: {
        chunks: true,
        directWebSocket: true,
        relayClient: true,
      },
      createdAt: Date.now(),
    };
  }

  function register() {
    if (!send(registrationPayload('peer:register'))) return false;
    lastRegisteredAt = nowIso();
    state.registered = true;
    return true;
  }

  function heartbeat() {
    send(registrationPayload('peer:heartbeat'));
    send({ type: 'peer:list', peerId: node.peerId, createdAt: Date.now() });
  }

  function shouldConnect(peer) {
    if (!peer?.peerId || peer.peerId === node.peerId) return false;
    const url = safeUrl(peer.url);
    if (!url) return false;
    if (url === safeUrl(getPublicUrl?.() || node.publicUrl || '')) return false;
    if (url === `ws://127.0.0.1:${node.port}`) return false;
    return true;
  }

  async function connectDiscoveredPeers(peers = []) {
    const candidates = peers
      .filter(shouldConnect)
      .filter((peer) => !node.peerSockets?.get?.(peer.peerId))
      .slice(0, CONNECT_BATCH_LIMIT);

    for (const peer of candidates) {
      try {
        directConnectAttempts += 1;
        const result = node.connectPeer({ peerId: peer.peerId, url: peer.url });
        if (result?.status === 'connected' || result?.status === 'connecting') directConnectSuccesses += 1;
      } catch (error) {
        lastError = error?.message || String(error);
        console.warn('[global-discovery] direct connect failed:', peer.peerId, peer.url, lastError);
      }
    }
  }

  function updatePeerList(peers = []) {
    knownPeers = Array.isArray(peers)
      ? peers
          .filter((peer) => peer && peer.peerId && peer.peerId !== node.peerId)
          .map((peer) => ({
            peerId: String(peer.peerId || ''),
            url: safeUrl(peer.url),
            role: String(peer.role || ''),
            displayName: String(peer.displayName || ''),
            identity: String(peer.identity || ''),
            relay: Boolean(peer.relay),
            lastSeenAt: peer.lastSeenAt || null,
            route: safeUrl(peer.url) && !isPrivateLanUrl(peer.url) ? 'direct' : 'relay-candidate',
          }))
      : [];
    lastPeerListAt = nowIso();
    void connectDiscoveredPeers(knownPeers);
  }

  function onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === 'peer:registered') {
      state.registered = true;
      updatePeerList(message.payload?.peers || []);
      return;
    }

    if (message.type === 'peer:list') {
      updatePeerList(message.payload?.peers || []);
      return;
    }

    if (message.type === 'peer:online') {
      const peer = message.payload;
      updatePeerList([peer, ...knownPeers.filter((entry) => entry.peerId !== peer?.peerId)]);
      return;
    }

    if (message.type === 'peer:offline') {
      knownPeers = knownPeers.filter((peer) => peer.peerId !== message.peerId);
      return;
    }

    if (message.type === 'relay:message') {
      node.broadcastToUi?.({ type: 'relay:message', fromPeerId: message.fromPeerId, payload: message.payload, createdAt: message.createdAt });
      return;
    }

    if (message.type === 'error') {
      lastError = message.error || 'global discovery error';
    }
  }

  function cleanupTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (discoveryTimer) clearInterval(discoveryTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    heartbeatTimer = null;
    discoveryTimer = null;
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      start('reconnect');
    }, 5000);
    reconnectTimer.unref?.();
  }

  function start(reason = 'manual') {
    running = true;
    state.enabled = Boolean(safeUrl(bootstrapUrl));
    state.bootstrapUrl = safeUrl(bootstrapUrl);

    if (!state.enabled) {
      lastError = 'P2P_BOOTSTRAP_URL is not configured';
      return summary();
    }

    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      register();
      return summary();
    }

    socket = new WebSocket(state.bootstrapUrl);
    socket.on('open', () => {
      state.connected = true;
      lastError = null;
      register();
      heartbeat();
      cleanupTimers();
      heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
      discoveryTimer = setInterval(() => send({ type: 'peer:list', peerId: node.peerId, createdAt: Date.now() }), DISCOVERY_INTERVAL_MS);
      heartbeatTimer.unref?.();
      discoveryTimer.unref?.();
      console.log('[global-discovery] connected to bootstrap', state.bootstrapUrl, 'reason=', reason);
    });
    socket.on('message', onMessage);
    socket.on('close', () => {
      state.connected = false;
      state.registered = false;
      cleanupTimers();
      scheduleReconnect();
    });
    socket.on('error', (error) => {
      lastError = error?.message || String(error);
      state.connected = false;
      console.warn('[global-discovery] bootstrap error:', lastError);
    });

    return summary();
  }

  function stop() {
    running = false;
    cleanupTimers();
    try { socket?.close(); } catch {}
    socket = null;
    state.connected = false;
    state.registered = false;
    return summary();
  }

  function refresh() {
    if (!socket || socket.readyState !== WebSocket.OPEN) start('refresh');
    heartbeat();
    return summary();
  }

  return { start, stop, refresh, summary };
}
