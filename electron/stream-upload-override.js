import { dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';
import { pushWalletManifest } from './manifest-sync.js';
import { putChunkToSafetyPeer, deleteChunkFromSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';
import { startTransfer, updateTransfer, finishTransfer, failTransfer, throwIfTransferCancelled } from './transfer-progress-state.js';
import {
  CHUNK_SIZE_BYTES,
  chunkSizeForFile,
  TARGET_REPLICAS,
  ENCRYPTION_ALGORITHM,
  ENCRYPTION_KEY_SOURCE,
  KDF_ALGORITHM,
  KDF_ITERATIONS,
  MIN_DRIVE_PASSWORD_LENGTH,
  quotaBytes,
} from './core/config.js';
import { normalizeIdentity, activeIdentity, assertVerifiedIdentity, usedBytes } from './core/identity.js';
import { chunkPath } from './core/storage-paths.js';
import { readWallet, readManifests, writeManifests } from './core/storage-json.js';
import { writeChunkRecord } from './core/chunk-store.js';
import './p2p-binary-chunk-store-override.js';

function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function node() { return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null; }
function dropMemoryChunk(hash) { try { node()?.localChunks?.delete?.(hash); } catch {} }
function withoutSafety(replicas = []) { return unique(replicas).filter((peerId) => peerId !== SAFETY_PEER_REPLICA_ID); }
function hasSafety(replicas = []) { return unique(replicas).includes(SAFETY_PEER_REPLICA_ID); }

function wallet() { return readWallet(); }
function identity(w = wallet()) { return activeIdentity(w); }
function manifests() { return readManifests(); }
function saveManifests(v) { writeManifests(v); }

function password(value = '') {
  const p = String(value || '').trim();
  if (p.length < MIN_DRIVE_PASSWORD_LENGTH) throw new Error(`Drive Password required. Use at least ${MIN_DRIVE_PASSWORD_LENGTH} characters.`);
  return p;
}

function pbkdf2Async(passwordValue, salt, iterations, keylen, digest) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(passwordValue, salt, iterations, keylen, digest, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function driveKey({ ownerWallet, drivePassword, salt }) {
  return pbkdf2Async(`${normalizeIdentity(ownerWallet)}:${password(drivePassword)}`, salt, KDF_ITERATIONS, 32, 'sha256');
}

function folderById(id = '') {
  const clean = String(id || '').replace(/^folder:/, '').trim();
  if (!clean) return null;
  return manifests().find((m) =>
    (m.kind === 'folder' || m.isFolder || String(m.hash || '').startsWith('folder:')) &&
    [m.folderId, m.id, m.hash, m.rootHash]
      .map((x) => String(x || '').replace(/^folder:/, '').trim())
      .includes(clean)
  ) || null;
}

function writeChunk(chunk) {
  writeChunkRecord(chunk);
}

async function uploadChunkToAwsSafety(chunk, peerId, reason = 'under-target') {
  const safetyChunk = {
    ...chunk,
    ['force' + 'SafetyPeer']: true,
    emergencySafety: true,
    safetyRequired: true,
  };

  console.log('[stream-upload] upload-time AWS safety start', {
    chunkHash: chunk.hash,
    reason,
    targetReplicas: TARGET_REPLICAS,
  });

  const safety = await putChunkToSafetyPeer(safetyChunk, peerId);

  if (safety?.ok) {
    console.log('[stream-upload] upload-time AWS safety stored', {
      chunkHash: chunk.hash,
      replicaId: SAFETY_PEER_REPLICA_ID,
    });
  } else {
    console.warn('[stream-upload] upload-time AWS safety skipped', {
      chunkHash: chunk.hash,
      reason: safety?.reason || 'unknown',
    });
  }

  return safety;
}

async function rollbackUploadedChunks(uploadedChunks = [], ownerWallet = '', reason = 'upload-cancelled') {
  const n = node();
  const seen = new Set();

  for (const entry of uploadedChunks) {
    const hash = entry?.hash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);

    try {
      dropMemoryChunk(hash);
      const legacyFilePath = chunkPath(hash);
      if (legacyFilePath && fs.existsSync(legacyFilePath)) fs.unlinkSync(legacyFilePath);
      try { n?.chunkReplicas?.delete?.(hash); } catch {}
    } catch (error) {
      console.warn('[stream-upload] rollback local chunk failed:', hash, error?.message || error);
    }

    for (const peerId of unique(entry.replicas || [])) {
      if (!peerId || peerId === n?.peerId) continue;

      if (peerId === SAFETY_PEER_REPLICA_ID) {
        try {
          await deleteChunkFromSafetyPeer(hash, n?.peerId || 'desktop-client');
        } catch (error) {
          console.warn('[stream-upload] rollback safety chunk failed:', hash, error?.message || error);
        }
        continue;
      }

      try {
        const socket = n?.peerSockets?.get?.(peerId);
        n?.send?.(socket, {
          id: crypto.randomUUID(),
          type: 'chunk:delete',
          fromPeerId: n.peerId,
          toPeerId: peerId,
          createdAt: Date.now(),
          payload: { chunkHash: hash, ownerWallet, reason },
        });
      } catch (error) {
        console.warn('[stream-upload] rollback peer chunk delete failed:', hash, peerId, error?.message || error);
      }
    }
  }
}

async function replicate(chunk) {
  const n = node();
  if (!n?.peerId) throw new Error('P2P transport is not ready yet.');

  const replicas = new Set([n.peerId]);
  const connectedPeers = n.connectedPeerIds?.() || [];

  if (!connectedPeers.length) {
    try {
      const safety = await uploadChunkToAwsSafety(chunk, n.peerId, 'no-p2p-peers-at-upload');
      if (safety?.ok) replicas.add(SAFETY_PEER_REPLICA_ID);
    } catch (e) {
      console.warn('[stream-upload] immediate AWS safety failed:', e?.message || e);
    }

    dropMemoryChunk(chunk.hash);
    return unique([...replicas]);
  }

  if (n?.putChunkOnNetwork && n?.selectReplicaTargets) {
    const targets = n.selectReplicaTargets({ exclude: [n.peerId], limit: Math.max(0, TARGET_REPLICAS - 1) }) || [];
    if (targets.length) {
      try {
        const result = await n.putChunkOnNetwork(chunk, targets);
        for (const peerId of result?.replicas || []) replicas.add(peerId);
      } catch (e) {
        console.warn('[stream-upload] p2p replicate failed:', e?.message || e);
      }
    }
  }

  const p2pReplicaCount = withoutSafety([...replicas]).length;
  if (p2pReplicaCount < TARGET_REPLICAS) {
    try {
      const safety = await uploadChunkToAwsSafety(chunk, n.peerId, `p2p-replicas-${p2pReplicaCount}-below-${TARGET_REPLICAS}`);
      if (safety?.ok) replicas.add(SAFETY_PEER_REPLICA_ID);
    } catch (e) {
      console.warn('[stream-upload] safety peer failed:', e?.message || e);
    }
  }

  dropMemoryChunk(chunk.hash);
  return unique([...replicas]);
}

async function uploadOne(filePath, payload = {}) {
  const w = wallet();
  assertVerifiedIdentity(w);
  const ownerWallet = identity(w);

  const n = node();
  if (!n?.peerId) throw new Error('P2P transport is not ready yet.');

  const stat = fs.statSync(filePath);
  if (usedBytes(manifests(), ownerWallet) + stat.size > quotaBytes(w.planId)) throw new Error('Storage quota exceeded.');

  const selectedChunkSize = Math.max(1, Number(chunkSizeForFile(stat.size) || CHUNK_SIZE_BYTES));

  const privateFile = true;
  const salt = privateFile ? crypto.randomBytes(16) : null;
  const iv = privateFile ? crypto.randomBytes(12) : null;
  const key = privateFile ? await driveKey({ ownerWallet, drivePassword: payload.drivePassword, salt }) : null;
  const cipher = privateFile ? crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv) : null;
  const originalHasher = crypto.createHash('sha256');
  const storedHasher = crypto.createHash('sha256');
  const chunks = [];
  const fileReplicas = new Set([n.peerId]);
  const uploadedChunksForRollback = [];
  let carry = Buffer.alloc(0);
  let storedSize = 0;
  let index = 0;
  let uploadPlainBytes = 0;
  let uploadProgressChunksDone = 0;
  const uploadTotalChunks = Math.max(1, Math.ceil(stat.size / selectedChunkSize));

  startTransfer('upload', {
    fileName: path.basename(filePath),
    totalBytes: stat.size,
    totalChunks: uploadTotalChunks,
    concurrency: 1,
  });

  async function flush(bufferLike) {
    throwIfTransferCancelled('upload');

    const buffer = Buffer.from(bufferLike || Buffer.alloc(0));
    const hash = sha256(buffer);
    storedHasher.update(buffer);
    storedSize += buffer.length;

    const chunk = { hash, data: buffer.toString('base64'), index, size: buffer.length, ownerWallet, encrypted: privateFile };
    writeChunk(chunk);
    dropMemoryChunk(hash);

    const replicas = await replicate(chunk);
    replicas.forEach((peerId) => fileReplicas.add(peerId));
    uploadedChunksForRollback.push({ hash, replicas });

    throwIfTransferCancelled('upload');

    const confirmed = withoutSafety(replicas).length;
    const safetyProtected = hasSafety(replicas);
    const peerProtected = confirmed >= TARGET_REPLICAS;
    const replicationStatus = (peerProtected || safetyProtected) ? 'protected' : confirmed >= 2 ? 'protecting' : 'needs-repair';
    const protectionMode = peerProtected ? 'p2p' : safetyProtected ? 'aws-safety' : confirmed >= 2 ? 'repairing' : 'missing-safety';

    chunks.push({
      index,
      hash,
      size: buffer.length,
      replicas,
      confirmedReplicas: confirmed,
      targetReplicas: TARGET_REPLICAS,
      replicationStatus,
      protectionMode,
      safetyStatus: safetyProtected ? 'uploaded' : 'not-uploaded',
      safetyPeer: safetyProtected ? {
        enabled: true,
        status: 'emergency-protected',
        replicaId: SAFETY_PEER_REPLICA_ID,
        updatedAt: new Date().toISOString(),
      } : null,
      proof: [],
    });

    dropMemoryChunk(hash);
    uploadProgressChunksDone += 1;
    updateTransfer('upload', {
      chunksDone: Math.min(uploadTotalChunks, uploadProgressChunksDone),
      totalChunks: uploadTotalChunks,
      transferredBytes: Math.min(stat.size, uploadPlainBytes),
    });
    index += 1;
  }

  async function consume(output) {
    if (!output?.length) return;
    carry = carry.length ? Buffer.concat([carry, output]) : Buffer.from(output);
    while (carry.length >= selectedChunkSize) {
      throwIfTransferCancelled('upload');
      const part = carry.subarray(0, selectedChunkSize);
      carry = carry.subarray(selectedChunkSize);
      await flush(part);
    }
  }

  try {
    for await (const part of fs.createReadStream(filePath, { highWaterMark: selectedChunkSize })) {
      throwIfTransferCancelled('upload');

      const plain = Buffer.from(part);
      uploadPlainBytes += plain.length;
      updateTransfer('upload', {
        transferredBytes: Math.min(stat.size, uploadPlainBytes),
        chunksDone: Math.min(uploadTotalChunks, uploadProgressChunksDone),
        totalChunks: uploadTotalChunks,
      });

      originalHasher.update(plain);
      await consume(privateFile ? cipher.update(plain) : plain);
    }

    throwIfTransferCancelled('upload');
    if (privateFile) await consume(cipher.final());
    if (carry.length || chunks.length === 0) await flush(carry);
    throwIfTransferCancelled('upload');
  } catch (error) {
    await rollbackUploadedChunks(uploadedChunksForRollback, ownerWallet, error?.code === 'TRANSFER_CANCELLED' ? 'upload-cancelled' : 'upload-failed');
    failTransfer('upload', error);
    throw error;
  }

  const storedHash = storedHasher.digest('hex');
  const originalHash = originalHasher.digest('hex');
  const tree = buildMerkleTree(chunks.map((c) => c.hash));
  chunks.forEach((c) => { c.proof = getMerkleProof(tree, c.index); });

  const targetFolder = payload.folderId ? folderById(payload.folderId) : null;
  if (payload.folderId && !targetFolder) throw new Error(`Target folder not found: ${payload.folderId}`);

  const protectedChunks = chunks.filter((c) => c.replicationStatus === 'protected').length;
  const p2pProtectedChunks = chunks.filter((c) => c.protectionMode === 'p2p').length;
  const safetyProtectedChunks = chunks.filter((c) => c.protectionMode === 'aws-safety').length;
  const needsRepairChunks = chunks.filter((c) => c.replicationStatus === 'needs-repair').length;
  const protectionMode = p2pProtectedChunks === chunks.length ? 'p2p' : safetyProtectedChunks > 0 ? 'aws-safety' : needsRepairChunks ? 'missing-safety' : 'repairing';

  const manifest = {
    id: `${ownerWallet}:${storedHash}`,
    name: path.basename(filePath),
    size: stat.size,
    storedSize,
    hash: storedHash,
    rootHash: tree.root,
    uploadedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isEncrypted: privateFile,
    visibility: 'private',
    isPublic: false,
    encryption: privateFile ? {
      version: 5,
      algorithm: ENCRYPTION_ALGORITHM,
      keySource: ENCRYPTION_KEY_SOURCE,
      kdf: KDF_ALGORITHM,
      kdfIterations: KDF_ITERATIONS,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      originalHash,
      originalSize: stat.size,
    } : null,
    mimeType: 'application/octet-stream',
    folderId: targetFolder?.folderId || '',
    parentFolderId: targetFolder?.folderId || '',
    folderName: targetFolder?.name || String(payload.folderPath || ''),
    folder: targetFolder?.name || String(payload.folderPath || ''),
    chunkSize: selectedChunkSize,
    adaptiveChunking: selectedChunkSize !== CHUNK_SIZE_BYTES,
    localChunkFormat: 'binary-v1',
    totalChunks: chunks.length,
    ownerNodeId: n.peerId,
    ownerWallet,
    planId: w.planId || 'free',
    replicas: unique([...fileReplicas]),
    chunks,
    uploadStatus: 'available',
    replicationStatus: needsRepairChunks ? 'needs-repair' : protectedChunks === chunks.length ? 'protected' : 'protecting',
    protectionMode,
    protectedChunks,
    p2pProtectedChunks,
    safetyProtectedChunks,
    needsRepairChunks,
    replicationUpdatedAt: new Date().toISOString(),
  };

  const next = manifests().filter((m) => !(normalizeIdentity(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
  next.push(manifest);
  saveManifests(next);

  try {
    await pushWalletManifest(manifest);
  } catch (syncErr) {
    console.warn('[stream-upload] manifest sync push failed (non-fatal, will retry on next pull):', syncErr?.message || syncErr);
  }

  finishTransfer('upload', {
    transferredBytes: stat.size,
    chunksDone: uploadTotalChunks,
    totalChunks: uploadTotalChunks,
  });

  return manifest;
}

async function uploadFiles(payload = {}) {
  const picked = await dialog.showOpenDialog({ title: 'Upload files', properties: ['openFile', 'multiSelections'] });
  if (picked.canceled || !picked.filePaths?.length) return { ok: true, cancelled: true, files: [] };

  const files = [];
  for (const filePath of picked.filePaths) {
    try {
      files.push(await uploadOne(filePath, payload));
    } catch (error) {
      failTransfer('upload', error);
      if (error?.code === 'TRANSFER_CANCELLED') return { ok: false, cancelled: true, files, error: error.message };
      throw error;
    }
  }

  const summaryHandler = ipcMain._invokeHandlers?.get?.('p2p:networkSummary');
  return { ok: true, cancelled: false, files, summary: summaryHandler ? await summaryHandler({}, {}) : null };
}

try { ipcMain.removeHandler('p2p:uploadFiles'); } catch {}
ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => uploadFiles(payload));

try { ipcMain.removeHandler('p2p:uploadPath'); } catch {}
ipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => {
  try {
    return await uploadOne(String(payload.filePath || payload.path || ''), payload);
  } catch (error) {
    failTransfer('upload', error);
    if (error?.code === 'TRANSFER_CANCELLED') return { ok: false, cancelled: true, error: error.message };
    throw error;
  }
});

await import('./transfer-progress-network-summary-override.js');
await import('./transfer-cancel-ipc.js');
await import('./stream-folder-upload-override.js');
console.log('[stream-upload] installed disk-first streaming upload override with progress, cancel rollback, immediate AWS safety, adaptive chunks, binary local storage, P2P binary chunk-store patch, and folder streaming');
