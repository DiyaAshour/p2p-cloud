import { app, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';
import { pushWalletManifest } from './manifest-sync.js';
import { putChunkToSafetyPeer } from './safety-peer.js';

const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 2 * 1024 * 1024);
const TARGET_REPLICAS = Math.max(4, Number(process.env.P2P_TARGET_REPLICAS || 4));
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';
const KDF_ALGORITHM = 'pbkdf2-sha256';
const KDF_ITERATIONS = 310000;
const MIN_DRIVE_PASSWORD_LENGTH = Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12);

function dataDir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function walletPath() { return path.join(dataDir(), 'wallet.json'); }
function manifestsPath() { return path.join(dataDir(), 'manifests.json'); }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks'); }
function chunkPath(hash) { return path.join(chunkStoreDir(), `${String(hash || '').replace(/[^a-fA-F0-9]/g, '')}.json`); }
function normalize(value = '') { return String(value || '').trim().toLowerCase(); }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function node() { return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null; }
function dropMemoryChunk(hash) { try { node()?.localChunks?.delete?.(hash); } catch {} }

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function wallet() { return readJson(walletPath(), {}); }
function identity(w = wallet()) { return normalize(w.accountId || w.address || ''); }
function manifests() { const v = readJson(manifestsPath(), []); return Array.isArray(v) ? v : []; }
function saveManifests(v) { writeJson(manifestsPath(), v); }
function password(value = '') {
  const p = String(value || '').trim();
  if (p.length < MIN_DRIVE_PASSWORD_LENGTH) throw new Error(`Drive Password required. Use at least ${MIN_DRIVE_PASSWORD_LENGTH} characters.`);
  return p;
}
function driveKey({ ownerWallet, drivePassword, salt }) {
  return crypto.pbkdf2Sync(`${normalize(ownerWallet)}:${password(drivePassword)}`, salt, KDF_ITERATIONS, 32, 'sha256');
}
function folderById(id = '') {
  const clean = String(id || '').replace(/^folder:/, '').trim();
  if (!clean) return null;
  return manifests().find((m) => (m.kind === 'folder' || m.isFolder || String(m.hash || '').startsWith('folder:')) && [m.folderId, m.id, m.hash, m.rootHash].map((x) => String(x || '').replace(/^folder:/, '').trim()).includes(clean)) || null;
}
function walletBytes(ownerWallet) {
  return manifests().filter((m) => normalize(m.ownerWallet) === ownerWallet && !(m.kind === 'folder' || m.isFolder || String(m.hash || '').startsWith('folder:'))).reduce((s, f) => s + Number(f.size || 0), 0);
}
function quotaBytes(planId = 'free') {
  if (planId === 'tb10') return 10 * 1024 ** 4;
  if (planId === 'tb7') return 7 * 1024 ** 4;
  if (planId === 'tb3') return 3 * 1024 ** 4;
  if (planId === 'tb1') return 1 * 1024 ** 4;
  return 5 * 1024 ** 3;
}
function writeChunk(chunk) {
  fs.mkdirSync(chunkStoreDir(), { recursive: true });
  writeJson(chunkPath(chunk.hash), { ...chunk, storedAt: new Date().toISOString() });
}
async function replicate(chunk) {
  const n = node();
  const replicas = new Set([n.peerId]);
  if (n?.putChunkOnNetwork && n?.selectReplicaTargets) {
    const targets = n.selectReplicaTargets({ exclude: [n.peerId], limit: Math.max(0, TARGET_REPLICAS - 1) }) || [];
    if (targets.length) {
      try {
        const result = await n.putChunkOnNetwork(chunk, targets);
        for (const peerId of result?.replicas || []) replicas.add(peerId);
      } catch (e) { console.warn('[stream-upload] p2p replicate failed:', e?.message || e); }
    }
  }
  try {
    const safety = await putChunkToSafetyPeer(chunk, n.peerId);
    if (safety?.ok) replicas.add('aws-safety-peer');
  } catch (e) { console.warn('[stream-upload] safety peer failed:', e?.message || e); }
  dropMemoryChunk(chunk.hash);
  return unique([...replicas]);
}
async function uploadOne(filePath, payload = {}) {
  const w = wallet();
  const ownerWallet = identity(w);
  if (!w.connected || !w.verified || !ownerWallet) throw new Error('Verified identity required. Connect wallet or sign in with Seed Account first.');
  const n = node();
  if (!n?.peerId) throw new Error('P2P transport is not ready yet.');
  const stat = fs.statSync(filePath);
  if (walletBytes(ownerWallet) + stat.size > quotaBytes(w.planId)) throw new Error('Storage quota exceeded.');

  const privateFile = Boolean(payload.isEncrypted);
  const salt = privateFile ? crypto.randomBytes(16) : null;
  const iv = privateFile ? crypto.randomBytes(12) : null;
  const cipher = privateFile ? crypto.createCipheriv(ENCRYPTION_ALGORITHM, driveKey({ ownerWallet, drivePassword: payload.drivePassword, salt }), iv) : null;
  const originalHasher = crypto.createHash('sha256');
  const storedHasher = crypto.createHash('sha256');
  const chunks = [];
  const fileReplicas = new Set([n.peerId]);
  let carry = Buffer.alloc(0);
  let storedSize = 0;
  let index = 0;

  async function flush(bufferLike) {
    const buffer = Buffer.from(bufferLike || Buffer.alloc(0));
    const hash = sha256(buffer);
    storedHasher.update(buffer);
    storedSize += buffer.length;
    const chunk = { hash, data: buffer.toString('base64'), index, size: buffer.length, ownerWallet, encrypted: privateFile };
    writeChunk(chunk);
    dropMemoryChunk(hash);
    const replicas = await replicate(chunk);
    replicas.forEach((peerId) => fileReplicas.add(peerId));
    const confirmed = replicas.filter((x) => x !== 'aws-safety-peer').length;
    chunks.push({ index, hash, size: buffer.length, replicas, confirmedReplicas: confirmed, targetReplicas: TARGET_REPLICAS, replicationStatus: confirmed >= TARGET_REPLICAS ? 'protected' : confirmed >= 2 ? 'protecting' : 'needs-repair', proof: [] });
    dropMemoryChunk(hash);
    index += 1;
  }
  async function consume(output) {
    if (!output?.length) return;
    carry = carry.length ? Buffer.concat([carry, output]) : Buffer.from(output);
    while (carry.length >= CHUNK_SIZE_BYTES) {
      const part = carry.subarray(0, CHUNK_SIZE_BYTES);
      carry = carry.subarray(CHUNK_SIZE_BYTES);
      await flush(part);
    }
  }

  for await (const part of fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES })) {
    const plain = Buffer.from(part);
    originalHasher.update(plain);
    await consume(privateFile ? cipher.update(plain) : plain);
  }
  if (privateFile) await consume(cipher.final());
  if (carry.length || chunks.length === 0) await flush(carry);

  const storedHash = storedHasher.digest('hex');
  const originalHash = originalHasher.digest('hex');
  const tree = buildMerkleTree(chunks.map((c) => c.hash));
  chunks.forEach((c) => { c.proof = getMerkleProof(tree, c.index); });
  const targetFolder = payload.folderId ? folderById(payload.folderId) : null;
  if (payload.folderId && !targetFolder) throw new Error(`Target folder not found: ${payload.folderId}`);
  const protectedChunks = chunks.filter((c) => c.replicationStatus === 'protected').length;
  const needsRepairChunks = chunks.filter((c) => c.replicationStatus === 'needs-repair').length;
  const manifest = {
    id: `${ownerWallet}:${storedHash}`, name: path.basename(filePath), size: stat.size, storedSize, hash: storedHash, rootHash: tree.root,
    uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isEncrypted: privateFile,
    visibility: privateFile ? 'private' : 'public', isPublic: !privateFile,
    encryption: privateFile ? { version: 5, algorithm: ENCRYPTION_ALGORITHM, keySource: ENCRYPTION_KEY_SOURCE, kdf: KDF_ALGORITHM, kdfIterations: KDF_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), originalHash, originalSize: stat.size } : null,
    mimeType: 'application/octet-stream', folderId: targetFolder?.folderId || '', parentFolderId: targetFolder?.folderId || '', folderName: targetFolder?.name || String(payload.folderPath || ''), folder: targetFolder?.name || String(payload.folderPath || ''),
    chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: n.peerId, ownerWallet, planId: w.planId || 'free', replicas: unique([...fileReplicas]), chunks,
    uploadStatus: 'available', replicationStatus: needsRepairChunks ? 'needs-repair' : protectedChunks === chunks.length ? 'protected' : 'protecting', protectedChunks, needsRepairChunks, replicationUpdatedAt: new Date().toISOString(),
  };
  const next = manifests().filter((m) => !(normalize(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
  next.push(manifest);
  saveManifests(next);
  // Manifest sync is best-effort — upload must not fail if the sync server is unreachable or slow
  try {
    await pushWalletManifest(manifest);
  } catch (syncErr) {
    console.warn('[stream-upload] manifest sync push failed (non-fatal, will retry on next pull):', syncErr?.message || syncErr);
  }
  return manifest;
}
async function uploadFiles(payload = {}) {
  const picked = await dialog.showOpenDialog({ title: 'Upload files', properties: ['openFile', 'multiSelections'] });
  if (picked.canceled || !picked.filePaths?.length) return { ok: true, cancelled: true, files: [] };
  const files = [];
  for (const filePath of picked.filePaths) files.push(await uploadOne(filePath, payload));
  const summaryHandler = ipcMain._invokeHandlers?.get?.('p2p:networkSummary');
  return { ok: true, cancelled: false, files, summary: summaryHandler ? await summaryHandler({}, {}) : null };
}
try { ipcMain.removeHandler('p2p:uploadFiles'); } catch {}
ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => uploadFiles(payload));
try { ipcMain.removeHandler('p2p:uploadPath'); } catch {}
ipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => uploadOne(String(payload.filePath || payload.path || ''), payload));
console.log('[stream-upload] installed disk-first streaming upload override');
