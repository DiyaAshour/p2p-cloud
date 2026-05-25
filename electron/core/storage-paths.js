import { app } from 'electron';
import path from 'node:path';

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

export function chunkPath(chunkHash) {
  const safe = String(chunkHash || '').replace(/[^a-fA-F0-9]/g, '');
  return path.join(chunkStoreDir(), `${safe}.json`);
}
