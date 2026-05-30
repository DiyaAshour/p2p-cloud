import { ipcMain } from 'electron';
import { WebSocket } from 'ws';

const DEFAULT_BOOTSTRAP_URL = 'ws://54.166.171.208:8788';
const CONNECT_TIMEOUT_MS = Number(process.env.P2P_BOOTSTRAP_CONNECT_TIMEOUT_MS || 8000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.P2P_BOOTSTRAP_HEARTBEAT_INTERVAL_MS || 30000);
const RECONNECT_MIN_MS = Number(process.env.P2P_BOOTSTRAP_RECONNECT_MIN_MS || 5000);
const RECONNECT_MAX_MS = Number(process.env.P2P_BOOTSTRAP_RECONNECT_MAX_MS || 60000);
const MAX_CONNECT_PEERS_PER_BATCH = Number(process.env.P2P_BOOTSTRAP_CONNECT_BATCH || 16);

function validWsUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    return ['ws:', 'wss:'].includes(parsed.protocol) ? parsed.toString().replace(/\/$/, '') : '';
  } catch {
    return '';
  }
}

function node() {
  return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null;
}

function safePublicUrl(n) {
  return validWsUrl(n?.publicUrl || process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || '');
}

function isLikelyPublicPeerUrl(url = '') {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function initialStatus() {
  return {
    enabled: false,
    bootstrapUrl: null,
    connected: false,
    registered: false,
    lastConnectedAt: null,
    lastRegisteredAt: null,
    lastPeerBatchAt: null,
    discoveredPeers: 0,
    connectAttempts: 0,
    connectedPeersFromBootstrap: 0,
    reconnectDelayMs: RECONNECT_MIN_MS,
    publicUrl: null,
    publicUrlLooksRoutable: false,
    warning: null,
    error: null,
  };
}

const state = {
  socket: null,
  heartbeatTimer: null,
  reconnectTimer: null,
  connectTimer: null,
  status: initialStatus(),
};

globalThis.__chunknetGlobalDiscovery = state.status;

function setStatus(patch = {}) {
  state.status = { ...state.status, ...patch };
  globalThis.__chunknetGlobalDiscovery = state.status;
  return state.status;
}

function bootstrapUrl() {
  if (String(process.env.P2P_GLOBAL_DISCOVERY_DISABLED || '').toLowerCase() === 'true') return '';
  return validWsUrl(process.env.P2P_BOOTSTRAP_URL || process.env.CHUNKNET_BOOTSTRAP_URL || DEFAULT_BOOTSTRAP_URL);
}

function send(message) {
  if (state.socket?.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify(message));
  return true;
}

function connectDiscoveredPeer(peer = {}) {
  const n = node();
  const peerId = String(peer.peerId || '').trim();
  const url = validWsUrl(peer.url || '');
  if (!n || !peerId || !url || peerId === n.peerId) return null;
  try {
    const result = n.connectPeer({ peerId, url });
    if (['connected', 'connecting'].includes(result?.status)) {
      setStatus({ connectedPeersFromBootstrap: state.status.connectedPeersFromBootstrap + 1 });
    }
    return result;
  } catch (error) {
    n.peerInfo?.set?.(peerId, { peerId, url, status: 'bootstrap-connect-error', error: error?.message || String(error), lastSeen: Date.now() });
    return { peerId, url, status: 'error', error: error?.message || String(error) };
  }
}

function connectDiscoveredPeers(peers = []) {
  const clean = Array.isArray(peers) ? peers : [];
  setStatus({ discoveredPeers: Math.max(state.status.discoveredPeers, clean.length), lastPeerBatchAt: new Date().toISOString() });
  for (const peer of clean.slice(0, MAX_CONNECT_PEERS_PER_BATCH)) connectDiscoveredPeer(peer);
}

function register() {
  const n = node();
  const url = safePublicUrl(n);
  if (!n?.peerId || !url) {
    setStatus({ registered: false, warning: 'P2P transport is not ready or P2P_PUBLIC_URL is missing' });
    return false;
  }

  const publicUrlLooksRoutable = isLikelyPublicPeerUrl(url);
  send({
    type: 'peer:register',
    peerId: n.peerId,
    url,
    role: 'desktop-peer',
    displayName: process.env.P2P_DISPLAY_NAME || 'Chunknet Desktop Peer',
  });

  setStatus({
    enabled: true,
    registered: true,
    publicUrl: url,
    publicUrlLooksRoutable,
    lastRegisteredAt: new Date().toISOString(),
    warning: publicUrlLooksRoutable ? null : 'Discovery is active, but this peer URL may not be reachable from the public internet. Use a public IP, port forwarding, VPN, or a future relay path for cross-NAT peers.',
  });

  return true;
}

function heartbeat() {
  const n = node();
  if (!n?.peerId) return;
  send({ type: 'peer:heartbeat', peerId: n.peerId });
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delay = Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, state.status.reconnectDelayMs || RECONNECT_MIN_MS));
  setStatus({ connected: false, registered: false, reconnectDelayMs: Math.min(RECONNECT_MAX_MS, delay * 2) });
  state.reconnectTimer = setTimeout(() => connectGlobalDiscovery(), delay);
  state.reconnectTimer.unref?.();
}

function closeSocket(reason = 'reset') {
  clearTimeout(state.connectTimer);
  clearInterval(state.heartbeatTimer);
  state.connectTimer = null;
  state.heartbeatTimer = null;
  if (state.socket) {
    try { state.socket.close(1000, reason); } catch {}
    try { state.socket.terminate?.(); } catch {}
  }
  state.socket = null;
}

export function connectGlobalDiscovery() {
  const url = bootstrapUrl();
  if (!url) {
    setStatus({ ...initialStatus(), enabled: false, warning: 'Global discovery disabled or no bootstrap URL configured' });
    return state.status;
  }

  const n = node();
  if (!n?.peerId) {
    setStatus({ enabled: true, bootstrapUrl: url, warning: 'Waiting for P2P transport to start' });
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => connectGlobalDiscovery(), RECONNECT_MIN_MS);
    state.reconnectTimer.unref?.();
    return state.status;
  }

  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return state.status;

  closeSocket('reconnect');
  setStatus({ enabled: true, bootstrapUrl: url, connectAttempts: state.status.connectAttempts + 1, error: null });

  const socket = new WebSocket(url, { maxPayload: 64 * 1024 });
  state.socket = socket;

  state.connectTimer = setTimeout(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      setStatus({ error: 'Bootstrap connection timeout' });
      try { socket.terminate(); } catch {}
    }
  }, CONNECT_TIMEOUT_MS);
  state.connectTimer.unref?.();

  socket.on('open', () => {
    clearTimeout(state.connectTimer);
    setStatus({ connected: true, bootstrapUrl: url, lastConnectedAt: new Date().toISOString(), reconnectDelayMs: RECONNECT_MIN_MS, error: null });
    register();
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(() => {
      register();
      heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    state.heartbeatTimer.unref?.();
  });

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'bootstrap:peers') connectDiscoveredPeers(msg.peers || []);
    if (msg.type === 'bootstrap:new-peer') connectDiscoveredPeer(msg.peer || {});
    if (msg.type === 'bootstrap:pong') connectDiscoveredPeers(msg.peers || []);
    if (msg.type === 'bootstrap:error') setStatus({ error: msg.error || 'bootstrap error' });
  });

  socket.on('close', () => {
    closeSocket('closed');
    scheduleReconnect();
  });

  socket.on('error', (error) => {
    setStatus({ error: error?.message || String(error) });
  });

  return state.status;
}

function installNetworkSummaryPatch() {
  const existing = ipcMain._invokeHandlers?.get?.('p2p:networkSummary');
  if (!existing || existing.__chunknetGlobalDiscoveryWrapped) return;
  try { ipcMain.removeHandler('p2p:networkSummary'); } catch {}
  const wrapped = async (event, payload = {}) => {
    const summary = await existing(event, payload);
    return { ...summary, globalDiscovery: state.status, bootstrapUrl: state.status.bootstrapUrl };
  };
  Object.defineProperty(wrapped, '__chunknetGlobalDiscoveryWrapped', { value: true });
  ipcMain.handle('p2p:networkSummary', wrapped);
}

function installBootstrapNowPatch() {
  const existing = ipcMain._invokeHandlers?.get?.('p2p:bootstrapNow');
  try { ipcMain.removeHandler('p2p:bootstrapNow'); } catch {}
  ipcMain.handle('p2p:bootstrapNow', async (event, payload = {}) => {
    connectGlobalDiscovery();
    const summary = existing ? await existing(event, payload) : {};
    return { ok: true, ...summary, globalDiscovery: state.status };
  });
}

export function installGlobalDiscovery() {
  installNetworkSummaryPatch();
  installBootstrapNowPatch();
  connectGlobalDiscovery();
  console.log('[global-discovery] installed', { bootstrapUrl: bootstrapUrl() || null });
  return state.status;
}

installGlobalDiscovery();
