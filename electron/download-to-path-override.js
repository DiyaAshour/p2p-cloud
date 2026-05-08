import { app, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getChunkFromSafetyPeer } from './safety-peer.js';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KDF_ITERATIONS = 310000;
const MIN_DRIVE_PASSWORD_LENGTH = Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12);

function normalizeWallet(address = '') {
  return String(address || '').trim().toLowerCase();
}

function safeName(name = '') {
  return String(name || 'download.bin').replace(/[\\/:*?"<>|]/g, '_');
}

function dataDir() {
  return path.join(app.getPath('userData'), 'native-p2p-storage');
}

function manifestsPath() {
  return path.join(dataDir(), 'manifests.json');
}

function walletPath() {
  return path.join(dataDir(), 'wallet.json');
}

function chunkStoreDir() {
  return process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks');
}

function chunkPath(chunkHash) {
  const safe = String(chunkHash || '').replace(/[^a-fA-F0-9]/g, '');
  return path.join(chunkStoreDir(), `${safe}.json`);
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function activeWallet() {
  const wallet = loadJson(walletPath(), {});
  return normalizeWallet(wallet.address);
}

function findManifest(payload = {}) {
  const wallet = activeWallet();
  const hash = String(payload.hash || '');
  const rootHash = String(payload.rootHash || '');
  const all = loadJson(manifestsPath(), []);
  return Array.isArray(all)
    ? all.find((m) => normalizeWallet(m.ownerWallet) === wallet && (m.hash === hash || m.rootHash === rootHash))
    : null;
}

function validateDrivePassword(drivePassword) {
  const password = String(drivePassword || '').trim();
  if (password.length < MIN_DRIVE_PASSWORD_LENGTH) {
    throw new Error(`Drive Password required. Use at least ${MIN_DRIVE_PASSWORD_LENGTH} characters.`);
  }
  return password;
}

function deriveDriveKey({ ownerWallet, drivePassword, salt }) {
  const wallet = normalizeWallet(ownerWallet);
  const password = validateDrivePassword(drivePassword);
  const saltBuffer = Buffer.from(String(salt || ''), 'base64');
  const iterations = Number(process.env.P2P_KDF_ITERATIONS || KDF_ITERATIONS);
  return crypto.pbkdf2Sync(`${wallet}:${password}`, saltBuffer, iterations, 32, 'sha256');
}

function readLocalChunkBuffer(hash) {
  const file = chunkPath(hash);
  if (!fs.existsSync(file)) return null;
  const chunk = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!chunk?.data) return null;
  return Buffer.from(chunk.data, 'base64');
}

async function readChunkBuffer(hash, peerId = 'desktop-client') {
  const local = readLocalChunkBuffer(hash);
  if (local) return local;
  const remote = await getChunkFromSafetyPeer(hash, peerId);
  if (!remote?.data) throw new Error(`Missing chunk: ${hash}`);
  return Buffer.from(remote.data, 'base64');
}

async function writeChunksToTemp(manifest, tempPath) {
  const ordered = [...(manifest.chunks || [])].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  if (!ordered.length) throw new Error('File manifest has no chunks');
  await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
  const out = fs.createWriteStream(tempPath);
  try {
    for (const meta of ordered) {
      const buffer = await readChunkBuffer(meta.hash, manifest.ownerNodeId || 'desktop-client');
      await new Promise((resolve, reject) => out.write(buffer, (error) => (error ? reject(error) : resolve())));
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    try { out.destroy(); } catch {}
    throw error;
  }
}

async function decryptTempToFile(tempPath, finalPath, manifest, drivePassword) {
  const enc = manifest.encryption || {};
  if (enc.algorithm !== ENCRYPTION_ALGORITHM || !enc.salt || !enc.iv || !enc.authTag) {
    throw new Error('Encrypted file metadata is missing or unsupported');
  }
  const key = deriveDriveKey({ ownerWallet: manifest.ownerWallet, drivePassword, salt: enc.salt });
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'));
  await pipeline(fs.createReadStream(tempPath), decipher, fs.createWriteStream(finalPath));
}

async function downloadManifestToPath(payload = {}) {
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this wallet');

  const save = await dialog.showSaveDialog({
    title: 'Save downloaded file',
    defaultPath: safeName(manifest.name || 'download.bin'),
  });
  if (save.canceled || !save.filePath) return { ok: true, cancelled: true };

  const tempPath = path.join(app.getPath('temp'), `chunknet-download-${crypto.randomUUID()}.bin`);
  try {
    await writeChunksToTemp(manifest, tempPath);
    if (manifest.isEncrypted) {
      await decryptTempToFile(tempPath, save.filePath, manifest, payload.drivePassword);
      try { fs.unlinkSync(tempPath); } catch {}
    } else {
      fs.renameSync(tempPath, save.filePath);
    }
    return { ok: true, file: manifest, path: save.filePath, bytes: [] };
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function installDownloadOverride() {
  for (const channel of ['p2p:download', 'p2p:downloadToPath']) {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, async (_event, payload = {}) => downloadManifestToPath(payload));
  }
  console.log('[download-to-path] installed safe streaming download handlers');
}

installDownloadOverride();
