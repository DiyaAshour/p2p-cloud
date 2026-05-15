import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROLES = new Set(['owner', 'admin', 'manager', 'editor', 'viewer', 'guest']);
const MANAGE_ROLES = new Set(['owner', 'admin', 'manager']);
const UPLOAD_ROLES = new Set(['owner', 'admin', 'manager', 'editor']);
const DELETE_ROLES = new Set(['owner', 'admin', 'manager']);

function now() { return new Date().toISOString(); }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function safeReadJson(filePath, fallback) { try { if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath, 'utf8')) ?? fallback; } catch { return fallback; } }
function safeWriteJson(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function withoutSignatures(workspace) { const { signature, lastSignature, ...rest } = workspace || {}; return rest; }
function signPayload(privateKeyPem, value) { return crypto.sign(null, Buffer.from(canonicalJson(value), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64'); }
function verifyPayload(publicKeyPem, value, signature) { try { return crypto.verify(null, Buffer.from(canonicalJson(value), 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signature || ''), 'base64')); } catch { return false; } }
function roleCanManage(role) { return MANAGE_ROLES.has(role); }
function roleCanUpload(role) { return UPLOAD_ROLES.has(role); }
function roleCanDelete(role) { return DELETE_ROLES.has(role); }

export class CompanyWorkspaceStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.identityPath = path.join(dataDir, 'device-identity.json');
    this.workspacesPath = path.join(dataDir, 'company-workspaces.json');
    this.identity = null;
    this.workspaces = [];
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.identity = safeReadJson(this.identityPath, null);
    this.workspaces = safeReadJson(this.workspacesPath, []);
    if (!Array.isArray(this.workspaces)) this.workspaces = [];
    return this;
  }

  saveIdentity() { safeWriteJson(this.identityPath, this.identity); }
  saveWorkspaces() { safeWriteJson(this.workspacesPath, this.workspaces); }

  getOrCreateIdentity({ displayName = 'Device User', email = '' } = {}) {
    if (this.identity?.deviceId && this.identity?.privateKeyPem && this.identity?.publicKeyPem) return this.identity;
    const pair = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicFingerprint = crypto.createHash('sha256').update(publicKeyPem).digest('hex');
    this.identity = { deviceId: `device_${publicFingerprint.slice(0, 24)}`, displayName, email, publicKeyPem, privateKeyPem, publicFingerprint, createdAt: now(), keyType: 'ed25519-device-identity' };
    this.saveIdentity();
    return this.identity;
  }

  publicIdentity() { const { privateKeyPem, ...safeIdentity } = this.getOrCreateIdentity(); return safeIdentity; }

  signWorkspace(workspace) {
    const identity = this.getOrCreateIdentity();
    const unsigned = withoutSignatures({ ...workspace, updatedAt: now() });
    return { ...unsigned, signature: signPayload(identity.privateKeyPem, unsigned), signedByDeviceId: identity.deviceId, signedByPublicKeyPem: identity.publicKeyPem, signatureAlgorithm: 'ed25519' };
  }

  verifyWorkspace(workspace) {
    return verifyPayload(workspace.signedByPublicKeyPem || workspace.ownerDevicePublicKeyPem, withoutSignatures(workspace), workspace.signature);
  }

  listWorkspaces() { return this.workspaces.map((workspace) => ({ ...workspace, signatureValid: this.verifyWorkspace(workspace) })); }
  findWorkspace(workspaceId) { return this.workspaces.find((workspace) => workspace.workspaceId === workspaceId) || null; }
  localMember(workspace) { const identity = this.getOrCreateIdentity(); return workspace?.members?.find((member) => member.deviceId === identity.deviceId) || null; }
  localRole(workspace) { return this.localMember(workspace)?.role || null; }
  assertCanManage(workspace) { if (!roleCanManage(this.localRole(workspace))) throw new Error('Your company role cannot manage this workspace.'); }

  createWorkspace({ name, ownerWallet = '', companyPlanId = 'company-local' } = {}) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Company name is required.');
    const identity = this.getOrCreateIdentity({ displayName: cleanName });
    const workspaceId = `workspace_${crypto.randomUUID()}`;
    const workspace = this.signWorkspace({
      workspaceId,
      name: cleanName,
      ownerWallet: String(ownerWallet || '').toLowerCase(),
      ownerDeviceId: identity.deviceId,
      ownerDevicePublicKeyPem: identity.publicKeyPem,
      companyPlanId,
      status: 'active',
      version: 1,
      createdAt: now(),
      members: [{ memberId: `member_${crypto.randomUUID()}`, deviceId: identity.deviceId, displayName: identity.displayName || cleanName, email: identity.email || '', role: 'owner', status: 'active', publicKeyPem: identity.publicKeyPem, addedAt: now() }],
      files: [], folders: [], accessGroups: [],
      audit: [{ at: now(), action: 'workspace:create', byDeviceId: identity.deviceId, role: 'owner' }],
    });
    this.workspaces.push(workspace);
    this.saveWorkspaces();
    return workspace;
  }

  inviteMember({ workspaceId, email = '', displayName = '', role = 'viewer' } = {}) {
    if (!ROLES.has(role) || role === 'owner') throw new Error('Invalid invite role.');
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    this.assertCanManage(workspace);
    const identity = this.getOrCreateIdentity();
    const inviteToken = `chunknet://invite/${Buffer.from(JSON.stringify({ workspaceId, email, role, createdAt: now() }), 'utf8').toString('base64url')}`;
    const next = this.signWorkspace({ ...workspace, members: [...(workspace.members || []), { memberId: `member_${crypto.randomUUID()}`, deviceId: '', displayName: displayName || email || 'Invited member', email, role, status: 'invited', publicKeyPem: '', inviteToken, addedAt: now(), invitedByDeviceId: identity.deviceId }], audit: [...(workspace.audit || []), { at: now(), action: 'member:invite', byDeviceId: identity.deviceId, email, role }] });
    this.replaceWorkspace(next);
    return { workspace: next, inviteToken };
  }

  changeMemberRole({ workspaceId, memberId, role } = {}) {
    if (!ROLES.has(role)) throw new Error('Invalid role.');
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    this.assertCanManage(workspace);
    const identity = this.getOrCreateIdentity();
    const next = this.signWorkspace({ ...workspace, members: (workspace.members || []).map((member) => member.memberId === memberId && member.role !== 'owner' ? { ...member, role, updatedAt: now() } : member), audit: [...(workspace.audit || []), { at: now(), action: 'member:role', byDeviceId: identity.deviceId, memberId, role }] });
    this.replaceWorkspace(next);
    return next;
  }

  removeMember({ workspaceId, memberId } = {}) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    this.assertCanManage(workspace);
    const identity = this.getOrCreateIdentity();
    const next = this.signWorkspace({ ...workspace, members: (workspace.members || []).filter((member) => member.memberId !== memberId || member.role === 'owner'), audit: [...(workspace.audit || []), { at: now(), action: 'member:remove', byDeviceId: identity.deviceId, memberId }] });
    this.replaceWorkspace(next);
    return next;
  }

  addFile({ workspaceId, file, folder = '' } = {}) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    if (!roleCanUpload(this.localRole(workspace))) throw new Error('Your company role cannot upload files.');
    const identity = this.getOrCreateIdentity();
    const rootHash = file?.rootHash || file?.hash;
    if (!rootHash) throw new Error('File root hash is required.');
    const oldFiles = (workspace.files || []).filter((item) => item.rootHash !== rootHash && item.hash !== file.hash);
    const companyFile = {
      fileId: `file_${crypto.randomUUID()}`,
      rootHash,
      hash: file.hash,
      name: file.name,
      size: file.size,
      totalChunks: file.totalChunks,
      folder,
      uploadedAt: file.uploadedAt || now(),
      uploadedByDeviceId: identity.deviceId,
      uploadedByName: identity.displayName || 'Device User',
      hidden: false,
      deleted: false,
      visibleTo: { uploader: true, owner: true, admins: true, roles: ['owner', 'admin', 'manager', 'editor', 'viewer'], members: [] },
      permissions: { rename: ['uploader', 'owner', 'admin'], hide: ['uploader', 'owner', 'admin'], delete: ['uploader', 'owner', 'admin'], manageAccess: ['uploader', 'owner', 'admin'] },
      updatedAt: now(),
    };
    const next = this.signWorkspace({ ...workspace, files: [...oldFiles, companyFile], audit: [...(workspace.audit || []), { at: now(), action: 'file:add', byDeviceId: identity.deviceId, rootHash, name: file.name }] });
    this.replaceWorkspace(next);
    return { workspace: next, companyFile };
  }

  canControlFile(workspace, companyFile) {
    const identity = this.getOrCreateIdentity();
    const role = this.localRole(workspace);
    return companyFile?.uploadedByDeviceId === identity.deviceId || role === 'owner' || role === 'admin';
  }

  updateFile({ workspaceId, rootHash, patch = {} } = {}) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    const file = (workspace.files || []).find((item) => item.rootHash === rootHash || item.hash === rootHash);
    if (!file) throw new Error('Company file not found.');
    if (!this.canControlFile(workspace, file)) throw new Error('Only the file uploader, owner, or admin can modify this file.');
    const identity = this.getOrCreateIdentity();
    const allowedPatch = {};
    if (typeof patch.name === 'string' && patch.name.trim()) allowedPatch.name = patch.name.trim();
    if (typeof patch.folder === 'string') allowedPatch.folder = patch.folder;
    if (typeof patch.hidden === 'boolean') { allowedPatch.hidden = patch.hidden; allowedPatch.hiddenByDeviceId = patch.hidden ? identity.deviceId : ''; allowedPatch.hiddenAt = patch.hidden ? now() : null; }
    if (typeof patch.deleted === 'boolean') { allowedPatch.deleted = patch.deleted; allowedPatch.deletedByDeviceId = patch.deleted ? identity.deviceId : ''; allowedPatch.deletedAt = patch.deleted ? now() : null; }
    const nextFile = { ...file, ...allowedPatch, updatedAt: now() };
    const next = this.signWorkspace({ ...workspace, files: (workspace.files || []).map((item) => item.fileId === file.fileId ? nextFile : item), audit: [...(workspace.audit || []), { at: now(), action: 'file:update', byDeviceId: identity.deviceId, rootHash: file.rootHash, patch: Object.keys(allowedPatch) }] });
    this.replaceWorkspace(next);
    return { workspace: next, companyFile: nextFile };
  }

  visibleFiles(workspace) {
    const identity = this.getOrCreateIdentity();
    const role = this.localRole(workspace);
    return (workspace?.files || []).filter((file) => {
      if (file.deleted) return false;
      if (file.uploadedByDeviceId === identity.deviceId) return true;
      if (role === 'owner' || role === 'admin') return true;
      if (file.hidden) return false;
      const visible = file.visibleTo || {};
      if (Array.isArray(visible.roles) && visible.roles.includes(role)) return true;
      if (Array.isArray(visible.members) && visible.members.includes(identity.deviceId)) return true;
      return visible.allCompany === true;
    });
  }

  state() {
    return { ok: true, deviceIdentity: this.publicIdentity(), workspaces: this.listWorkspaces(), permissions: { roles: Array.from(ROLES), manageRoles: Array.from(MANAGE_ROLES), uploadRoles: Array.from(UPLOAD_ROLES), deleteRoles: Array.from(DELETE_ROLES) } };
  }

  replaceWorkspace(workspace) {
    this.workspaces = this.workspaces.map((item) => item.workspaceId === workspace.workspaceId ? workspace : item);
    this.saveWorkspaces();
  }
}

export function createCompanyWorkspaceStore({ dataDir }) { return new CompanyWorkspaceStore({ dataDir }).load(); }
