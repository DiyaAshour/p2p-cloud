import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { verifyMessage } from 'viem';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';
import { startP2PTransport } from './p2p-transport.js';
import { isManifestSyncEnabled, pullWalletManifests, pushWalletManifest, deleteWalletManifest } from './manifest-sync.js';
import { replicateChunk, repairManifests, countUnderReplicatedChunks } from './replication-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_TITLE = 'p2p.cloud';
const IS_DEV = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);
const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';
const KDF_ALGORITHM = 'pbkdf2-sha256';
const KDF_ITERATIONS = 310000;
const WALLET_LOGIN_MAX_AGE_MS = 10 * 60 * 1000;
const WALLET_LOGIN_MAX_FUTURE_MS = 2 * 60 * 1000;

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
let walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE };

function normalizeWallet(address = '') { return String(address || '').trim().toLowerCase(); }
function activeWallet() { return normalizeWallet(walletState.address); }
function isValidWallet(address = '') { return /^0x[a-fA-F0-9]{40}$/.test(String(address).trim()); }
function assertVerifiedWallet() { if (!walletState.connected || !walletState.verified || !isValidWallet(walletState.address)) throw new Error('Verified wallet required. Connect wallet first.'); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function hashBufferHex(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function firstLanAddress() { const nets = os.networkInterfaces(); for (const list of Object.values(nets)) for (const net of list || []) if (net && !net.internal && net.family === 'IPv4' && !net.address.startsWith('169.254.')) return net.address; return '127.0.0.1'; }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(app.getPath('userData'), 'native-p2p-storage', 'chunks'); }
function publicPeerUrl(node) { return process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${node.port}`; }
function drivePasswordFromPayload(payload = {}) { const password = String(payload.drivePassword || '').trim(); if (password.length < 6) throw new Error('Drive Password required. Use at least 6 characters.'); return password; }
function splitIntoChunks(buffer) { const chunks = []; for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE_BYTES) { const data = buffer.slice(offset, offset + CHUNK_SIZE_BYTES); chunks.push({ index: chunks.length, size: data.length, data, hash: hashBufferHex(data) }); } return chunks; }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }

function parseLoginMessageTime(message = '') {
  const match = String(message).match(/^Time:\s*(.+)$/im);
  if (!match) throw new Error('Wallet login message is missing timestamp');
  const time = new Date(match[1]);
  if (Number.isNaN(time.getTime())) throw new Error('Wallet login timestamp is invalid');
  return time;
}

async function verifyWalletLoginPayload(payload = {}, address = '') {
  const normalizedAddress = normalizeWallet(address);
  const message = String(payload.loginMessage || '');
  const signature = String(payload.signature || '');

  if (!message || !signature) throw new Error('Missing wallet signature. Reconnect wallet.');
  if (!message.startsWith('p2p.cloud login\n')) throw new Error('Unsupported wallet login message');
  if (!message.toLowerCase().includes(`wallet: ${normalizedAddress}`)) throw new Error('Wallet login message does not match connected address');

  const signedAt = parseLoginMessageTime(message);
  const age = Date.now() - signedAt.getTime();
  if (age > WALLET_LOGIN_MAX_AGE_MS) throw new Error('Wallet login signature expired. Reconnect wallet.');
  if (age < -WALLET_LOGIN_MAX_FUTURE_MS) throw new Error('Wallet login timestamp is too far in the future');

  const valid = await verifyMessage({ address: normalizedAddress, message, signature });
  if (!valid) throw new Error('Wallet signature verification failed');

  return { message, signature, signedAt: signedAt.toISOString() };
}

function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {
  const wallet = normalizeWallet(ownerWallet);
  if (!isValidWallet(wallet)) throw new Error('Valid wallet address required for private file encryption.');
  if (!drivePassword || String(drivePassword).length < 6) throw new Error('Drive Password required.');
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64');
  return crypto.pbkdf2Sync(`${wallet}:${drivePassword}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');
}

function encryptPrivateBuffer(plainBuffer, ownerWallet = activeWallet(), drivePassword) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveDriveKey({ ownerWallet, drivePassword, salt });
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  return { ciphertext, encryption: { version: 4, algorithm: ENCRYPTION_ALGORITHM, keySource: ENCRYPTION_KEY_SOURCE, kdf: KDF_ALGORITHM, kdfIterations: KDF_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), originalHash: hashBufferHex(plainBuffer), originalSize: plainBuffer.length } };
}

function decryptPrivateBuffer(ciphertext, manifest, drivePassword) {
  if (!manifest?.encryption || manifest.encryption.algorithm !== ENCRYPTION_ALGORITHM) throw new Error('Encrypted file metadata is missing or unsupported');
  if (manifest.encryption.keySource !== ENCRYPTION_KEY_SOURCE) throw new Error(`This file was encrypted with an older key source (${manifest.encryption.keySource || 'unknown'}). Re-upload it with Drive Password encryption.`);
  const key = deriveDriveKey({ ownerWallet: manifest.ownerWallet, drivePassword, salt: manifest.encryption.salt });
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(manifest.encryption.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, 'base64'));
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (manifest.encryption.originalHash && hashBufferHex(plain) !== manifest.encryption.originalHash) throw new Error('Private file integrity failed after decrypt');
  return plain;
}

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
    walletState = { ...walletState, ...parsed, planId: PLANS[parsed?.planId] ? parsed.planId : 'free', encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE };
    if (walletState.planId !== 'free' && (!walletState.paidUntil || Number(walletState.paidUntil) < nowSeconds())) walletState = { ...walletState, planId: 'free', paidUntil: null, subscriptionTx: null };
  } catch {
    walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE };
  }
}

function persistWallet() { ensureDataDir(); const { encryptionSecret, loginSignature, ...safeWallet } = walletState; fs.writeFileSync(walletPath, JSON.stringify({ ...safeWallet, encryptionKeySource: ENCRYPTION_KEY_SOURCE }, null, 2), 'utf8'); }
function loadManifests() { ensureDataDir(); try { const parsed = JSON.parse(fs.readFileSync(manifestsPath, 'utf8')); manifests = Array.isArray(parsed) ? parsed : []; } catch { manifests = []; } }
function persistManifests() { ensureDataDir(); fs.writeFileSync(manifestsPath, JSON.stringify(manifests, null, 2), 'utf8'); }
function walletOwnsManifest(manifest) { return normalizeWallet(manifest.ownerWallet) === activeWallet(); }
function walletManifests() { return walletState.connected ? manifests.filter(walletOwnsManifest) : []; }
function totalStoredBytesForWallet() { return walletManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }
function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, address: activeWallet() || walletState.address, plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes) }; }
function assertWalletUploadAllowed(nextBytes = 0) { assertVerifiedWallet(); const plan = PLANS[walletState.planId] || PLANS.free; if (totalStoredBytesForWallet() + nextBytes > plan.quotaBytes) throw new Error(`Storage quota exceeded. Current plan: ${plan.name}.`); }
function findManifest(payload = {}) { const hash = String(payload.hash || ''); const rootHash = String(payload.rootHash || ''); return walletManifests().find((m) => m.hash === hash || m.rootHash === rootHash); }

async function syncPull() {
  try {
    if (!isManifestSyncEnabled() || !walletState.connected || !walletState.address) return;
    const remote = await pullWalletManifests(activeWallet());
    if (!Array.isArray(remote)) return;
    const map = new Map(manifests.map((m) => [`${normalizeWallet(m.ownerWallet)}:${m.hash}`, m]));
    for (const m of remote) map.set(`${normalizeWallet(m.ownerWallet)}:${m.hash}`, { ...m, ownerWallet: normalizeWallet(m.ownerWallet) });
    manifests = Array.from(map.values());
    persistManifests();
  } catch (e) { console.warn('[manifest-sync] pull failed:', e?.message || e); }
}
async function syncPush(manifest) { try { if (isManifestSyncEnabled()) await pushWalletManifest(manifest); } catch (e) { console.warn('[manifest-sync] push failed:', e?.message || e); } }
async function syncDelete(ownerWallet, hash) { try { if (isManifestSyncEnabled()) await deleteWalletManifest(ownerWallet, hash); } catch (e) { console.warn('[manifest-sync] delete failed:', e?.message || e); } }

function ensureTransport(options = {}) {
  if (!transportNode) {
    const port = Number(process.env.P2P_TRANSPORT_PORT || 8787);
    const publicUrl = process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${port}`;
    transportNode = startP2PTransport({ ...options, publicUrl, chunkStoreDir: chunkStoreDir() });
  }
  return transportNode;
}

function networkSummary() {
  const node = ensureTransport({});
  const own = walletManifests();
  const connectedPeers = node.connectedPeerIds?.() || [];
  return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, publicPeerUrl: publicPeerUrl(node), connectedPeers: connectedPeers.length, peerCount: connectedPeers.length, peers: Array.from(node.peerInfo?.values?.() || []), targetReplicas: TARGET_REPLICAS, totalFiles: own.length, encryptedFiles: own.filter((f) => f.isEncrypted).length, publicFiles: own.filter((f) => !f.isEncrypted).length, totalBytes: own.reduce((s, f) => s + Number(f.size || 0), 0), totalChunks: own.reduce((s, f) => s + Number(f.chunks?.length || 0), 0), underReplicatedChunks: countUnderReplicatedChunks(node, own, TARGET_REPLICAS), wallet: walletSummary() };
}

function resolvePreloadPath() { const preloadPath = path.join(__dirname, 'preload.cjs'); if (!fs.existsSync(preloadPath)) throw new Error(`Missing Electron preload file: ${preloadPath}`); return preloadPath; }
function resolveRendererIndexPath() { const candidates = [path.join(app.getAppPath(), 'dist', 'public', 'index.html'), path.join(app.getAppPath(), 'public', 'index.html'), path.join(__dirname, '..', 'dist', 'public', 'index.html'), path.join(process.resourcesPath || '', 'app', 'dist', 'public', 'index.html')]; for (const c of candidates) if (c && fs.existsSync(c)) return c; throw new Error(`Renderer index.html not found. Tried: ${candidates.join(' | ')}`); }
function createMainWindow() { mainWindow = new BrowserWindow({ title: APP_TITLE, width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#09090b', show: false, webPreferences: { preload: resolvePreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: false } }); mainWindow.once('ready-to-show', () => mainWindow?.show()); mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); if (IS_DEV) mainWindow.loadURL(DEV_SERVER_URL); else mainWindow.loadFile(resolveRendererIndexPath()); mainWindow.on('closed', () => { mainWindow = null; }); }

ipcMain.handle('electron:openDevTools', async () => { mainWindow?.webContents.openDevTools({ mode: 'detach' }); return { ok: true }; });
ipcMain.handle('electron:diagnostics', async () => ({ ok: true, cwd: process.cwd(), dirname: __dirname, preloadPath: resolvePreloadPath(), rendererPath: IS_DEV ? DEV_SERVER_URL : resolveRendererIndexPath(), isPackaged: app.isPackaged, appPath: app.getAppPath() }));
ipcMain.handle('system:open-external', async (_event, payload = {}) => { const url = String(payload.url || ''); if (!/^https?:\/\//i.test(url)) throw new Error('Invalid external URL'); await shell.openExternal(url); return { ok: true }; });
ipcMain.handle('wallet:status', async () => walletSummary());
ipcMain.handle('wallet:connect', async (_event, payload = {}) => {
  const address = normalizeWallet(payload.address);
  if (!isValidWallet(address)) throw new Error('Invalid wallet address. Expected 0x + 40 hex characters.');
  const login = await verifyWalletLoginPayload(payload, address);
  const sameWallet = address === activeWallet();
  walletState = { ...walletState, connected: true, verified: true, address, planId: sameWallet && PLANS[walletState.planId] ? walletState.planId : 'free', connectedAt: new Date().toISOString(), verifiedAt: login.signedAt, loginMessage: login.message, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE };
  persistWallet();
  await syncPull();
  return walletSummary();
});
ipcMain.handle('wallet:disconnect', async () => { walletState = { ...walletState, connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, loginMessage: null, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; persistWallet(); return walletSummary(); });
ipcMain.handle('wallet:setPlan', async (_event, payload = {}) => { assertVerifiedWallet(); const planId = String(payload.planId || 'free'); if (!PLANS[planId]) throw new Error('Unknown wallet plan'); walletState = { ...walletState, planId, paidUntil: payload.paidUntil || walletState.paidUntil || null, subscriptionTx: payload.txHash || walletState.subscriptionTx || null }; persistWallet(); return walletSummary(); });
ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); await syncPull(); return networkSummary(); });
ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { if (!walletState.connected || !walletState.verified) return []; const query = String(payload.query || '').trim().toLowerCase(); const own = walletManifests(); if (!query) return own; return own.filter((f) => [f.name, f.hash, f.rootHash, f.ownerWallet || ''].some((v) => String(v || '').toLowerCase().includes(query))); });

ipcMain.handle('p2p:upload', async (_event, payload = {}) => {
  const node = ensureTransport({});
  if (!payload.bytes) throw new Error('File bytes are required');
  const originalBuffer = Buffer.from(payload.bytes);
  assertWalletUploadAllowed(originalBuffer.length);
  const ownerWallet = activeWallet();
  const privateFile = Boolean(payload.isEncrypted);
  const drivePassword = privateFile ? drivePasswordFromPayload(payload) : null;
  const secured = privateFile ? encryptPrivateBuffer(originalBuffer, ownerWallet, drivePassword) : { ciphertext: originalBuffer, encryption: null };
  const storedBuffer = secured.ciphertext;
  const chunks = splitIntoChunks(storedBuffer);
  const tree = buildMerkleTree(chunks.map((c) => c.hash));
  const storedHash = hashBufferHex(storedBuffer);
  const fileReplicas = new Set([node.peerId]);
  const manifest = { id: `${ownerWallet}:${storedHash}`, name: String(payload.name || 'file'), size: originalBuffer.length, storedSize: storedBuffer.length, hash: storedHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: privateFile, encryption: secured.encryption, mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream', chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: [] };

  for (const chunk of chunks) {
    const chunkPayload = { hash: chunk.hash, data: chunk.data.toString('base64'), index: chunk.index, size: chunk.size, ownerWallet, encrypted: privateFile };
    const replicas = replicateChunk(node, chunkPayload, [node.peerId], TARGET_REPLICAS);
    for (const peerId of replicas) fileReplicas.add(peerId);
    manifest.chunks.push({ index: chunk.index, hash: chunk.hash, size: chunk.size, replicas, proof: getMerkleProof(tree, chunk.index) });
  }

  manifest.replicas = unique(Array.from(fileReplicas));
  manifests = manifests.filter((m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
  manifests.push(manifest);
  persistManifests();
  persistWallet();
  await syncPush(manifest);
  return { ok: true, file: manifest, summary: networkSummary() };
});

ipcMain.handle('p2p:download', async (_event, payload = {}) => { assertVerifiedWallet(); const node = ensureTransport({}); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const buffers = []; for (const meta of [...(manifest.chunks || [])].sort((a, b) => a.index - b.index)) { const local = node.getLocalChunk?.(meta.hash) || node.localChunks?.get(meta.hash); const chunk = local || await node.fetchChunkFromNetwork(meta.hash); node.storeLocalChunk?.(chunk); const buffer = Buffer.from(chunk.data, 'base64'); if (hashBufferHex(buffer) !== meta.hash) throw new Error(`Chunk integrity failed: ${meta.hash}`); buffers.push(buffer); } const storedBuffer = Buffer.concat(buffers); if (hashBufferHex(storedBuffer) !== manifest.hash) throw new Error('File integrity failed'); const drivePassword = manifest.isEncrypted ? drivePasswordFromPayload(payload) : null; const outputBuffer = manifest.isEncrypted ? decryptPrivateBuffer(storedBuffer, manifest, drivePassword) : storedBuffer; return { ok: true, file: manifest, bytes: Array.from(outputBuffer) }; });
ipcMain.handle('p2p:delete', async (_event, payload = {}) => { assertVerifiedWallet(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); manifests = manifests.filter((m) => !(walletOwnsManifest(m) && m.hash === manifest.hash)); persistManifests(); await syncDelete(activeWallet(), manifest.hash); return { ok: true, summary: networkSummary() }; });
ipcMain.handle('p2p:networkSummary', async () => networkSummary());
ipcMain.handle('p2p:bootstrapNow', async () => ({ ok: true, summary: networkSummary() }));
ipcMain.handle('p2p:connectPeer', async (_event, payload = {}) => { const peerId = String(payload.peerId || '').trim(); const url = String(payload.url || '').trim(); if (!peerId || !/^wss?:\/\//i.test(url)) throw new Error('peerId and ws:// URL are required'); const result = ensureTransport({}).connectPeer({ peerId, url }); return { ok: true, ...result, summary: networkSummary() }; });
ipcMain.handle('p2p:repair', async () => { assertVerifiedWallet(); const node = ensureTransport({}); const own = walletManifests(); const result = await repairManifests({ node, manifests: own, configuredTargetReplicas: TARGET_REPLICAS, persistManifests, syncPush }); return { ok: true, ...result, summary: networkSummary() }; });
ipcMain.handle('p2p:prepareProof', async (_event, payload = {}) => { assertVerifiedWallet(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const chunk = manifest.chunks?.[0]; if (!chunk) throw new Error('No chunks available for proof'); return { ok: true, proof: { ownerWallet: activeWallet(), rootHash: manifest.rootHash, chunkIndex: chunk.index, leaf: chunk.hash, merkleProof: chunk.proof, encrypted: Boolean(manifest.isEncrypted), keySource: manifest.encryption?.keySource || null, preparedAt: new Date().toISOString() } }; });

app.whenReady().then(async () => { app.setName(APP_TITLE); ensureDataDir(); loadWallet(); loadManifests(); ensureTransport({}); await syncPull(); createMainWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); }); }).catch((error) => { console.error('Electron failed:', error); app.exit(1); });
app.on('before-quit', () => { persistWallet(); persistManifests(); if (transportNode) transportNode.stop(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
