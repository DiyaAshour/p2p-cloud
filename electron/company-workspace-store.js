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
function isActiveWorkspace(workspace = {}) { return !workspace.deleted && workspace.status !== 'deleted' && workspace.status !== 'archived'; }
function cleanName(name = '') { return String(name || '').trim().replace(/\s+/g, ' '); }

function normalizeFolder(folder = {}, workspaceId = '') {
  const folderId = String(folder.folderId || folder.id || folder.hash || folder.rootHash || '').trim();
  const name = cleanName(folder.name);
  if (!folderId || !name) return null;
  return {
    ...folder,
    id: folder.id || folderId,
    folderId,
    name,
    parentFolderId: String(folder.parentFolderId || '').trim(),
    workspaceId,
    kind: 'company-folder',
    isFolder: true,
    updatedAt: folder.updatedAt || folder.createdAt || now(),
  };
}

function normalizeFolders(folders = [], workspaceId = '') {
  const map = new Map();
  for (const raw of Array.isArray(folders) ? folders : []) {
    const folder = normalizeFolder(raw, workspaceId);
    if (folder) map.set(folder.folderId, folder);
  }
  return Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function folderMap(folders = []) {
  const map = new Map();
  for (const folder of folders) map.set(folder.folderId, folder);
  return map;
}

function folderPathById(folders = [], folderId = '') {
  const map = folderMap(folders);
  const names = [];
  const seen = new Set();
  let cursor = map.get(String(folderId || '').trim());

  while (cursor) {
    if (seen.has(cursor.folderId)) break;
    seen.add(cursor.folderId);
    names.unshift(cursor.name);
    cursor = cursor.parentFolderId ? map.get(cursor.parentFolderId) : null;
  }

  return names.join(' / ');
}

function collectDescendantFolderIds(folders = [], folderId = '') {
  const ids = new Set([String(folderId || '').trim()].filter(Boolean));
  let changed = true;

  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentFolderId && ids.has(folder.parentFolderId) && !ids.has(folder.folderId)) {
        ids.add(folder.folderId);
        changed = true;
      }
    }
  }

  return ids;
}

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
    this.workspaces = this.workspaces.map((workspace) => ({
      ...workspace,
      folders: normalizeFolders(workspace.folders || [], workspace.workspaceId),
    }));
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
    const unsigned = withoutSignatures({
      ...workspace,
      folders: normalizeFolders(workspace.folders || [], workspace.workspaceId),
      updatedAt: now(),
    });
    return { ...unsigned, signature: signPayload(identity.privateKeyPem, unsigned), signedByDeviceId: identity.deviceId, signedByPublicKeyPem: identity.publicKeyPem, signatureAlgorithm: 'ed25519' };
  }

  verifyWorkspace(workspace) {
    return verifyPayload(workspace.signedByPublicKeyPem || workspace.ownerDevicePublicKeyPem, withoutSignatures(workspace), workspace.signature);
  }

  listWorkspaces({ includeDeleted = false } = {}) { return this.workspaces.filter((workspace) => includeDeleted || isActiveWorkspace(workspace)).map((workspace) => ({ ...workspace, folders: normalizeFolders(workspace.folders || [], workspace.workspaceId), signatureValid: this.verifyWorkspace(workspace) })); }
  findWorkspace(workspaceId, { includeDeleted = false } = {}) { const workspace = this.workspaces.find((item) => item.workspaceId === workspaceId) || null; if (!workspace) return null; if (!includeDeleted && !isActiveWorkspace(workspace)) return null; return { ...workspace, folders: normalizeFolders(workspace.folders || [], workspace.workspaceId) }; }
  localMember(workspace) { const identity = this.getOrCreateIdentity(); return workspace?.members?.find((member) => member.deviceId === identity.deviceId) || null; }
  localRole(workspace) { return this.localMember(workspace)?.role || null; }
  assertCanManage(workspace) { if (!roleCanManage(this.localRole(workspace))) throw new Error('Your company role cannot manage this workspace.'); }
  assertCanDeleteWorkspace(workspace) { if (this.localRole(workspace) !== 'owner') throw new Error('Only the company owner can delete this workspace.'); }

  createWorkspace({ name, ownerWallet = '', companyPlanId = 'company-local' } = {}) {
    const clean = cleanName(name);
    if (!clean) throw new Error('Company name is required.');
    const identity = this.getOrCreateIdentity({ displayName: clean });
    const workspaceId = `workspace_${crypto.randomUUID()}`;
    const workspace = this.signWorkspace({
      workspaceId,
      name: clean,
      ownerWallet: String(ownerWallet || '').toLowerCase(),
      ownerDeviceId: identity.deviceId,
      ownerDevicePublicKeyPem: identity.publicKeyPem,
      companyPlanId,
      status: 'active',
      version: 1,
      createdAt: now(),
      members: [{ memberId: `member_${crypto.randomUUID()}`, deviceId: identity.deviceId, displayName: identity.displayName || clean, email: identity.email || '', role: 'owner', status: 'active', publicKeyPem: identity.publicKeyPem, addedAt: now() }],
      files: [], folders: [], accessGroups: [],
      audit: [{ at: now(), action: 'workspace:create', byDeviceId: identity.deviceId, role: 'owner' }],
    });
    this.workspaces.push(workspace);
    this.saveWorkspaces();
    return workspace;
  }

  deleteWorkspace({ workspaceId } = {}) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    this.assertCanDeleteWorkspace(workspace);
    const identity = this.getOrCreateIdentity();
    const next = this.signWorkspace({
      ...workspace,
      status: 'deleted',
      deleted: true,
      deletedAt: now(),
      deletedByDeviceId: identity.deviceId,
      audit: [...(workspace.audit || []), { at: now(), action: 'workspace:delete', byDeviceId: identity.deviceId, role: 'owner', mode: 'soft-delete' }],
    });
    this.replaceWorkspace(next, { includeDeleted: true });
    return { ok: true, workspace: next };
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

  createFolder({ workspaceId, name = '', parentFolderId = '' } = {}) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    this.assertCanManage(workspace);

    const clean = cleanName(name);
    if (!clean) throw new Error('Folder name is required.');

    const folders = normalizeFolders(workspace.folders || [], workspace.workspaceId);
    const parentId = String(parentFolderId || '').trim();
    if (parentId && !folders.some((folder) => folder.folderId === parentId)) throw new Error('Parent folder not found.');

    const duplicate = folders.some((folder) => String(folder.parentFolderId || '') === parentId && folder.name.toLowerCase() === clean.toLowerCase());
    if (duplicate) throw new Error('Folder already exists in this location.');

    const identity = this.getOrCreateIdentity();
    const folder = {
      id: `company_folder_${crypto.randomUUID()}`,
      folderId: `company_folder_${crypto.randomUUID()}`,
      workspaceId: workspace.workspaceId,
      name: clean,
      parentFolderId: parentId,
      kind: 'company-folder',
      isFolder: true,
      createdAt: now(),
      updatedAt: now(),
      createdByDeviceId: identity.deviceId,
      sortKey: clean.toLowerCase(),
    };

    folder.id = folder.folderId;

    const nextFolders = [...folders, folder];
    const next = this.signWorkspace({
      ...workspace,
      folders: nextFolders,
      audit: [...(workspace.audit || []), { at: now(), action: 'folder:create', byDeviceId: identity.deviceId, folderId: folder.folderId, name: folder.name, parentFolderId: parentId }],
    });

    this.replaceWorkspace(next);
    return { ok: true, workspace: next, folder, folders: next.folders || [] };
  }

  updateFolder({ workspaceId, folderId, patch = {} } = {}) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    this.assertCanManage(workspace);

    const folders = normalizeFolders(workspace.folders || [], workspace.workspaceId);
    const targetId = String(folderId || '').trim();
    const folder = folders.find((item) => item.folderId === targetId);
    if (!folder) throw new Error('Company folder not found.');

    const identity = this.getOrCreateIdentity();
    const nextParentId = patch.parentFolderId === undefined ? folder.parentFolderId || '' : String(patch.parentFolderId || '').trim();
    const name = typeof patch.name === 'string' && cleanName(patch.name) ? cleanName(patch.name) : folder.name;

    if (nextParentId === targetId) throw new Error('Cannot move folder inside itself.');
    if (nextParentId && !folders.some((item) => item.folderId === nextParentId)) throw new Error('Target folder not found.');
    const descendantIds = collectDescendantFolderIds(folders, targetId);
    if (nextParentId && descendantIds.has(nextParentId)) throw new Error('Cannot move folder inside its child.');

    const duplicate = folders.some((item) => item.folderId !== targetId && String(item.parentFolderId || '') === nextParentId && item.name.toLowerCase() === name.toLowerCase());
    if (duplicate) throw new Error('Folder already exists in this location.');

    const nextFolder = { ...folder, name, parentFolderId: nextParentId, updatedAt: now(), updatedByDeviceId: identity.deviceId, sortKey: name.toLowerCase() };
    const nextFolders = folders.map((item) => item.folderId === targetId ? nextFolder : item);
    const pathAfter = folderPathById(nextFolders, targetId);
    const descendantAfter = collectDescendantFolderIds(nextFolders, targetId);

    const nextFiles = (workspace.files || []).map((file) => {
      if (!descendantAfter.has(String(file.folderId || ''))) return file;
      return { ...file, folderPath: folderPathById(nextFolders, file.folderId), folder: folderPathById(nextFolders, file.folderId), updatedAt: now() };
    });

    const next = this.signWorkspace({
      ...workspace,
      folders: nextFolders,
      files: nextFiles,
      audit: [...(workspace.audit || []), { at: now(), action: 'folder:update', byDeviceId: identity.deviceId, folderId: targetId, name, parentFolderId: nextParentId, path: pathAfter }],
    });

    this.replaceWorkspace(next);
    return { ok: true, workspace: next, folder: nextFolder, folders: next.folders || [] };
  }

  deleteFolder({ workspaceId, folderId, fileDisposition = 'move', targetFolderId = '' } = {}) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    this.assertCanManage(workspace);

    const folders = normalizeFolders(workspace.folders || [], workspace.workspaceId);
    const targetId = String(folderId || '').trim();
    const folder = folders.find((item) => item.folderId === targetId);
    if (!folder) throw new Error('Company folder not found.');

    const deleteIds = collectDescendantFolderIds(folders, targetId);
    const moveTargetId = String(targetFolderId || '').trim();
    const deleteFilesToo = String(fileDisposition || '').toLowerCase() === 'delete';

    if (moveTargetId && deleteIds.has(moveTargetId)) throw new Error('Cannot move files into a folder being deleted.');
    if (moveTargetId && !folders.some((item) => item.folderId === moveTargetId)) throw new Error('Target folder not found.');

    const identity = this.getOrCreateIdentity();
    const remainingFolders = folders.filter((item) => !deleteIds.has(item.folderId));
    const targetPath = moveTargetId ? folderPathById(remainingFolders, moveTargetId) : '';

    const nextFiles = (workspace.files || []).map((file) => {
      if (!deleteIds.has(String(file.folderId || ''))) return file;
      if (deleteFilesToo) {
        return { ...file, deleted: true, deletedAt: now(), deletedByDeviceId: identity.deviceId, updatedAt: now() };
      }
      return { ...file, folderId: moveTargetId, parentFolderId: moveTargetId, folderPath: targetPath, folder: targetPath, updatedAt: now() };
    });

    const next = this.signWorkspace({
      ...workspace,
      folders: remainingFolders,
      files: nextFiles,
      audit: [...(workspace.audit || []), { at: now(), action: 'folder:delete', byDeviceId: identity.deviceId, folderId: targetId, name: folder.name, removedFolders: deleteIds.size, fileDisposition: deleteFilesToo ? 'delete' : 'move', targetFolderId: moveTargetId }],
    });

    this.replaceWorkspace(next);
    return { ok: true, workspace: next, deletedFolderId: targetId, removedFolderIds: Array.from(deleteIds), folders: next.folders || [] };
  }

  addFile({ workspaceId, file, folder = '', folderId = '', folderPath = '' } = {}) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) throw new Error('Workspace not found.');
    if (!roleCanUpload(this.localRole(workspace))) throw new Error('Your company role cannot upload files.');
    const identity = this.getOrCreateIdentity();
    const rootHash = file?.rootHash || file?.hash;
    if (!rootHash) throw new Error('File root hash is required.');

    const folders = normalizeFolders(workspace.folders || [], workspace.workspaceId);
    const cleanFolderId = String(folderId || '').trim();
    const effectiveFolderPath = cleanFolderId ? folderPathById(folders, cleanFolderId) : String(folderPath || folder || '').trim();
    const oldFiles = (workspace.files || []).filter((item) => item.rootHash !== rootHash && item.hash !== file.hash);
    const companyFile = {
      fileId: `file_${crypto.randomUUID()}`,
      rootHash,
      hash: file.hash,
      name: file.name,
      size: file.size,
      totalChunks: file.totalChunks,
      folder: effectiveFolderPath,
      folderId: cleanFolderId,
      parentFolderId: cleanFolderId,
      folderPath: effectiveFolderPath,
      uploadedAt: file.uploadedAt || now(),
      uploadedByDeviceId: identity.deviceId,
      uploadedByName: identity.displayName || 'Device User',
      hidden: false,
      deleted: false,
      visibleTo: { uploader: true, owner: true, admins: true, roles: ['owner', 'admin', 'manager', 'editor', 'viewer'], members: [] },
      permissions: { rename: ['uploader', 'owner', 'admin'], hide: ['uploader', 'owner', 'admin'], delete: ['uploader', 'owner', 'admin'], manageAccess: ['uploader', 'owner', 'admin'] },
      updatedAt: now(),
    };
    const next = this.signWorkspace({ ...workspace, folders, files: [...oldFiles, companyFile], audit: [...(workspace.audit || []), { at: now(), action: 'file:add', byDeviceId: identity.deviceId, rootHash, name: file.name, folderId: cleanFolderId, folderPath: effectiveFolderPath }] });
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
    const folders = normalizeFolders(workspace.folders || [], workspace.workspaceId);
    const allowedPatch = {};
    if (typeof patch.name === 'string' && patch.name.trim()) allowedPatch.name = patch.name.trim();
    if (typeof patch.folder === 'string') allowedPatch.folder = patch.folder;
    if (typeof patch.folderPath === 'string') allowedPatch.folderPath = patch.folderPath;
    if (typeof patch.folderId === 'string') {
      const folderId = patch.folderId.trim();
      if (folderId && !folders.some((folder) => folder.folderId === folderId)) throw new Error('Target folder not found.');
      allowedPatch.folderId = folderId;
      allowedPatch.parentFolderId = folderId;
      allowedPatch.folderPath = folderId ? folderPathById(folders, folderId) : '';
      allowedPatch.folder = allowedPatch.folderPath;
    }
    if (typeof patch.hidden === 'boolean') { allowedPatch.hidden = patch.hidden; allowedPatch.hiddenByDeviceId = patch.hidden ? identity.deviceId : ''; allowedPatch.hiddenAt = patch.hidden ? now() : null; }
    if (typeof patch.deleted === 'boolean') { allowedPatch.deleted = patch.deleted; allowedPatch.deletedByDeviceId = patch.deleted ? identity.deviceId : ''; allowedPatch.deletedAt = patch.deleted ? now() : null; }
    const nextFile = { ...file, ...allowedPatch, updatedAt: now() };
    const next = this.signWorkspace({ ...workspace, folders, files: (workspace.files || []).map((item) => item.fileId === file.fileId ? nextFile : item), audit: [...(workspace.audit || []), { at: now(), action: 'file:update', byDeviceId: identity.deviceId, rootHash: file.rootHash, patch: Object.keys(allowedPatch) }] });
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

  replaceWorkspace(workspace, { includeDeleted = false } = {}) {
    const normalized = { ...workspace, folders: normalizeFolders(workspace.folders || [], workspace.workspaceId) };
    const exists = this.workspaces.some((item) => item.workspaceId === normalized.workspaceId);
    if (!exists && includeDeleted) this.workspaces.push(normalized);
    else if (!exists) this.workspaces.push(normalized);
    else this.workspaces = this.workspaces.map((item) => item.workspaceId === normalized.workspaceId ? normalized : item);
    this.saveWorkspaces();
  }
}

export function createCompanyWorkspaceStore({ dataDir }) { return new CompanyWorkspaceStore({ dataDir }).load(); }
