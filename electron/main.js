import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
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
import { putChunkToSafetyPeer, getChunkFromSafetyPeer, safetyPeerUrl } from './safety-peer.js';
import './seed-auth-cooldown-ipc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_TITLE = 'p2p.cloud';
const IS_DEV = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);
const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const AUTO_REPAIR_INTERVAL_MS = Math.max(30_000, Number(process.env.P2P_AUTO_REPAIR_INTERVAL_MS || 60_000));
const UPLOAD_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.P2P_UPLOAD_CONCURRENCY || 4)));
const DOWNLOAD_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.P2P_DOWNLOAD_CONCURRENCY || 6)));
const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';
function keySourceForIdentity() { return ENCRYPTION_KEY_SOURCE; }
const KDF_ALGORITHM = 'pbkdf2-sha256';
const KDF_ITERATIONS = 310000;
const MIN_DRIVE_PASSWORD_LENGTH = Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12);
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
let autoRepairTimer = null;
let autoRepairRunning = false;
let lastAutoRepairStatus = { ok: true, active: false, intervalMs: AUTO_REPAIR_INTERVAL_MS, lastRunAt: null, repairedChunks: 0, underReplicatedChunks: 0, skippedReason: 'not-started', error: null };
let transferProgress = { upload: null, download: null };
let dataDir = null;
let manifestsPath = null;
let walletPath = null;
let manifests = [];
let walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE };
let lastSyncStatus = { ok: false, lastPulledAt: null, lastPushedAt: null, error: null, remoteFiles: 0 };

function normalizeWallet(address = '') { return String(address || '').trim().toLowerCase(); }
function activeWallet() { return normalizeWallet(walletState.accountId || walletState.address); }
function isValidWallet(address = '') { return /^0x[a-fA-F0-9]{40}$/.test(String(address).trim()); }
function isVerifiedSeedIdentity() {
  const accountId = String(walletState.accountId || walletState.address || '');
  return Boolean(
    walletState.connected &&
    walletState.verified &&
    walletState.authMode === 'seed' &&
    accountId.startsWith('seed:')
  );
}

function assertVerifiedWallet() {
  if (isVerifiedSeedIdentity()) return;

  if (!walletState.connected || !walletState.verified || !activeWallet()) {
    throw new Error('Verified identity required. Connect wallet or sign in with Seed Account first.');
  }
}
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function hashBufferHex(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function firstLanAddress() { const nets = os.networkInterfaces(); for (const list of Object.values(nets)) for (const net of list || []) if (net && !net.internal && net.family === 'IPv4' && !net.address.startsWith('169.254.')) return net.address; return '127.0.0.1'; }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(app.getPath('userData'), 'native-p2p-storage', 'chunks'); }
function publicPeerUrl(node) { return process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${node.port}`; }
function validateDrivePassword(drivePassword) { const password = String(drivePassword || '').trim(); if (password.length < MIN_DRIVE_PASSWORD_LENGTH) throw new Error(`Drive Password required. Use at least ${MIN_DRIVE_PASSWORD_LENGTH} characters.`); return password; }
function drivePasswordFromPayload(payload = {}) { return validateDrivePassword(payload.drivePassword); }
function splitIntoChunks(buffer) { const chunks = []; for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE_BYTES) { const data = buffer.slice(offset, offset + CHUNK_SIZE_BYTES); chunks.push({ index: chunks.length, size: data.length, data, hash: hashBufferHex(data) }); } return chunks; }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function hasEncryptionMetadata(manifest = {}) { return Boolean(manifest.encryption && manifest.encryption.algorithm && manifest.encryption.keySource && manifest.encryption.salt && manifest.encryption.iv && manifest.encryption.authTag); }
function isUsableManifest(manifest = {}) { return !(manifest.isEncrypted === true && !hasEncryptionMetadata(manifest)); }
function clampConcurrency(value, fallback, max) { return Math.max(1, Math.min(max, Number(value || fallback))); }

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function createProgress(kind, { fileName, totalBytes, totalChunks, concurrency }) {
  const now = Date.now();
  transferProgress[kind] = {
    active: true,
    phase: 'running',
    fileName,
    totalBytes,
    transferredBytes: 0,
    percent: 0,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    chunksDone: 0,
    totalChunks,
    concurrency,
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    error: null,
  };
}

function updateProgress(kind, { bytesDelta = 0, chunkDelta = 0, phase = 'running', error = null } = {}) {
  const progress = transferProgress[kind];
  if (!progress) return;
  const now = Date.now();
  const started = new Date(progress.startedAt).getTime() || now;
  const elapsedSeconds = Math.max(0.001, (now - started) / 1000);
  const transferredBytes = Math.min(progress.totalBytes, Number(progress.transferredBytes || 0) + Number(bytesDelta || 0));
  const chunksDone = Math.min(progress.totalChunks, Number(progress.chunksDone || 0) + Number(chunkDelta || 0));
  const speedBytesPerSecond = transferredBytes / elapsedSeconds;
  const remainingBytes = Math.max(0, progress.totalBytes - transferredBytes);
  transferProgress[kind] = {
    ...progress,
    phase,
    transferredBytes,
    percent: progress.totalBytes ? (transferredBytes / progress.totalBytes) * 100 : 100,
    speedBytesPerSecond,
    etaSeconds: speedBytesPerSecond > 0 && remainingBytes > 0 ? remainingBytes / speedBytesPerSecond : 0,
    chunksDone,
    updatedAt: new Date(now).toISOString(),
    error,
  };
}

function finishProgress(kind, phase = 'complete', error = null) {
  const progress = transferProgress[kind];
  if (!progress) return;
  updateProgress(kind, { bytesDelta: 0, chunkDelta: 0, phase, error });
  transferProgress[kind] = { ...transferProgress[kind], active: false, phase, error };
}

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

function isValidStorageIdentity(identity = '') {
  const value = normalizeWallet(identity);
  return isValidWallet(value) || value.startsWith('seed:');
}

function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {
  const identity = normalizeWallet(ownerWallet);

  if (!isValidStorageIdentity(identity)) {
    throw new Error('Valid wallet or seed identity required for private file encryption.');
  }

  const password = validateDrivePassword(drivePassword);
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64');

  return crypto.pbkdf2Sync(`${identity}:${password}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');
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
function loadManifests() { ensureDataDir(); try { const parsed = JSON.parse(fs.readFileSync(manifestsPath, 'utf8')); manifests = Array.isArray(parsed) ? parsed.filter(isUsableManifest) : []; persistManifests(); } catch { manifests = []; } }
function persistManifests() { ensureDataDir(); fs.writeFileSync(manifestsPath, JSON.stringify(manifests.filter(isUsableManifest), null, 2), 'utf8'); }
function walletOwnsManifest(manifest) { return normalizeWallet(manifest.ownerWallet) === activeWallet(); }
function walletManifests() { return walletState.connected ? manifests.filter(walletOwnsManifest).filter(isUsableManifest) : []; }
function totalStoredBytesForWallet() { return walletManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }
function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet() || walletState.address, plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }
function assertWalletUploadAllowed(nextBytes = 0) { assertVerifiedWallet(); const plan = PLANS[walletState.planId] || PLANS.free; if (totalStoredBytesForWallet() + nextBytes > plan.quotaBytes) throw new Error(`Storage quota exceeded. Current plan: ${plan.name}.`); }
function findManifest(payload = {}) { const hash = String(payload.hash || ''); const rootHash = String(payload.rootHash || ''); return walletManifests().find((m) => m.hash === hash || m.rootHash === rootHash); }

async function syncPull() {
  const identity = activeWallet();

  if (!isManifestSyncEnabled() || !walletState.connected || !identity) {
    return { ok: false, skipped: true };
  }

  try {
    const remote = await pullWalletManifests(identity);

    if (!Array.isArray(remote)) return { ok: false, skipped: true };

    const map = new Map(
      manifests
        .filter(isUsableManifest)
        .map((m) => [`${normalizeWallet(m.ownerWallet)}:${m.hash}`, m])
    );

    for (const m of remote.filter(isUsableManifest)) {
      const key = `${normalizeWallet(m.ownerWallet)}:${m.hash}`;
      const local = map.get(key);

      map.set(key, {
        ...(local || {}),
        ...m,
        ownerWallet: normalizeWallet(m.ownerWallet),
        encryption: m.encryption || local?.encryption || null,
      });
    }

    manifests = Array.from(map.values()).filter(isUsableManifest);
    persistManifests();

    lastSyncStatus = {
      ...lastSyncStatus,
      ok: true,
      lastPulledAt: new Date().toISOString(),
      error: null,
      remoteFiles: remote.length,
    };

    return { ok: true, remoteFiles: remote.length };
  } catch (e) {
    lastSyncStatus = {
      ...lastSyncStatus,
      ok: false,
      error: e?.message || String(e),
    };

    console.warn('[manifest-sync] pull failed:', e?.message || e);
    throw new Error(`Manifest sync pull failed: ${e?.message || e}`);
  }
}
async function syncPush(manifest) {
  if (!isManifestSyncEnabled()) return { ok: false, skipped: true };
  try {
    const result = await pushWalletManifest(manifest);
    lastSyncStatus = { ...lastSyncStatus, ok: true, lastPushedAt: new Date().toISOString(), error: null };
    return result || { ok: true };
  } catch (e) {
    lastSyncStatus = { ...lastSyncStatus, ok: false, error: e?.message || String(e) };
    console.warn('[manifest-sync] push failed:', e?.message || e);
    throw new Error(`File was saved locally, but cross-device sync failed: ${e?.message || e}`);
  }
}
async function syncDelete(ownerWallet, hash) { try { if (isManifestSyncEnabled()) await deleteWalletManifest(ownerWallet, hash); } catch (e) { console.warn('[manifest-sync] delete failed:', e?.message || e); } }

function ensureTransport(options = {}) {
  if (!transportNode) {
    const port = Number(process.env.P2P_TRANSPORT_PORT || 8787);
    const publicUrl = process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${port}`;
    transportNode = startP2PTransport({ ...options, publicUrl, chunkStoreDir: chunkStoreDir() });
  }
  return transportNode;
}

async function runAutoRepair(reason = 'interval') {
  if (autoRepairRunning) {
    lastAutoRepairStatus = {
      ...lastAutoRepairStatus,
      active: true,
      skippedReason: 'already-running',
    };
    return lastAutoRepairStatus;
  }

  if (!walletState.connected || !walletState.verified || !activeWallet()) {
    lastAutoRepairStatus = {
      ...lastAutoRepairStatus,
      active: Boolean(autoRepairTimer),
      skippedReason: 'identity-not-verified',
      error: null,
    };
    return lastAutoRepairStatus;
  }

  const node = ensureTransport({});
  const own = walletManifests();
  const underReplicatedChunks = countUnderReplicatedChunks(node, own, TARGET_REPLICAS);

  if (underReplicatedChunks <= 0) {
    lastAutoRepairStatus = {
      ok: true,
      active: Boolean(autoRepairTimer),
      intervalMs: AUTO_REPAIR_INTERVAL_MS,
      lastRunAt: new Date().toISOString(),
      repairedChunks: 0,
      underReplicatedChunks: 0,
      skippedReason: 'healthy',
      error: null,
    };
    return lastAutoRepairStatus;
  }

  autoRepairRunning = true;

  try {
    console.log(`[auto-repair] ${reason}: repairing ${underReplicatedChunks} under-replicated chunk(s)`);

    const result = await repairManifests({
      node,
      manifests: own,
      configuredTargetReplicas: TARGET_REPLICAS,
      persistManifests,
      syncPush,
    });

    const repairedChunks = (result.report || []).filter((entry) => entry.repaired).length;

    lastAutoRepairStatus = {
      ok: true,
      active: Boolean(autoRepairTimer),
      intervalMs: AUTO_REPAIR_INTERVAL_MS,
      lastRunAt: new Date().toISOString(),
      repairedChunks,
      underReplicatedChunks,
      skippedReason: null,
      error: null,
    };

    return lastAutoRepairStatus;
  } catch (error) {
    lastAutoRepairStatus = {
      ok: false,
      active: Boolean(autoRepairTimer),
      intervalMs: AUTO_REPAIR_INTERVAL_MS,
      lastRunAt: new Date().toISOString(),
      repairedChunks: 0,
      underReplicatedChunks,
      skippedReason: null,
      error: error?.message || String(error),
    };

    console.warn('[auto-repair] failed:', error?.message || error);
    return lastAutoRepairStatus;
  } finally {
    autoRepairRunning = false;
  }
}

function startAutoRepairLoop() {
  if (autoRepairTimer) return;
  autoRepairTimer = setInterval(() => {
    runAutoRepair('interval').catch((error) => console.warn('[auto-repair] unhandled:', error?.message || error));
  }, AUTO_REPAIR_INTERVAL_MS);
  autoRepairTimer.unref?.();
  lastAutoRepairStatus = { ...lastAutoRepairStatus, active: true, intervalMs: AUTO_REPAIR_INTERVAL_MS, skippedReason: 'waiting' };
  runAutoRepair('startup').catch((error) => console.warn('[auto-repair] startup failed:', error?.message || error));
}

function stopAutoRepairLoop() {
  if (!autoRepairTimer) return;
  clearInterval(autoRepairTimer);
  autoRepairTimer = null;
  lastAutoRepairStatus = { ...lastAutoRepairStatus, active: false, skippedReason: 'stopped' };
}

function networkSummary() {
  const node = ensureTransport({});
  const own = walletManifests();
  const connectedPeers = node.connectedPeerIds?.() || [];
  return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, publicPeerUrl: publicPeerUrl(node), safetyPeerUrl: safetyPeerUrl(), connectedPeers: connectedPeers.length, peerCount: connectedPeers.length, peers: Array.from(node.peerInfo?.values?.() || []), targetReplicas: TARGET_REPLICAS, totalFiles: own.length, encryptedFiles: own.filter((f) => f.isEncrypted).length, publicFiles: own.filter((f) => !f.isEncrypted).length, totalBytes: own.reduce((s, f) => s + Number(f.size || 0), 0), totalChunks: own.reduce((s, f) => s + Number(f.chunks?.length || 0), 0), underReplicatedChunks: countUnderReplicatedChunks(node, own, TARGET_REPLICAS), transferProgress, transferSettings: { uploadConcurrency: UPLOAD_CONCURRENCY, downloadConcurrency: DOWNLOAD_CONCURRENCY }, autoRepair: lastAutoRepairStatus, wallet: walletSummary(), sync: lastSyncStatus };
}

function resolvePreloadPath() { const preloadPath = path.join(__dirname, 'preload.cjs'); if (!fs.existsSync(preloadPath)) throw new Error(`Missing Electron preload file: ${preloadPath}`); return preloadPath; }
function resolveRendererIndexPath() { const candidates = [path.join(app.getAppPath(), 'dist', 'public', 'index.html'), path.join(app.getAppPath(), 'public', 'index.html'), path.join(__dirname, '..', 'dist', 'public', 'index.html'), path.join(process.resourcesPath || '', 'app', 'dist', 'public', 'index.html')]; for (const c of candidates) if (c && fs.existsSync(c)) return c; throw new Error(`Renderer index.html not found. Tried: ${candidates.join(' | ')}`); }
function createMainWindow() { mainWindow = new BrowserWindow({ title: APP_TITLE, width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#09090b', show: false, webPreferences: { preload: resolvePreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: false } }); mainWindow.once('ready-to-show', () => mainWindow?.show()); mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); if (IS_DEV) mainWindow.loadURL(DEV_SERVER_URL); else mainWindow.loadFile(resolveRendererIndexPath()); mainWindow.on('closed', () => { mainWindow = null; }); }

ipcMain.handle('wallet:status', async () => {
  loadWallet();
  loadManifests();

  if (walletState.connected && walletState.verified) {
    try {
      await syncPull();
    } catch (error) {
      lastSyncStatus = {
        ...lastSyncStatus,
        ok: false,
        error: error?.message || String(error),
      };
    }
  }

  return walletSummary();
});

ipcMain.handle('wallet:connect', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();

  const address = normalizeWallet(payload.address);

  if (!isValidWallet(address)) {
    throw new Error('Invalid wallet address. Expected 0x + 40 hex characters.');
  }

  const login = await verifyWalletLoginPayload(payload, address);
  const sameWallet = address === activeWallet();

  walletState = {
    ...walletState,
    connected: true,
    verified: true,
    authMode: 'wallet',
    address,
    accountId: address,
    username: null,
    seedFingerprint: null,
    planId: sameWallet && PLANS[walletState.planId] ? walletState.planId : 'free',
    connectedAt: new Date().toISOString(),
    verifiedAt: login.signedAt,
    loginMessage: login.message,
    loginSignature: undefined,
    encryptionSecret: undefined,
    encryptionKeySource: ENCRYPTION_KEY_SOURCE,
  };

  persistWallet();

  try {
    await syncPull();
  } catch (error) {
    lastSyncStatus = {
      ...lastSyncStatus,
      ok: false,
      error: error?.message || String(error),
    };
  }

  startAutoRepairLoop();

  return walletSummary();
});

ipcMain.handle('wallet:disconnect', async () => {
  stopAutoRepairLoop();

  walletState = {
    ...walletState,
    connected: false,
    verified: false,
    authMode: null,
    address: '',
    accountId: '',
    username: null,
    seedFingerprint: null,
    planId: 'free',
    connectedAt: null,
    verifiedAt: null,
    paidUntil: null,
    subscriptionTx: null,
    loginMessage: null,
    loginSignature: undefined,
    encryptionSecret: undefined,
    encryptionKeySource: ENCRYPTION_KEY_SOURCE,
  };

  persistWallet();
  return walletSummary();
});
ipcMain.handle('wallet:setPlan', async (_event, payload = {}) => { assertVerifiedWallet(); const planId = String(payload.planId || 'free'); if (!PLANS[planId]) throw new Error('Unknown wallet plan'); walletState = { ...walletState, planId, paidUntil: payload.paidUntil || walletState.paidUntil || null, subscriptionTx: payload.txHash || walletState.subscriptionTx || null }; persistWallet(); return walletSummary(); });
ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } return networkSummary(); });
ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();

  if (!walletState.connected || !walletState.verified) return [];

  await syncPull();

  const query = String(payload.query || '').trim().toLowerCase();
  const own = walletManifests();

  if (!query) return own;

  return own.filter((f) =>
    [f.name, f.hash, f.rootHash, f.ownerWallet || '', f.folderName || '', f.folder || '']
      .some((v) => String(v || '').toLowerCase().includes(query))
  );
});

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
  const chunkResults = new Array(chunks.length);
  const uploadConcurrency = clampConcurrency(payload.uploadConcurrency, UPLOAD_CONCURRENCY, 12);
  createProgress('upload', { fileName: String(payload.name || 'file'), totalBytes: storedBuffer.length, totalChunks: chunks.length, concurrency: uploadConcurrency });

  try {
    await mapWithConcurrency(chunks, uploadConcurrency, async (chunk) => {
      const chunkPayload = { hash: chunk.hash, data: chunk.data.toString('base64'), index: chunk.index, size: chunk.size, ownerWallet, encrypted: privateFile };
      const replicas = replicateChunk(node, chunkPayload, [node.peerId], TARGET_REPLICAS);
      try {
        await putChunkToSafetyPeer(chunkPayload, node.peerId);
        replicas.push('aws-safety-peer');
      } catch (error) {
        throw new Error(`Safety peer upload failed for chunk ${chunk.hash}: ${error?.message || error}`);
      }
      chunkResults[chunk.index] = { index: chunk.index, hash: chunk.hash, size: chunk.size, replicas: unique(replicas), proof: getMerkleProof(tree, chunk.index) };
      updateProgress('upload', { bytesDelta: chunk.size, chunkDelta: 1 });
    });
  } catch (error) {
    finishProgress('upload', 'error', error?.message || String(error));
    throw error;
  }

  const manifest = { id: `${ownerWallet}:${storedHash}`, name: String(payload.name || 'file'), size: originalBuffer.length, storedSize: storedBuffer.length, hash: storedHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption: secured.encryption, mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream', chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: chunkResults };

  for (const chunkMeta of manifest.chunks) {
    for (const peerId of chunkMeta.replicas || []) fileReplicas.add(peerId);
  }

  manifest.replicas = unique(Array.from(fileReplicas));
  manifests = manifests.filter((m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
  manifests.push(manifest);
  persistManifests();
  persistWallet();
  await syncPush(manifest);
  await syncPull();
  finishProgress('upload');
  return { ok: true, file: manifest, summary: networkSummary(), sync: lastSyncStatus, progress: transferProgress.upload };
});

ipcMain.handle('p2p:download', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const node = ensureTransport({});
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this wallet');
  const orderedChunks = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index);
  const buffers = new Array(orderedChunks.length);
  const downloadConcurrency = clampConcurrency(payload.downloadConcurrency, DOWNLOAD_CONCURRENCY, 16);
  createProgress('download', { fileName: manifest.name, totalBytes: Number(manifest.storedSize || manifest.size || 0), totalChunks: orderedChunks.length, concurrency: downloadConcurrency });

  try {
    await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {
      const local = node.getLocalChunk?.(meta.hash) || node.localChunks?.get(meta.hash);
      let chunk = local;
      if (!chunk) {
        try {
          chunk = await node.fetchChunkFromNetwork(meta.hash);
        } catch (error) {
          console.warn('[p2p:download] network fetch failed, trying safety peer:', error?.message || error);
          chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId);
        }
      }
      node.storeLocalChunk?.(chunk);
      const buffer = Buffer.from(chunk.data, 'base64');
      if (hashBufferHex(buffer) !== meta.hash) throw new Error(`Chunk integrity failed: ${meta.hash}`);
      buffers[meta.index] = buffer;
      updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 });
    });
  } catch (error) {
    finishProgress('download', 'error', error?.message || String(error));
    throw error;
  }

  const storedBuffer = Buffer.concat(buffers);
  if (hashBufferHex(storedBuffer) !== manifest.hash) throw new Error('File integrity failed');
  const drivePassword = manifest.isEncrypted ? drivePasswordFromPayload(payload) : null;
  const outputBuffer = manifest.isEncrypted ? decryptPrivateBuffer(storedBuffer, manifest, drivePassword) : storedBuffer;
  finishProgress('download');
  return { ok: true, file: manifest, bytes: Array.from(outputBuffer), progress: transferProgress.download };
});
ipcMain.handle('p2p:delete', async (_event, payload = {}) => { assertVerifiedWallet(); await syncPull(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); manifests = manifests.filter((m) => !(walletOwnsManifest(m) && m.hash === manifest.hash)); persistManifests(); await syncDelete(activeWallet(), manifest.hash); return { ok: true, summary: networkSummary() }; });
for (const channel of [
  'p2p:uploadFiles',
  'p2p:downloadToPath',
  'p2p:moveItem',
  'p2p:renameItem',
  'p2p:deleteItem',
]) {
  try { ipcMain.removeHandler(channel); } catch {}
}

function safeOutputName(name = 'download') {
  return String(name || 'download').replace(/[\\/:*?"<>|]/g, '_');
}

function isFolderManifest(manifest = {}) {
  return (
    manifest.kind === 'folder' ||
    manifest.type === 'folder' ||
    manifest.isFolder === true ||
    manifest.name === '.p2p-folder' ||
    Boolean(manifest.folderId && !manifest.chunks?.length) ||
    Boolean(manifest.folderId && String(manifest.hash || '').startsWith('folder:'))
  );
}

function manifestItemId(manifest = {}) {
  return String(manifest.folderId || manifest.id || manifest.rootHash || manifest.hash || '');
}

function canTouchManifest(manifest = {}) {
  const owner = normalizeWallet(manifest.ownerWallet || manifest.owner || manifest.wallet || '');
  return !owner || owner === activeWallet();
}

function findAnyItem(payload = {}) {
  const ids = [
    payload.itemId,
    payload.folderId,
    payload.fileId,
    payload.id,
    payload.rootHash,
    payload.hash,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  if (!ids.length) return null;

  return manifests
    .filter(isUsableManifest)
    .filter(canTouchManifest)
    .find((manifest) => {
      const values = [
        manifest.id,
        manifest.fileId,
        manifest.folderId,
        manifest.hash,
        manifest.rootHash,
        manifest.name,
      ]
        .map((v) => String(v || '').trim())
        .filter(Boolean);

      return ids.some((id) => values.includes(id));
    }) || null;
}

function findFolderByAny(value = '') {
  const id = String(value || '').trim();
  if (!id) return null;

  return manifests
    .filter(isUsableManifest)
    .filter(canTouchManifest)
    .find((manifest) => {
      if (!isFolderManifest(manifest)) return false;

      return [
        manifest.folderId,
        manifest.id,
        manifest.hash,
        manifest.rootHash,
        manifest.name,
      ]
        .map((v) => String(v || '').trim())
        .includes(id);
    }) || null;
}

function folderDisplayName(folder) {
  return folder?.name || '';
}

function assertFolderMoveSafe(folderId, targetFolderId) {
  if (!folderId || !targetFolderId) return;
  if (folderId === targetFolderId) throw new Error('Cannot move folder into itself');

  const folders = manifests
  .filter(isUsableManifest)
  .filter(canTouchManifest)
  .filter(isFolderManifest);
  
  let cursor = targetFolderId;
  const seen = new Set();

  while (cursor) {
    if (cursor === folderId) throw new Error('Cannot move folder inside its child');
    if (seen.has(cursor)) throw new Error('Folder tree cycle detected');

    seen.add(cursor);
    const parent = folders.find((folder) => String(folder.folderId || '') === cursor);
    cursor = String(parent?.parentFolderId || '');
  }
}

function descendantFolderIds(rootFolderId) {
  const root = String(rootFolderId || '').trim();
  const removed = new Set([root]);

  const folders = manifests
    .filter(isUsableManifest)
    .filter(canTouchManifest)
    .filter(isFolderManifest);

  let changed = true;

  while (changed) {
    changed = false;

    for (const folder of folders) {
      const id = String(folder.folderId || '').trim();
      const parent = String(folder.parentFolderId || '').trim();

      if (id && parent && removed.has(parent) && !removed.has(id)) {
        removed.add(id);
        changed = true;
      }
    }
  }

  return removed;
}

ipcMain.handle('p2p:moveItem', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();
  await syncPull();

  const item = findAnyItem(payload);
  if (!item) throw new Error(`Item not found: ${payload.itemId || payload.hash || payload.rootHash || ''}`);

  const targetFolderId = String(payload.targetFolderId || payload.folderId || '');
  const targetFolder = targetFolderId ? findFolderByAny(targetFolderId) : null;

  if (targetFolderId && !targetFolder) throw new Error(`Target folder not found: ${targetFolderId}`);

  if (isFolderManifest(item)) {
    assertFolderMoveSafe(String(item.folderId || ''), targetFolderId);

    item.parentFolderId = targetFolder?.folderId || '';
    item.updatedAt = new Date().toISOString();

    persistManifests();
    await syncPush(item);
    await syncPull();

    return { ok: true, item };
  }

  item.folderId = targetFolder?.folderId || '';
  item.parentFolderId = targetFolder?.folderId || '';
  item.folderName = folderDisplayName(targetFolder);
  item.folder = folderDisplayName(targetFolder);
  item.updatedAt = new Date().toISOString();

  persistManifests();
  await syncPush(item);
  await syncPull();

  return { ok: true, item };
});

ipcMain.handle('p2p:renameItem', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();
  await syncPull();

  const item = findAnyItem(payload);
  if (!item) throw new Error(`Item not found: ${payload.itemId || payload.hash || payload.rootHash || ''}`);

  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Name is required');

  item.name = name;
  item.updatedAt = new Date().toISOString();

  persistManifests();
  await syncPush(item);
  await syncPull();

  return { ok: true, item };
});

function findOwnedManifestItemById(itemId = '') {
  const id = String(itemId || '').trim();

  if (!id) return null;

  return walletManifests().find((manifest) => {
    const values = [
      manifest.id,
      manifest.fileId,
      manifest.folderId,
      manifest.hash,
      manifest.rootHash,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    return values.includes(id);
  }) || null;
}

ipcMain.handle('p2p:deleteItem', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();
  await syncPull();

  const item = findAnyItem(payload);
  if (!item) throw new Error(`Item not found: ${payload.itemId || payload.hash || payload.rootHash || ''}`);

  if (isFolderManifest(item)) {
    const itemFolderId = String(item.folderId || manifestItemId(item) || '').trim();
    const removedFolderIds = descendantFolderIds(itemFolderId);
    const fileDisposition = String(payload.fileDisposition || 'move');
    const targetFolderId = String(payload.targetFolderId || '');
    const targetFolder = targetFolderId ? findFolderByAny(targetFolderId) : null;

    if (targetFolderId && !targetFolder) throw new Error(`Target folder not found: ${targetFolderId}`);

    const changedFiles = [];
    const deletedFiles = [];
    const ownedManifests = manifests
  .filter(isUsableManifest)
  .filter(canTouchManifest);

const removedFolders = ownedManifests.filter(
  (manifest) => isFolderManifest(manifest) && removedFolderIds.has(String(manifest.folderId || ''))
);

for (const manifest of ownedManifests) {
      if (isFolderManifest(manifest)) continue;

      const currentFolderId = String(manifest.folderId || manifest.parentFolderId || '');

      if (removedFolderIds.has(currentFolderId)) {
        if (fileDisposition === 'delete') {
          deletedFiles.push(manifest);
        } else {
          manifest.folderId = targetFolder?.folderId || '';
          manifest.parentFolderId = targetFolder?.folderId || '';
          manifest.folderName = targetFolder?.name || '';
          manifest.folder = targetFolder?.name || '';
          manifest.updatedAt = new Date().toISOString();
          changedFiles.push(manifest);
        }
      }
    }

    manifests = manifests.filter((manifest) => {
  if (!canTouchManifest(manifest)) return true;

      if (isFolderManifest(manifest)) {
        return !removedFolderIds.has(String(manifest.folderId || ''));
      }

      return !deletedFiles.some((file) => file.hash === manifest.hash);
    });

    persistManifests();

    for (const file of changedFiles) await syncPush(file);
    for (const file of deletedFiles) await syncDelete(activeWallet(), file.hash);
    for (const folder of removedFolders) await syncDelete(activeWallet(), folder.hash || folder.rootHash);

    await syncPull();

    return { ok: true, removedFolders: removedFolders.length, changedFiles: changedFiles.length, deletedFiles: deletedFiles.length };
  }

  manifests = manifests.filter(
  (manifest) => !(canTouchManifest(manifest) && manifest.hash === item.hash)
);

  persistManifests();
  await syncDelete(activeWallet(), item.hash);
  await syncPull();

  return { ok: true };
});

ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();

  const picked = await dialog.showOpenDialog({
    title: 'Upload files',
    properties: ['openFile', 'multiSelections'],
  });

  if (picked.canceled || !picked.filePaths?.length) {
    return { ok: true, cancelled: true, files: [] };
  }

  const uploaded = [];

  for (const filePath of picked.filePaths) {
    const buffer = fs.readFileSync(filePath);
    const node = ensureTransport({});
    const originalBuffer = Buffer.from(buffer);

    assertWalletUploadAllowed(originalBuffer.length);

    const ownerWallet = activeWallet();
    const privateFile = Boolean(payload.isEncrypted);
    const drivePassword = privateFile ? drivePasswordFromPayload(payload) : null;
    const secured = privateFile
      ? encryptPrivateBuffer(originalBuffer, ownerWallet, drivePassword)
      : { ciphertext: originalBuffer, encryption: null };

    const storedBuffer = secured.ciphertext;
    const chunks = splitIntoChunks(storedBuffer);
    const tree = buildMerkleTree(chunks.map((c) => c.hash));
    const storedHash = hashBufferHex(storedBuffer);
    const fileReplicas = new Set([node.peerId]);
    const chunkResults = new Array(chunks.length);
    const uploadConcurrency = clampConcurrency(payload.uploadConcurrency, UPLOAD_CONCURRENCY, 12);

    createProgress('upload', {
      fileName: path.basename(filePath),
      totalBytes: storedBuffer.length,
      totalChunks: chunks.length,
      concurrency: uploadConcurrency,
    });

    try {
      await mapWithConcurrency(chunks, uploadConcurrency, async (chunk) => {
        const chunkPayload = {
          hash: chunk.hash,
          data: chunk.data.toString('base64'),
          index: chunk.index,
          size: chunk.size,
          ownerWallet,
          encrypted: privateFile,
        };

        const replicas = replicateChunk(node, chunkPayload, [node.peerId], TARGET_REPLICAS);

        try {
          await putChunkToSafetyPeer(chunkPayload, node.peerId);
          replicas.push('aws-safety-peer');
        } catch (error) {
          throw new Error(`Safety peer upload failed for chunk ${chunk.hash}: ${error?.message || error}`);
        }

        chunkResults[chunk.index] = {
          index: chunk.index,
          hash: chunk.hash,
          size: chunk.size,
          replicas: unique(replicas),
          proof: getMerkleProof(tree, chunk.index),
        };

        updateProgress('upload', { bytesDelta: chunk.size, chunkDelta: 1 });
      });
    } catch (error) {
      finishProgress('upload', 'error', error?.message || String(error));
      throw error;
    }

    const targetFolderId = String(payload.folderId || '');
    const targetFolder = targetFolderId ? findFolderByAny(targetFolderId) : null;

    if (targetFolderId && !targetFolder) throw new Error(`Target folder not found: ${targetFolderId}`);

    const manifest = {
      id: `${ownerWallet}:${storedHash}`,
      name: path.basename(filePath),
      size: originalBuffer.length,
      storedSize: storedBuffer.length,
      hash: storedHash,
      rootHash: tree.root,
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isEncrypted: privateFile,
      visibility: privateFile ? 'private' : 'public',
      isPublic: !privateFile,
      encryption: secured.encryption,
      mimeType: 'application/octet-stream',
      folderId: targetFolder?.folderId || '',
      parentFolderId: targetFolder?.folderId || '',
      folderName: targetFolder?.name || String(payload.folderPath || ''),
      folder: targetFolder?.name || String(payload.folderPath || ''),
      chunkSize: CHUNK_SIZE_BYTES,
      totalChunks: chunks.length,
      ownerNodeId: node.peerId,
      ownerWallet,
      planId: walletState.planId,
      replicas: [node.peerId],
      chunks: chunkResults,
    };

    for (const chunkMeta of manifest.chunks) {
      for (const peerId of chunkMeta.replicas || []) fileReplicas.add(peerId);
    }

    manifest.replicas = unique(Array.from(fileReplicas));

    manifests = manifests.filter(
      (m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash)
    );

    manifests.push(manifest);
    persistManifests();
    persistWallet();

    await syncPush(manifest);
    uploaded.push(manifest);

    finishProgress('upload');
  }

  await syncPull();

  return { ok: true, cancelled: false, files: uploaded, summary: networkSummary(), sync: lastSyncStatus };
});

ipcMain.handle('p2p:downloadToPath', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();
  await syncPull();

  const node = ensureTransport({});
  const manifest = findManifest(payload);

  if (!manifest) throw new Error('File not found for this wallet');

  const save = await dialog.showSaveDialog({
    title: 'Download file',
    defaultPath: path.join(app.getPath('downloads'), safeOutputName(manifest.name || 'download')),
  });

  if (save.canceled || !save.filePath) {
    return { ok: true, cancelled: true };
  }

  const orderedChunks = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index);
  const buffers = new Array(orderedChunks.length);
  const downloadConcurrency = clampConcurrency(payload.downloadConcurrency, DOWNLOAD_CONCURRENCY, 16);

  createProgress('download', {
    fileName: manifest.name,
    totalBytes: Number(manifest.storedSize || manifest.size || 0),
    totalChunks: orderedChunks.length,
    concurrency: downloadConcurrency,
  });

  try {
    await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {
      const local = node.getLocalChunk?.(meta.hash) || node.localChunks?.get(meta.hash);
      let chunk = local;

      if (!chunk) {
        try {
          chunk = await node.fetchChunkFromNetwork(meta.hash);
        } catch (error) {
          console.warn('[p2p:downloadToPath] network fetch failed, trying safety peer:', error?.message || error);
          chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId);
        }
      }

      node.storeLocalChunk?.(chunk);

      const buffer = Buffer.from(chunk.data, 'base64');

      if (hashBufferHex(buffer) !== meta.hash) {
        throw new Error(`Chunk integrity failed: ${meta.hash}`);
      }

      buffers[meta.index] = buffer;
      updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 });
    });
  } catch (error) {
    finishProgress('download', 'error', error?.message || String(error));
    throw error;
  }

  const storedBuffer = Buffer.concat(buffers);

  if (hashBufferHex(storedBuffer) !== manifest.hash) {
    throw new Error('File integrity failed');
  }

  const drivePassword = manifest.isEncrypted ? drivePasswordFromPayload(payload) : null;
  const outputBuffer = manifest.isEncrypted
    ? decryptPrivateBuffer(storedBuffer, manifest, drivePassword)
    : storedBuffer;

  fs.writeFileSync(save.filePath, outputBuffer);

  finishProgress('download');

  return { ok: true, cancelled: false, path: save.filePath, file: manifest, progress: transferProgress.download };
});

ipcMain.handle('p2p:networkSummary', async () => {
  loadWallet();
  loadManifests();

  if (walletState.connected && walletState.verified) {
    await syncPull();
    startAutoRepairLoop();
  }

  return networkSummary();
});


ipcMain.handle('p2p:bootstrapNow', async () => ({ ok: true, summary: networkSummary() }));
ipcMain.handle('p2p:connectPeer', async (_event, payload = {}) => { const peerId = String(payload.peerId || '').trim(); const url = String(payload.url || '').trim(); if (!peerId || !/^wss?:\/\//i.test(url)) throw new Error('peerId and ws:// URL are required'); const result = ensureTransport({}).connectPeer({ peerId, url }); return { ok: true, ...result, summary: networkSummary() }; });
ipcMain.handle('p2p:repair', async () => { assertVerifiedWallet(); const node = ensureTransport({}); const own = walletManifests(); const result = await repairManifests({ node, manifests: own, configuredTargetReplicas: TARGET_REPLICAS, persistManifests, syncPush }); return { ok: true, ...result, summary: networkSummary() }; });
ipcMain.handle('p2p:prepareProof', async (_event, payload = {}) => { assertVerifiedWallet(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const chunk = manifest.chunks?.[0]; if (!chunk) throw new Error('No chunks available for proof'); return { ok: true, proof: { ownerWallet: activeWallet(), rootHash: manifest.rootHash, chunkIndex: chunk.index, leaf: chunk.hash, merkleProof: chunk.proof, encrypted: Boolean(manifest.isEncrypted), keySource: manifest.encryption?.keySource || null, preparedAt: new Date().toISOString() } }; });

app.whenReady().then(async () => { app.setName(APP_TITLE); ensureDataDir(); loadWallet(); loadManifests(); ensureTransport({}); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } createMainWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); }); }).catch((error) => { console.error('Electron failed:', error); app.exit(1); });
app.on('before-quit', () => { stopAutoRepairLoop(); persistWallet(); persistManifests(); if (transportNode) transportNode.stop(); });
app.on('window-all-closed', () => {});
