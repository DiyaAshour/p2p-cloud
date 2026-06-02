import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { readChunkRecord } from './core/chunk-store.js';
import { filterCapacityPeers } from './peer-capacity.js';

const TARGET_REPLICAS = Math.max(1, Number(process.env.P2P_TARGET_REPLICAS || 3));
const MAX_QUEUE_ITEMS = Math.max(1000, Number(process.env.P2P_REPAIR_QUEUE_MAX_ITEMS || 100000));
const MAX_ITEMS_PER_RUN = Math.max(1, Number(process.env.P2P_REPAIR_QUEUE_MAX_ITEMS_PER_RUN || 32));
const RUN_INTERVAL_MS = Math.max(60_000, Number(process.env.P2P_REPAIR_QUEUE_INTERVAL_MS || 2 * 60 * 1000));
const START_DELAY_MS = Math.max(10_000, Number(process.env.P2P_REPAIR_QUEUE_START_DELAY_MS || 60_000));
const ACK_TIMEOUT_MS = Math.max(2000, Number(process.env.P2P_CHUNK_STORE_ACK_TIMEOUT_MS || 7000));
const HEALTH_TIMEOUT_MS = Math.max(1000, Number(process.env.P2P_PEER_HEALTH_QUERY_TIMEOUT_MS || 2500));
const MAX_MESSAGE_BYTES = Math.max(1024 * 1024, Number(process.env.P2P_MAX_MESSAGE_BYTES || 8 * 1024 * 1024));
const BACKOFF_BASE_MS = Math.max(10_000, Number(process.env.P2P_REPAIR_QUEUE_BACKOFF_BASE_MS || 30_000));
const BACKOFF_MAX_MS = Math.max(BACKOFF_BASE_MS, Number(process.env.P2P_REPAIR_QUEUE_BACKOFF_MAX_MS || 30 * 60 * 1000));

let timer = null;
let active = false;
let lastStatus = { active: false, lastRunAt: null, queued: 0, processed: 0, repaired: 0, failed: 0, error: null };

function dataDir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function manifestsPath() { return path.join(dataDir(), 'manifests.json'); }
function queuePath() { return path.join(dataDir(), 'repair-queue.json'); }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function nowIso() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }
function readJson(filePath, fallback) { try { if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; } }
function writeJson(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); }
function readManifests() { const parsed = readJson(manifestsPath(), []); return Array.isArray(parsed) ? parsed : []; }
function writeManifests(value) { writeJson(manifestsPath(), Array.isArray(value) ? value : []); }
function readQueue() { const parsed = readJson(queuePath(), null); if (!parsed || typeof parsed !== 'object') return { version: 1, updatedAt: nowIso(), items: [] }; return { version: 1, updatedAt: parsed.updatedAt || nowIso(), items: Array.isArray(parsed.items) ? parsed.items : [] }; }
function writeQueue(queue) { const items = Array.isArray(queue.items) ? queue.items.slice(0, MAX_QUEUE_ITEMS) : []; writeJson(queuePath(), { version: 1, updatedAt: nowIso(), items }); return { version: 1, updatedAt: nowIso(), items }; }
function confirmedCount(chunk = {}) { return unique(chunk.replicas || []).filter((id) => id !== 'aws-safety-peer').length; }
function chunkNeedsRepair(chunk = {}) { return confirmedCount(chunk) < TARGET_REPLICAS; }
function itemKey(fileHash, chunkHash) { return `${fileHash}:${chunkHash}`; }
function queueStats(queue = readQueue()) { const now = nowMs(); const items = Array.isArray(queue.items) ? queue.items : []; return { queued: items.length, due: items.filter((i) => Number(i.nextAttemptAt || 0) <= now).length, targetReplicas: TARGET_REPLICAS, queuePath: queuePath(), lastStatus }; }

function rebuildQueueFromManifests(reason = 'rebuild') {
  const queue = readQueue();
  const byKey = new Map((queue.items || []).map((item) => [item.key, item]));
  let added = 0;
  let kept = 0;
  for (const manifest of readManifests()) {
    if (!manifest?.hash || !Array.isArray(manifest.chunks)) continue;
    for (const chunk of manifest.chunks) {
      if (!chunk?.hash || !chunkNeedsRepair(chunk)) continue;
      const key = itemKey(manifest.hash, chunk.hash);
      const current = byKey.get(key);
      if (current) { kept += 1; continue; }
      byKey.set(key, { key, fileHash: manifest.hash, chunkHash: chunk.hash, chunkIndex: Number(chunk.index || 0), priority: 100 - confirmedCount(chunk), attempts: 0, nextAttemptAt: 0, createdAt: nowIso(), updatedAt: nowIso(), reason });
      added += 1;
    }
  }
  const next = Array.from(byKey.values()).sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  writeQueue({ items: next });
  return { ok: true, added, kept, ...queueStats(readQueue()) };
}

function queryPeerHealth(summary = {}) {
  return new Promise((resolve) => {
    const port = Number(summary.port || process.env.P2P_TRANSPORT_PORT || 8787);
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: MAX_MESSAGE_BYTES });
    let settled = false;
    const finish = (peers = []) => { if (settled) return; settled = true; clearTimeout(timeout); try { socket.close(); } catch {} resolve(Array.isArray(peers) ? peers : []); };
    const timeout = setTimeout(() => finish([]), HEALTH_TIMEOUT_MS);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'ui:hello' })));
    socket.on('message', (raw) => { let message; try { message = JSON.parse(raw.toString()); } catch { return; } if (message.type === 'ui:ready') finish(message.peers || []); });
    socket.on('error', () => finish([]));
  });
}
function bucketWeight(bucket = '') { return ({ fast: 100, stable: 75, probation: 20, new: 10, congested: -30, quarantine: -80, offline: -90, dead: -100 })[bucket] ?? 0; }
function scorePeer(peer = {}) { const health = peer.health || {}; const pressure = peer.pressure || {}; const storage = peer.remoteStorage || {}; const capacityBonus = Math.min(25, Math.floor(Number(storage.remainingSharedBytes || 0) / (1024 * 1024 * 1024))); return Number(health.score || 0) + bucketWeight(health.bucket) + (storage.acceptingChunks === true ? 10 : storage.acceptingChunks === false ? -80 : 0) + capacityBonus - (pressure.overloaded ? 40 : 0); }
function mergePeers(summaryPeers = [], healthPeers = []) { const byId = new Map(); for (const p of summaryPeers || []) if (p?.peerId) byId.set(p.peerId, { ...p }); for (const p of healthPeers || []) if (p?.peerId) byId.set(p.peerId, { ...(byId.get(p.peerId) || {}), ...p }); return Array.from(byId.values()); }
async function peerTargets(summary = {}, knownReplicas = [], incomingBytes = 0) {
  const healthPeers = await queryPeerHealth(summary);
  const blocked = new Set(unique([summary.peerId, ...knownReplicas]));
  const candidates = mergePeers(summary.peers || [], healthPeers)
    .filter((peer) => peer?.peerId && peer.url && /^wss?:\/\//i.test(peer.url))
    .filter((peer) => !blocked.has(peer.peerId))
    .filter((peer) => peer.status === 'connected' || peer.status === 'connecting' || !peer.status)
    .filter((peer) => !['dead', 'offline', 'quarantine', 'congested'].includes(peer.health?.bucket));
  const { accepted, rejected } = filterCapacityPeers(candidates, incomingBytes);
  if (rejected.length) console.log('[repair-queue] capacity rejected peers', rejected.map((p) => ({ peerId: p.peerId, reason: p.admission?.reason })));
  return accepted.sort((a, b) => scorePeer(b) - scorePeer(a));
}
function putChunkWithAck({ peer, chunk, fromPeerId }) {
  return new Promise((resolve) => {
    const messageId = crypto.randomUUID();
    const socket = new WebSocket(peer.url, { maxPayload: MAX_MESSAGE_BYTES });
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timeout); try { socket.close(); } catch {} resolve(result); };
    const timeout = setTimeout(() => finish({ ok: false, peerId: peer.peerId, error: 'chunk:stored-ack timeout' }), ACK_TIMEOUT_MS);
    socket.on('open', () => { socket.send(JSON.stringify({ type: 'peer:hello', fromPeerId, toPeerId: peer.peerId, payload: { peerId: fromPeerId, url: null } })); socket.send(JSON.stringify({ id: messageId, type: 'chunk:put', fromPeerId, toPeerId: peer.peerId, createdAt: Date.now(), payload: { chunk } })); });
    socket.on('message', (raw) => { let message; try { message = JSON.parse(raw.toString()); } catch { return; } if (message.type !== 'chunk:stored-ack') return; if (message.payload?.ackTo && message.payload?.ackTo !== messageId) return; if (message.payload?.chunkHash && message.payload.chunkHash !== chunk.hash) return; if (message.payload?.ok === false) return finish({ ok: false, peerId: peer.peerId, error: message.payload?.error || 'chunk rejected', admission: peer.admission || null }); finish({ ok: true, peerId: peer.peerId, score: scorePeer(peer), bucket: peer.health?.bucket || 'unknown', admission: peer.admission || null }); });
    socket.on('error', (error) => finish({ ok: false, peerId: peer.peerId, error: error?.message || String(error), score: scorePeer(peer), bucket: peer.health?.bucket || 'unknown', admission: peer.admission || null }));
    socket.on('close', () => {});
  });
}

function findQueuedChunk(manifests, item) { const manifestIndex = manifests.findIndex((m) => m?.hash === item.fileHash); if (manifestIndex < 0) return null; const manifest = manifests[manifestIndex]; const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : []; const chunkIndex = chunks.findIndex((c) => c?.hash === item.chunkHash || Number(c?.index) === Number(item.chunkIndex)); if (chunkIndex < 0) return null; return { manifestIndex, chunkIndex, manifest, chunk: chunks[chunkIndex] }; }
function backoffMs(attempts = 0) { return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(8, Number(attempts || 0))); }

async function processQueueItem(item, summary) {
  const manifests = readManifests();
  const found = findQueuedChunk(manifests, item);
  if (!found) return { done: true, repaired: false, removed: true, reason: 'missing-manifest-or-chunk' };
  if (!chunkNeedsRepair(found.chunk)) return { done: true, repaired: false, removed: true, reason: 'already-protected' };
  const local = readChunkRecord(found.chunk.hash);
  if (!local?.data) return { done: false, repaired: false, error: 'local chunk missing' };

  const replicas = new Set(unique(found.chunk.replicas || []).filter((id) => id !== 'aws-safety-peer'));
  replicas.add(summary.peerId || 'desktop-client');
  const hadSafety = unique(found.chunk.replicas || []).includes('aws-safety-peer');
  const targets = await peerTargets(summary, Array.from(replicas), Number(local.size || found.chunk.size || 0));
  const failed = [];
  for (const peer of targets) {
    if (replicas.size >= TARGET_REPLICAS) break;
    const result = await putChunkWithAck({ peer, chunk: local, fromPeerId: summary.peerId || 'desktop-client' });
    if (result.ok) replicas.add(peer.peerId); else failed.push(result);
  }
  const nextChunk = { ...found.chunk, replicas: unique([...replicas, hadSafety ? 'aws-safety-peer' : null]), confirmedReplicas: replicas.size, targetReplicas: TARGET_REPLICAS, failedReplicas: failed, replicationStatus: replicas.size >= TARGET_REPLICAS ? 'protected' : 'protecting', repairedAt: nowIso() };
  manifests[found.manifestIndex].chunks[found.chunkIndex] = nextChunk;
  const protectedChunks = manifests[found.manifestIndex].chunks.filter((c) => confirmedCount(c) >= TARGET_REPLICAS).length;
  manifests[found.manifestIndex].protectedChunks = protectedChunks;
  manifests[found.manifestIndex].replicationStatus = protectedChunks === manifests[found.manifestIndex].chunks.length ? 'protected' : 'protecting';
  manifests[found.manifestIndex].replicationUpdatedAt = nowIso();
  writeManifests(manifests);
  return { done: replicas.size >= TARGET_REPLICAS, repaired: replicas.size > confirmedCount(found.chunk), confirmedReplicas: replicas.size, targetReplicas: TARGET_REPLICAS, failed };
}

async function runRepairQueueOnce(reason = 'interval') {
  if (active) return lastStatus;
  active = true;
  let processed = 0; let repaired = 0; let failed = 0;
  try {
    const summaryHandler = ipcMain._invokeHandlers?.get?.('p2p:networkSummary');
    const summary = summaryHandler ? await summaryHandler({}, {}) : { peerId: 'desktop-client', port: Number(process.env.P2P_TRANSPORT_PORT || 8787), peers: [] };
    const queue = readQueue();
    const now = nowMs();
    const due = queue.items.filter((item) => Number(item.nextAttemptAt || 0) <= now).slice(0, MAX_ITEMS_PER_RUN);
    const remaining = new Map(queue.items.map((item) => [item.key, item]));
    for (const item of due) {
      processed += 1;
      const result = await processQueueItem(item, summary || {});
      if (result.repaired) repaired += 1;
      if (result.done || result.removed) remaining.delete(item.key);
      else {
        failed += 1;
        const attempts = Number(item.attempts || 0) + 1;
        remaining.set(item.key, { ...item, attempts, lastError: result.error || 'not-enough-capacity-or-peers', lastAttemptAt: nowIso(), nextAttemptAt: nowMs() + backoffMs(attempts), updatedAt: nowIso() });
      }
    }
    writeQueue({ items: Array.from(remaining.values()) });
    lastStatus = { active: false, reason, lastRunAt: nowIso(), queued: remaining.size, processed, repaired, failed, error: null };
    return lastStatus;
  } catch (error) {
    lastStatus = { active: false, reason, lastRunAt: nowIso(), queued: readQueue().items.length, processed, repaired, failed, error: error?.message || String(error) };
    console.warn('[repair-queue] failed:', lastStatus.error);
    return lastStatus;
  } finally { active = false; }
}

function installRepairQueue() {
  rebuildQueueFromManifests('startup');
  setTimeout(() => void runRepairQueueOnce('startup'), START_DELAY_MS).unref?.();
  timer = setInterval(() => { rebuildQueueFromManifests('interval'); void runRepairQueueOnce('interval'); }, RUN_INTERVAL_MS);
  timer.unref?.();
  try { ipcMain.removeHandler('p2p:repairQueueStatus'); } catch {}
  ipcMain.handle('p2p:repairQueueStatus', async () => queueStats(readQueue()));
  try { ipcMain.removeHandler('p2p:repairQueueRebuild'); } catch {}
  ipcMain.handle('p2p:repairQueueRebuild', async () => rebuildQueueFromManifests('manual'));
  try { ipcMain.removeHandler('p2p:repairQueueNow'); } catch {}
  ipcMain.handle('p2p:repairQueueNow', async () => { rebuildQueueFromManifests('manual-run'); return runRepairQueueOnce('manual'); });
  console.log('[repair-queue] installed', { targetReplicas: TARGET_REPLICAS, maxItemsPerRun: MAX_ITEMS_PER_RUN, intervalMs: RUN_INTERVAL_MS, capacityAdmission: true, queuePath: queuePath() });
}

installRepairQueue();
