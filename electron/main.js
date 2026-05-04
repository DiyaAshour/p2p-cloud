import { app, BrowserWindow, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';
import { startP2PTransport } from './p2p-transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);
const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const IS_DEV = process.env.NODE_ENV !== 'production';
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';

const PLANS = {
  free: { id: 'free', name: 'Free', quotaBytes: FREE_QUOTA_BYTES, priceUsd: 0, locked: false },
  tb1: { id: 'tb1', name: '1 TB', quotaBytes: 1 * 1024 ** 4, priceUsd: 1, locked: true },
  tb3: { id: 'tb3', name: '3 TB', quotaBytes: 3 * 1024 ** 4, priceUsd: 2.5, locked: true },
  tb7: { id: 'tb7', name: '7 TB', quotaBytes: 7 * 1024 ** 4, priceUsd: 4.99, locked: true },
  tb10: { id: 'tb10', name: '10 TB', quotaBytes: 10 * 1024 ** 4, priceUsd: 7.99, locked: true },
};

let mainWindow = null;
let transportNode = null;
let dataDir = null;
let manifestsPath = null;
let walletPath = null;
let manifests = [];
let walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null };

function normalizeWallet(address = '') { return String(address || '').trim().toLowerCase(); }
function activeWallet() { return normalizeWallet(walletState.address); }
function isValidWallet(address = '') { return /^0x[a-fA-F0-9]{40}$/.test(String(address).trim()); }
function assertVerifiedWallet() {
  if (!walletState.connected || !walletState.verified || !isValidWallet(walletState.address)) throw new Error('Verified wallet required. Connect and verify a wallet first.');
}
function walletOwnsManifest(manifest) { return normalizeWallet(manifest.ownerWallet) === activeWallet(); }
function walletManifests() { return manifests.filter(walletOwnsManifest); }

function resolvePreloadPath() {
  const preloadPath = path.join(__dirname, 'preload.cjs');
  if (!fs.existsSync(preloadPath)) throw new Error(`Missing Electron preload file: ${preloadPath}`);
  console.log('[electron] cwd:', process.cwd());
  console.log('[electron] preload:', preloadPath);
  return preloadPath;
}

function ensureDataDir() {
  if (dataDir && manifestsPath && walletPath) return;
  dataDir = path.join(app.getPath('userData'), 'native-p2p-storage');
  manifestsPath = path.join(dataDir, 'manifests.json');
  walletPath = path.join(dataDir, 'wallet.json');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(manifestsPath)) fs.writeFileSync(manifestsPath, '[]', 'utf8');
  if (!fs.existsSync(walletPath)) fs.writeFileSync(walletPath, JSON.stringify(walletState, null, 2), 'utf8');
}

function loadWallet() {
  ensureDataDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    walletState = { ...walletState, ...parsed, planId: PLANS[parsed?.planId] ? parsed.planId : 'free', verified: Boolean(parsed?.verified) };
    if (PLANS[walletState.planId]?.locked && !walletState.paidUntil) walletState.planId = 'free';
  } catch { walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null }; }
}
function persistWallet() { ensureDataDir(); fs.writeFileSync(walletPath, JSON.stringify(walletState, null, 2), 'utf8'); }
function loadManifests() { ensureDataDir(); try { const parsed = JSON.parse(fs.readFileSync(manifestsPath, 'utf8')); manifests = Array.isArray(parsed) ? parsed : []; } catch { manifests = []; } }
function persistManifests() { ensureDataDir(); fs.writeFileSync(manifestsPath, JSON.stringify(manifests, null, 2), 'utf8'); }
function totalStoredBytesForWallet() { return walletManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }
function totalStoredBytesAll() { return manifests.reduce((sum, file) => sum + Number(file.size || 0), 0); }

function walletSummary() {
  const plan = PLANS[walletState.planId] || PLANS.free;
  const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0;
  return { ok: true, ...walletState, address: activeWallet() || walletState.address, plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), paymentRequired: PLANS[walletState.planId]?.locked && !walletState.paidUntil };
}

function assertWalletUploadAllowed(nextBytes = 0) {
  assertVerifiedWallet();
  const plan = PLANS[walletState.planId] || PLANS.free;
  if (plan.locked && !walletState.paidUntil) throw new Error('Payment required. Paid plans are locked until payment verification is connected.');
  if (totalStoredBytesForWallet() + nextBytes > plan.quotaBytes) throw new Error(`Storage quota exceeded. Current plan: ${plan.name}.`);
}

function ensureTransport(options = {}) { if (!transportNode) transportNode = startP2PTransport(options); return transportNode; }
function hashBufferHex(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function splitIntoChunks(buffer) { const chunks = []; for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE_BYTES) { const data = buffer.slice(offset, offset + CHUNK_SIZE_BYTES); chunks.push({ index: chunks.length, size: data.length, data, hash: hashBufferHex(data) }); } return chunks; }
function findManifest(payload = {}) { const hash = String(payload.hash || ''); const rootHash = String(payload.rootHash || ''); return walletManifests().find((manifest) => manifest.hash === hash || manifest.rootHash === rootHash); }

function networkSummary() {
  const node = ensureTransport({});
  const peers = Array.from(node.peerInfo.values());
  const connectedPeerIds = node.connectedPeerIds();
  const ownManifests = walletState.connected ? walletManifests() : [];
  const totalBytes = ownManifests.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const totalChunks = ownManifests.reduce((sum, file) => sum + Number(file.chunks?.length || 0), 0);
  const underReplicatedChunks = ownManifests.reduce((sum, file) => sum + (file.chunks || []).filter((chunk) => new Set([node.peerId, ...(chunk.replicas || [])]).size < TARGET_REPLICAS).length, 0);
  return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, peers, connectedPeerIds, connectedPeers: connectedPeerIds.length, peerCount: connectedPeerIds.length, targetReplicas: TARGET_REPLICAS, totalFiles: ownManifests.length, files: ownManifests.length, encryptedFiles: ownManifests.filter((file) => file.isEncrypted).length, publicFiles: ownManifests.filter((file) => !file.isEncrypted).length, totalBytes, totalBytesAll: totalStoredBytesAll(), totalMB: totalBytes / 1024 / 1024, totalChunks, underReplicatedChunks, wallet: walletSummary() };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#09090b', show: false, webPreferences: { preload: resolvePreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  mainWindow.once('ready-to-show', () => { mainWindow?.show(); if (IS_DEV || process.env.ELECTRON_OPEN_DEVTOOLS === '1') mainWindow?.webContents.openDevTools({ mode: 'detach' }); });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => console.error('[electron] preload failed:', preloadPath, error));
  if (IS_DEV) mainWindow.loadURL(DEV_SERVER_URL); else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'public', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('electron:openDevTools', async () => { mainWindow?.webContents.openDevTools({ mode: 'detach' }); return { ok: true }; });
ipcMain.handle('electron:diagnostics', async () => ({ ok: true, cwd: process.cwd(), dirname: __dirname, preloadPath: resolvePreloadPath(), isPackaged: app.isPackaged, appPath: app.getAppPath() }));
ipcMain.handle('wallet:status', async () => walletSummary());
ipcMain.handle('wallet:connect', async (_event, payload = {}) => { const address = String(payload.address || '').trim(); if (!isValidWallet(address)) throw new Error('Invalid wallet address. Expected 0x + 40 hex characters.'); walletState = { ...walletState, connected: true, verified: true, address: normalizeWallet(address), planId: 'free', connectedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), paidUntil: null }; persistWallet(); return walletSummary(); });
ipcMain.handle('wallet:disconnect', async () => { walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null }; persistWallet(); return walletSummary(); });
ipcMain.handle('wallet:setPlan', async (_event, payload = {}) => { const planId = String(payload.planId || 'free'); if (!PLANS[planId]) throw new Error('Unknown wallet plan'); assertVerifiedWallet(); if (PLANS[planId].locked) throw new Error('Paid plans are locked until payment verification is connected.'); walletState = { ...walletState, planId }; persistWallet(); return walletSummary(); });

ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); return networkSummary(); });
ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { assertVerifiedWallet(); const query = String(payload.query || '').trim().toLowerCase(); const ownManifests = walletManifests(); if (!query) return ownManifests; return ownManifests.filter((file) => [file.name, file.hash, file.rootHash, file.ownerWallet || ''].some((value) => String(value || '').toLowerCase().includes(query))); });
ipcMain.handle('p2p:upload', async (_event, payload = {}) => {
  const node = ensureTransport({});
  if (!payload.bytes) throw new Error('File bytes are required');
  const buffer = Buffer.from(payload.bytes);
  assertWalletUploadAllowed(buffer.length);
  const chunks = splitIntoChunks(buffer);
  const tree = buildMerkleTree(chunks.map((chunk) => chunk.hash));
  const fileHash = hashBufferHex(buffer);
  const ownerWallet = activeWallet();
  const manifest = { id: `${ownerWallet}:${fileHash}`, name: String(payload.name || 'file'), size: buffer.length, hash: fileHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: Boolean(payload.isEncrypted), mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream', chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: [] };
  const connectedPeerIds = node.connectedPeerIds();
  for (const chunk of chunks) { const chunkPayload = { hash: chunk.hash, data: chunk.data.toString('base64'), index: chunk.index, size: chunk.size, ownerWallet }; node.localChunks.set(chunk.hash, chunkPayload); const targets = connectedPeerIds.slice(0, TARGET_REPLICAS - 1); let replicas = [node.peerId]; if (targets.length) { const result = node.putChunkOnNetwork(chunkPayload, targets); replicas = Array.from(new Set([...replicas, ...(result.replicas || [])])); } manifest.chunks.push({ index: chunk.index, hash: chunk.hash, size: chunk.size, replicas, proof: getMerkleProof(tree, chunk.index) }); }
  manifests = manifests.filter((entry) => !(normalizeWallet(entry.ownerWallet) === ownerWallet && entry.hash === manifest.hash));
  manifests.push(manifest);
  persistManifests();
  return { ok: true, file: manifest, summary: networkSummary() };
});
ipcMain.handle('p2p:download', async (_event, payload = {}) => { assertVerifiedWallet(); const node = ensureTransport({}); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const buffers = []; for (const chunkMeta of [...manifest.chunks].sort((a, b) => a.index - b.index)) { const localChunk = node.localChunks.get(chunkMeta.hash); const chunk = localChunk || await node.fetchChunkFromNetwork(chunkMeta.hash); const chunkBuffer = Buffer.from(chunk.data, 'base64'); if (hashBufferHex(chunkBuffer) !== chunkMeta.hash) throw new Error(`Chunk integrity failed: ${chunkMeta.hash}`); buffers.push(chunkBuffer); } const fileBuffer = Buffer.concat(buffers); if (hashBufferHex(fileBuffer) !== manifest.hash) throw new Error('File integrity failed'); return { ok: true, file: manifest, bytes: Array.from(fileBuffer) }; });
ipcMain.handle('p2p:delete', async (_event, payload = {}) => { assertVerifiedWallet(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); manifests = manifests.filter((entry) => !(walletOwnsManifest(entry) && entry.hash === manifest.hash)); persistManifests(); return { ok: true, summary: networkSummary() }; });
ipcMain.handle('p2p:networkSummary', async () => networkSummary());
ipcMain.handle('p2p:bootstrapNow', async () => ({ ok: true, summary: networkSummary() }));
ipcMain.handle('p2p:connectPeer', async (_event, payload = {}) => { const peerId = String(payload.peerId || '').trim(); const url = String(payload.url || '').trim(); if (!peerId) throw new Error('peerId is required'); if (!/^wss?:\/\//i.test(url)) throw new Error('peer URL must start with ws:// or wss://'); const result = ensureTransport({}).connectPeer({ peerId, url }); return { ok: true, ...result, summary: networkSummary() }; });
ipcMain.handle('p2p:repair', async () => { assertVerifiedWallet(); const node = ensureTransport({}); const report = walletManifests().flatMap((file) => (file.chunks || []).map((chunk) => { const replicas = Array.from(new Set([node.peerId, ...(chunk.replicas || [])])); return { file: file.name, rootHash: file.rootHash, chunkIndex: chunk.index, chunkHash: chunk.hash, healthyReplicas: replicas, targetReplicas: TARGET_REPLICAS, underReplicated: replicas.length < TARGET_REPLICAS }; })); return { ok: true, report, summary: networkSummary() }; });
ipcMain.handle('p2p:prepareProof', async (_event, payload = {}) => { assertVerifiedWallet(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const chunkIndex = Number(payload.chunkIndex ?? 0); const chunk = manifest.chunks.find((item) => item.index === chunkIndex) || manifest.chunks[0]; if (!chunk) throw new Error('No chunks available for proof'); return { ok: true, proof: { ownerWallet: activeWallet(), rootHash: manifest.rootHash, chunkIndex: chunk.index, leaf: chunk.hash, merkleProof: chunk.proof, preparedAt: new Date().toISOString() } }; });

app.whenReady().then(() => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport({}); createMainWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); }); }).catch((error) => { console.error('Electron failed:', error); app.exit(1); });
app.on('before-quit', () => { persistWallet(); persistManifests(); if (transportNode) transportNode.stop(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
