import './company-drive-hardening-ipc.js';
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

function dir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function p(name) { return path.join(dir(), name); }
function cdir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(dir(), 'chunks'); }
function ensure() { fs.mkdirSync(dir(), { recursive: true }); fs.mkdirSync(cdir(), { recursive: true }); for (const f of ['manifests.json', 'companies.json', 'company-members.json']) if (!fs.existsSync(p(f))) fs.writeFileSync(p(f), '[]'); }
function readJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } }
function writeJson(file, v) { ensure(); fs.writeFileSync(file, JSON.stringify(v, null, 2)); }
function wallet() { return readJson(p('wallet.json'), { connected: false, verified: false, planId: 'free' }); }
function id(v = '') { return String(v || '').trim().toLowerCase(); }
function me() { const w = wallet(); return id(w.accountId || w.address || ''); }
function validId(v = '') { const x = id(v); return /^0x[a-f0-9]{40}$/.test(x) || x.startsWith('seed:'); }
function assertMe() { const w = wallet(); const m = me(); if (!w.connected || !w.verified || !m) throw new Error('Verified identity required.'); return { w, m }; }
function arr(file) { ensure(); const x = readJson(p(file), []); return Array.isArray(x) ? x : []; }
function manifests() { return arr('manifests.json'); }
function companies() { return arr('companies.json'); }
function members() { return arr('company-members.json'); }
function saveManifests(v) { writeJson(p('manifests.json'), v); }
function saveCompanies(v) { writeJson(p('companies.json'), v); }
function saveMembers(v) { writeJson(p('company-members.json'), v); }
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function safe(h) { return String(h || '').replace(/[^a-fA-F0-9]/g, ''); }
function chunkPath(h) { return path.join(cdir(), `${safe(h)}.json`); }
function pass(v = '') { const s = String(v || '').trim(); if (s.length < MIN_PASS) throw new Error(`Drive Password required. Use at least ${MIN_PASS} characters.`); return s; }
function lim(plan = wallet().planId || 'free') { return LIMITS[plan] || LIMITS.free; }
function cleanName(v = '') { const s = String(v || '').trim().replace(/\s+/g, ' '); if (!s) throw new Error('Name is required'); if (s.length > 80) throw new Error('Name is too long'); return s; }
function cleanRole(v = 'viewer') { const r = String(v || 'viewer').toLowerCase(); if (!ROLES.has(r)) throw new Error('Invalid role'); return r; }
function company(idv = '') { return companies().find((c) => String(c.companyId) === String(idv || '').trim()) || null; }
function memberRows(cid) { return members().filter((m) => m.companyId === cid); }
function roleFor(c, who = me()) { if (!c) return null; if (id(c.ownerWallet) === id(who)) return 'owner'; return memberRows(c.companyId).find((m) => id(m.wallet) === id(who))?.role || null; }
function owned(who = me()) { return companies().filter((c) => id(c.ownerWallet) === id(who)); }
function visible(who = me()) { const ids = new Set(members().filter((m) => id(m.wallet) === id(who)).map((m) => m.companyId)); return companies().filter((c) => id(c.ownerWallet) === id(who) || ids.has(c.companyId)); }
function files(cid) { return manifests().filter((m) => m.driveType === 'company' && m.companyId === cid && m.kind !== 'folder' && !m.isFolder); }
function used(cid) { return files(cid).reduce((s, f) => s + Number(f.size || 0), 0); }
function summary(c) { const u = used(c.companyId); return { ...c, role: roleFor(c), usedBytes: u, remainingBytes: Math.max(0, Number(c.quotaBytes || 0) - u), members: memberRows(c.companyId), files: files(c.companyId) }; }
function assertOwner(cid) { const { m } = assertMe(); const c = company(cid); if (!c) throw new Error('Company Drive not found'); if (id(c.ownerWallet) !== m) throw new Error('Only the Company Drive owner can control this workspace'); return c; }
function assertAccess(cid, allowed = READ) { assertMe(); const c = company(cid); if (!c) throw new Error('Company Drive not found'); const r = roleFor(c); if (!r || !allowed.has(r)) throw new Error('You do not have access to this Company Drive'); return { c, r }; }
function refreshLimits() { const { w, m } = assertMe(); const l = lim(w.planId); const list = companies(); let changed = false; for (const c of list) if (id(c.ownerWallet) === m) { if (c.planId !== w.planId) { c.planId = w.planId || 'free'; changed = true; } if (c.quotaBytes !== l.companyDriveBytes) { c.quotaBytes = l.companyDriveBytes; changed = true; } if (c.maxMembers !== l.maxMembers) { c.maxMembers = l.maxMembers; changed = true; } if (changed) c.updatedAt = new Date().toISOString(); } if (changed) saveCompanies(list); }
function state() { const { w } = assertMe(); refreshLimits(); return { ok: true, limits: lim(w.planId), ownedCount: owned().length, workspaces: visible().map(summary), companies: visible().map(summary) }; }
function split(buf) { const out = []; for (let o = 0; o < buf.length; o += CHUNK) { const data = buf.slice(o, o + CHUNK); out.push({ index: out.length, size: data.length, data, hash: sha(data) }); } return out; }
function writeChunk(ch, extra) { writeJson(chunkPath(ch.hash), { hash: ch.hash, data: ch.data.toString('base64'), index: ch.index, size: ch.size, ...extra, storedAt: new Date().toISOString() }); }
function readChunk(h) { const c = readJson(chunkPath(h), null); if (!c?.data) throw new Error('Missing company chunk: ' + h); return Buffer.from(c.data, 'base64'); }
async function key(owner, password, salt) { return new Promise((res, rej) => crypto.pbkdf2(`${id(owner)}:${pass(password)}`, Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64'), KDF, 32, 'sha256', (e, k) => e ? rej(e) : res(k))); }
async function enc(buf, owner, password) { const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), k = await key(owner, password, salt); const cipher = crypto.createCipheriv(ALG, k, iv); const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]); return { ciphertext, encryption: { version: 4, algorithm: ALG, keySource: KEY_SRC, kdf: 'pbkdf2-sha256', kdfIterations: KDF, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), originalHash: sha(buf), originalSize: buf.length } }; }
async function dec(buf, manifest, password) { const k = await key(manifest.ownerWallet, password, manifest.encryption.salt); const d = crypto.createDecipheriv(ALG, k, Buffer.from(manifest.encryption.iv, 'base64')); d.setAuthTag(Buffer.from(manifest.encryption.authTag, 'base64')); const out = Buffer.concat([d.update(buf), d.final()]); if (manifest.encryption.originalHash && sha(out) !== manifest.encryption.originalHash) throw new Error('Company file integrity failed after decrypt'); return out; }
function findFile(payload = {}) { const target = String(payload.hash || payload.rootHash || payload.fileId || payload.id || ''); return files(payload.companyId).find((f) => [f.hash, f.rootHash, f.fileId, f.id].map(String).includes(target)); }

async function addFile(payload = {}) { if (!payload.bytes) throw new Error('File bytes are required'); const original = Buffer.from(payload.bytes); const { c } = assertAccess(payload.companyId, WRITE); if (used(c.companyId) + original.length > Number(c.quotaBytes || 0)) throw new Error('Company Drive quota exceeded.'); const privateFile = Boolean(payload.isEncrypted ?? true); const owner = id(c.ownerWallet); const uploadedBy = me(); const secured = privateFile ? await enc(original, owner, payload.drivePassword) : { ciphertext: original, encryption: null }; const chunks = split(secured.ciphertext); const tree = buildMerkleTree(chunks.map((x) => x.hash)); const fileHash = sha(secured.ciphertext); const metas = chunks.map((ch) => { writeChunk(ch, { driveType: 'company', companyId: c.companyId, ownerWallet: owner, uploadedByWallet: uploadedBy, encrypted: privateFile }); return { index: ch.index, hash: ch.hash, size: ch.size, replicas: ['local-company-drive'], proof: getMerkleProof(tree, ch.index) }; }); const manifest = { id: `${c.companyId}:${fileHash}`, fileId: fileHash, driveType: 'company', companyId: c.companyId, companyName: c.name, name: String(payload.name || 'company-file'), size: original.length, storedSize: secured.ciphertext.length, hash: fileHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: 'company', isPublic: false, encryption: secured.encryption, mimeType: String(payload.mimeType || 'application/octet-stream'), folderId: String(payload.folderId || ''), folderName: String(payload.folderName || payload.folder || ''), folder: String(payload.folderName || payload.folder || ''), chunkSize: CHUNK, totalChunks: chunks.length, ownerNodeId: 'local-company-drive', ownerWallet: owner, uploadedByWallet: uploadedBy, planId: c.planId, replicas: ['local-company-drive'], chunks: metas }; const list = manifests().filter((m) => !(m.driveType === 'company' && m.companyId === c.companyId && m.hash === manifest.hash)); list.push(manifest); saveManifests(list); return { ok: true, file: manifest, workspace: summary(c) }; }
async function readObj(payload = {}) { const { c } = assertAccess(payload.companyId, READ); const f = findFile(payload); if (!f) throw new Error('Company file not found'); const stored = Buffer.concat([...(f.chunks || [])].sort((a, b) => a.index - b.index).map((m) => { const b = readChunk(m.hash); if (sha(b) !== m.hash) throw new Error('Chunk integrity failed: ' + m.hash); return b; })); if (sha(stored) !== f.hash) throw new Error('Company file integrity failed'); const out = f.isEncrypted ? await dec(stored, f, payload.drivePassword) : stored; return { ok: true, file: f, workspace: summary(c), bytes: Array.from(out) }; }

export function installCompanyDriveHandlers() {
  for (const ch of ['company:state','company:deviceIdentity','company:createWorkspace','company:deleteWorkspace','company:inviteMember','company:changeMemberRole','company:removeMember','company:addFile','company:readObject','company:publishObject','company:tokenFromObject','company:updateFile','company:createJoinRequest','company:exportWorkspaceAccess','company:importWorkspaceAccess']) { try { ipcMain.removeHandler(ch); } catch {} }
  ipcMain.handle('company:state', async () => state());
  ipcMain.handle('company:deviceIdentity', async () => ({ ok: true, identity: me() }));
  ipcMain.handle('company:createWorkspace', async (_e, payload = {}) => { const { w, m } = assertMe(); const l = lim(w.planId); const list = companies(); if (owned(m).length >= l.maxCompanyDrives) throw new Error('Company Drive limit reached for your current plan'); const now = new Date().toISOString(); const c = { companyId: 'company_' + crypto.randomBytes(16).toString('hex'), name: cleanName(payload.name || 'Company Drive'), ownerWallet: m, planId: w.planId || 'free', quotaBytes: l.companyDriveBytes, maxMembers: l.maxMembers, createdAt: now, updatedAt: now }; list.push(c); saveCompanies(list); return { ok: true, workspace: summary(c), state: state() }; });
  ipcMain.handle('company:deleteWorkspace', async (_e, payload = {}) => { const c = assertOwner(payload.companyId); saveCompanies(companies().filter((x) => x.companyId !== c.companyId)); saveMembers(members().filter((x) => x.companyId !== c.companyId)); const removed = manifests().filter((m) => m.driveType === 'company' && m.companyId === c.companyId); saveManifests(manifests().filter((m) => !(m.driveType === 'company' && m.companyId === c.companyId))); return { ok: true, deletedCompanyId: c.companyId, removedFiles: removed.length, state: state() }; });
  ipcMain.handle('company:inviteMember', async (_e, payload = {}) => { const c = assertOwner(payload.companyId); const wallet = id(payload.wallet || payload.address || payload.memberWallet); if (!validId(wallet)) throw new Error('Valid member wallet or seed identity is required'); if (wallet === id(c.ownerWallet)) throw new Error('Owner already controls this Company Drive'); const rows = members(); const existing = rows.find((m) => m.companyId === c.companyId && id(m.wallet) === wallet); if (!existing && memberRows(c.companyId).length >= Number(c.maxMembers || 0)) throw new Error('Company Drive member limit reached'); if (existing) { existing.role = cleanRole(payload.role || 'viewer'); existing.updatedAt = new Date().toISOString(); } else rows.push({ companyId: c.companyId, wallet, role: cleanRole(payload.role || 'viewer'), invitedByWallet: me(), joinedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); saveMembers(rows); return { ok: true, workspace: summary(c), state: state() }; });
  ipcMain.handle('company:changeMemberRole', async (_e, payload = {}) => { const c = assertOwner(payload.companyId); const wallet = id(payload.wallet || payload.address || payload.memberWallet); const rows = members(); const r = rows.find((m) => m.companyId === c.companyId && id(m.wallet) === wallet); if (!r) throw new Error('Company member not found'); r.role = cleanRole(payload.role || 'viewer'); r.updatedAt = new Date().toISOString(); saveMembers(rows); return { ok: true, workspace: summary(c), state: state() }; });
  ipcMain.handle('company:removeMember', async (_e, payload = {}) => { const c = assertOwner(payload.companyId); const wallet = id(payload.wallet || payload.address || payload.memberWallet); saveMembers(members().filter((m) => !(m.companyId === c.companyId && id(m.wallet) === wallet))); return { ok: true, workspace: summary(c), state: state() }; });
  ipcMain.handle('company:addFile', async (_e, payload = {}) => addFile(payload));
  ipcMain.handle('company:readObject', async (_e, payload = {}) => readObj(payload));
  ipcMain.handle('company:publishObject', async (_e, payload = {}) => { const { c } = assertAccess(payload.companyId, READ); const f = findFile(payload); if (!f) throw new Error('Company file not found'); return { ok: true, workspace: summary(c), object: { ...f, chunks: undefined } }; });
  ipcMain.handle('company:tokenFromObject', async (_e, payload = {}) => { const token = { companyId: String(payload.companyId || ''), hash: String(payload.hash || payload.rootHash || payload.fileId || ''), createdAt: new Date().toISOString() }; return { ok: true, token: Buffer.from(JSON.stringify(token), 'utf8').toString('base64url'), payload: token }; });
  ipcMain.handle('company:updateFile', async (_e, payload = {}) => { const c = assertOwner(payload.companyId); const f = findFile(payload); if (!f) throw new Error('Company file not found'); if (payload.delete || payload.deleted) { saveManifests(manifests().filter((m) => !(m.driveType === 'company' && m.companyId === c.companyId && m.hash === f.hash))); return { ok: true, deleted: true, state: state() }; } const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : payload; if ('name' in patch) f.name = cleanName(patch.name); if ('folderId' in patch) f.folderId = String(patch.folderId || ''); if ('folderName' in patch || 'folder' in patch) { f.folderName = String(patch.folderName || patch.folder || ''); f.folder = f.folderName; } f.updatedAt = new Date().toISOString(); saveManifests(manifests().map((m) => m.companyId === c.companyId && m.hash === f.hash ? f : m)); return { ok: true, file: f, workspace: summary(c), state: state() }; });
  ipcMain.handle('company:createJoinRequest', async (_e, payload = {}) => { assertMe(); return { ok: true, request: { requestId: 'join_' + crypto.randomBytes(12).toString('hex'), companyId: String(payload.companyId || ''), wallet: me(), requestedAt: new Date().toISOString() } }; });
  ipcMain.handle('company:exportWorkspaceAccess', async (_e, payload = {}) => { const c = assertOwner(payload.companyId); const pack = { company: c, members: memberRows(c.companyId) }; return { ok: true, access: Buffer.from(JSON.stringify(pack), 'utf8').toString('base64url'), ...pack }; });
  ipcMain.handle('company:importWorkspaceAccess', async (_e, payload = {}) => { assertMe(); const raw = payload.access || payload.token || payload.data; if (!raw) throw new Error('Workspace access token is required'); const pack = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); if (!pack.company?.companyId) throw new Error('Invalid workspace access token'); if (!company(pack.company.companyId)) saveCompanies([...companies(), pack.company]); const rows = members(); for (const m of Array.isArray(pack.members) ? pack.members : []) if (!rows.find((r) => r.companyId === m.companyId && id(r.wallet) === id(m.wallet))) rows.push(m); saveMembers(rows); return { ok: true, state: state() }; });
  console.log('[company-drive] IPC engine installed');
}

installCompanyDriveHandlers();
