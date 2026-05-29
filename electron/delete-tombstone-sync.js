/**
 * delete-tombstone-sync.js
 *
 * Applies delete tombstones received through manifest sync or peer messages.
 */

import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const PASSIVE_APPLY_MIN_INTERVAL_MS = Number(process.env.P2P_TOMBSTONE_PASSIVE_APPLY_MIN_INTERVAL_MS || 15000);
let lastPassiveApplyAt = 0;
let lastLoggedResultKey = '';

function dataDir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function manifestsPath() { return path.join(dataDir(), 'manifests.json'); }
function tombstonesPath() { return path.join(dataDir(), 'delete-tombstones.json'); }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks'); }
function chunkPath(hash) { return path.join(chunkStoreDir(), `${String(hash || '').replace(/[^a-fA-F0-9]/g, '')}.json`); }

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function manifests() { const v = readJson(manifestsPath(), []); return Array.isArray(v) ? v : []; }
function saveManifests(v) { writeJson(manifestsPath(), v); }
function tombstones() { const v = readJson(tombstonesPath(), []); return Array.isArray(v) ? v : []; }
function saveTombstones(v) { writeJson(tombstonesPath(), v); }
function node() { return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null; }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function cleanId(value = '') { return String(value || '').replace(/^folder:/, '').trim(); }

function isDeleteTombstone(item = {}) {
  return item.type === 'delete-tombstone-v1' || item.kind === 'delete-tombstone' || item.isTombstone === true || String(item.id || '').startsWith('tombstone:');
}
function isFolderManifest(item = {}) {
  return item.kind === 'folder' || item.type === 'folder' || item.isFolder === true || String(item.hash || '').startsWith('folder:') || String(item.rootHash || '').startsWith('folder:');
}
function isUiPrefs(item = {}) {
  return String(item.hash || '').startsWith('ui:prefs:') || String(item.rootHash || '').startsWith('ui:prefs:') || String(item.type || '') === 'ui-prefs';
}
function idsOf(item = {}) {
  const hash = String(item.hash || '').trim();
  const rootHash = String(item.rootHash || '').trim();
  return unique([item.id, item.itemId, item.fileId, item.folderId, hash, rootHash, cleanId(hash), cleanId(rootHash), ...(Array.isArray(item.originalManifestIds) ? item.originalManifestIds : [])].map((x) => String(x || '').trim()).filter(Boolean));
}
function chunkHashesOfTombstone(t = {}) {
  return unique([...(Array.isArray(t.chunkHashes) ? t.chunkHashes : []), ...(Array.isArray(t.chunks) ? t.chunks.map((c) => c?.hash) : [])]
    .map((x) => String(x || '').trim().toLowerCase())
    .filter((x) => /^[a-f0-9]{64}$/.test(x)));
}
function matchesTombstone(item = {}, tombstone = {}) {
  const tombstoneIds = new Set(idsOf(tombstone).map(cleanId));
  return idsOf(item).some((id) => tombstoneIds.has(cleanId(id)));
}
function deleteLocalChunk(hash) {
  try {
    const n = node();
    n?.localChunks?.delete?.(hash);
    n?.chunkReplicas?.delete?.(hash);
  } catch {}
  const file = chunkPath(hash);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); return true; } catch {}
  }
  return false;
}
function mergeTombstones(incoming = []) {
  const current = tombstones();
  const next = [...current];
  let added = 0;
  for (const tombstone of incoming.filter(isDeleteTombstone)) {
    const incomingIds = new Set(idsOf(tombstone).map(cleanId));
    const exists = next.some((t) => idsOf(t).some((id) => incomingIds.has(cleanId(id))));
    if (!exists) { next.push(tombstone); added += 1; }
  }
  if (added) saveTombstones(next);
  return next;
}

function resultKey(result = {}) {
  return [result.tombstones, result.applied, result.removedManifests, result.chunksDeleted].join(':');
}

function logApplyResult(result, { forceLog = false } = {}) {
  const changed = Boolean(result.applied || result.removedManifests || result.chunksDeleted);
  if (!changed) return;

  const key = resultKey(result);
  if (!forceLog && key === lastLoggedResultKey) return;

  lastLoggedResultKey = key;
  console.log('[tombstone-sync] applied', result);
}

export function applyIncomingTombstones(remoteManifests = [], options = {}) {
  const incoming = (Array.isArray(remoteManifests) ? remoteManifests : []).filter(isDeleteTombstone);
  const allTombstones = mergeTombstones([...manifests().filter(isDeleteTombstone), ...incoming]);
  const before = manifests();
  let deletedChunks = 0;

  for (const tombstone of allTombstones) {
    for (const hash of chunkHashesOfTombstone(tombstone)) {
      if (deleteLocalChunk(hash)) deletedChunks += 1;
    }
  }

  const after = before.filter((item) => {
    if (isDeleteTombstone(item)) return false;
    if (isUiPrefs(item)) return false;
    if (isFolderManifest(item)) return true;
    return !allTombstones.some((t) => matchesTombstone(item, t));
  });

  if (after.length !== before.length) saveManifests(after);

  const result = { ok: true, tombstones: allTombstones.length, applied: incoming.length, removedManifests: before.length - after.length, chunksDeleted: deletedChunks };
  logApplyResult(result, options);
  return result;
}

function applyIncomingTombstonesPassive() {
  const nowMs = Date.now();
  if (nowMs - lastPassiveApplyAt < PASSIVE_APPLY_MIN_INTERVAL_MS) {
    return { ok: true, skipped: true, reason: 'throttled' };
  }

  lastPassiveApplyAt = nowMs;
  return applyIncomingTombstones([], { forceLog: false });
}

export function broadcastLocalTombstonesToPeer(peerId) {
  const n = node();
  const socket = n?.peerSockets?.get?.(peerId);
  if (!socket || !n?.send) return { sent: 0 };
  let sent = 0;
  for (const tombstone of tombstones()) {
    try {
      const ok = n.send(socket, { type: 'tombstone:apply', fromPeerId: n.peerId, toPeerId: peerId, createdAt: Date.now(), payload: tombstone });
      if (ok) sent += 1;
    } catch (error) {
      console.warn('[tombstone-sync] failed to send tombstone', { peerId, error: error?.message || String(error) });
    }
  }
  return { sent };
}

export function handleIncomingTombstoneMessage(message = {}) {
  const tombstone = message?.payload;
  if (!isDeleteTombstone(tombstone)) return { ok: false, skipped: true };
  return applyIncomingTombstones([tombstone], { forceLog: true });
}

function installListFilesFilter() {
  const oldHandler = ipcMain._invokeHandlers?.get?.('p2p:listFiles');
  if (!oldHandler) return false;
  try { ipcMain.removeHandler('p2p:listFiles'); } catch {}
  ipcMain.handle('p2p:listFiles', async (event, payload = {}) => {
    applyIncomingTombstonesPassive();
    const result = await oldHandler(event, payload);
    const list = Array.isArray(result) ? result : [];
    return list.filter((item) => !isDeleteTombstone(item) && !isUiPrefs(item) && item?.hash && item?.totalChunks > 0);
  });
  console.log('[tombstone-sync] p2p:listFiles filter installed');
  return true;
}

try { ipcMain.removeHandler('p2p:applyDeleteTombstones'); } catch {}
ipcMain.handle('p2p:applyDeleteTombstones', async (_event, remoteManifests = []) => applyIncomingTombstones(Array.isArray(remoteManifests) ? remoteManifests : [], { forceLog: true }));
try { ipcMain.removeHandler('p2p:listTombstones'); } catch {}
ipcMain.handle('p2p:listTombstones', () => tombstones());

let installed = false;
function install() {
  applyIncomingTombstonesPassive();
  if (!installed) installed = installListFilesFilter();
}
install();
setTimeout(install, 1000);
setTimeout(install, 3000);
setInterval(() => {
  try { applyIncomingTombstonesPassive(); }
  catch (error) { console.warn('[tombstone-sync] periodic apply failed:', error?.message || error); }
}, Number(process.env.P2P_TOMBSTONE_APPLY_INTERVAL_MS || 60000));

console.log('[tombstone-sync] delete tombstone sync installed');
