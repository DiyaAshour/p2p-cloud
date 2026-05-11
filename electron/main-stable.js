import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { verifyMessage } from 'viem';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';
import { startP2PTransport } from './p2p-transport.js';
import { putChunkToSafetyPeer, getChunkFromSafetyPeer, safetyPeerUrl } from './safety-peer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_TITLE = 'Chunknet';
const IS_DEV = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 2 * 1024 * 1024);
const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const UPLOAD_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.P2P_UPLOAD_CONCURRENCY || 4)));
const DOWNLOAD_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.P2P_DOWNLOAD_CONCURRENCY || 6)));
const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';
const KDF_ALGORITHM = 'pbkdf2-sha256';
const KDF_ITERATIONS = 310000;
const MIN_DRIVE_PASSWORD_LENGTH = Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12);

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
let transferProgress = { upload: null, download: null };
const TRANSFER_CANCELLED_UPLOAD = '__TRANSFER_CANCELLED_UPLOAD__';
let lastSyncStatus = { ok: false, lastPulledAt: null, lastPushedAt: null, error: null, remoteFiles: 0, skipped: true };
let lastAutoRepairStatus = { ok: true, active: false, intervalMs: 10_800_000, lastRunAt: null, repairedChunks: 0, underReplicatedChunks: 0, skippedReason: 'disabled-at-startup', error: null };
let walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE };

function normalizeWallet(address = '') { return String(address || '').trim().toLowerCase(); }
function activeWallet() { return normalizeWallet(walletState.address); }
function isValidWallet(address = '') { return /^0x[a-fA-F0-9]{40}$/.test(String(address).trim()); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function hashBufferHex(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function safeName(name = '') { return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_'); }
function firstLanAddress() { const nets = os.networkInterfaces(); for (const list of Object.values(nets)) for (const net of list || []) if (net && !net.internal && net.family === 'IPv4' && !net.address.startsWith('169.254.')) return net.address; return '127.0.0.1'; }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(app.getPath('userData'), 'native-p2p-storage', 'chunks'); }
function publicPeerUrl(node) { return process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${node.port}`; }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function hasEncryptionMetadata(manifest = {}) {
  if (!manifest.encryption?.algorithm || !manifest.encryption?.keySource || !manifest.encryption?.salt) return false;
  // version 5: per-chunk encryption — لا يحتاج iv/authTag عالمستوى الكامل
  if (manifest.encryption.version >= 5) return Boolean(manifest.encryption.perChunk && Array.isArray(manifest.encryption.chunkAuthTags));
  // version 4: تشفير الملف كله
  return Boolean(manifest.encryption.iv && manifest.encryption.authTag);
}
function isUsableManifest(manifest = {}) { return !(manifest.isEncrypted === true && !hasEncryptionMetadata(manifest)); }
function validateDrivePassword(drivePassword) { const password = String(drivePassword || '').trim(); if (password.length < MIN_DRIVE_PASSWORD_LENGTH) throw new Error(`Drive Password required. Use at least ${MIN_DRIVE_PASSWORD_LENGTH} characters.`); return password; }
function drivePasswordFromPayload(payload = {}) { return validateDrivePassword(payload.drivePassword); }
function assertVerifiedWallet() { if (!walletState.connected || !walletState.verified || !isValidWallet(walletState.address)) throw new Error('Verified wallet required. Connect wallet first.'); }
function chunkPath(chunkHash) { const safe = String(chunkHash || '').replace(/[^a-fA-F0-9]/g, ''); return path.join(chunkStoreDir(), `${safe}.json`); }

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
  } catch { walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; }
}
function persistWallet() { ensureDataDir(); const { encryptionSecret, loginSignature, ...safeWallet } = walletState; fs.writeFileSync(walletPath, JSON.stringify({ ...safeWallet, encryptionKeySource: ENCRYPTION_KEY_SOURCE }, null, 2), 'utf8'); }
function loadManifests() { ensureDataDir(); try { const parsed = JSON.parse(fs.readFileSync(manifestsPath, 'utf8')); manifests = Array.isArray(parsed) ? parsed.filter(isUsableManifest) : []; } catch { manifests = []; } }
function persistManifests() { ensureDataDir(); fs.writeFileSync(manifestsPath, JSON.stringify(manifests.filter(isUsableManifest), null, 2), 'utf8'); }
function walletOwnsManifest(manifest) { return normalizeWallet(manifest.ownerWallet) === activeWallet(); }
function walletManifests() { return walletState.connected ? manifests.filter(walletOwnsManifest).filter(isUsableManifest) : []; }
function totalStoredBytesForWallet() { return walletManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }
function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet() || walletState.address, plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }
function assertWalletUploadAllowed(nextBytes = 0) { assertVerifiedWallet(); const plan = PLANS[walletState.planId] || PLANS.free; if (totalStoredBytesForWallet() + nextBytes > plan.quotaBytes) throw new Error(`Storage quota exceeded. Current plan: ${plan.name}.`); }
function findManifest(payload = {}) { const hash = String(payload.hash || ''); const rootHash = String(payload.rootHash || ''); return walletManifests().find((m) => m.hash === hash || m.rootHash === rootHash); }

function ensureTransport(options = {}) {
  if (!transportNode) {
    const port = Number(process.env.P2P_TRANSPORT_PORT || 8787);
    const publicUrl = process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${port}`;
    transportNode = startP2PTransport({ ...options, publicUrl, chunkStoreDir: chunkStoreDir() });
  }
  return transportNode;
}

async function verifyWalletLoginPayload(payload = {}, address = '') {
  const message = String(payload.loginMessage || '');
  const signature = String(payload.signature || '');
  if (!message || !signature) return { message: null, signature: null, signedAt: new Date().toISOString(), insecureDevFallback: true };
  const valid = await verifyMessage({ address: normalizeWallet(address), message, signature });
  if (!valid) throw new Error('Wallet signature verification failed');
  return { message, signature, signedAt: new Date().toISOString() };
}

function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {
  const wallet = normalizeWallet(ownerWallet);
  if (!isValidWallet(wallet)) throw new Error('Valid wallet address required for private file encryption.');
  const password = validateDrivePassword(drivePassword);
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64');
  return crypto.pbkdf2Sync(`${wallet}:${password}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');
}

// ─── version 4: فك تشفير الملف كله من buffer (للتوافق مع الملفات القديمة) ───
function decryptPrivateBuffer(ciphertext, manifest, drivePassword) {
  if (!manifest?.encryption || manifest.encryption.algorithm !== ENCRYPTION_ALGORITHM) throw new Error('Encrypted file metadata is missing or unsupported');
  const key = deriveDriveKey({ ownerWallet: manifest.ownerWallet, drivePassword, salt: manifest.encryption.salt });
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(manifest.encryption.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, 'base64'));
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (manifest.encryption.originalHash && hashBufferHex(plain) !== manifest.encryption.originalHash) throw new Error('Private file integrity failed after decrypt');
  return plain;
}

// ─── version 5: فك تشفير chunk by chunk مباشرة على disk ───
async function decryptChunkedFileToStream(encryptedPath, manifest, drivePassword, writeStream) {
  const key = deriveDriveKey({ ownerWallet: manifest.ownerWallet, drivePassword, salt: manifest.encryption.salt });
  const chunkAuthTags = manifest.encryption.chunkAuthTags;
  const fd = fs.openSync(encryptedPath, 'r');
  // كل chunk مخزّن هيك: [iv: 12 bytes][authTag: 16 bytes][size: 4 bytes][encryptedData]
  const HEADER_SIZE = 32; // 12 + 16 + 4
  let fileOffset = 0;
  try {
    for (const { iv, authTag } of chunkAuthTags) {
      const header = Buffer.allocUnsafe(HEADER_SIZE);
      fs.readSync(fd, header, 0, HEADER_SIZE, fileOffset);
      fileOffset += HEADER_SIZE;
      const encryptedSize = header.readUInt32BE(28);
      const encryptedData = Buffer.allocUnsafe(encryptedSize);
      fs.readSync(fd, encryptedData, 0, encryptedSize, fileOffset);
      fileOffset += encryptedSize;
      const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(authTag, 'base64'));
      const plain = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      await new Promise((resolve, reject) => {
        writeStream.write(plain, (err) => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    fs.closeSync(fd);
  }
}

function createProgress(kind, { fileName, totalBytes, totalChunks, concurrency }) { const now = Date.now(); transferProgress[kind] = { active: true, phase: 'running', fileName, totalBytes, transferredBytes: 0, percent: 0, speedBytesPerSecond: 0, etaSeconds: null, chunksDone: 0, totalChunks, concurrency, startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), error: null }; }
function updateProgress(kind, { bytesDelta = 0, chunkDelta = 0, phase = 'running', error = null } = {}) { const progress = transferProgress[kind]; if (!progress) return; const now = Date.now(); const started = new Date(progress.startedAt).getTime() || now; const elapsedSeconds = Math.max(0.001, (now - started) / 1000); const transferredBytes = Math.min(progress.totalBytes, Number(progress.transferredBytes || 0) + Number(bytesDelta || 0)); const chunksDone = Math.min(progress.totalChunks, Number(progress.chunksDone || 0) + Number(chunkDelta || 0)); const speedBytesPerSecond = transferredBytes / elapsedSeconds; const remainingBytes = Math.max(0, progress.totalBytes - transferredBytes); transferProgress[kind] = { ...progress, phase, transferredBytes, percent: progress.totalBytes ? (transferredBytes / progress.totalBytes) * 100 : 100, speedBytesPerSecond, etaSeconds: speedBytesPerSecond > 0 && remainingBytes > 0 ? remainingBytes / speedBytesPerSecond : 0, chunksDone, updatedAt: new Date(now).toISOString(), error }; }
function finishProgress(kind, phase = 'complete', error = null) { const progress = transferProgress[kind]; if (!progress) return; updateProgress(kind, { phase, error }); transferProgress[kind] = { ...transferProgress[kind], active: false, phase, error }; }

// ─── version 5: تشفير كل chunk لحاله — رام ثابت ~2MB بغض النظر عن حجم الملف ───
async function encryptedTempFile(filePath, ownerWallet, drivePassword) {
  const salt = crypto.randomBytes(16);
  const key = deriveDriveKey({ ownerWallet, drivePassword, salt });
  const tempPath = path.join(app.getPath('temp'), `chunknet-${crypto.randomUUID()}.enc`);
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const writeStream = fs.createWriteStream(tempPath);
  const chunkAuthTags = [];

  try {
    for (let offset = 0; offset < stat.size; offset += CHUNK_SIZE_BYTES) {
      const size = Math.min(CHUNK_SIZE_BYTES, stat.size - offset);
      const data = Buffer.allocUnsafe(size);
      fs.readSync(fd, data, 0, size, offset);

      // IV مختلف لكل chunk — ضروري لأمان AES-GCM
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      const authTag = cipher.getAuthTag();

      // format: [iv: 12][authTag: 16][encryptedSize: 4][encryptedData]
      const sizeBuf = Buffer.allocUnsafe(4);
      sizeBuf.writeUInt32BE(encrypted.length, 0);
      const frame = Buffer.concat([iv, authTag, sizeBuf, encrypted]);

      await new Promise((resolve, reject) => {
        writeStream.write(frame, (err) => (err ? reject(err) : resolve()));
      });

      chunkAuthTags.push({ iv: iv.toString('base64'), authTag: authTag.toString('base64') });
    }
  } finally {
    fs.closeSync(fd);
    await new Promise((resolve, reject) => {
      writeStream.end((err) => (err ? reject(err) : resolve()));
    });
  }

  const originalHash = await hashFileHex(filePath);

  return {
    tempPath,
    cleanup: true,
    encryption: {
      version: 5,
      algorithm: ENCRYPTION_ALGORITHM,
      keySource: ENCRYPTION_KEY_SOURCE,
      kdf: KDF_ALGORITHM,
      kdfIterations: KDF_ITERATIONS,
      salt: salt.toString('base64'),
      perChunk: true,
      chunkAuthTags,
      originalHash,
      originalSize: stat.size,
    },
  };
}

async function hashFileHex(filePath) { const hash = crypto.createHash('sha256'); await new Promise((resolve, reject) => { const input = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES }); input.on('data', (data) => hash.update(data)); input.on('end', resolve); input.on('error', reject); }); return hash.digest('hex'); }
function storeChunkPayload(payload) { fs.mkdirSync(chunkStoreDir(), { recursive: true }); fs.writeFileSync(chunkPath(payload.hash), JSON.stringify({ ...payload, storedAt: new Date().toISOString() }), 'utf8'); }
function readChunkPayload(hash) { const p = chunkPath(hash); if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function uploadFilePathStreaming(filePath, payload = {}) {
  ensureDataDir(); loadWallet(); loadManifests();
  const node = ensureTransport({});
  const stat = fs.statSync(filePath);
  assertWalletUploadAllowed(stat.size);
  const ownerWallet = activeWallet();
  const privateFile = Boolean(payload.isEncrypted);
  const drivePassword = privateFile ? drivePasswordFromPayload(payload) : null;
  const secured = privateFile ? await encryptedTempFile(filePath, ownerWallet, drivePassword) : { tempPath: filePath, cleanup: false, encryption: null };
  const storedSize = fs.statSync(secured.tempPath).size;
  const totalChunks = Math.max(1, Math.ceil(storedSize / CHUNK_SIZE_BYTES));
  const fileName = safeName(path.basename(filePath));
  createProgress('upload', { fileName, totalBytes: storedSize, totalChunks, concurrency: UPLOAD_CONCURRENCY });

  const chunkResults = [];
  const hashes = [];
  const fd = fs.openSync(secured.tempPath, 'r');
  let storedHash;
  try {
    const wholeHash = crypto.createHash('sha256');
    for (let index = 0, offset = 0; offset < storedSize; index += 1, offset += CHUNK_SIZE_BYTES) {
      const size = Math.min(CHUNK_SIZE_BYTES, storedSize - offset);
      const data = Buffer.allocUnsafe(size);
      fs.readSync(fd, data, 0, size, offset);
      wholeHash.update(data);
      const hash = hashBufferHex(data);
      hashes.push(hash);
      const chunkPayload = { hash, data: data.toString('base64'), index, size, ownerWallet, encrypted: privateFile };
      storeChunkPayload(chunkPayload);
      const replicas = [node.peerId];
      try { await putChunkToSafetyPeer(chunkPayload, node.peerId); replicas.push('aws-safety-peer'); } catch (error) { console.warn('[safety-peer] optional upload failed:', error?.message || error); }
      chunkResults.push({ index, hash, size, replicas: unique(replicas), proof: [] });
      updateProgress('upload', { bytesDelta: size, chunkDelta: 1 });
    }
    storedHash = wholeHash.digest('hex');
  } catch (error) { finishProgress('upload', 'error', error?.message || String(error)); throw error; }
  finally { fs.closeSync(fd); if (secured.cleanup) { try { fs.unlinkSync(secured.tempPath); } catch {} } }

  const tree = buildMerkleTree(hashes);
  for (const chunk of chunkResults) chunk.proof = getMerkleProof(tree, chunk.index);
  const manifest = { id: `${ownerWallet}:${storedHash}`, name: fileName, size: stat.size, storedSize, hash: storedHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption: secured.encryption, mimeType: payload.mimeType || 'application/octet-stream', chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunkResults.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: chunkResults };
  manifests = manifests.filter((m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
  manifests.push(manifest);
  persistManifests(); persistWallet(); finishProgress('upload');
  return manifest;
}

function networkSummary() { const node = ensureTransport({}); const own = walletManifests(); const connectedPeers = node.connectedPeerIds?.() || []; return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, publicPeerUrl: publicPeerUrl(node), safetyPeerUrl: safetyPeerUrl(), connectedPeers: connectedPeers.length, peerCount: connectedPeers.length, peers: Array.from(node.peerInfo?.values?.() || []), targetReplicas: TARGET_REPLICAS, totalFiles: own.length, encryptedFiles: own.filter((f) => f.isEncrypted).length, publicFiles: own.filter((f) => !f.isEncrypted).length, totalBytes: own.reduce((s, f) => s + Number(f.size || 0), 0), totalChunks: own.reduce((s, f) => s + Number(f.chunks?.length || 0), 0), underReplicatedChunks: 0, transferProgress, transferSettings: { uploadConcurrency: UPLOAD_CONCURRENCY, downloadConcurrency: DOWNLOAD_CONCURRENCY }, autoRepair: lastAutoRepairStatus, wallet: walletSummary(), sync: lastSyncStatus }; }
function resolvePreloadPath() { const preloadPath = path.join(__dirname, 'preload.cjs'); if (!fs.existsSync(preloadPath)) throw new Error(`Missing Electron preload file: ${preloadPath}`); return preloadPath; }
function resolveRendererIndexPath() { const candidates = [path.join(app.getAppPath(), 'dist', 'public', 'index.html'), path.join(app.getAppPath(), 'public', 'index.html'), path.join(__dirname, '..', 'dist', 'public', 'index.html'), path.join(process.resourcesPath || '', 'app', 'dist', 'public', 'index.html')]; for (const c of candidates) if (c && fs.existsSync(c)) return c; throw new Error(`Renderer index.html not found. Tried: ${candidates.join(' | ')}`); }
function createMainWindow() { mainWindow = new BrowserWindow({ title: APP_TITLE, width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#09090b', show: false, webPreferences: { preload: resolvePreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: false } }); mainWindow.once('ready-to-show', () => mainWindow?.show()); mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); if (IS_DEV) mainWindow.loadURL(DEV_SERVER_URL); else mainWindow.loadFile(resolveRendererIndexPath()); mainWindow.on('closed', () => { mainWindow = null; }); }

ipcMain.handle('electron:openDevTools', async () => { mainWindow?.webContents.openDevTools({ mode: 'detach' }); return { ok: true }; });
ipcMain.handle('electron:diagnostics', async () => ({ ok: true, cwd: process.cwd(), dirname: __dirname, preloadPath: resolvePreloadPath(), rendererPath: IS_DEV ? DEV_SERVER_URL : resolveRendererIndexPath(), isPackaged: app.isPackaged, appPath: app.getAppPath() }));
ipcMain.handle('system:open-external', async (_event, payload = {}) => { const url = String(payload.url || ''); if (!/^https?:\/\//i.test(url)) throw new Error('Invalid external URL'); await shell.openExternal(url); return { ok: true }; });
ipcMain.handle('wallet:status', async () => { ensureDataDir(); loadWallet(); loadManifests(); return walletSummary(); });
ipcMain.handle('wallet:connect', async (_event, payload = {}) => { const address = normalizeWallet(payload.address); if (!isValidWallet(address)) throw new Error('Invalid wallet address. Expected 0x + 40 hex characters.'); const login = await verifyWalletLoginPayload(payload, address); const sameWallet = address === activeWallet(); walletState = { ...walletState, connected: true, verified: true, address, planId: sameWallet && PLANS[walletState.planId] ? walletState.planId : 'free', connectedAt: new Date().toISOString(), verifiedAt: login.signedAt, loginMessage: login.message, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; persistWallet(); return walletSummary(); });
ipcMain.handle('wallet:disconnect', async () => { walletState = { ...walletState, connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, loginMessage: null, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; persistWallet(); return walletSummary(); });
ipcMain.handle('wallet:setPlan', async (_event, payload = {}) => { assertVerifiedWallet(); const planId = String(payload.planId || 'free'); if (!PLANS[planId]) throw new Error('Unknown wallet plan'); walletState = { ...walletState, planId, paidUntil: payload.paidUntil || walletState.paidUntil || null, subscriptionTx: payload.txHash || walletState.subscriptionTx || null }; persistWallet(); return walletSummary(); });
ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); return networkSummary(); });
ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { if (!walletState.connected || !walletState.verified) return []; const query = String(payload.query || '').trim().toLowerCase(); const own = walletManifests(); if (!query) return own; return own.filter((f) => [f.name, f.hash, f.rootHash, f.ownerWallet || ''].some((v) => String(v || '').toLowerCase().includes(query))); });
ipcMain.handle('p2p:upload', async () => { throw new Error('Use native streaming upload. Browser RAM upload is disabled.'); });
ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose files to store',
    properties: ['openFile', 'multiSelections'],
  });

  if (result.canceled || !result.filePaths?.length) {
    return { ok: true, cancelled: true, files: [] };
  }

  const files = [];

  try {
    for (const filePath of result.filePaths) {
      files.push(await uploadFilePathStreaming(filePath, payload));
    }

    return {
      ok: true,
      files,
      summary: networkSummary(),
      progress: transferProgress.upload,
    };
  } catch (error) {
    const message = String(error?.message || '');

    if (
      error?.code === TRANSFER_CANCELLED_UPLOAD ||
      message.includes(TRANSFER_CANCELLED_UPLOAD) ||
      message.toLowerCase().includes('upload canceled') ||
      message.toLowerCase().includes('upload cancelled')
    ) {
      finishProgress('upload', 'cancelled', null);

      return {
        ok: true,
        cancelled: true,
        files,
        summary: networkSummary(),
        progress: transferProgress.upload,
      };
    }

    throw error;
  }
});
ipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => ({ ok: true, file: await uploadFilePathStreaming(String(payload.filePath || ''), payload), summary: networkSummary() }));
ipcMain.handle('p2p:download', async (_event, payload = {}) => { assertVerifiedWallet(); const node = ensureTransport({}); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const ordered = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index); createProgress('download', { fileName: manifest.name, totalBytes: Number(manifest.storedSize || manifest.size || 0), totalChunks: ordered.length, concurrency: DOWNLOAD_CONCURRENCY }); const buffers = []; for (const meta of ordered) { let chunk = readChunkPayload(meta.hash); if (!chunk) chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId); const buffer = Buffer.from(chunk.data, 'base64'); buffers.push(buffer); updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 }); } const stored = Buffer.concat(buffers); const plain = manifest.isEncrypted ? decryptPrivateBuffer(stored, manifest, payload.drivePassword) : stored; finishProgress('download'); return { ok: true, file: manifest, bytes: Array.from(plain), progress: transferProgress.download }; });
ipcMain.handle('p2p:downloadToPath', async (_event, payload = {}) => {
  assertVerifiedWallet();

  const node = ensureTransport({});
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this wallet');

  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Save file',
    defaultPath: safeName(manifest.name),
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { ok: true, cancelled: true };
  }

  const ordered = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index);

  createProgress('download', {
    fileName: manifest.name,
    totalBytes: Number(manifest.storedSize || manifest.size || 0),
    totalChunks: ordered.length,
    concurrency: 1,
  });

  const outputPath = saveResult.filePath;
  // ملفات مشفرة: نحتاج temp file للـ ciphertext قبل فك التشفير
  const tempEncryptedPath = path.join(app.getPath('temp'), `chunknet-download-${crypto.randomUUID()}.enc`);
  const writePath = manifest.isEncrypted ? tempEncryptedPath : outputPath;
  const writeStream = fs.createWriteStream(writePath);

  try {
    // ── اكتب الـ chunks على disk مباشرة بدون تجميعهم بالرام ──
    for (const meta of ordered) {
      let chunk = readChunkPayload(meta.hash);
      if (!chunk) chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId);
      if (!chunk?.data) throw new Error(`Missing chunk: ${meta.hash}`);

      const buffer = Buffer.from(chunk.data, 'base64');

      await new Promise((resolve, reject) => {
        writeStream.write(buffer, (err) => (err ? reject(err) : resolve()));
      });

      updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 });
    }

    await new Promise((resolve, reject) => {
      writeStream.end((err) => (err ? reject(err) : resolve()));
    });

    // ── فك التشفير ──
    if (manifest.isEncrypted) {
      const encVersion = manifest.encryption?.version ?? 4;

      if (encVersion >= 5) {
        // version 5: فك تشفير chunk by chunk مباشرة على disk — رام ~2MB فقط
        const decryptStream = fs.createWriteStream(outputPath);
        await decryptChunkedFileToStream(tempEncryptedPath, manifest, payload.drivePassword, decryptStream);
        await new Promise((resolve, reject) => {
          decryptStream.end((err) => (err ? reject(err) : resolve()));
        });
      } else {
        // version 4 (legacy): فك تشفير الملف كله — بيأكل رام بحجم الملف
        const plain = decryptPrivateBuffer(
          fs.readFileSync(tempEncryptedPath),
          manifest,
          payload.drivePassword
        );
        fs.writeFileSync(outputPath, plain);
      }
    }

    finishProgress('download');

    return {
      ok: true,
      savedTo: outputPath,
      file: manifest,
      progress: transferProgress.download,
    };
  } catch (error) {
    finishProgress('download', 'error', error?.message || String(error));
    try { writeStream.destroy(); } catch {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    throw error;
  } finally {
    try {
      if (manifest.isEncrypted && fs.existsSync(tempEncryptedPath)) {
        fs.unlinkSync(tempEncryptedPath);
      }
    } catch {}
  }
});
ipcMain.handle('p2p:delete', async (_event, payload = {}) => { assertVerifiedWallet(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); manifests = manifests.filter((m) => !(normalizeWallet(m.ownerWallet) === activeWallet() && m.hash === manifest.hash)); persistManifests(); return { ok: true, summary: networkSummary() }; });
ipcMain.handle('p2p:networkSummary', async () => networkSummary());
ipcMain.handle('p2p:bootstrapNow', async () => ({ ok: true, skipped: true, reason: 'stable-main-no-startup-bootstrap' }));
ipcMain.handle('p2p:connectPeer', async (_event, payload = {}) => ensureTransport({}).connectPeer(payload));
ipcMain.handle('p2p:repair', async () => ({ ok: true, changed: false, report: [], skippedReason: 'manual-repair-disabled-in-stable-startup-build' }));
ipcMain.handle('p2p:prepareProof', async (_event, payload = {}) => { const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); return { ok: true, proof: { rootHash: manifest.rootHash, chunks: manifest.chunks?.map((c) => ({ index: c.index, hash: c.hash, proof: c.proof })) || [] } }; });

app.whenReady().then(() => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport({}); createMainWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createMainWindow(); });
