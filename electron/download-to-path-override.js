import { app, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getChunkFromSafetyPeer } from './safety-peer.js';
import { ENCRYPTION_ALGORITHM, KDF_ITERATIONS, MIN_DRIVE_PASSWORD_LENGTH } from './core/config.js';
import { activeIdentity, normalizeIdentity } from './core/identity.js';
import { chunkPath, walletPath } from './core/storage-paths.js';
import { readJson, readManifests } from './core/storage-json.js';
import './hard-delete-override.js';

function safeName(name = '') {
  return String(name || 'download.bin').replace(/[\\/:*?"<>|]/g, '_');
}

function currentIdentity() {
  return activeIdentity(readJson(walletPath(), {}));
}

function p2pNode() {
  return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null;
}

function dropMemoryChunk(hash) {
  try { p2pNode()?.localChunks?.delete?.(hash); } catch {}
}

function findManifest(payload = {}) {
  const identity = currentIdentity();
  const hash = String(payload.hash || '');
  const rootHash = String(payload.rootHash || '');
  return readManifests().find((manifest) =>
    normalizeIdentity(manifest.ownerWallet) === identity &&
    (manifest.hash === hash || manifest.rootHash === rootHash)
  ) || null;
}

function validateDrivePassword(drivePassword) {
  const password = String(drivePassword || '').trim();
  if (password.length < MIN_DRIVE_PASSWORD_LENGTH) {
    throw new Error(`Drive Password required. Use at least ${MIN_DRIVE_PASSWORD_LENGTH} characters.`);
  }
  return password;
}

function deriveDriveKey({ ownerWallet, drivePassword, salt }) {
  const identity = normalizeIdentity(ownerWallet);
  const password = validateDrivePassword(drivePassword);
  const saltBuffer = Buffer.from(String(salt || ''), 'base64');
  return crypto.pbkdf2Sync(`${identity}:${password}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');
}

function readLocalChunkBuffer(hash) {
  const file = chunkPath(hash);
  if (!fs.existsSync(file)) return null;
  const chunk = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!chunk?.data) return null;
  return Buffer.from(chunk.data, 'base64');
}

async function readNetworkChunk(hash) {
  const node = p2pNode();
  if (!node?.fetchChunkFromNetwork) return null;
  const chunk = await node.fetchChunkFromNetwork(hash);
  try { node.storeLocalChunk?.(chunk); } catch {}
  dropMemoryChunk(hash);
  return chunk?.data ? Buffer.from(chunk.data, 'base64') : null;
}

async function readChunkBuffer(hash, peerId = 'desktop-client') {
  const local = readLocalChunkBuffer(hash);
  if (local) return local;

  try {
    const network = await readNetworkChunk(hash);
    if (network) return network;
  } catch (error) {
    console.warn('[download-to-path] network fetch failed, trying safety peer:', error?.message || error);
  }

  const remote = await getChunkFromSafetyPeer(hash, peerId);
  if (!remote?.data) throw new Error(`Missing chunk: ${hash}`);
  dropMemoryChunk(hash);
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
      dropMemoryChunk(meta.hash);
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
  if (!manifest) throw new Error('File not found for this identity');

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
  console.log('[download-to-path] installed disk-first streaming download handlers');
}

installDownloadOverride();
