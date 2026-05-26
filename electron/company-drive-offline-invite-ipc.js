import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = () => path.join(app.getPath('userData'), 'native-p2p-storage');
const filePath = (name) => path.join(dataDir(), name);
const INVITE_PREFIX = 'chunknet-invite:';
const ROLES = new Set(['admin', 'manager', 'editor', 'viewer', 'guest']);

function ensure() {
  fs.mkdirSync(dataDir(), { recursive: true });
  for (const name of ['companies.json', 'company-members.json', 'company-files.json']) {
    if (!fs.existsSync(filePath(name))) fs.writeFileSync(filePath(name), '[]', 'utf8');
  }
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { ensure(); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function list(name) { ensure(); const value = readJson(filePath(name), []); return Array.isArray(value) ? value : []; }
function wallet() { return readJson(filePath('wallet.json'), { connected: false, verified: false, planId: 'free' }); }
function norm(value = '') { return String(value || '').trim().toLowerCase(); }
function activeIdentity() { const w = wallet(); return norm(w.accountId || w.address || ''); }
function assertVerified() { const w = wallet(); const id = activeIdentity(); if (!w.connected || !w.verified || !id) throw new Error('Verified identity required.'); return { wallet: w, identity: id }; }
function companies() { return list('companies.json'); }
function members() { return list('company-members.json'); }
function companyFiles() { return list('company-files.json'); }
function saveCompanies(value) { writeJson(filePath('companies.json'), value); }
function saveMembers(value) { writeJson(filePath('company-members.json'), value); }
function companyId(company) { return String(company?.workspaceId || company?.companyId || '').trim(); }
function workspaceId(payload = {}) { return String(payload.workspaceId || payload.companyId || payload.id || '').trim(); }
function findCompany(id = '') { const target = String(id || '').trim(); return companies().find((company) => companyId(company) === target) || null; }
function rawMembers(id = '') { return members().filter((member) => String(member.workspaceId || member.companyId || '') === String(id || '') && member.status !== 'removed'); }
function memberLookup(payload = {}) { return norm(payload.memberId || payload.wallet || payload.memberWallet || payload.address || payload.deviceId || payload.email || ''); }
function cleanRole(value = 'viewer') { const role = norm(value || 'viewer'); if (!ROLES.has(role)) throw new Error('Invalid role'); return role; }
function isMemberIdentity(value = '') { const v = norm(value); return /^0x[a-f0-9]{40}$/.test(v) || v.startsWith('seed:'); }
function normalizeMember(member = {}) {
  const identity = norm(member.wallet || member.deviceId || member.email || '');
  const workspace = String(member.workspaceId || member.companyId || '');
  return {
    ...member,
    companyId: workspace,
    workspaceId: workspace,
    memberId: String(member.memberId || crypto.createHash('sha256').update(`${workspace}:${identity}:${member.role || ''}`).digest('hex').slice(0, 16)),
    deviceId: String(member.deviceId || (isMemberIdentity(identity) ? identity : '') || identity),
    wallet: String(member.wallet || (isMemberIdentity(identity) ? identity : '')),
    email: String(member.email || identity),
    displayName: member.displayName || String(member.email || identity || 'Member').slice(0, 32),
    role: member.role || 'viewer',
    status: member.status || (isMemberIdentity(identity) ? 'active' : 'invited'),
  };
}
function assertOwner(id = '') {
  const { identity } = assertVerified();
  const company = findCompany(id);
  if (!company) throw new Error('Company Drive not found');
  if (norm(company.ownerWallet) !== identity) throw new Error('Only the Company Drive owner can control this workspace');
  const cid = companyId(company);
  return { ...company, companyId: cid, workspaceId: cid };
}
function encodePack(pack) { return INVITE_PREFIX + Buffer.from(JSON.stringify(pack), 'utf8').toString('base64url'); }
function decodePack(raw = '') {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Workspace access token is required');
  const encoded = text.startsWith(INVITE_PREFIX) ? text.slice(INVITE_PREFIX.length) : text;
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new Error('Invalid or old invite token. Ask the owner to copy a fresh invite token.'); }
}
function upsertCompany(company) {
  const cid = companyId(company);
  if (!cid) throw new Error('Invalid workspace access token');
  const normalized = { ...company, companyId: cid, workspaceId: cid };
  const existing = companies();
  if (!existing.some((item) => companyId(item) === cid)) saveCompanies([...existing, normalized]);
  return normalized;
}
function upsertMembers(incoming = []) {
  const rows = members();
  for (const member of incoming.map(normalizeMember)) {
    const exists = rows.some((item) => String(item.workspaceId || item.companyId || '') === member.workspaceId && String(item.memberId || '') === member.memberId);
    if (!exists) rows.push(member);
  }
  saveMembers(rows);
}
function state() {
  const identity = activeIdentity();
  const visibleIds = new Set(members().filter((member) => [member.wallet, member.deviceId, member.email].map(norm).includes(identity) && member.status !== 'removed').map((member) => String(member.workspaceId || member.companyId || '')));
  const workspaces = companies().filter((company) => norm(company.ownerWallet) === identity || visibleIds.has(companyId(company))).map((company) => ({
    ...company,
    workspaceId: companyId(company),
    companyId: companyId(company),
    members: rawMembers(companyId(company)),
    files: companyFiles().filter((file) => String(file.workspaceId || file.companyId || '') === companyId(company)),
  }));
  return { ok: true, deviceIdentity: { deviceId: identity, email: identity, displayName: identity }, workspaces, companies: workspaces };
}
function inviteMember(payload = {}) {
  const company = assertOwner(workspaceId(payload));
  const rawIdentity = memberLookup(payload);
  if (!rawIdentity) throw new Error('Member email, deviceId, or wallet is required');
  if (rawIdentity === norm(company.ownerWallet)) throw new Error('Owner already controls this Company Drive');

  const rows = members();
  const existing = rows.find((member) => String(member.workspaceId || member.companyId || '') === company.workspaceId && [member.memberId, member.wallet, member.deviceId, member.email].map(norm).includes(rawIdentity));
  const invitedMember = normalizeMember({
    companyId: company.workspaceId,
    workspaceId: company.workspaceId,
    wallet: isMemberIdentity(rawIdentity) ? rawIdentity : '',
    deviceId: isMemberIdentity(rawIdentity) ? rawIdentity : '',
    email: rawIdentity,
    role: cleanRole(payload.role || 'viewer'),
    status: isMemberIdentity(rawIdentity) ? 'active' : 'invited',
    invitedByWallet: activeIdentity(),
    joinedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  if (existing) Object.assign(existing, invitedMember, { memberId: existing.memberId, updatedAt: new Date().toISOString() });
  else rows.push(invitedMember);
  saveMembers(rows);

  const pack = {
    type: 'chunknet-company-invite-v2',
    issuedAt: new Date().toISOString(),
    company,
    members: [invitedMember],
    role: invitedMember.role,
    invitedIdentity: rawIdentity,
  };
  const inviteToken = encodePack(pack);
  return { ok: true, workspace: { ...company, members: rawMembers(company.workspaceId) }, inviteToken, access: inviteToken, state: state() };
}
function importWorkspaceAccess(payload = {}) {
  const { identity } = assertVerified();
  const pack = decodePack(payload.access || payload.token || payload.data);
  const company = upsertCompany(pack.company || pack.workspace);
  const cid = companyId(company);
  const currentMember = normalizeMember({
    companyId: cid,
    workspaceId: cid,
    wallet: identity,
    deviceId: identity,
    email: identity,
    role: cleanRole(pack.role || pack.member?.role || 'viewer'),
    status: 'active',
    joinedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  upsertMembers([...(Array.isArray(pack.members) ? pack.members : []), currentMember]);
  return { ok: true, workspace: { ...company, members: rawMembers(cid) }, state: state() };
}
function installOfflineInviteHandlers() {
  for (const channel of ['company:inviteMember', 'company:approveJoinRequest', 'company:importWorkspaceAccess']) {
    try { ipcMain.removeHandler(channel); } catch {}
  }
  ipcMain.handle('company:inviteMember', async (_event, payload = {}) => inviteMember(payload));
  ipcMain.handle('company:approveJoinRequest', async (_event, payload = {}) => inviteMember(payload));
  ipcMain.handle('company:importWorkspaceAccess', async (_event, payload = {}) => importWorkspaceAccess(payload));
  console.log('[company-drive] offline invite tokens installed');
}

installOfflineInviteHandlers();
setImmediate(installOfflineInviteHandlers);
