import { ipcMain } from 'electron';
import { UI_PREFS_MANIFEST_KIND } from './core/config.js';
import { activeIdentity, assertVerifiedIdentity, normalizeIdentity } from './core/identity.js';
import { readWallet, readManifests, writeManifests } from './core/storage-json.js';

function prefsId(ownerWallet = '') {
  return `ui:prefs:${normalizeIdentity(ownerWallet)}`;
}

function sanitizePrefs(value = {}) {
  const prefs = value && typeof value === 'object' ? value : {};
  return {
    expandedFolderIds: Array.isArray(prefs.expandedFolderIds)
      ? Array.from(new Set(prefs.expandedFolderIds.map((id) => String(id || '').trim()).filter(Boolean)))
      : [],
    activeFolderId: typeof prefs.activeFolderId === 'string' ? prefs.activeFolderId : '',
    activeView: typeof prefs.activeView === 'string' ? prefs.activeView : '',
  };
}

function readIdentity() {
  const wallet = readWallet();
  assertVerifiedIdentity(wallet);
  return activeIdentity(wallet);
}

function findPrefsManifest(manifests = [], ownerWallet = '') {
  const id = prefsId(ownerWallet);
  return manifests.find((item) =>
    normalizeIdentity(item.ownerWallet) === ownerWallet &&
    (
      item.kind === UI_PREFS_MANIFEST_KIND ||
      item.type === 'ui-prefs' ||
      item.id === id ||
      item.hash === id ||
      item.rootHash === id
    )
  ) || null;
}

function getUiPrefs() {
  const ownerWallet = readIdentity();
  const manifest = findPrefsManifest(readManifests(), ownerWallet);
  return sanitizePrefs(manifest?.prefs || manifest?.uiPrefs || manifest || {});
}

function setUiPrefs(payload = {}) {
  const ownerWallet = readIdentity();
  const current = readManifests();
  const id = prefsId(ownerWallet);
  const now = new Date().toISOString();
  const prefs = sanitizePrefs(payload);
  const existing = findPrefsManifest(current, ownerWallet);

  const nextPrefs = sanitizePrefs({
    ...(existing?.prefs || existing?.uiPrefs || {}),
    ...prefs,
  });

  const manifest = {
    ...(existing || {}),
    id,
    hash: id,
    rootHash: id,
    kind: UI_PREFS_MANIFEST_KIND,
    type: 'ui-prefs',
    name: '__ui_prefs__',
    ownerWallet,
    visibility: 'private',
    isPublic: false,
    isEncrypted: false,
    size: 0,
    storedSize: 0,
    totalChunks: 0,
    chunks: [],
    replicas: [],
    prefs: nextPrefs,
    updatedAt: now,
    createdAt: existing?.createdAt || now,
  };

  const withoutOld = current.filter((item) => item !== existing && !(normalizeIdentity(item.ownerWallet) === ownerWallet && (item.id === id || item.hash === id || item.rootHash === id)));
  withoutOld.push(manifest);
  writeManifests(withoutOld);

  return nextPrefs;
}

try { ipcMain.removeHandler('p2p:getUiPrefs'); } catch {}
ipcMain.handle('p2p:getUiPrefs', async () => getUiPrefs());

try { ipcMain.removeHandler('p2p:setUiPrefs'); } catch {}
ipcMain.handle('p2p:setUiPrefs', async (_event, payload = {}) => setUiPrefs(payload));

console.log('[ui-prefs] p2p:getUiPrefs and p2p:setUiPrefs IPC installed');
