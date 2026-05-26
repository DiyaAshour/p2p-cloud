import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';

const GB = 1024 ** 3;
const TB = 1024 ** 4;
const CHUNK = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);
const MIN_PASS = Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12);
const KDF = 310000;
const ALG = 'aes-256-gcm';
const KEY_SRC = 'wallet-password-v1';
const LIMITS = {
  free: { maxCompanyDrives: 1, companyDriveBytes: 1 * GB, maxMembers: 3 },
  tb1: { maxCompanyDrives: 1, companyDriveBytes: 1 * GB, maxMembers: 3 },
  tb3: { maxCompanyDrives: 1, companyDriveBytes: 3 * TB, maxMembers: 10 },
  tb7: { maxCompanyDrives: 3, companyDriveBytes: 7 * TB, maxMembers: 25 },
  tb10: { maxCompanyDrives: 10, companyDriveBytes: 10 * TB, maxMembers: 100 },
};
const READ = new Set(['owner', 'admin', 'editor', 'viewer']);
const WRITE = new Set(['owner', 'admin', 'editor']);
const ROLES = new Set(['admin', 'editor', 'viewer']);

const dir = () => path.join(app.getPath('userData'), 'native-p2p-storage');
const file = (name) => path.join(dir(), name);
const chunkDir = () => process.env.P2P_CHUNK_STORE_DIR || path.join(dir(), 'chunks');
function ensure() {
  fs.mkdirSync(dir(), { recursive: true });
  fs.mkdirSync(chunkDir(), { recursive: true });
  for (const name of ['manifests.json', 'companies.json', 'company-members.json']) if (!fs.existsSync(file(name))) fs.writeFileSync(file(name), '[]');
}
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, v) { ensure(); fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function wallet() { return readJson(file('wallet.json'), { connected: false, verified: false, planId: 'free' }); }
function norm(v = '') { return String(v || '').trim().toLowerCase(); }
function me() { const w = wallet(); return norm(w.accountId || w.address || ''); }
function verified() { const w = wallet(); const id = me(); return Boolean(w.connected && w.verified && id); }
function assertMe() { const w = wallet(); const id = me(); if (!w.connected || !w.verified || !id) throw new Error('Verified identity required.'); return { w, id }; }
function validIdentity(v = '') { const x = norm(v); return /^0x[a-f0-9]{40}$/.test(x) || x.startsWith('seed:'); }
function list(name) { ensure(); const v = readJson(file(name), []); return Array.isArray(v) ? v : []; }
function manifests() { return list('manifests.json'); }
function companies() { return list('companies.json'); }
function members() { return list('company-members.json'); }
function saveManifests(v) { writeJson(file('manifests.json'), v); }
function saveMembers(v) { writeJson(file('company-members.json'), v); }
function saveCompanies(v) { writeJson(file('companies.json'), v); }
function limits(plan = wallet().planId || 'free') { return LIMITS[plan] || LIMITS.free; }
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function cleanName(v = '') { const s = String(v || '').trim().replace(/\s+/g, ' '); if (!s) throw new Error('Name is required'); if (s.length > 80) throw new Error('Name is too long'); return s; }
function cleanRole(v = 'viewer') { const r = String(v || 'viewer').toLowerCase(); if (!ROLES.has(r)) throw new Error('Invalid role'); return r; }
function company(id = '') { return companies().find((c) => String(c.companyId || '') === String(id || '').trim()) || null; }
function memberRows(companyId) { return members().filter((m) => String(m.companyId || '') === String(companyId || '')); }
function roleFor(c, who = me()) { if (!c) return null; if (norm(c.ownerWallet) === norm(who)) return 'owner'; return memberRows(c.companyId).find((m) => norm(m.wallet) === norm(who))?.role || null; }
function owned(who = me()) { return companies().filter((c) => norm(c.ownerWallet) === norm(who)); }
function visible(who = me()) { const ids = new Set(members().filter((m) => norm(m.wallet) === norm(who)).map((m) => m.companyId)); return companies().filter((c) => norm(c.ownerWallet) === norm(who) || ids.has(c.companyId)); }
function companyFiles(companyId) { return manifests().filter((m) => m.driveType === 'company' && m.companyId === companyId && m.kind !== 'folder' && !m.isFolder); }
function used(companyId) { return companyFiles(companyId).reduce((s, f) => s + Number(f.size || 0), 0); }
function summary(c) { const u = used(c.companyId); return { ...c, role: roleFor(c), usedBytes: u, remainingBytes: Math.max(0, Number(c.quotaBytes || 0) - u), members: memberRows(c.companyId), files: companyFiles(c.companyId) }; }
function refreshLimits() { if (!verified()) return; const { w, id } = assertMe(); const lim = limits(w.planId); const cs = companies(); let changed = false; for (const c of cs) { if (norm(c.ownerWallet) !== id) continue; let itemChanged = false; if (c.planId !== (w.planId || 'free')) { c.planId = w.planId || 'free'; itemChanged = true; } if (Number(c.quotaBytes || 0) !== lim.companyDriveBytes) { c.quotaBytes = lim.companyDriveBytes; itemChanged = true; } if (Number(c.maxMembers || 0) !== lim.maxMembers) { c.maxMembers = lim.maxMembers; itemChanged = true; } if (itemChanged) { c.updatedAt = new Date().toISOString(); changed = true; } } if (changed) saveCompanies(cs); }
function state() { const w = wallet(); if (!verified()) return { ok: true, locked: true, limits: limits(w.planId), ownedCount: 0, workspaces: [], companies: [] }; refreshLimits(); return { ok: true, locked: false, limits: limits(w.planId), ownedCount: owned().length, workspaces: visible().map(summary), companies: visible().map(summary) }; }
function assertOwner(companyId) { const { id } = assertMe(); const c = company(companyId); if (!c) throw new Error('Company Drive not found'); if (norm(c.ownerWallet) !== id) throw new Error('Only the Company Drive owner can control this workspace'); return c; }
function assertAccess(companyId, allowed = READ) { assertMe(); const c = company(companyId); if (!c) throw new Error('Company Drive not found'); const role = roleFor(c); if (!role || !allowed.has(role)) throw new Error('You do not have access to this Company Drive'); return c; }
function pass(v = '') { const p = String(v || '').trim(); if (p.length < MIN_PASS) throw new Error(`Drive Password required. Use at least ${MIN_PASS} characters.`); return p; }
function storageOwner(companyId) { return `company:${String(companyId || '').trim()}`; }
function chunkPath(hash) { return path.join(chunkDir(), `${String(hash || '').replace(/[^a-fA-F0-9]/g, '')}.json`); }
function split(buf) { const out = []; for (let offset = 0; offset < buf.length; offset += CHUNK) { const data = buf.slice(offset, offset + CHUNK); out.push({ index: out.length, size: data.length, data, hash: sha(data) }); } return out; }
function writeChunk(chunk, extra) { writeJson(chunkPath(chunk.hash), { hash: chunk.hash, data: chunk.data.toString('base64'), index: chunk.index, size: chunk.size, ...extra, storedAt: new Date().toISOString() }); }
async function key(owner, password, salt) { return new Promise((resolve, reject) => crypto.pbkdf2(`${norm(owner)}:${pass(password)}`, Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64'), KDF, 32, 'sha256', (err, k) => err ? reject(err) : resolve(k))); }
async function encrypt(buf, owner, password) { const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12); const k = await key(owner, password, salt); const cipher = crypto.createCipheriv(ALG, k, iv); const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]); return { ciphertext, encryption: { version: 4, algorithm: ALG, keySource: KEY_SRC, kdf: 'pbkdf2-sha256', kdfIterations: KDF, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), originalHash: sha(buf), originalSize: buf.length } }; }
async function addFile(payload = {}) { if (!payload.bytes) throw new Error('File bytes are required'); const c = assertAccess(payload.companyId, WRITE); const original = Buffer.from(payload.bytes); if (used(c.companyId) + original.length > Number(c.quotaBytes || 0)) throw new Error('Company Drive quota exceeded.'); const privateFile = Boolean(payload.isEncrypted ?? true); const owner = storageOwner(c.companyId); const secured = privateFile ? await encrypt(original, owner, payload.drivePassword) : { ciphertext: original, encryption: null }; const chunks = split(secured.ciphertext); const tree = buildMerkleTree(chunks.map((x) => x.hash)); const fileHash = sha(secured.ciphertext); const metas = chunks.map((ch) => { writeChunk(ch, { driveType: 'company', companyId: c.companyId, ownerWallet: owner, ownerCompanyWallet: norm(c.ownerWallet), uploadedByWallet: me(), encrypted: privateFile }); return { index: ch.index, hash: ch.hash, size: ch.size, replicas: ['local-company-drive'], proof: getMerkleProof(tree, ch.index) }; }); const manifest = { id: `${c.companyId}:${fileHash}`, fileId: fileHash, driveType: 'company', companyId: c.companyId, companyName: c.name, name: String(payload.name || 'company-file'), size: original.length, storedSize: secured.ciphertext.length, hash: fileHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: 'company', isPublic: false, encryption: secured.encryption, mimeType: String(payload.mimeType || 'application/octet-stream'), folderId: String(payload.folderId || ''), folderName: String(payload.folderName || payload.folder || ''), folder: String(payload.folderName || payload.folder || ''), chunkSize: CHUNK, totalChunks: chunks.length, ownerNodeId: 'local-company-drive', ownerWallet: owner, ownerCompanyWallet: norm(c.ownerWallet), uploadedByWallet: me(), planId: c.planId, replicas: ['local-company-drive'], chunks: metas }; const next = manifests().filter((m) => !(m.driveType === 'company' && m.companyId === c.companyId && m.hash === manifest.hash)); next.push(manifest); saveManifests(next); return { ok: true, file: manifest, workspace: summary(c) }; }
function approveJoin(payload = {}) { const req = payload.request && typeof payload.request === 'object' ? payload.request : payload; const c = assertOwner(req.companyId || payload.companyId); const walletId = norm(req.wallet || payload.wallet || payload.address || payload.memberWallet); if (!validIdentity(walletId)) throw new Error('Valid member wallet or seed identity is required'); if (walletId === norm(c.ownerWallet)) throw new Error('Owner already controls this Company Drive'); const rows = members(); const existing = rows.find((m) => m.companyId === c.companyId && norm(m.wallet) === walletId); if (!existing && memberRows(c.companyId).length >= Number(c.maxMembers || 0)) throw new Error('Company Drive member limit reached'); if (existing) { existing.role = cleanRole(payload.role || existing.role || 'viewer'); existing.updatedAt = new Date().toISOString(); } else rows.push({ companyId: c.companyId, wallet: walletId, role: cleanRole(payload.role || 'viewer'), invitedByWallet: me(), joinedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); saveMembers(rows); return { ok: true, workspace: summary(c), state: state() }; }

function installCompanyDriveHardening() {
  for (const channel of ['company:state', 'company:addFile', 'company:approveJoinRequest']) { try { ipcMain.removeHandler(channel); } catch {} }
  ipcMain.handle('company:state', async () => state());
  ipcMain.handle('company:addFile', async (_event, payload = {}) => addFile(payload));
  ipcMain.handle('company:approveJoinRequest', async (_event, payload = {}) => approveJoin(payload));
  console.log('[company-drive] hardening installed');
}

installCompanyDriveHardening();
setImmediate(installCompanyDriveHardening);
