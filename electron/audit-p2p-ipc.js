import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_AUDIT_EVENTS = Number(process.env.P2P_AUDIT_MAX_EVENTS || 2000);
const AUDIT_OBJECT_TYPE = 'chunknet-company-audit-event-v1';
const AUDIT_MANIFEST_TYPE = 'chunknet-company-audit-manifest-v1';
const REPLICATION_FACTOR = Number(process.env.P2P_AUDIT_REPLICATION_FACTOR || process.env.P2P_REPLICATION_FACTOR || 3);

const dataDir = () => path.join(app.getPath('userData'), 'native-p2p-storage');
const auditPath = () => path.join(dataDir(), 'audit-log.json');
const auditManifestPath = () => path.join(dataDir(), 'audit-manifests.json');
const walletPath = () => path.join(dataDir(), 'wallet.json');
const chunkDir = () => process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks');
const objectDir = () => path.join(dataDir(), 'audit-objects');

function ensure() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(chunkDir(), { recursive: true });
  fs.mkdirSync(objectDir(), { recursive: true });
  if (!fs.existsSync(auditPath())) fs.writeFileSync(auditPath(), '[]', 'utf8');
  if (!fs.existsSync(auditManifestPath())) fs.writeFileSync(auditManifestPath(), '[]', 'utf8');
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  ensure();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function wallet() { return readJson(walletPath(), { connected: false, verified: false, planId: 'free' }); }
function actor() {
  const w = wallet();
  return String(w.accountId || w.address || w.username || 'guest').trim().toLowerCase();
}
function events() {
  ensure();
  const list = readJson(auditPath(), []);
  return Array.isArray(list) ? list : [];
}
function manifests() {
  ensure();
  const list = readJson(auditManifestPath(), []);
  return Array.isArray(list) ? list : [];
}
function saveEvents(list) { writeJson(auditPath(), list.slice(-MAX_AUDIT_EVENTS)); }
function saveManifests(list) { writeJson(auditManifestPath(), list.slice(-MAX_AUDIT_EVENTS)); }
function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function safeHash(value = '') { return String(value || '').replace(/[^a-fA-F0-9]/g, ''); }
function chunkPath(hash) { return path.join(chunkDir(), `${safeHash(hash)}.json`); }
function objectPath(hash) { return path.join(objectDir(), `${safeHash(hash)}.json`); }
function node() {
  return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null;
}
function sanitizeDetails(details = {}) {
  if (!details || typeof details !== 'object') return {};
  const out = { ...details };
  for (const key of Object.keys(out)) {
    if (/password|secret|private|seed|token/i.test(key)) out[key] = '[redacted]';
  }
  return out;
}
function workspaceIdFrom(details = {}) {
  return String(details.workspaceId || details.companyId || '').trim();
}
async function publishAuditEvent(event) {
  const bytes = Buffer.from(JSON.stringify(event), 'utf8');
  const hash = sha(bytes);
  const workspaceId = workspaceIdFrom(event.details || {});
  const ownerWallet = workspaceId ? `company-audit:${workspaceId}` : `audit:${event.actor || 'system'}`;
  const chunk = {
    hash,
    index: 0,
    size: bytes.length,
    data: bytes.toString('base64'),
    ownerWallet,
    objectType: AUDIT_OBJECT_TYPE,
    driveType: 'audit',
    workspaceId,
    companyId: workspaceId,
    auditId: event.auditId,
    encrypted: false,
    storedAt: new Date().toISOString(),
  };
  const manifest = {
    manifestType: AUDIT_MANIFEST_TYPE,
    driveType: 'audit',
    visibility: 'company-audit',
    auditId: event.auditId,
    action: event.action,
    actor: event.actor,
    at: event.at,
    hash,
    rootHash: hash,
    workspaceId,
    companyId: workspaceId,
    objectType: AUDIT_OBJECT_TYPE,
    ownerWallet,
    size: bytes.length,
    totalChunks: 1,
    chunks: [{ index: 0, hash, size: bytes.length }],
    replicas: ['local-audit'],
    replicationStatus: 'local',
    targetReplicationFactor: REPLICATION_FACTOR,
    detailsPreview: sanitizeDetails(event.details || {}),
  };

  writeJson(chunkPath(hash), chunk);
  writeJson(objectPath(hash), event);

  const current = manifests().filter((item) => item.auditId !== event.auditId && item.hash !== hash);
  current.push(manifest);
  saveManifests(current);

  const p2p = node();
  if (p2p?.selectReplicaTargets && p2p?.putChunkOnNetwork) {
    try {
      const targets = p2p.selectReplicaTargets({ exclude: [], limit: REPLICATION_FACTOR }) || [];
      if (targets.length) {
        await p2p.putChunkOnNetwork(chunk, targets);
        manifest.replicas = ['local-audit', ...targets.map((target) => target.peerId || target.id || String(target))];
        manifest.replicationStatus = manifest.replicas.length >= REPLICATION_FACTOR ? 'protected' : 'replicating';
        const next = manifests().filter((item) => item.auditId !== manifest.auditId && item.hash !== manifest.hash);
        next.push(manifest);
        saveManifests(next);
      }
    } catch (error) {
      manifest.replicationStatus = 'needs-repair';
      manifest.replicationError = String(error?.message || error || 'replication failed');
      const next = manifests().filter((item) => item.auditId !== manifest.auditId && item.hash !== manifest.hash);
      next.push(manifest);
      saveManifests(next);
    }
  }

  return manifest;
}
async function recordAuditEvent(action, details = {}) {
  const event = {
    auditId: 'audit_' + crypto.randomBytes(12).toString('hex'),
    action: String(action || 'unknown'),
    actor: actor(),
    at: new Date().toISOString(),
    details: sanitizeDetails(details),
  };
  saveEvents([...events(), event]);
  const manifest = await publishAuditEvent(event);
  return { event, manifest };
}
function listAudit(payload = {}) {
  const limit = Math.max(1, Math.min(500, Number(payload.limit || 200)));
  const workspaceId = String(payload.workspaceId || payload.companyId || '').trim();
  const action = String(payload.action || '').trim();
  let rows = events();
  if (workspaceId) rows = rows.filter((event) => String(event.details?.workspaceId || event.details?.companyId || '') === workspaceId);
  if (action) rows = rows.filter((event) => event.action === action);
  const allManifests = manifests();
  const byAuditId = new Map(allManifests.map((manifest) => [manifest.auditId, manifest]));
  const hydrated = rows.slice(-limit).reverse().map((event) => ({
    ...event,
    p2p: byAuditId.get(event.auditId) || null,
  }));
  return { ok: true, events: hydrated, manifests: allManifests.slice(-limit).reverse() };
}
function clearAudit(payload = {}) {
  if (payload.localOnly === false) {
    throw new Error('P2P audit history is append-only. Use localOnly:true to clear only this device cache.');
  }
  saveEvents([]);
  return { ok: true, cleared: true, localOnly: true, events: [] };
}
function listAuditManifests(payload = {}) {
  const workspaceId = String(payload.workspaceId || payload.companyId || '').trim();
  const limit = Math.max(1, Math.min(500, Number(payload.limit || 200)));
  let rows = manifests();
  if (workspaceId) rows = rows.filter((manifest) => String(manifest.workspaceId || manifest.companyId || '') === workspaceId);
  return { ok: true, manifests: rows.slice(-limit).reverse() };
}
function installP2PAuditHandlers() {
  for (const channel of ['audit:list', 'audit:record', 'audit:clear', 'audit:listManifests']) {
    try { ipcMain.removeHandler(channel); } catch {}
  }
  ipcMain.handle('audit:list', async (_event, payload = {}) => listAudit(payload));
  ipcMain.handle('audit:record', async (_event, payload = {}) => {
    const result = await recordAuditEvent(payload.action, payload.details || {});
    return { ok: true, ...result };
  });
  ipcMain.handle('audit:clear', async (_event, payload = {}) => clearAudit(payload));
  ipcMain.handle('audit:listManifests', async (_event, payload = {}) => listAuditManifests(payload));
  console.log('[audit] P2P replicated audit IPC installed');
}

installP2PAuditHandlers();
setImmediate(installP2PAuditHandlers);
