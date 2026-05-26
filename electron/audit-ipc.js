import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_AUDIT_EVENTS = Number(process.env.P2P_AUDIT_MAX_EVENTS || 1000);
const dataDir = () => path.join(app.getPath('userData'), 'native-p2p-storage');
const auditPath = () => path.join(dataDir(), 'audit-log.json');
const walletPath = () => path.join(dataDir(), 'wallet.json');

function ensure() {
  fs.mkdirSync(dataDir(), { recursive: true });
  if (!fs.existsSync(auditPath())) fs.writeFileSync(auditPath(), '[]', 'utf8');
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
function saveEvents(list) {
  writeJson(auditPath(), list.slice(-MAX_AUDIT_EVENTS));
}
function sanitizeDetails(details = {}) {
  if (!details || typeof details !== 'object') return {};
  const out = { ...details };
  for (const key of Object.keys(out)) {
    if (/password|secret|private|seed|token/i.test(key)) out[key] = '[redacted]';
  }
  return out;
}
export function recordAuditEvent(action, details = {}) {
  const event = {
    auditId: 'audit_' + crypto.randomBytes(12).toString('hex'),
    action: String(action || 'unknown'),
    actor: actor(),
    at: new Date().toISOString(),
    details: sanitizeDetails(details),
  };
  const next = [...events(), event];
  saveEvents(next);
  return event;
}
function listAudit(payload = {}) {
  const limit = Math.max(1, Math.min(500, Number(payload.limit || 200)));
  const workspaceId = String(payload.workspaceId || payload.companyId || '').trim();
  const action = String(payload.action || '').trim();
  let rows = events();
  if (workspaceId) rows = rows.filter((event) => String(event.details?.workspaceId || event.details?.companyId || '') === workspaceId);
  if (action) rows = rows.filter((event) => event.action === action);
  return { ok: true, events: rows.slice(-limit).reverse() };
}
function clearAudit(payload = {}) {
  const keepSystem = Boolean(payload.keepSystem);
  if (!keepSystem) {
    saveEvents([]);
    return { ok: true, cleared: true, events: [] };
  }
  const remaining = events().filter((event) => String(event.action || '').startsWith('system:'));
  saveEvents(remaining);
  return { ok: true, cleared: true, events: remaining.slice().reverse() };
}
export function installAuditHandlers() {
  for (const channel of ['audit:list', 'audit:record', 'audit:clear']) {
    try { ipcMain.removeHandler(channel); } catch {}
  }
  ipcMain.handle('audit:list', async (_event, payload = {}) => listAudit(payload));
  ipcMain.handle('audit:record', async (_event, payload = {}) => {
    const event = recordAuditEvent(payload.action, payload.details || {});
    return { ok: true, event };
  });
  ipcMain.handle('audit:clear', async (_event, payload = {}) => clearAudit(payload));
  recordAuditEvent('system:audit-ready', { source: 'electron' });
  console.log('[audit] IPC installed');
}

installAuditHandlers();
