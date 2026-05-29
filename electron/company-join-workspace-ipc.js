import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { createCompanyWorkspaceStore } from './company-workspace-store.js';

const ROLES = new Set(['owner', 'admin', 'manager', 'editor', 'viewer', 'guest']);
let store = null;

function dataDir() {
  return path.join(app.getPath('userData'), 'native-p2p-storage');
}

function companyStore() {
  if (!store) store = createCompanyWorkspaceStore({ dataDir: dataDir() });
  return store;
}

function now() {
  return new Date().toISOString();
}

function encodeInvitePayload(payload = {}) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeInviteToken(inviteToken = '') {
  const raw = String(inviteToken || '').trim();
  if (!raw) throw new Error('Invite token is required.');

  const encoded = raw.startsWith('chunknet://invite/')
    ? raw.slice('chunknet://invite/'.length)
    : raw;

  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid company invite token.');
  }
}

function normalizeFolders(folders = [], workspaceId = '') {
  const map = new Map();

  for (const raw of Array.isArray(folders) ? folders : []) {
    const folderId = String(raw?.folderId || raw?.id || raw?.hash || raw?.rootHash || '').trim();
    const name = String(raw?.name || '').trim().replace(/\s+/g, ' ');
    if (!folderId || !name) continue;

    map.set(folderId, {
      ...raw,
      id: raw.id || folderId,
      folderId,
      name,
      parentFolderId: String(raw.parentFolderId || '').trim(),
      workspaceId,
      kind: 'company-folder',
      isFolder: true,
      updatedAt: raw.updatedAt || raw.createdAt || now(),
    });
  }

  return Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function publicWorkspaceSnapshot(workspace = {}) {
  return {
    ...workspace,
    folders: normalizeFolders(workspace.folders || [], workspace.workspaceId),
    files: Array.isArray(workspace.files) ? workspace.files : [],
    members: Array.isArray(workspace.members) ? workspace.members : [],
    audit: Array.isArray(workspace.audit) ? workspace.audit.slice(-200) : [],
  };
}

function findExistingWorkspace(storeInstance, workspaceId) {
  try {
    return storeInstance.findWorkspace(workspaceId, { includeDeleted: true });
  } catch {
    return null;
  }
}

async function inviteMemberWithPortableToken(payload = {}) {
  const s = companyStore();
  const result = s.inviteMember(payload);
  const workspace = result?.workspace;

  if (!workspace?.workspaceId) return result;

  const invited = [...(workspace.members || [])]
    .reverse()
    .find((member) => member.status === 'invited' && (!payload.email || member.email === payload.email));

  const invitePayload = {
    version: 2,
    type: 'chunknet-company-invite',
    workspaceId: workspace.workspaceId,
    email: payload.email || invited?.email || '',
    role: payload.role || invited?.role || 'viewer',
    invitedMemberId: invited?.memberId || '',
    createdAt: now(),
    workspace: publicWorkspaceSnapshot(workspace),
  };

  const inviteToken = `chunknet://invite/${encodeInvitePayload(invitePayload)}`;

  return {
    ...result,
    inviteToken,
    portableInvite: true,
  };
}

async function joinWorkspace(payload = {}) {
  const s = companyStore();
  const invite = decodeInviteToken(payload.inviteToken);
  const workspaceId = String(invite.workspaceId || invite.workspace?.workspaceId || '').trim();

  if (!workspaceId) throw new Error('Invite token missing workspaceId.');

  const importedWorkspace = invite.workspace && typeof invite.workspace === 'object'
    ? invite.workspace
    : findExistingWorkspace(s, workspaceId);

  if (!importedWorkspace) {
    throw new Error('Invite token does not include workspace data. Ask the owner to generate a new invite.');
  }

  const identity = s.getOrCreateIdentity({
    displayName: payload.displayName || payload.email || 'Company Member',
    email: payload.email || invite.email || '',
  });

  const role = ROLES.has(invite.role) && invite.role !== 'owner' ? invite.role : 'viewer';
  const existing = findExistingWorkspace(s, workspaceId);
  const base = existing || importedWorkspace;
  const members = Array.isArray(base.members) ? base.members : [];
  const invitedMemberId = String(invite.invitedMemberId || '').trim();

  let claimed = false;

  let nextMembers = members.map((member) => {
    const sameDevice = member.deviceId && member.deviceId === identity.deviceId;
    const matchingInvite =
      (invitedMemberId && member.memberId === invitedMemberId) ||
      (!member.deviceId && invite.email && String(member.email || '').toLowerCase() === String(invite.email).toLowerCase());

    if (sameDevice || (!claimed && matchingInvite)) {
      claimed = true;
      return {
        ...member,
        deviceId: identity.deviceId,
        displayName: payload.displayName || member.displayName || identity.displayName || 'Company Member',
        email: payload.email || member.email || identity.email || invite.email || '',
        role: member.role === 'owner' ? 'owner' : (member.role || role),
        status: 'active',
        publicKeyPem: identity.publicKeyPem,
        joinedAt: member.joinedAt || now(),
        updatedAt: now(),
      };
    }

    return member;
  });

  if (!claimed) {
    nextMembers = [
      ...nextMembers,
      {
        memberId: `member_${crypto.randomUUID()}`,
        deviceId: identity.deviceId,
        displayName: payload.displayName || identity.displayName || payload.email || 'Company Member',
        email: payload.email || identity.email || invite.email || '',
        role,
        status: 'active',
        publicKeyPem: identity.publicKeyPem,
        joinedAt: now(),
      },
    ];
  }

  const next = s.signWorkspace({
    ...base,
    workspaceId,
    status: 'active',
    folders: normalizeFolders(base.folders || [], workspaceId),
    members: nextMembers,
    audit: [
      ...(Array.isArray(base.audit) ? base.audit : []),
      {
        at: now(),
        action: 'workspace:join',
        byDeviceId: identity.deviceId,
        role,
        email: payload.email || invite.email || '',
      },
    ],
  });

  s.replaceWorkspace(next, { includeDeleted: true });

  return {
    ok: true,
    workspace: next,
    deviceIdentity: s.publicIdentity(),
  };
}

try { ipcMain.removeHandler('company:inviteMember'); } catch {}
ipcMain.handle('company:inviteMember', async (_event, payload = {}) => inviteMemberWithPortableToken(payload));

try { ipcMain.removeHandler('company:joinWorkspace'); } catch {}
ipcMain.handle('company:joinWorkspace', async (_event, payload = {}) => joinWorkspace(payload));

console.log('[company] portable invite + join workspace IPC installed');
