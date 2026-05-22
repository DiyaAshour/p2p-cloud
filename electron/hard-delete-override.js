import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deleteWalletManifest } from './manifest-sync.js';
import { deleteChunkFromSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';

function dataDir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function walletPath() { return path.join(dataDir(), 'wallet.json'); }
function manifestsPath() { return path.join(dataDir(), 'manifests.json'); }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks'); }
function chunkPath(hash) { return path.join(chunkStoreDir(), `${String(hash || '').replace(/[^a-fA-F0-9]/g, '')}.json`); }
function normalize(value = '') { return String(value || '').trim().toLowerCase(); }
function readJson(file, fallback) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function wallet() { return readJson(walletPath(), {}); }
function identity(w = wallet()) { return normalize(w.accountId || w.address || ''); }
function manifests() { const v = readJson(manifestsPath(), []); return Array.isArray(v) ? v : []; }
function saveManifests(v) { writeJson(manifestsPath(), v); }
function node() { return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null; }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function isFolderManifest(item = {}) { return item.kind === 'folder' || item.type === 'folder' || item.isFolder === true || String(item.hash || '').startsWith('folder:'); }
function manifestIds(item = {}) { const hash = String(item.hash || '').trim(); const rootHash = String(item.rootHash || '').trim(); return unique([item.id, item.itemId, item.fileId, item.folderId, hash, rootHash, hash.replace(/^folder:/, ''), rootHash.replace(/^folder:/, ''), item.name].map((x) => String(x || '').trim()).filter(Boolean)); }
function payloadIds(payload = {}) { return unique([payload.itemId, payload.id, payload.fileId, payload.folderId, payload.hash, payload.rootHash, payload.name].map((x) => String(x || '').trim()).filter(Boolean)); }
function matchesAnyId(item = {}, ids = []) { const wanted = new Set(ids.flatMap((id) => [String(id || '').trim(), String(id || '').replace(/^folder:/, '').trim()]).filter(Boolean)); return manifestIds(item).some((id) => wanted.has(id) || wanted.has(String(id || '').replace(/^folder:/, '').trim())); }
function walletOwns(item = {}, owner = identity()) { const itemOwner = normalize(item.ownerWallet || item.owner || item.wallet || ''); return !itemOwner || itemOwner === owner; }
function findItem(payload = {}) { const owner = identity(); const ids = payloadIds(payload); return manifests().filter((m) => walletOwns(m, owner)).find((m) => matchesAnyId(m, ids)) || null; }
function chunkHashesOf(item = {}) { return unique((item.chunks || []).map((c) => String(c?.hash || '').trim().toLowerCase()).filter((h) => /^[a-f0-9]{64}$/.test(h))); }

function deleteLocalChunk(hash) {
  const n = node();
  try { n?.localChunks?.delete?.(hash); } catch {}
  try { n?.chunkReplicas?.delete?.(hash); } catch {}
  const file = chunkPath(hash);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}

async function deleteChunkFromConnectedPeers(hash, ownerWallet) {
  const n = node();
  const peers = n?.connectedPeerIds?.() || [];
  const sent = [];
  const failed = [];

  for (const peerId of peers) {
    const socket = n?.peerSockets?.get?.(peerId);
    if (!socket) continue;
    const ok = n.send?.(socket, {
      id: crypto.randomUUID(),
      type: 'chunk:delete',
      fromPeerId: n.peerId,
      toPeerId: peerId,
      createdAt: Date.now(),
      payload: { chunkHash: hash, ownerWallet, reason: 'owner-hard-delete' },
    });
    if (ok) sent.push(peerId);
    else failed.push({ peerId, error: 'send-failed' });
  }

  return { sent, failed };
}

async function hardDeleteFileManifest(item) {
  const ownerWallet = identity();
  const n = node();
  const hashes = chunkHashesOf(item);
  const report = { chunkHashes: hashes, localDeleted: [], safetyDeleted: [], peerDeleteSent: [], safetyErrors: [], peerErrors: [] };

  for (const hash of hashes) {
    try {
      deleteLocalChunk(hash);
      report.localDeleted.push(hash);
    } catch (error) {
      report.peerErrors.push({ hash, phase: 'local', error: error?.message || String(error) });
    }

    const shouldDeleteSafety = true;
    if (shouldDeleteSafety) {
      try {
        const result = await deleteChunkFromSafetyPeer(hash, n?.peerId || 'desktop-client');
        if (result?.ok) report.safetyDeleted.push(hash);
      } catch (error) {
        report.safetyErrors.push({ hash, error: error?.message || String(error) });
      }
    }

    try {
      const peerResult = await deleteChunkFromConnectedPeers(hash, ownerWallet);
      report.peerDeleteSent.push(...peerResult.sent.map((peerId) => ({ hash, peerId })));
      report.peerErrors.push(...peerResult.failed.map((entry) => ({ hash, ...entry })));
    } catch (error) {
      report.peerErrors.push({ hash, phase: 'peers', error: error?.message || String(error) });
    }
  }

  return report;
}

async function removeManifestSync(item) {
  const ownerWallet = identity();
  const hash = item.hash || item.rootHash || item.folderId;
  try {
    await deleteWalletManifest(ownerWallet, hash);
    return { ok: true };
  } catch (error) {
    console.warn('[hard-delete] manifest sync delete failed:', error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
}

async function hardDeleteItem(payload = {}) {
  const w = wallet();
  if (!w.connected || !w.verified || !identity(w)) throw new Error('Verified identity required.');

  const item = findItem(payload);
  if (!item) throw new Error(`Item not found. payload=${JSON.stringify(payload)}`);

  if (isFolderManifest(item)) {
    throw new Error('Hard delete override handles files only. Delete folders through folder delete flow.');
  }

  const deleteReport = await hardDeleteFileManifest(item);
  const removedIds = new Set(manifestIds(item));
  const before = manifests();
  const after = before.filter((candidate) => !matchesAnyId(candidate, Array.from(removedIds)));
  saveManifests(after);
  const sync = await removeManifestSync(item);

  console.log('[hard-delete] deleted file', {
    name: item.name,
    hash: item.hash,
    chunks: deleteReport.chunkHashes.length,
    safetyDeleted: deleteReport.safetyDeleted.length,
    peerDeleteSent: deleteReport.peerDeleteSent.length,
    removedManifests: before.length - after.length,
  });

  return {
    ok: true,
    hardDelete: true,
    deleted: before.length - after.length,
    deletedFiles: 1,
    movedFiles: 0,
    removedIds: Array.from(removedIds),
    sync,
    ...deleteReport,
  };
}

// p2p:delete = file hard delete only (chunks + safety peer + connected peers)
try { ipcMain.removeHandler('p2p:delete'); } catch {}
ipcMain.handle('p2p:delete', async (_event, payload = {}) => hardDeleteItem(payload));

// IMPORTANT: do NOT override p2p:deleteItem here.
// p2p:deleteItem is used exclusively by the folder delete flow in main.
// Routing folders into hardDeleteItem() breaks with:
// "Hard delete override handles files only."
console.log('[hard-delete] installed file hard delete override for p2p:delete only');
