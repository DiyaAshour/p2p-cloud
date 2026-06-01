import { app } from 'electron';
import path from 'node:path';

function safeChunkHash(chunkHash) {
  return String(chunkHash || '').replace(/[^a-fA-F0-9]/g, '');
}

export function dataDir() {
  return path.join(app.getPath('userData'), 'native-p2p-storage');
}

/** Backwards-compatible alias used by runtime health checks and older modules. */
export function storageRoot() {
  return dataDir();
}

export function manifestsPath() {
  return path.join(dataDir(), 'manifests.json');
}

export function walletPath() {
  return path.join(dataDir(), 'wallet.json');
}

export function chunkStoreDir() {
  return process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks');
}

// Legacy JSON/base64 chunk path. Keep for backwards compatibility.
export function chunkPath(chunkHash) {
  const safe = safeChunkHash(chunkHash);
  return path.join(chunkStoreDir(), `${safe}.json`);
}

// Production binary chunk path. Sharded by first 4 hash chars to avoid huge folders.
export function chunkBinaryPath(chunkHash) {
  const safe = safeChunkHash(chunkHash);
  const a = safe.slice(0, 2) || '00';
  const b = safe.slice(2, 4) || '00';
  return path.join(chunkStoreDir(), 'objects', a, b, `${safe}.chunk`);
}

export function chunkMetaPath(chunkHash) {
  const safe = safeChunkHash(chunkHash);
  const a = safe.slice(0, 2) || '00';
  const b = safe.slice(2, 4) || '00';
  return path.join(chunkStoreDir(), 'objects', a, b, `${safe}.meta.json`);
}
