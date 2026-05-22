import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deleteWalletManifest, pushWalletManifest } from './manifest-sync.js';
import { deleteChunkFromSafetyPeer } from './safety-peer.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function dataDir()        { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function walletPath()     { return path.join(dataDir(), 'wallet.json'); }
function manifestsPath()  { return path.join(dataDir(), 'manifests.json'); }
function chunkStoreDir()  { return process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks'); }
function chunkPath(hash)  { return path.join(chunkStoreDir(), `${String(hash || '').replace(/[^a-fA-F0-9]/g, '')}.json`); }
function normalize(v = '') { return String(v || '').trim().toLowerCase(); }
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function wallet()               { return readJson(walletPath(), {}); }
function identity(w = wallet()) { return normalize(w.accountId || w.address || ''); }
function manifests()            { const v = readJson(manifestsPath(), []); return Array.isArray(v) ? v : []; }
function saveManifests(v)       { writeJson(manifestsPath(), v); }
function node()                 { return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null; }
function unique(values = [])    { return Array.from(new Set(values.filter(Boolean))); }

function isFolderManifest(item = {}) {
  return (
    item.kind === 'folder' ||
    item.type === 'folder' ||
    item.isFolder === true ||
    String(item.hash || '').startsWith('folder:')
  );
}

function manifestIds(item = {}) {
  const hash     = String(item.hash     || '').trim();
  const rootHash = String(item.rootHash || '').trim();
  return unique(
    [item.id, item.itemId, item.fileId, item.folderId,
     hash, rootHash,
     hash.replace(/^folder:/, ''), rootHash.replace(/^folder:/, ''),
     item.name]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  );
}

function payloadIds(payload = {}) {
  return unique(
    [payload.itemId, payload.id, payload.fileId, payload.folderId,
     payload.hash, payload.rootHash, payload.name]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  );
}

function matchesAnyId(item = {}, ids = []) {
  const wanted = new Set(
    ids.flatMap((id) => [
      String(id || '').trim(),
      String(id || '').replace(/^folder:/, '').trim(),
    ]).filter(Boolean)
  );
  return manifestIds(item).some(
    (id) => wanted.has(id) || wanted.has(String(id || '').replace(/^folder:/, '').trim())
  );
}

function walletOwns(item = {}, owner = identity()) {
  const itemOwner = normalize(item.ownerWallet || item.owner || item.wallet || '');
  return !itemOwner || itemOwner === owner;
}

function isDeleteTombstone(item = {}) {
  return (
    item.type    === 'delete-tombstone-v1' ||
    item.kind    === 'delete-tombstone'    ||
    item.isTombstone === true              ||
    String(item.id || '').startsWith('tombstone:')
  );
}

function findItem(payload = {}) {
  const owner = identity();
  const ids   = payloadIds(payload);
  return manifests()
    .filter((m) => !isDeleteTombstone(m))   // never treat a tombstone as a live file
    .filter((m) => walletOwns(m, owner))
    .find((m)   => matchesAnyId(m, ids)) || null;
}

function chunkHashesOf(item = {}) {
  return unique(
    (item.chunks || [])
      .map((c) => String(c?.hash || '').trim().toLowerCase())
      .filter((h) => /^[a-f0-9]{64}$/.test(h))
  );
}

// ─── Low-level chunk deletion ────────────────────────────────────────────────

function deleteLocalChunk(hash) {
  const n = node();
  try { n?.localChunks?.delete?.(hash);   } catch {}
  try { n?.chunkReplicas?.delete?.(hash); } catch {}
  const file = chunkPath(hash);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}

async function deleteChunkFromConnectedPeers(hash, ownerWallet) {
  const n     = node();
  const peers = n?.connectedPeerIds?.() || [];
  const sent  = [];
  const failed = [];

  for (const peerId of peers) {
    const socket = n?.peerSockets?.get?.(peerId);
    if (!socket) continue;
    const ok = n.send?.(socket, {
      id:         crypto.randomUUID(),
      type:       'chunk:delete',
      fromPeerId: n.peerId,
      toPeerId:   peerId,
      createdAt:  Date.now(),
      payload:    { chunkHash: hash, ownerWallet, reason: 'owner-hard-delete' },
    });
    if (ok) sent.push(peerId);
    else    failed.push({ peerId, error: 'send-failed' });
  }

  return { sent, failed };
}

async function removeManifestSync(item) {
  const ownerWallet = identity();
  const hash        = item.hash || item.rootHash || item.folderId;
  try {
    await deleteWalletManifest(ownerWallet, hash);
    return { ok: true };
  } catch (error) {
    console.warn('[hard-delete] manifest sync delete failed:', error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
}

// ─── Main: Local-first hard delete + Tombstone propagation ──────────────────
//
// Flow:
//   1. Remove file manifest locally → UI refreshes immediately (no waiting)
//   2. Save tombstone locally       → prevents file from coming back via sync
//   3. Delete local chunks immediately
//   4. Background cleanup (setTimeout 0):
//        a. Delete chunks from AWS safety peer
//        b. Send chunk:delete to all connected peers
//        c. Remove remote manifest via manifest-sync
//
// Offline peers: when they come back online, syncPull / bootstrap / peer-hello
// will encounter the tombstone and must delete any matching chunks they hold.
// (Wire that logic in manifest-sync.js → syncPull once this file is stable.)

async function hardDeleteItem(payload = {}) {
  const w = wallet();
  if (!w.connected || !w.verified || !identity(w)) {
    throw new Error('Verified identity required.');
  }

  const item = findItem(payload);
  if (!item) throw new Error(`Item not found. payload=${JSON.stringify(payload)}`);

  if (isFolderManifest(item)) {
    throw new Error('Hard delete override handles files only. Delete folders through folder delete flow.');
  }

  const ownerWallet = identity();
  const n           = node();
  const hashes      = chunkHashesOf(item);
  const removedIds  = new Set(manifestIds(item));

  // ── Build tombstone ────────────────────────────────────────────────────────
  const tombstone = {
    type:                'delete-tombstone-v1',
    id:                  `tombstone:${item.hash || item.rootHash || crypto.randomUUID()}`,
    hash:                item.hash     || '',
    rootHash:            item.rootHash || item.hash || '',
    name:                item.name     || 'file',
    ownerWallet,
    deletedAt:           new Date().toISOString(),
    deletedByPeerId:     n?.peerId || 'desktop-client',
    reason:              'owner-hard-delete',
    chunkHashes:         hashes,
    originalManifestIds: Array.from(removedIds),
  };

  // ── Step 1: Remove file manifest → UI updates instantly ───────────────────
  const before             = manifests();
  const afterWithoutFile   = before.filter((candidate) => !matchesAnyId(candidate, Array.from(removedIds)));

  // ── Step 2: Replace any stale tombstone for same file, then add new one ───
  const withoutOldTombstone = afterWithoutFile.filter((candidate) => {
    if (candidate?.type !== 'delete-tombstone-v1') return true;
    return !(
      candidate.hash     === tombstone.hash     ||
      candidate.rootHash === tombstone.rootHash ||
      candidate.id       === tombstone.id
    );
  });

  const after = [...withoutOldTombstone, tombstone];
  saveManifests(after); // ← single write; UI can re-render immediately after this

  // ── Step 3: Delete local chunks (fast, synchronous) ───────────────────────
  const localDeleted = [];
  const localErrors  = [];

  for (const hash of hashes) {
    try {
      deleteLocalChunk(hash);
      localDeleted.push(hash);
    } catch (error) {
      localErrors.push({ hash, phase: 'local', error: error?.message || String(error) });
    }
  }

  // ── Step 4: Background cleanup — never blocks the user ────────────────────
  setTimeout(async () => {
    const report = {
      safetyDeleted:  [],
      safetyErrors:   [],
      peerDeleteSent: [],
      peerErrors:     [],
      syncDelete:     null,
      tombstoneSync:  null,
    };

    for (const hash of hashes) {
      // 4a. AWS safety peer
      try {
        const result = await deleteChunkFromSafetyPeer(hash, n?.peerId || 'desktop-client');
        if (result?.ok) report.safetyDeleted.push(hash);
      } catch (error) {
        report.safetyErrors.push({ hash, error: error?.message || String(error) });
      }

      // 4b. Connected peers
      try {
        const peerResult = await deleteChunkFromConnectedPeers(hash, ownerWallet);
        report.peerDeleteSent.push(...peerResult.sent.map((peerId) => ({ hash, peerId })));
        report.peerErrors.push(...peerResult.failed.map((entry)  => ({ hash, ...entry })));
      } catch (error) {
        report.peerErrors.push({ hash, phase: 'peers', error: error?.message || String(error) });
      }
    }

    // 4c. Remove old file manifest from remote sync
    try {
      report.syncDelete = await removeManifestSync(item);
    } catch (error) {
      report.syncDelete = { ok: false, error: error?.message || String(error) };
    }

    // 4d. Push tombstone online so offline devices receive delete command later
    try {
      report.tombstoneSync = await pushWalletManifest(tombstone);
    } catch (error) {
      report.tombstoneSync = { ok: false, error: error?.message || String(error) };
      console.warn('[hard-delete] tombstone sync failed:', error?.message || error);
    }

    console.log('[hard-delete] background cleanup finished', {
      name:           item.name,
      hash:           item.hash,
      chunks:         hashes.length,
      safetyDeleted:  report.safetyDeleted.length,
      safetyErrors:   report.safetyErrors.length,
      peerDeleteSent: report.peerDeleteSent.length,
      syncDelete:     report.syncDelete,
      tombstoneSync:  report.tombstoneSync,
    });
  }, 0);

  console.log('[hard-delete] local-first delete completed; tombstone created', {
    name:             item.name,
    hash:             item.hash,
    chunks:           hashes.length,
    localDeleted:     localDeleted.length,
    removedManifests: before.length - afterWithoutFile.length,
    tombstone:        tombstone.id,
  });

  return {
    ok:                      true,
    hardDelete:              true,
    deleteMode:              'local-first-tombstone-background-cleanup',
    deleted:                 before.length - afterWithoutFile.length,
    deletedFiles:            1,
    movedFiles:              0,
    removedIds:              Array.from(removedIds),
    tombstone,
    chunkHashes:             hashes,
    localDeleted,
    peerErrors:              localErrors,
    remoteCleanupScheduled:  true,
  };
}

// ─── IPC registration ────────────────────────────────────────────────────────
//
// p2p:delete     → file hard delete (this file)
// p2p:deleteItem → folder delete flow in main.js — DO NOT override here

try { ipcMain.removeHandler('p2p:delete'); } catch {}
ipcMain.handle('p2p:delete', async (_event, payload = {}) => hardDeleteItem(payload));

console.log('[hard-delete] installed file hard delete override for p2p:delete only');
