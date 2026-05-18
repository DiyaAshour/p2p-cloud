import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import './seed-auth-cooldown-ipc.js';
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
function activeWallet() { return normalizeWallet(walletState.accountId || walletState.address); }
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

  if (!walletState.connected || !walletState.verified || !isValidWallet(walletState.address)) {
    throw new Error('Verified identity required. Connect wallet or sign in with Seed Account first.');
  }
}
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

async function encryptedTempFile(filePath, ownerWallet, drivePassword) {
  const salt = crypto.randomBytes(16);
  const key = deriveDriveKey({ ownerWallet, drivePassword, salt });
  const source = fs.createReadStream(filePath);
  const tempPath = path.join(app.getPath('temp'), `chunknet-encrypted-${crypto.randomUUID()}.bin`);
  const target = fs.createWriteStream(tempPath);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  await pipeline(source, cipher, target);
  const original = fs.readFileSync(filePath);
  return { tempPath, cleanup: true, encryption: { version: 4, algorithm: ENCRYPTION_ALGORITHM, keySource: ENCRYPTION_KEY_SOURCE, kdf: KDF_ALGORITHM, kdfIterations: KDF_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), originalHash: hashBufferHex(original), originalSize: original.length } };
}

function createProgress(kind, { fileName, totalBytes, totalChunks, concurrency }) { const now = Date.now(); transferProgress[kind] = { active: true, phase: 'running', fileName, totalBytes, transferredBytes: 0, percent: 0, speedBytesPerSecond: 0, etaSeconds: null, chunksDone: 0, totalChunks, concurrency, startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), error: null }; }
function updateProgress(kind, { bytesDelta = 0, chunkDelta = 0, phase = 'running', error = null } = {}) { const p = transferProgress[kind]; if (!p) return; const transferredBytes = Math.min(p.totalBytes, Number(p.transferredBytes || 0) + Number(bytesDelta || 0)); const chunksDone = Math.min(p.totalChunks, Number(p.chunksDone || 0) + Number(chunkDelta || 0)); transferProgress[kind] = { ...p, phase, transferredBytes, chunksDone, percent: p.totalBytes ? (transferredBytes / p.totalBytes) * 100 : 100, updatedAt: new Date().toISOString(), error }; }
function finishProgress(kind, phase = 'complete', error = null) { if (!transferProgress[kind]) return; transferProgress[kind] = { ...transferProgress[kind], active: false, phase, error, percent: phase === 'complete' ? 100 : transferProgress[kind].percent }; }

async function uploadFilePathStreaming(filePath, payload = {}) {
