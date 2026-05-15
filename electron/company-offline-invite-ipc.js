import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { createCompanyWorkspaceStore } from './company-workspace-store.js';

const ROLES = new Set(['admin', 'manager', 'editor', 'viewer', 'guest']);
const MANAGE_ROLES = new Set(['owner', 'admin', 'manager']);
let store = null;

function dataDir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function companyStore() { if (!store) store = createCompanyWorkspaceStore({ dataDir: dataDir() }); return store; }
function now() { return new Date().toISOString(); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function withoutSignature(value) { const { signature, ...rest } = value || {}; return rest; }
function sign(privateKeyPem, value) { return crypto.sign(null, Buffer.from(canonicalJson(value), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64'); }
function verify(publicKeyPem, value, signature) { try { return crypto.verify(null, Buffer.from(canonicalJson(value), 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signature || ''), 'base64')); } catch { return false; } }
function token(kind, payload) { return `chunknet://${kind}/${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`; }
function parseToken(raw, expectedKind) { const m = String(raw || '').trim().match(/^chunknet:\/\/([^/]+)\/(.+)$/); if (!m) throw new Error('Invalid Chunknet token.'); const [, kind, encoded] = m; if (expectedKind && kind !== expectedKind) throw new Error(`Expected ${expectedKind} token.`); return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
function assertSigned(payload) { if (!verify(payload.signedByPublicKeyPem, withoutSignature(payload), payload.signature)) throw new Error('Invalid token signature.'); }
function roleCanManage(role) { return MANAGE_ROLES.has(role); }
function assertCanManage(store, workspace) { if (!roleCanManage(store.localRole(workspace))) throw new Error('Your company role cannot manage this workspace.'); }

function createSignedInvite({ workspaceId, email = '', displayName = '', role = 'viewer' }) {
  if (!ROLES.has(role)) throw new Error('Invalid invite role.');
  const s = companyStore();
  const workspace = s.findWorkspace(workspaceId);
  if (!workspace) throw new Error('Workspace not found.');
  assertCanManage(s, workspace);
  const identity = s.getOrCreateIdentity();
  const inviteId = `invite_${crypto.randomUUID()}`;
  const unsignedInvite = { kind: 'invite', version: 1, inviteId, workspaceId: workspace.workspaceId, companyName: workspace.name, ownerWallet: workspace.ownerWallet || '', email, displayName: displayName || email || 'Invited member', role, workspaceSignature: workspace.signature, createdAt: now(), signedByDeviceId: identity.deviceId, signedByPublicKeyPem: identity.publicKeyPem };
  const invite = { ...unsignedInvite, signature: sign(identity.privateKeyPem, unsignedInvite) };
  const inviteToken = token('invite', invite);
  const next = s.signWorkspace({ ...workspace, members: [...(workspace.members || []), { memberId: `member_${crypto.randomUUID()}`, inviteId, deviceId: '', displayName: displayName || email || 'Invited member', email, role, status: 'invited', publicKeyPem: '', inviteToken, addedAt: now(), invitedByDeviceId: identity.deviceId }], audit: [...(workspace.audit || []), { at: now(), action: 'member:invite-offline', byDeviceId: identity.deviceId, email, role, inviteId }] });
  s.replaceWorkspace(next);
  return { workspace: next, inviteToken };
}

function createJoinRequest({ inviteToken, displayName = '', email = '' }) {
  const invite = parseToken(inviteToken, 'invite');
  assertSigned(invite);
  const s = companyStore();
  const identity = s.getOrCreateIdentity({ displayName: displayName || invite.displayName || email || invite.email || 'Device User', email: email || invite.email || '' });
  const unsigned = { kind: 'join-request', version: 1, invite, workspaceId: invite.workspaceId, companyName: invite.companyName, requestedRole: invite.role, email: email || invite.email || '', displayName: displayName || invite.displayName || email || invite.email || 'Device User', deviceId: identity.deviceId, publicKeyPem: identity.publicKeyPem, publicFingerprint: identity.publicFingerprint, requestedAt: now(), signedByDeviceId: identity.deviceId, signedByPublicKeyPem: identity.publicKeyPem };
  const request = { ...unsigned, signature: sign(identity.privateKeyPem, unsigned) };
  return { joinRequestToken: token('join-request', request), joinRequest: request };
}

function exportWorkspaceAccess({ workspaceId }) {
  const s = companyStore();
  const workspace = s.findWorkspace(workspaceId);
  if (!workspace) throw new Error('Workspace not found.');
  const role = s.localRole(workspace);
  if (!role) throw new Error('This device is not a member of this workspace.');
  const identity = s.getOrCreateIdentity();
  const unsigned = { kind: 'workspace-access', version: 1, workspace, exportedAt: now(), signedByDeviceId: identity.deviceId, signedByPublicKeyPem: identity.publicKeyPem };
  const access = { ...unsigned, signature: sign(identity.privateKeyPem, unsigned) };
  return { workspaceAccessToken: token('workspace-access', access) };
}

function approveJoinRequest({ joinRequestToken }) {
  const request = parseToken(joinRequestToken, 'join-request');
  assertSigned(request);
  assertSigned(request.invite);
  const s = companyStore();
  const workspace = s.findWorkspace(request.workspaceId);
  if (!workspace) throw new Error('Workspace not found on this admin device.');
  assertCanManage(s, workspace);
  const inviter = (workspace.members || []).find((m) => m.deviceId === request.invite.signedByDeviceId || m.publicKeyPem === request.invite.signedByPublicKeyPem);
  if (!roleCanManage(inviter?.role)) throw new Error('Invite signer is not allowed to manage this workspace.');
  const identity = s.getOrCreateIdentity();
  const role = request.invite.role || request.requestedRole || 'viewer';
  const pending = (workspace.members || []).find((m) => m.inviteId === request.invite.inviteId || (request.email && m.email === request.email && m.status === 'invited'));
  const memberId = pending?.memberId || `member_${crypto.randomUUID()}`;
  const activeMember = { memberId, inviteId: request.invite.inviteId, deviceId: request.deviceId, displayName: request.displayName || request.email || 'Device User', email: request.email || request.invite.email || '', role, status: 'active', publicKeyPem: request.publicKeyPem, publicFingerprint: request.publicFingerprint, addedAt: now(), approvedByDeviceId: identity.deviceId };
  const next = s.signWorkspace({ ...workspace, members: [activeMember, ...(workspace.members || []).filter((m) => m.memberId !== memberId && m.deviceId !== request.deviceId)], audit: [...(workspace.audit || []), { at: now(), action: 'member:approve-join-offline', byDeviceId: identity.deviceId, approvedDeviceId: request.deviceId, role }] });
  s.replaceWorkspace(next);
  const access = exportWorkspaceAccess({ workspaceId: next.workspaceId });
  return { workspace: next, workspaceAccessToken: access.workspaceAccessToken };
}

function importWorkspaceAccess({ workspaceAccessToken }) {
  const access = parseToken(workspaceAccessToken, 'workspace-access');
  assertSigned(access);
  const s = companyStore();
  const workspace = access.workspace;
  if (!s.verifyWorkspace(workspace)) throw new Error('Workspace manifest signature is invalid.');
  const identity = s.getOrCreateIdentity();
  const isMember = (workspace.members || []).some((m) => m.deviceId === identity.deviceId);
  if (!isMember) throw new Error('This device is not a member in this workspace access token.');
  s.workspaces = [workspace, ...s.workspaces.filter((w) => w.workspaceId !== workspace.workspaceId)];
  s.saveWorkspaces();
  return workspace;
}

function installOfflineInviteIpc() {
  try { ipcMain.removeHandler('company:inviteMember'); } catch {}
  ipcMain.handle('company:inviteMember', async (_event, payload = {}) => createSignedInvite(payload));
  for (const channel of ['company:createJoinRequest', 'company:approveJoinRequest', 'company:exportWorkspaceAccess', 'company:importWorkspaceAccess']) {
    try { ipcMain.removeHandler(channel); } catch {}
  }
  ipcMain.handle('company:createJoinRequest', async (_event, payload = {}) => createJoinRequest(payload));
  ipcMain.handle('company:approveJoinRequest', async (_event, payload = {}) => approveJoinRequest(payload));
  ipcMain.handle('company:exportWorkspaceAccess', async (_event, payload = {}) => exportWorkspaceAccess(payload));
  ipcMain.handle('company:importWorkspaceAccess', async (_event, payload = {}) => importWorkspaceAccess(payload));
  console.log('[company] level 1 offline invite approval IPC installed');
}

installOfflineInviteIpc();
