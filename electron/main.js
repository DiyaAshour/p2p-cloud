import { app, BrowserWindow, ipcMain, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';
import { startP2PTransport } from './p2p-transport.js';
import { isManifestSyncEnabled, pullWalletManifests, pushWalletManifest, deleteWalletManifest } from './manifest-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_TITLE = 'p2p.cloud';
const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);
const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const IS_DEV = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const BOOTSTRAP_URL = process.env.P2P_BOOTSTRAP_URL || process.env.VITE_P2P_BOOTSTRAP_URL || 'ws://54.166.171.208:8788';
const AUTO_REPAIR_INTERVAL_MS = Number(process.env.P2P_AUTO_REPAIR_INTERVAL_MS || 60000);

const PLANS = {
  free: { id: 'free', name: 'Free', quotaBytes: FREE_QUOTA_BYTES, priceUsd: 0, locked: false },
  tb1: { id: 'tb1', name: '1 TB', quotaBytes: 1 * 1024 ** 4, priceUsd: 1, locked: true },
  tb3: { id: 'tb3', name: '3 TB', quotaBytes: 3 * 1024 ** 4, priceUsd: 2.5, locked: true },
  tb7: { id: 'tb7', name: '7 TB', quotaBytes: 7 * 1024 ** 4, priceUsd: 4.99, locked: true },
  tb10: { id: 'tb10', name: '10 TB', quotaBytes: 10 * 1024 ** 4, priceUsd: 7.99, locked: true },
};
const CONTRACT_PLAN_TO_APP_PLAN = { 1: 'tb1', 3: 'tb3', 7: 'tb7', 10: 'tb10' };

let mainWindow = null;
let transportNode = null;
let dataDir = null;
let manifestsPath = null;
let walletPath = null;
let bootstrapSocket = null;
let bootstrapHeartbeat = null;
let autoRepairTimer = null;
let autoRepairRunning = false;
let manifests = [];
let walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null };

function normalizeWallet(address = '') { return String(address || '').trim().toLowerCase(); }
function activeWallet() { return normalizeWallet(walletState.address); }
function isValidWallet(address = '') { return /^0x[a-fA-F0-9]{40}$/.test(String(address).trim()); }
function assertVerifiedWallet() { if (!walletState.connected || !walletState.verified || !isValidWallet(walletState.address)) throw new Error('Verified wallet required. Connect and verify a wallet first.'); }
function walletOwnsManifest(manifest) { return normalizeWallet(manifest.ownerWallet) === activeWallet(); }
function walletManifests() { return walletState.connected ? manifests.filter(walletOwnsManifest) : []; }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function firstLanAddress() { const nets = os.networkInterfaces(); for (const items of Object.values(nets)) for (const net of items || []) { if (!net || net.internal || net.family !== 'IPv4') continue; const ip = net.address; if (ip && !ip.startsWith('127.') && !ip.startsWith('169.254.')) return ip; } return '127.0.0.1'; }
function publicPeerUrl(node) { return process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${node.port}`; }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(app.getPath('userData'), 'native-p2p-storage', 'chunks'); }

function ensureDataDir() {
  if (dataDir && manifestsPath && walletPath) return;
  dataDir = path.join(app.getPath('userData'), 'native-p2p-storage');
  manifestsPath = path.join(dataDir, 'manifests.json');
  walletPath = path.join(dataDir, 'wallet.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(chunkStoreDir(), { recursive: true });
  if (!fs.existsSync(manifestsPath)) fs.writeFileSync(manifestsPath, '[]', 'utf8');
  if (!fs.existsSync(walletPath)) fs.writeFileSync(walletPath, JSON.stringify(walletState, null, 2), 'utf8');
}
function loadWallet() {
  ensureDataDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    walletState = { ...walletState, ...parsed, planId: PLANS[parsed?.planId] ? parsed.planId : 'free', verified: Boolean(parsed?.verified) };
    if (walletState.planId !== 'free' && (!walletState.paidUntil || Number(walletState.paidUntil) < nowSeconds())) {
      walletState = { ...walletState, planId: 'free', paidUntil: null, subscriptionTx: null };
    }
  } catch {
    walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null };
  }
}
function persistWallet() { ensureDataDir(); fs.writeFileSync(walletPath, JSON.stringify(walletState, null, 2), 'utf8'); }
function loadManifests() { ensureDataDir(); try { const parsed = JSON.parse(fs.readFileSync(manifestsPath, 'utf8')); manifests = Array.isArray(parsed) ? parsed : []; } catch { manifests = []; } }
function persistManifests() { ensureDataDir(); fs.writeFileSync(manifestsPath, JSON.stringify(manifests, null, 2), 'utf8'); }
function totalStoredBytesForWallet() { return walletManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }
function totalStoredBytesAll() { return manifests.reduce((sum, file) => sum + Number(file.size || 0), 0); }
function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, address: activeWallet() || walletState.address, plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), paymentRequired: plan.locked && (!walletState.paidUntil || Number(walletState.paidUntil) < nowSeconds()) }; }
function assertWalletUploadAllowed(nextBytes = 0) { assertVerifiedWallet(); const plan = PLANS[walletState.planId] || PLANS.free; if (plan.locked && (!walletState.paidUntil || Number(walletState.paidUntil) < nowSeconds())) throw new Error('Payment required. Paid plan expired or not verified.'); if (totalStoredBytesForWallet() + nextBytes > plan.quotaBytes) throw new Error(`Storage quota exceeded. Current plan: ${plan.name}.`); }

function sendBootstrapRegister(node) { if (bootstrapSocket?.readyState !== WebSocket.OPEN) return; const url = publicPeerUrl(node); node.publicUrl = url; bootstrapSocket.send(JSON.stringify({ type: 'peer:register', peerId: node.peerId, url, wallet: activeWallet() || null })); console.log('[bootstrap] registered', node.peerId, url); }
function connectBootstrap(node) {
  if (!BOOTSTRAP_URL) return;
  if (bootstrapSocket?.readyState === WebSocket.OPEN) { sendBootstrapRegister(node); return; }
  try {
    bootstrapSocket = new WebSocket(BOOTSTRAP_URL);
    bootstrapSocket.on('open', () => { sendBootstrapRegister(node); if (bootstrapHeartbeat) clearInterval(bootstrapHeartbeat); bootstrapHeartbeat = setInterval(() => { if (bootstrapSocket?.readyState === WebSocket.OPEN) { sendBootstrapRegister(node); bootstrapSocket.send(JSON.stringify({ type: 'peer:heartbeat', peerId: node.peerId, url: publicPeerUrl(node), wallet: activeWallet() || null })); } }, 30000); });
    bootstrapSocket.on('message', (raw) => { try { const msg = JSON.parse(raw.toString()); const peers = msg.type === 'bootstrap:peers' ? msg.peers : msg.type === 'bootstrap:new-peer' ? [msg.peer] : []; for (const peer of peers || []) { if (!peer?.peerId || !peer?.url || peer.peerId === node.peerId) continue; if (peer.url.includes('127.0.0.1') || peer.url.includes('localhost')) continue; try { node.connectPeer({ peerId: peer.peerId, url: peer.url }); } catch (e) { console.warn('[bootstrap] peer connect failed:', e?.message || e); } } } catch (e) { console.warn('[bootstrap] bad message:', e?.message || e); } });
    bootstrapSocket.on('close', () => { if (bootstrapHeartbeat) clearInterval(bootstrapHeartbeat); bootstrapSocket = null; setTimeout(() => connectBootstrap(node), 5000); });
    bootstrapSocket.on('error', (e) => console.warn('[bootstrap] error:', e?.message || e));
  } catch (e) { console.warn('[bootstrap] connect failed:', e?.message || e); }
}
function ensureTransport(options = {}) { if (!transportNode) { const port = Number(process.env.P2P_TRANSPORT_PORT || 8787); const publicUrl = process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${port}`; transportNode = startP2PTransport({ ...options, publicUrl, chunkStoreDir: chunkStoreDir() }); } return transportNode; }

function hashBufferHex(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function splitIntoChunks(buffer) { const chunks = []; for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE_BYTES) { const data = buffer.slice(offset, offset + CHUNK_SIZE_BYTES); chunks.push({ index: chunks.length, size: data.length, data, hash: hashBufferHex(data) }); } return chunks; }
function findManifest(payload = {}) { const hash = String(payload.hash || ''); const rootHash = String(payload.rootHash || ''); return walletManifests().find((manifest) => manifest.hash === hash || manifest.rootHash === rootHash); }
function mergeManifests(remoteList) { if (!Array.isArray(remoteList) || remoteList.length === 0) return; const map = new Map(manifests.map((m) => [`${normalizeWallet(m.ownerWallet)}:${m.hash}`, m])); for (const r of remoteList) { const key = `${normalizeWallet(r.ownerWallet)}:${r.hash}`; if (!map.has(key)) map.set(key, r); } manifests = Array.from(map.values()); persistManifests(); }
async function syncPull() { try { if (!isManifestSyncEnabled()) return; if (!walletState.connected || !walletState.address) return; const list = await pullWalletManifests(activeWallet()); mergeManifests(list); } catch (e) { console.warn('[manifest-sync] pull failed:', e?.message || e); } }
async function syncPush(manifest) { try { if (!isManifestSyncEnabled()) return; await pushWalletManifest(manifest); } catch (e) { console.warn('[manifest-sync] push failed:', e?.message || e); } }
async function syncDelete(ownerWallet, hash) { try { if (!isManifestSyncEnabled()) return; await deleteWalletManifest(ownerWallet, hash); } catch (e) { console.warn('[manifest-sync] delete failed:', e?.message || e); } }

function preferredReplicaTargets(node, currentReplicas = []) { const excluded = new Set([node.peerId, ...currentReplicas]); const peers = Array.from(node.peerInfo.values()).filter((peer) => node.peerSockets.get(peer.peerId)?.readyState === WebSocket.OPEN).sort((a, b) => { const aw = String(a.peerId || '').includes('node') || String(a.url || '').includes('54.166.171.208') ? 1 : 0; const bw = String(b.peerId || '').includes('node') || String(b.url || '').includes('54.166.171.208') ? 1 : 0; return bw - aw; }).map((peer) => peer.peerId).filter((peerId) => !excluded.has(peerId)); return peers.slice(0, Math.max(0, TARGET_REPLICAS - new Set([node.peerId, ...currentReplicas]).size)); }
async function replicateChunkIfPossible(node, chunkMeta, manifest) { const chunk = node.getLocalChunk?.(chunkMeta.hash) || node.localChunks.get(chunkMeta.hash); if (!chunk) return { ok: false, reason: 'missing-local-chunk' }; const replicas = new Set([node.peerId, ...(chunkMeta.replicas || [])]); if (replicas.size >= TARGET_REPLICAS) return { ok: true, repaired: false, replicas: Array.from(replicas) }; const targets = preferredReplicaTargets(node, Array.from(replicas)); if (!targets.length) return { ok: false, reason: 'no-targets', replicas: Array.from(replicas) }; try { const result = node.putChunkOnNetwork(chunk, targets); for (const peerId of result.replicas || []) replicas.add(peerId); chunkMeta.replicas = Array.from(replicas); manifest.replicas = Array.from(new Set([...(manifest.replicas || []), ...chunkMeta.replicas])); return { ok: true, repaired: true, targets, replicas: chunkMeta.replicas }; } catch (error) { return { ok: false, reason: error?.message || 'replication-failed', replicas: Array.from(replicas) }; } }
async function runAutoRepair({ manual = false } = {}) { if (autoRepairRunning) return { ok: true, skipped: true, reason: 'already-running' }; autoRepairRunning = true; try { const node = ensureTransport({}); connectBootstrap(node); if (walletState.connected) await syncPull(); const files = walletManifests(); let repairedChunks = 0; let missingLocalChunks = 0; let changed = false; for (const manifest of files) { for (const chunk of manifest.chunks || []) { const result = await replicateChunkIfPossible(node, chunk, manifest); if (result.reason === 'missing-local-chunk') missingLocalChunks++; if (result.repaired) { repairedChunks++; changed = true; } } if (changed) await syncPush(manifest); } if (changed) persistManifests(); const report = { ok: true, manual, files: files.length, repairedChunks, missingLocalChunks, peers: node.connectedPeerIds().length, at: new Date().toISOString() }; if (manual || repairedChunks || missingLocalChunks) console.log('[auto-repair]', report); return report; } finally { autoRepairRunning = false; } }
function startAutoRepairLoop() { if (autoRepairTimer) return; autoRepairTimer = setInterval(() => { runAutoRepair().catch((error) => console.warn('[auto-repair] failed:', error?.message || error)); }, AUTO_REPAIR_INTERVAL_MS); console.log('[auto-repair] loop enabled every', AUTO_REPAIR_INTERVAL_MS, 'ms'); }

function networkSummary() { const node = ensureTransport({}); const peers = Array.from(node.peerInfo.values()); const connectedPeerIds = node.connectedPeerIds(); const ownManifests = walletState.connected ? walletManifests() : []; const totalBytes = ownManifests.reduce((sum, file) => sum + Number(file.size || 0), 0); const totalChunks = ownManifests.reduce((sum, file) => sum + Number(file.chunks?.length || 0), 0); const underReplicatedChunks = ownManifests.reduce((sum, file) => sum + (file.chunks || []).filter((chunk) => new Set([node.peerId, ...(chunk.replicas || [])]).size < TARGET_REPLICAS).length, 0); return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, bootstrapUrl: BOOTSTRAP_URL, publicPeerUrl: publicPeerUrl(node), detectedLanAddress: firstLanAddress(), chunkStoreDir: chunkStoreDir(), peers, connectedPeerIds, connectedPeers: connectedPeerIds.length, peerCount: connectedPeerIds.length, targetReplicas: TARGET_REPLICAS, totalFiles: ownManifests.length, files: ownManifests.length, encryptedFiles: ownManifests.filter((file) => file.isEncrypted).length, publicFiles: ownManifests.filter((file) => !file.isEncrypted).length, totalBytes, totalBytesAll: totalStoredBytesAll(), totalMB: totalBytes / 1024 / 1024, totalChunks, underReplicatedChunks, wallet: walletSummary() }; }
function resolvePreloadPath() { const preloadPath = path.join(__dirname, 'preload.cjs'); if (!fs.existsSync(preloadPath)) throw new Error(`Missing Electron preload file: ${preloadPath}`); console.log('[electron] cwd:', process.cwd()); console.log('[electron] preload:', preloadPath); return preloadPath; }
function resolveRendererIndexPath() { const candidates = [path.join(app.getAppPath(), 'dist', 'public', 'index.html'), path.join(app.getAppPath(), 'public', 'index.html'), path.join(__dirname, '..', 'dist', 'public', 'index.html'), path.join(process.resourcesPath || '', 'app', 'dist', 'public', 'index.html')]; for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate; throw new Error(`Renderer index.html not found. Tried: ${candidates.join(' | ')}`); }
function createMainWindow() { mainWindow = new BrowserWindow({ title: APP_TITLE, width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#09090b', show: false, webPreferences: { preload: resolvePreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: false } }); mainWindow.once('ready-to-show', () => { mainWindow?.setTitle(APP_TITLE); mainWindow?.show(); if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') mainWindow?.webContents.openDevTools({ mode: 'detach' }); }); mainWindow.webContents.on('page-title-updated', (event) => { event.preventDefault(); mainWindow?.setTitle(APP_TITLE); }); mainWindow.webContents.on('did-finish-load', () => mainWindow?.setTitle(APP_TITLE)); mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => console.error('[electron] preload failed:', preloadPath, error)); if (IS_DEV) mainWindow.loadURL(DEV_SERVER_URL); else mainWindow.loadFile(resolveRendererIndexPath()); mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); mainWindow.on('closed', () => { mainWindow = null; }); }

ipcMain.handle('electron:openDevTools', async () => { mainWindow?.webContents.openDevTools({ mode: 'detach' }); return { ok: true }; });
ipcMain.handle('electron:diagnostics', async () => ({ ok: true, cwd: process.cwd(), dirname: __dirname, preloadPath: resolvePreloadPath(), rendererPath: IS_DEV ? DEV_SERVER_URL : resolveRendererIndexPath(), isPackaged: app.isPackaged, appPath: app.getAppPath() }));
ipcMain.handle('system:open-external', async (_event, payload = {}) => { const url = String(payload.url || ''); if (!/^https?:\/\//i.test(url)) throw new Error('Invalid external URL'); await shell.openExternal(url); return { ok: true }; });
ipcMain.handle('wallet:status', async () => walletSummary());
ipcMain.handle('wallet:connect', async (_event, payload = {}) => { const address = String(payload.address || '').trim(); if (!isValidWallet(address)) throw new Error('Invalid wallet address. Expected 0x + 40 hex characters.'); const sameWallet = normalizeWallet(address) === activeWallet(); walletState = { ...walletState, connected: true, verified: true, address: normalizeWallet(address), planId: sameWallet ? walletState.planId : 'free', connectedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), paidUntil: sameWallet ? walletState.paidUntil : null, subscriptionTx: sameWallet ? walletState.subscriptionTx : null }; persistWallet(); await syncPull(); if (transportNode) connectBootstrap(transportNode); runAutoRepair().catch(() => {}); return walletSummary(); });
ipcMain.handle('wallet:disconnect', async () => { walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null }; persistWallet(); return walletSummary(); });
ipcMain.handle('wallet:setPlan', async (_event, payload = {}) => { const planId = String(payload.planId || 'free'); if (!PLANS[planId]) throw new Error('Unknown wallet plan'); assertVerifiedWallet(); if (planId === 'free') { walletState = { ...walletState, planId: 'free', paidUntil: null, subscriptionTx: null }; persistWallet(); return walletSummary(); } const paymentProvider = String(payload.paymentProvider || '').toLowerCase(); if (paymentProvider === 'paypal' || process.env.PAYPAL_MVP_UNLOCK === '1') { walletState = { ...walletState, planId, paidUntil: nowSeconds() + 30 * 24 * 60 * 60, subscriptionTx: String(payload.txHash || `paypal-mvp-${Date.now()}`) }; persistWallet(); return walletSummary(); } const paidUntil = Number(payload.paidUntil || 0); const quotaBytes = Number(payload.quotaBytes || 0); const contractPlanId = Number(payload.contractPlanId || 0); const txHash = String(payload.txHash || ''); const expectedPlanId = CONTRACT_PLAN_TO_APP_PLAN[contractPlanId]; if (expectedPlanId !== planId) throw new Error('Subscription plan does not match selected app plan.'); if (!paidUntil || paidUntil < nowSeconds()) throw new Error('Subscription is not active.'); if (quotaBytes < PLANS[planId].quotaBytes) throw new Error('Subscription quota is lower than selected plan.'); walletState = { ...walletState, planId, paidUntil, subscriptionTx: txHash || walletState.subscriptionTx }; persistWallet(); return walletSummary(); });
ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); const node = ensureTransport(options); connectBootstrap(node); await syncPull(); startAutoRepairLoop(); return networkSummary(); });
ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { if (!walletState.connected || !walletState.verified) return []; const query = String(payload.query || '').trim().toLowerCase(); const ownManifests = walletManifests(); if (!query) return ownManifests; return ownManifests.filter((file) => [file.name, file.hash, file.rootHash, file.ownerWallet || ''].some((value) => String(value || '').toLowerCase().includes(query))); });
ipcMain.handle('p2p:upload', async (_event, payload = {}) => { const node = ensureTransport({}); if (!payload.bytes) throw new Error('File bytes are required'); const buffer = Buffer.from(payload.bytes); assertWalletUploadAllowed(buffer.length); const chunks = splitIntoChunks(buffer); const tree = buildMerkleTree(chunks.map((chunk) => chunk.hash)); const fileHash = hashBufferHex(buffer); const ownerWallet = activeWallet(); const manifest = { id: `${ownerWallet}:${fileHash}`, name: String(payload.name || 'file'), size: buffer.length, hash: fileHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: Boolean(payload.isEncrypted), mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream', chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: [] }; const connectedPeerIds = node.connectedPeerIds(); for (const chunk of chunks) { const chunkPayload = { hash: chunk.hash, data: chunk.data.toString('base64'), index: chunk.index, size: chunk.size, ownerWallet }; node.storeLocalChunk?.(chunkPayload); const targets = connectedPeerIds.slice(0, TARGET_REPLICAS - 1); let replicas = [node.peerId]; if (targets.length) { const result = node.putChunkOnNetwork(chunkPayload, targets); replicas = Array.from(new Set([...replicas, ...(result.replicas || [])])); } manifest.chunks.push({ index: chunk.index, hash: chunk.hash, size: chunk.size, replicas, proof: getMerkleProof(tree, chunk.index) }); } manifests = manifests.filter((entry) => !(normalizeWallet(entry.ownerWallet) === ownerWallet && entry.hash === manifest.hash)); manifests.push(manifest); persistManifests(); await syncPush(manifest); runAutoRepair().catch(() => {}); return { ok: true, file: manifest, summary: networkSummary() }; });
ipcMain.handle('p2p:download', async (_event, payload = {}) => { assertVerifiedWallet(); const node = ensureTransport({}); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const buffers = []; for (const chunkMeta of [...manifest.chunks].sort((a, b) => a.index - b.index)) { const localChunk = node.getLocalChunk?.(chunkMeta.hash) || node.localChunks.get(chunkMeta.hash); const chunk = localChunk || await node.fetchChunkFromNetwork(chunkMeta.hash); node.storeLocalChunk?.(chunk); const chunkBuffer = Buffer.from(chunk.data, 'base64'); if (hashBufferHex(chunkBuffer) !== chunkMeta.hash) throw new Error(`Chunk integrity failed: ${chunkMeta.hash}`); buffers.push(chunkBuffer); } const fileBuffer = Buffer.concat(buffers); if (hashBufferHex(fileBuffer) !== manifest.hash) throw new Error('File integrity failed'); return { ok: true, file: manifest, bytes: Array.from(fileBuffer) }; });
ipcMain.handle('p2p:delete', async (_event, payload = {}) => { assertVerifiedWallet(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); manifests = manifests.filter((entry) => !(walletOwnsManifest(entry) && entry.hash === manifest.hash)); persistManifests(); await syncDelete(activeWallet(), manifest.hash); return { ok: true, summary: networkSummary() }; });
ipcMain.handle('p2p:networkSummary', async () => networkSummary());
ipcMain.handle('p2p:bootstrapNow', async () => { const node = ensureTransport({}); connectBootstrap(node); return { ok: true, summary: networkSummary() }; });
ipcMain.handle('p2p:connectPeer', async (_event, payload = {}) => { const peerId = String(payload.peerId || '').trim(); const url = String(payload.url || '').trim(); if (!peerId) throw new Error('peerId is required'); if (!/^wss?:\/\//i.test(url)) throw new Error('peer URL must start with ws:// or wss://'); const result = ensureTransport({}).connectPeer({ peerId, url }); return { ok: true, ...result, summary: networkSummary() }; });
ipcMain.handle('p2p:repair', async () => runAutoRepair({ manual: true }));
ipcMain.handle('p2p:prepareProof', async (_event, payload = {}) => { assertVerifiedWallet(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const chunkIndex = Number(payload.chunkIndex ?? 0); const chunk = manifest.chunks.find((item) => item.index === chunkIndex) || manifest.chunks[0]; if (!chunk) throw new Error('No chunks available for proof'); return { ok: true, proof: { ownerWallet: activeWallet(), rootHash: manifest.rootHash, chunkIndex: chunk.index, leaf: chunk.hash, merkleProof: chunk.proof, preparedAt: new Date().toISOString() } }; });

app.whenReady().then(async () => { app.setName(APP_TITLE); ensureDataDir(); loadWallet(); loadManifests(); const node = ensureTransport({}); connectBootstrap(node); await syncPull(); startAutoRepairLoop(); createMainWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); }); }).catch((error) => { console.error('Electron failed:', error); app.exit(1); });
app.on('before-quit', () => { if (bootstrapHeartbeat) clearInterval(bootstrapHeartbeat); if (autoRepairTimer) clearInterval(autoRepairTimer); bootstrapSocket?.close(); persistWallet(); persistManifests(); if (transportNode) transportNode.stop(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
