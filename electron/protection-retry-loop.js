import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const TARGET_REPLICAS = Math.max(4, Number(process.env.P2P_TARGET_REPLICAS || 4));
const MIN_CONFIRMED_REPLICAS = Math.max(3, Number(process.env.P2P_UPLOAD_MIN_CONFIRMED_REPLICAS || 3));
const MAX_REPLICA_ATTEMPTS = Math.max(4, Number(process.env.P2P_UPLOAD_MAX_REPLICA_ATTEMPTS || 8));
const ACK_TIMEOUT_MS = Math.max(2000, Number(process.env.P2P_CHUNK_STORE_ACK_TIMEOUT_MS || 7000));
const HEALTH_TIMEOUT_MS = Math.max(1000, Number(process.env.P2P_PEER_HEALTH_QUERY_TIMEOUT_MS || 2500));
const MAX_MESSAGE_BYTES = Math.max(1024 * 1024, Number(process.env.P2P_MAX_MESSAGE_BYTES || 8 * 1024 * 1024));
const LOOP_INTERVAL_MS = Math.max(60_000, Number(process.env.P2P_PROTECTION_RETRY_INTERVAL_MS || 5 * 60 * 1000));
const START_DELAY_MS = Math.max(10_000, Number(process.env.P2P_PROTECTION_RETRY_START_DELAY_MS || 45_000));
const MAX_CHUNKS_PER_RUN = Math.max(1, Number(process.env.P2P_PROTECTION_RETRY_MAX_CHUNKS_PER_RUN || 64));

let active = false;
let timer = null;
let lastStatus = { active: false, lastRunAt: null, repairedChunks: 0, checkedChunks: 0, error: null };

// ─── Pause / Resume Controls ────────────────────────────────────────────────
let pausedUntil = 0;
let pauseReason = null;

function pauseProtectionRetry(ms = 5 * 60 * 1000, reason = 'manual-pause') {
  pausedUntil = Math.max(pausedUntil, Date.now() + Number(ms || 0));
  pauseReason = reason;
  const until = new Date(pausedUntil).toISOString();
  console.log('[protection-retry] paused', { ms, reason, until });
  return { ok: true, paused: true, pausedUntil: until, reason };
}

function resumeProtectionRetry(reason = 'manual-resume') {
  pausedUntil = 0;
  pauseReason = null;
  console.log('[protection-retry] resumed', { reason });
  return { ok: true, paused: false, reason };
}

function isProtectionRetryPaused() {
  return Date.now() < pausedUntil;
}
// ────────────────────────────────────────────────────────────────────────────

function dataDir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function manifestsPath() { return path.join(dataDir(), 'manifests.json'); }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks'); }
function chunkPath(chunkHash) { return path.join(chunkStoreDir(), `${String(chunkHash || '').replace(/[^a-fA-F0-9]/g, '')}.json`); }
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
function readLocalChunk(hash) { return readJson(chunkPath(hash), null); }

function classifyChunk(chunk = {}) {
  const replicas = unique(chunk.replicas || []);
  const confirmed = replicas.filter((id) => id !== 'aws-safety-peer').length;
  const hasSafety = replicas.includes('aws-safety-peer');
  const protectedEnough = confirmed >= TARGET_REPLICAS;
  const safeEnough = confirmed >= MIN_CONFIRMED_REPLICAS || (hasSafety && confirmed >= MIN_CONFIRMED_REPLICAS - 1);
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
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      resolve(Array.isArray(peers) ? peers : []);
    };
    const timeout = setTimeout(() => finish([]), HEALTH_TIMEOUT_MS);
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
  const pressurePenalty = pressure.overloaded ? 40 : 0;
  return Number(health.score || 0) + bucketWeight(health.bucket) + storageBonus - pressurePenalty;
}

function mergePeerInfo(summaryPeers = [], healthPeers = []) {
  const byId = new Map();
  for (const peer of summaryPeers || []) if (peer?.peerId) byId.set(peer.peerId, { ...peer });
  for (const peer of healthPeers || []) if (peer?.peerId) byId.set(peer.peerId, { ...(byId.get(peer.peerId) || {}), ...peer });
  return Array.from(byId.values());
}

async function peerTargets(summary = {}, knownReplicas = []) {
  const healthPeers = await queryPeerHealth(summary);
  const blocked = new Set(unique([summary.peerId, ...knownReplicas]));
  return mergePeerInfo(summary.peers || [], healthPeers)
    .filter((peer) => peer?.peerId && peer.url && /^wss?:\/\//i.test(peer.url))
    .filter((peer) => !blocked.has(peer.peerId))
    .filter((peer) => peer.status === 'connected' || peer.status === 'connecting' || !peer.status)
    .filter((peer) => !['dead', 'offline', 'quarantine', 'congested'].includes(peer.health?.bucket))
    .sort((a, b) => scorePeer(b) - scorePeer(a))
    .slice(0, MAX_REPLICA_ATTEMPTS);
}

function putChunkWithAck({ peer, chunk, fromPeerId }) {
  return new Promise((resolve) => {
    const messageId = crypto.randomUUID();
    const socket = new WebSocket(peer.url, { maxPayload: MAX_MESSAGE_BYTES });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, peerId: peer.peerId, error: 'chunk:stored-ack timeout' }), ACK_TIMEOUT_MS);
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
      finish({ ok: true, peerId: peer.peerId, score: scorePeer(peer), bucket: peer.health?.bucket || 'unknown' });
    });
    socket.on('error', (error) => finish({ ok: false, peerId: peer.peerId, error: error?.message || String(error), score: scorePeer(peer), bucket: peer.health?.bucket || 'unknown' }));
    socket.on('close', () => {});
  });
}

async function repairChunk(chunkMeta, summary) {
  const initial = classifyChunk(chunkMeta);
  if (initial.replicationStatus === 'protected') return { chunk: initial, changed: false, checked: false };
  const chunk = readLocalChunk(initial.hash);
  if (!chunk?.data) return { chunk: { ...initial, replicationStatus: 'needs-repair', error: 'local chunk missing' }, changed: true, checked: true };

  const replicas = new Set(initial.replicas.filter((id) => id !== 'aws-safety-peer'));
  replicas.add(summary.peerId || 'desktop-client');
  const hadSafety = initial.replicas.includes('aws-safety-peer');
  const failedReplicas = [];
  const selectedPeers = await peerTargets(summary, Array.from(replicas));

  for (const peer of selectedPeers) {
    if (replicas.size >= TARGET_REPLICAS) break;
    const result = await putChunkWithAck({ peer, chunk, fromPeerId: summary.peerId || 'desktop-client' });
    if (result.ok) replicas.add(peer.peerId);
    else failedReplicas.push(result);
  }

  const confirmed = replicas.size;
  const protectedEnough = confirmed >= TARGET_REPLICAS;
  const safeEnough = confirmed >= MIN_CONFIRMED_REPLICAS || (hadSafety && confirmed >= MIN_CONFIRMED_REPLICAS - 1);
  const next = {
    ...initial,
    replicas: unique([...replicas, hadSafety ? 'aws-safety-peer' : null]),
    confirmedReplicas: confirmed,
    selectedPeers: selectedPeers.map((peer) => ({ peerId: peer.peerId, score: scorePeer(peer), bucket: peer.health?.bucket || 'unknown' })),
    failedReplicas,
    replicationStatus: protectedEnough ? 'protected' : safeEnough ? 'protecting' : 'needs-repair',
  };
  return { chunk: next, changed: JSON.stringify(next.replicas) !== JSON.stringify(initial.replicas) || next.replicationStatus !== initial.replicationStatus, checked: true };
}

function refreshManifestStatus(manifest) {
  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks.map(classifyChunk) : [];
  const protectedChunks = chunks.filter((chunk) => chunk.replicationStatus === 'protected').length;
  const repairChunks = chunks.filter((chunk) => chunk.replicationStatus === 'needs-repair').length;
  return {
    ...manifest,
    chunks,
    replicas: unique(chunks.flatMap((chunk) => chunk.replicas || [])),
    uploadStatus: 'available',
    replicationStatus: repairChunks > 0 ? 'needs-repair' : protectedChunks === chunks.length ? 'protected' : 'protecting',
    protectedChunks,
    needsRepairChunks: repairChunks,
    replicationUpdatedAt: new Date().toISOString(),
  };
}

async function runProtectionRetryOnce() {
  // Guard: disabled via environment variable
  if (process.env.P2P_PROTECTION_RETRY_DISABLED === '1') {
    lastStatus = { ...lastStatus, active: false, skipped: true, reason: 'disabled', error: null };
    return lastStatus;
  }

  // Guard: paused programmatically (e.g. during a delete operation)
  if (isProtectionRetryPaused()) {
    lastStatus = {
      ...lastStatus,
      active: false,
      skipped: true,
      reason: pauseReason || 'paused',
      paused: true,
      pausedUntil: new Date(pausedUntil).toISOString(),
      error: null,
    };
    return lastStatus;
  }

  if (active) return lastStatus;
  active = true;
  let checkedChunks = 0;
  let repairedChunks = 0;
  try {
    const summaryHandler = ipcMain._invokeHandlers?.get?.('p2p:networkSummary');
    const summary = summaryHandler ? await summaryHandler({}, {}) : { peerId: 'desktop-client', port: Number(process.env.P2P_TRANSPORT_PORT || 8787), peers: [] };
    const manifests = readManifests();
    let budget = MAX_CHUNKS_PER_RUN;
    let changed = false;

    const next = [];
    for (const manifest of manifests) {
      let current = refreshManifestStatus(manifest);
      const chunks = [];
      for (const chunk of current.chunks || []) {
        if (budget > 0 && chunk.replicationStatus !== 'protected') {
          const result = await repairChunk(chunk, summary || {});
          chunks.push(result.chunk);
          if (result.checked) { checkedChunks += 1; budget -= 1; }
          if (result.changed) { repairedChunks += 1; changed = true; }
        } else {
          chunks.push(chunk);
        }
      }
      current = refreshManifestStatus({ ...current, chunks });
      next.push(current);
    }

    if (changed) writeManifests(next);
    lastStatus = { active: false, lastRunAt: new Date().toISOString(), repairedChunks, checkedChunks, error: null };
    return lastStatus;
  } catch (error) {
    lastStatus = { active: false, lastRunAt: new Date().toISOString(), repairedChunks, checkedChunks, error: error?.message || String(error) };
    console.warn('[protection-retry] failed:', lastStatus.error);
    return lastStatus;
  } finally {
    active = false;
  }
}

function installProtectionRetryLoop() {
  if (timer) return;
  setTimeout(() => void runProtectionRetryOnce(), START_DELAY_MS).unref?.();
  timer = setInterval(() => void runProtectionRetryOnce(), LOOP_INTERVAL_MS);
  timer.unref?.();
  try { ipcMain.removeHandler('p2p:protectionRetryNow'); } catch {}
  ipcMain.handle('p2p:protectionRetryNow', async () => runProtectionRetryOnce());

  try { ipcMain.removeHandler('p2p:pauseProtectionRetry'); } catch {}
  ipcMain.handle('p2p:pauseProtectionRetry', async (_event, payload = {}) =>
    pauseProtectionRetry(
      Number(payload.ms || 5 * 60 * 1000),
      String(payload.reason || 'delete-operation')
    )
  );

  try { ipcMain.removeHandler('p2p:resumeProtectionRetry'); } catch {}
  ipcMain.handle('p2p:resumeProtectionRetry', async (_event, payload = {}) =>
    resumeProtectionRetry(String(payload.reason || 'delete-operation-finished'))
  );

  try { ipcMain.removeHandler('p2p:protectionRetryStatus'); } catch {}
  ipcMain.handle('p2p:protectionRetryStatus', async () => ({
    ...lastStatus,
    paused: isProtectionRetryPaused(),
    pausedUntil: pausedUntil ? new Date(pausedUntil).toISOString() : null,
    pauseReason,
  }));

  console.log('[protection-retry] loop installed', { intervalMs: LOOP_INTERVAL_MS, startDelayMs: START_DELAY_MS, maxChunksPerRun: MAX_CHUNKS_PER_RUN, targetReplicas: TARGET_REPLICAS });
}

installProtectionRetryLoop();
