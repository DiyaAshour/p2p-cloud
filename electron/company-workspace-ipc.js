import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { createCompanyWorkspaceStore } from './company-workspace-store.js';

let store = null;

function dataDir() {
  return path.join(app.getPath('userData'), 'native-p2p-storage');
}

function companyStore() {
  if (!store) store = createCompanyWorkspaceStore({ dataDir: dataDir() });
  return store;
}

function activeWalletAddress() {
  const handlers = ipcMain._invokeHandlers;
  const walletStatus = handlers?.get?.('wallet:status');
  return walletStatus ? walletStatus({}, {}).then((status) => status?.address || '') : Promise.resolve('');
}

function workspaceIdFromPayload(payload = {}) {
  return String(payload.workspaceId || payload.companyId || payload.id || '').trim();
}

function auditIdFor(workspaceId, event = {}, index = 0) {
  if (event.auditId) return String(event.auditId);

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ workspaceId, event, index }))
    .digest('hex')
    .slice(0, 32);
}

function auditDetails(event = {}, workspace = {}) {
  const details = event.details && typeof event.details === 'object' ? { ...event.details } : {};

  for (const [key, value] of Object.entries(event)) {
    if (
      [
        'auditId',
        'action',
        'actor',
        'at',
        'createdAt',
        'updatedAt',
        'details',
        'p2p',
      ].includes(key)
    ) {
      continue;
    }

    if (!(key in details)) details[key] = value;
  }

  if (!details.workspaceId) details.workspaceId = workspace.workspaceId;
  if (!details.workspaceName) details.workspaceName = workspace.name;

  return details;
}

function normalizeAuditEvent(workspace = {}, event = {}, index = 0) {
  const workspaceId = String(workspace.workspaceId || workspace.companyId || '').trim();
  const at = event.at || event.createdAt || event.updatedAt || workspace.updatedAt || new Date(0).toISOString();

  return {
    auditId: auditIdFor(workspaceId, event, index),
    action: String(event.action || 'audit:event'),
    actor: String(
      event.actor ||
        event.byDeviceId ||
        event.byWallet ||
        event.deviceId ||
        event.wallet ||
        workspace.signedByDeviceId ||
        workspace.ownerDeviceId ||
        ''
    ),
    at,
    details: auditDetails(event, { ...workspace, workspaceId }),
    p2p: event.p2p || null,
  };
}

function listAudit(payload = {}) {
  const s = companyStore();
  const targetWorkspaceId = workspaceIdFromPayload(payload);
  const limit = Math.max(1, Math.min(1000, Number(payload.limit || 200)));

  const workspaces = targetWorkspaceId
    ? [s.findWorkspace(targetWorkspaceId, { includeDeleted: true })].filter(Boolean)
    : s.listWorkspaces({ includeDeleted: true });

  const events = workspaces
    .flatMap((workspace) =>
      (Array.isArray(workspace.audit) ? workspace.audit : []).map((event, index) =>
        normalizeAuditEvent(workspace, event, index)
      )
    )
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);

  return { ok: true, events, count: events.length, workspaceId: targetWorkspaceId };
}

function recordAudit(payload = {}) {
  const s = companyStore();
  const targetWorkspaceId = workspaceIdFromPayload(payload) || workspaceIdFromPayload(payload.details || {});
  const workspace = targetWorkspaceId
    ? s.findWorkspace(targetWorkspaceId, { includeDeleted: true })
    : s.listWorkspaces({ includeDeleted: false })[0];

  if (!workspace) {
    return { ok: true, skipped: 'no-company-workspace', events: [] };
  }

  const identity = s.getOrCreateIdentity();
  const event = {
    auditId: `audit_${crypto.randomUUID()}`,
    at: new Date().toISOString(),
    action: String(payload.action || 'audit:record'),
    actor: identity.deviceId,
    byDeviceId: identity.deviceId,
    details: payload.details && typeof payload.details === 'object' ? payload.details : {},
    p2p: payload.p2p || null,
  };

  const next = s.signWorkspace({
    ...workspace,
    audit: [...(Array.isArray(workspace.audit) ? workspace.audit : []), event],
  });

  s.replaceWorkspace(next, { includeDeleted: true });

  return {
    ok: true,
    event: normalizeAuditEvent(next, event, next.audit.length - 1),
    ...listAudit({ workspaceId: next.workspaceId, limit: payload.limit || 200 }),
  };
}

function clearAudit(payload = {}) {
  const s = companyStore();
  const targetWorkspaceId = workspaceIdFromPayload(payload);
  const workspace = targetWorkspaceId ? s.findWorkspace(targetWorkspaceId, { includeDeleted: true }) : null;

  if (!workspace) throw new Error('Company workspace not found.');

  s.assertCanManage(workspace);

  const identity = s.getOrCreateIdentity();
  const clearedEvents = Array.isArray(workspace.audit) ? workspace.audit.length : 0;
  const event = {
    auditId: `audit_${crypto.randomUUID()}`,
    at: new Date().toISOString(),
    action: 'audit:clear',
    actor: identity.deviceId,
    byDeviceId: identity.deviceId,
    details: { workspaceId: workspace.workspaceId, workspaceName: workspace.name, clearedEvents },
  };

  const next = s.signWorkspace({ ...workspace, audit: [event] });
  s.replaceWorkspace(next, { includeDeleted: true });

  return { ok: true, clearedEvents, events: [normalizeAuditEvent(next, event, 0)] };
}

function listAuditManifests() {
  const s = companyStore();

  return {
    ok: true,
    manifests: s.listWorkspaces({ includeDeleted: true }).map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      auditEvents: Array.isArray(workspace.audit) ? workspace.audit.length : 0,
      folders: Array.isArray(workspace.folders) ? workspace.folders.length : 0,
      updatedAt: workspace.updatedAt || workspace.createdAt || null,
      signatureValid: s.verifyWorkspace(workspace),
    })),
  };
}

function installAuditIpc() {
  for (const channel of ['audit:list', 'audit:record', 'audit:clear', 'audit:listManifests']) {
    try { ipcMain.removeHandler(channel); } catch {}
  }

  ipcMain.handle('audit:list', async (_event, payload = {}) => listAudit(payload));
  ipcMain.handle('audit:record', async (_event, payload = {}) => recordAudit(payload));
  ipcMain.handle('audit:clear', async (_event, payload = {}) => clearAudit(payload));
  ipcMain.handle('audit:listManifests', async () => listAuditManifests());

  console.log('[company] audit IPC installed');
}

function installCompanyWorkspaceIpc() {
  try { ipcMain.removeHandler('company:state'); } catch {}
  ipcMain.handle('company:state', async () => companyStore().state());

  try { ipcMain.removeHandler('company:deviceIdentity'); } catch {}
  ipcMain.handle('company:deviceIdentity', async (_event, payload = {}) => companyStore().getOrCreateIdentity(payload));

  try { ipcMain.removeHandler('company:createWorkspace'); } catch {}
  ipcMain.handle('company:createWorkspace', async (_event, payload = {}) => {
    const ownerWallet = payload.ownerWallet || await activeWalletAddress();
    return companyStore().createWorkspace({ ...payload, ownerWallet });
  });

  try { ipcMain.removeHandler('company:deleteWorkspace'); } catch {}
  ipcMain.handle('company:deleteWorkspace', async (_event, payload = {}) => companyStore().deleteWorkspace(payload));

  try { ipcMain.removeHandler('company:inviteMember'); } catch {}
  ipcMain.handle('company:inviteMember', async (_event, payload = {}) => companyStore().inviteMember(payload));

  try { ipcMain.removeHandler('company:changeMemberRole'); } catch {}
  ipcMain.handle('company:changeMemberRole', async (_event, payload = {}) => companyStore().changeMemberRole(payload));

  try { ipcMain.removeHandler('company:removeMember'); } catch {}
  ipcMain.handle('company:removeMember', async (_event, payload = {}) => companyStore().removeMember(payload));

  try { ipcMain.removeHandler('company:addFile'); } catch {}
  ipcMain.handle('company:addFile', async (_event, payload = {}) => companyStore().addFile(payload));

  try { ipcMain.removeHandler('company:updateFile'); } catch {}
  ipcMain.handle('company:updateFile', async (_event, payload = {}) => companyStore().updateFile(payload));

  try { ipcMain.removeHandler('company:createFolder'); } catch {}
  ipcMain.handle('company:createFolder', async (_event, payload = {}) => companyStore().createFolder(payload));

  try { ipcMain.removeHandler('company:updateFolder'); } catch {}
  ipcMain.handle('company:updateFolder', async (_event, payload = {}) => companyStore().updateFolder(payload));

  try { ipcMain.removeHandler('company:deleteFolder'); } catch {}
  ipcMain.handle('company:deleteFolder', async (_event, payload = {}) => companyStore().deleteFolder(payload));

  installAuditIpc();

  console.log('[company] workspace IPC installed');
}

installCompanyWorkspaceIpc();
