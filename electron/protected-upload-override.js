import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { readChunkRecord } from './core/chunk-store.js';
import { filterCapacityPeers } from './peer-capacity.js';

const TARGET_REPLICAS = Math.max(1, Number(process.env.P2P_TARGET_REPLICAS || 3));
const MIN_CONFIRMED_REPLICAS = Math.max(1, Math.min(TARGET_REPLICAS, Number(process.env.P2P_UPLOAD_MIN_CONFIRMED_REPLICAS || TARGET_REPLICAS)));
const MAX_REPLICA_ATTEMPTS = Math.max(TARGET_REPLICAS, Number(process.env.P2P_UPLOAD_MAX_REPLICA_ATTEMPTS || 8));
const ACK_TIMEOUT_MS = Math.max(2000, Number(process.env.P2P_CHUNK_STORE_ACK_TIMEOUT_MS || 7000));
const HEALTH_TIMEOUT_MS = Math.max(1000, Number(process.env.P2P_PEER_HEALTH_QUERY_TIMEOUT_MS || 2500));
const MAX_MESSAGE_BYTES = Math.max(1024 * 1024, Number(process.env.P2P_MAX_MESSAGE_BYTES || 8 * 1024 * 1024));

function dataDir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function manifestsPath() { return path.join(dataDir(), 'manifests.json'); }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }

function readJson(filePath, fallback) {
  try { if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
function readManifests() { const parsed = readJson(manifestsPath(), []); return Array.isArray(parsed) ? parsed : []; }
function writeManifests(manifests) { writeJson(manifestsPath(), manifests); }
function readLocalChunk(hash) { return readChunkRecord(hash); }

function classifyChunk(chunk = {}) {
  const replicas = unique(chunk.replicas || []);
  const confirmed = replicas.filter((id) => id !== 'aws-safety-peer').length;
  const hasSafety = replicas.includes('aws-safety-peer');
  const protectedEnough = confirmed >= TARGET_REPLICAS;
  const safeEnough = confirmed >= MIN_CONFIRMED_REPLICAS || (hasSafety && confirmed >= Math.max(1, MIN_CONFIRMED_REPLICAS - 1));
  return { ...chunk, replicas, confirmedReplicas: confirmed, targetReplicas: TARGET_REPLICAS, minimumConfirmedReplicas: MIN_CONFIRMED_REPLICAS, replicationStatus: protectedEnough ? 'protected' : safeEnough ? 'protecting' : 'needs-repair' };
}

function queryPeerHealth(summary = {}) {
  return new Promise((resolve) => {
    const port = Number(summary.port || 8787);
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: MAX_MESSAGE_BYTES });
    let settled = false;
    const finish = (peers = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(Array.isArray(peers) ? peers : []);
    };
    const timer = setTimeout(() => finish([]), HEALTH_TIMEOUT_MS);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'ui:hello' })));
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'ui:ready') finish(message.peers || []);
    });
    socket.on('error', () => finish([]));
  });
}

function bucketWeight(bucket = '') {
  return ({ fast: 100, stable: 75, probation: 20, new: 10, congested: -30, quarantine: -80, offline: -90, dead: -100 })[bucket] ?? 0;
}

function scorePeer(peer = {}) {
  const health = peer.health || {};
  const pressure = peer.pressure || {};
  const remoteStorage = peer.remoteStorage || {};
  const storageBonus = remoteStorage.acceptingChunks === true ? 10 : remoteStorage.acceptingChunks === false ? -80 : 0;
  const capacityBonus = Math.min(25, Math.floor(Number(remoteStorage.remainingSharedBytes || 0) / (1024 * 1024 * 1024)));
  const pressurePenalty = pressure.overloaded ? 40 : 0;
  return Number(health.score || 0) + bucketWeight(health.bucket) + storageBonus + capacityBonus - pressurePenalty;
}

function mergePeerInfo(summaryPeers = [], healthPeers = []) {
  const byId = new Map();
  for (const peer of summaryPeers || []) if (peer?.peerId) byId.set(peer.peerId, { ...peer });
  for (const peer of healthPeers || []) {
    if (!peer?.peerId) continue;
    byId.set(peer.peerId, { ...(byId.get(peer.peerId) || {}), ...peer });
  }
  return Array.from(byId.values());
}

async function peerTargets(summary = {}, knownReplicas = [], incomingBytes = 0) {
  const healthPeers = await queryPeerHealth(summary);
  const blocked = new Set(unique([summary.peerId, ...knownReplicas]));
  const candidates = mergePeerInfo(summary.peers || [], healthPeers)
    .filter((peer) => peer?.peerId && peer.url && /^wss?:\/\//i.test(peer.url))
    .filter((peer) => !blocked.has(peer.peerId))
    .filter((peer) => peer.status === 'connected' || peer.status === 'connecting' || !peer.status)
    .filter((peer) => !['dead', 'offline', 'quarantine', 'congested'].includes(peer.health?.bucket));
  const { accepted, rejected } = filterCapacityPeers(candidates, incomingBytes);
  if (rejected.length) console.log('[protected-upload] capacity rejected peers', rejected.map((p) => ({ peerId: p.peerId, reason: p.admission?.reason })));
  return accepted.sort((a, b) => scorePeer(b) - scorePeer(a)).slice(0, MAX_REPLICA_ATTEMPTS);
}

function putChunkWithAck({ peer, chunk, fromPeerId }) {
  return new Promise((resolve) => {
    const messageId = crypto.randomUUID();
    const socket = new WebSocket(peer.url, { maxPayload: MAX_MESSAGE_BYTES });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, peerId: peer.peerId, error: 'chunk:stored-ack timeout' }), ACK_TIMEOUT_MS);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'peer:hello', fromPeerId, toPeerId: peer.peerId, payload: { peerId: fromPeerId, url: null } }));
      socket.send(JSON.stringify({ id: messageId, type: 'chunk:put', fromPeerId, toPeerId: peer.peerId, createdAt: Date.now(), payload: { chunk } }));
    });
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type !== 'chunk:stored-ack') return;
      if (message.payload?.ackTo && message.payload.ackTo !== messageId) return;
      if (message.payload?.chunkHash && message.payload.chunkHash !== chunk.hash) return;
      if (message.payload?.ok === false) return finish({ ok: false, peerId: peer.peerId, error: message.payload?.error || 'chunk rejected' });
      finish({ ok: true, peerId: peer.peerId, score: scorePeer(peer), bucket: peer.health?.bucket || 'unknown', admission: peer.admission || null });
    });
    socket.on('error', (error) => finish({ ok: false, peerId: peer.peerId, error: error?.message || String(error), score: scorePeer(peer), bucket: peer.health?.bucket || 'unknown', admission: peer.admission || null }));
    socket.on('close', () => {});
  });
}

async function replicateChunkToConfirmedPeers({ chunkMeta, summary }) {
  const initial = classifyChunk(chunkMeta);
  if (initial.confirmedReplicas >= TARGET_REPLICAS) return initial;

  const chunk = readLocalChunk(initial.hash);
  if (!chunk?.data) return { ...initial, replicationStatus: 'needs-repair', error: 'local chunk missing' };

  const replicas = new Set(initial.replicas.filter((id) => id !== 'aws-safety-peer'));
  replicas.add(summary.peerId || 'desktop-client');
  const hadSafety = initial.replicas.includes('aws-safety-peer');
  const failedReplicas = [];
  const selectedPeers = await peerTargets(summary, Array.from(replicas), Number(chunk.size || initial.size || 0));

  for (const peer of selectedPeers) {
    if (replicas.size >= TARGET_REPLICAS) break;
    const result = await putChunkWithAck({ peer, chunk, fromPeerId: summary.peerId || 'desktop-client' });
    if (result.ok) replicas.add(peer.peerId);
    else failedReplicas.push(result);
  }

  const confirmed = replicas.size;
  const protectedEnough = confirmed >= TARGET_REPLICAS;
  const safeEnough = confirmed >= MIN_CONFIRMED_REPLICAS || (hadSafety && confirmed >= Math.max(1, MIN_CONFIRMED_REPLICAS - 1));
  return {
    ...initial,
    replicas: unique([...replicas, hadSafety ? 'aws-safety-peer' : null]),
    confirmedReplicas: confirmed,
    selectedPeers: selectedPeers.map((peer) => ({ peerId: peer.peerId, score: scorePeer(peer), bucket: peer.health?.bucket || 'unknown', admission: peer.admission || null })),
    failedReplicas,
    replicationStatus: protectedEnough ? 'protected' : safeEnough ? 'protecting' : 'needs-repair',
  };
}

async function protectFile(file = {}, summary = {}) {
  const chunks = [];
  for (const chunk of Array.isArray(file.chunks) ? file.chunks : []) chunks.push(await replicateChunkToConfirmedPeers({ chunkMeta: chunk, summary }));
  const protectedChunks = chunks.filter((chunk) => chunk.replicationStatus === 'protected').length;
  const repairChunks = chunks.filter((chunk) => chunk.replicationStatus === 'needs-repair').length;
  const replicas = unique(chunks.flatMap((chunk) => chunk.replicas || []));
  return { ...file, chunks, replicas, uploadStatus: 'available', replicationStatus: repairChunks > 0 ? 'needs-repair' : protectedChunks === chunks.length ? 'protected' : 'protecting', protectedChunks, needsRepairChunks: repairChunks, replicationUpdatedAt: new Date().toISOString() };
}

async function updateStoredManifests(files = [], summary = {}) {
  if (!files.length) return files;
  const protectedFiles = [];
  for (const file of files) protectedFiles.push(await protectFile(file, summary));
  const map = new Map(protectedFiles.map((file) => [file.hash, file]));
  const next = readManifests().map((manifest) => map.has(manifest.hash) ? { ...manifest, ...map.get(manifest.hash) } : manifest);
  writeManifests(next);
  return protectedFiles;
}

function installProtectedUploadStatusOverride() {
  const handlers = ipcMain._invokeHandlers;
  const oldUploadFiles = handlers?.get?.('p2p:uploadFiles');
  const oldUploadPath = handlers?.get?.('p2p:uploadPath');
  const oldSummary = handlers?.get?.('p2p:networkSummary');
  if (!oldUploadFiles) { console.warn('[protected-upload] base p2p:uploadFiles handler missing; skipped'); return; }

  try { ipcMain.removeHandler('p2p:uploadFiles'); } catch {}
  ipcMain.handle('p2p:uploadFiles', async (event, payload = {}) => {
    const result = await oldUploadFiles(event, payload);
    if (result?.cancelled || !Array.isArray(result?.files)) return result;
    const summaryBefore = oldSummary ? await oldSummary(event, {}) : result.summary;
    const files = await updateStoredManifests(result.files, summaryBefore || {});
    const summary = oldSummary ? await oldSummary(event, {}) : result.summary;
    return { ...result, files, summary };
  });

  if (oldUploadPath) {
    try { ipcMain.removeHandler('p2p:uploadPath'); } catch {}
    ipcMain.handle('p2p:uploadPath', async (event, payload = {}) => {
      const result = await oldUploadPath(event, payload);
      if (!result?.file) return result;
      const summaryBefore = oldSummary ? await oldSummary(event, {}) : result.summary;
      const [file] = await updateStoredManifests([result.file], summaryBefore || {});
      const summary = oldSummary ? await oldSummary(event, {}) : result.summary;
      return { ...result, file, summary };
    });
  }

  console.log('[protected-upload] scored ack replication override installed', { targetReplicas: TARGET_REPLICAS, minConfirmed: MIN_CONFIRMED_REPLICAS, maxAttempts: MAX_REPLICA_ATTEMPTS, capacityAdmission: true });
}

installProtectedUploadStatusOverride();
