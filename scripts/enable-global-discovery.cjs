#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainFile = path.join(root, 'electron', 'main.js');
const preloadFile = path.join(root, 'electron', 'preload.cjs');
const packageFile = path.join(root, 'package.json');

function die(message) {
  console.error('[enable-global-discovery] ' + message);
  process.exit(1);
}

function read(file) {
  if (!fs.existsSync(file)) die('Missing ' + path.relative(root, file));
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.writeFileSync(file, content, 'utf8');
}

function ensureIncludes(source, needle, insertion, position = 'after') {
  if (source.includes(insertion.trim())) return source;
  if (!source.includes(needle)) die('Anchor not found: ' + needle);
  return position === 'before'
    ? source.replace(needle, insertion + '\n' + needle)
    : source.replace(needle, needle + '\n' + insertion);
}

function patchMain() {
  let source = read(mainFile);

  source = ensureIncludes(
    source,
    "import { startP2PTransport } from './p2p-transport.js';",
    "import { createGlobalDiscoveryClient } from './global-discovery-client.js';"
  );

  source = ensureIncludes(
    source,
    'let transportNode = null;',
    'let globalDiscoveryClient = null;'
  );

  if (!source.includes('function bootstrapUrl()')) {
    source = ensureIncludes(
      source,
      "function publicPeerUrl(node) { return process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${node.port}`; }",
      "function bootstrapUrl() { return process.env.P2P_BOOTSTRAP_URL || process.env.P2P_GLOBAL_DISCOVERY_URL || process.env.VITE_P2P_BOOTSTRAP_URL || ''; }"
    );
  }

  if (!source.includes('function ensureGlobalDiscovery')) {
    const block = `
function ensureGlobalDiscovery(reason = 'start') {
  const node = ensureTransport({});
  const url = bootstrapUrl();

  if (!url) return null;

  if (!globalDiscoveryClient) {
    globalDiscoveryClient = createGlobalDiscoveryClient({
      node,
      bootstrapUrl: url,
      getIdentity: () => activeWallet(),
      getPublicUrl: () => publicPeerUrl(node),
    });
  }

  try {
    globalDiscoveryClient.start(reason);
  } catch (error) {
    console.warn('[global-discovery] failed to start:', error?.message || error);
  }

  return globalDiscoveryClient;
}

function stopGlobalDiscovery() {
  try {
    globalDiscoveryClient?.stop?.();
  } catch {}
  globalDiscoveryClient = null;
}

function globalDiscoverySummary() {
  if (!globalDiscoveryClient) {
    return {
      enabled: Boolean(bootstrapUrl()),
      bootstrapUrl: bootstrapUrl(),
      connected: false,
      registered: false,
      peerCount: 0,
      knownPeers: [],
      lastError: bootstrapUrl() ? null : 'P2P_BOOTSTRAP_URL is not configured',
    };
  }

  return globalDiscoveryClient.summary();
}
`;
    source = ensureIncludes(source, 'function safePeerList(node) {', block, 'before');
  }

  source = source.replace(
    "function safePeerList(node) {\n  return Array.from(node.peerInfo?.values?.() || []).slice(0, 50).map((peer) => ({ peerId: String(peer.peerId || ''), url: peer.url || null, status: peer.status || null, direction: peer.direction || null, lastSeen: peer.lastSeen || null }));\n}",
    "function safePeerList(node) {\n  return Array.from(node.peerInfo?.values?.() || []).slice(0, 50).map((peer) => ({ peerId: String(peer.peerId || ''), url: peer.url || null, status: peer.status || null, direction: peer.direction || null, lastSeen: peer.lastSeen || null, health: node.getPeerHealth?.(peer.peerId) || null }));\n}"
  );

  if (!source.includes('globalDiscovery: globalDiscoverySummary()')) {
    source = source.replace(
      'sync: lastSyncStatus };',
      'sync: lastSyncStatus, globalDiscovery: globalDiscoverySummary() };'
    );
  }

  source = source.replace(
    "ipcMain.handle('wallet:disconnect', async () => {\n  stopAutoRepairLoop();",
    "ipcMain.handle('wallet:disconnect', async () => {\n  stopAutoRepairLoop();\n  stopGlobalDiscovery();"
  );

  source = source.replace(
    "  startAutoRepairLoop();\n\n  return walletSummary();\n});",
    "  startAutoRepairLoop();\n  ensureGlobalDiscovery('wallet:connect');\n\n  return walletSummary();\n});"
  );

  source = source.replace(
    "ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } return networkSummary(); });",
    "ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); ensureGlobalDiscovery('p2p:start'); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } return networkSummary(); });"
  );

  if (!source.includes("ipcMain.handle('p2p:globalDiscoveryRefresh'")) {
    source = source.replace(
      "ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); ensureGlobalDiscovery('p2p:start'); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } return networkSummary(); });",
      "ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); ensureGlobalDiscovery('p2p:start'); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } return networkSummary(); });\n\nipcMain.handle('p2p:globalDiscoveryRefresh', async () => {\n  const discovery = ensureGlobalDiscovery('manual-refresh');\n  discovery?.refresh?.();\n  return networkSummary();\n});\n\nipcMain.handle('p2p:globalDiscoveryStatus', async () => networkSummary());"
    );
  }

  write(mainFile, source);
  console.log('[enable-global-discovery] patched electron/main.js');
}

function patchPreload() {
  let source = read(preloadFile);

  if (!source.includes("'p2p:globalDiscoveryRefresh'")) {
    source = source.replace(
      "  'p2p:networkSummary',",
      "  'p2p:networkSummary',\n  'p2p:globalDiscoveryRefresh',\n  'p2p:globalDiscoveryStatus',"
    );
  }

  write(preloadFile, source);
  console.log('[enable-global-discovery] patched electron/preload.cjs');
}

function patchPackage() {
  const pkg = JSON.parse(read(packageFile));
  pkg.scripts ||= {};
  pkg.scripts['bootstrap:server'] ||= 'node server/global-discovery-server.js';
  pkg.scripts['global-discovery:server'] ||= 'node server/global-discovery-server.js';
  pkg.scripts['storage:peer'] ||= 'node server/storage-peer.js';
  write(packageFile, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[enable-global-discovery] patched package.json');
}

patchMain();
patchPreload();
patchPackage();
console.log('[enable-global-discovery] OK');
