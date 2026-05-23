import { dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

function cleanFolderId(value = '') {
  return String(value || '').replace(/^folder:/, '').trim();
}

function sameFolderId(a = '', b = '') {
  return cleanFolderId(a) === cleanFolderId(b);
}

function cleanFolderName(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function getHandler(channel) {
  const handler = ipcMain._invokeHandlers?.get?.(channel);
  if (!handler) throw new Error(`Required IPC handler is missing: ${channel}`);
  return handler;
}

async function invoke(channel, event, payload = {}) {
  return getHandler(channel)(event, payload);
}

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
}

function* walkDirectories(dir) {
  yield dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDirectories(fullPath);
  }
}

async function listFolders(event) {
  const folders = await invoke('p2p:listFolders', event, {});
  return Array.isArray(folders) ? folders : [];
}

function findFolder(folders = [], parentFolderId = '', name = '') {
  const wanted = cleanFolderName(name).toLowerCase();
  return folders.find((folder) => {
    if (!folder) return false;
    return sameFolderId(folder.parentFolderId || '', parentFolderId) &&
      cleanFolderName(folder.name || '').toLowerCase() === wanted;
  }) || null;
}

async function ensureFolder(event, { name, parentFolderId = '' }) {
  const cleanName = cleanFolderName(name);
  if (!cleanName) throw new Error('Folder name is required');

  const existing = findFolder(await listFolders(event), parentFolderId, cleanName);
  if (existing?.folderId) return existing;

  const result = await invoke('p2p:createFolder', event, {
    name: cleanName,
    parentFolderId: cleanFolderId(parentFolderId),
  });

  if (result?.folder?.folderId) return result.folder;
  if (result?.folderId) return result;

  const folders = Array.isArray(result?.folders) ? result.folders : await listFolders(event);
  const created = findFolder(folders, parentFolderId, cleanName);
  if (created?.folderId) return created;

  throw new Error(`Folder was created but folderId was not returned: ${cleanName}`);
}

function folderPathLabel(parts = []) {
  return parts.map(cleanFolderName).filter(Boolean).join(' / ');
}

async function buildFolderTree(event, rootDir, baseParentFolderId = '') {
  const rootParent = path.dirname(rootDir);
  const idByAbsDir = new Map();
  const partsByAbsDir = new Map();

  async function ensureDir(dirPath) {
    const absDir = path.resolve(dirPath);
    if (idByAbsDir.has(absDir)) {
      return { folderId: idByAbsDir.get(absDir), parts: partsByAbsDir.get(absDir) || [] };
    }

    const parts = path.relative(rootParent, absDir).split(path.sep).filter(Boolean);
    let parentFolderId = cleanFolderId(baseParentFolderId);
    let currentAbs = rootParent;
    const builtParts = [];

    for (const part of parts) {
      currentAbs = path.join(currentAbs, part);
      const absCurrent = path.resolve(currentAbs);
      builtParts.push(part);

      if (idByAbsDir.has(absCurrent)) {
        parentFolderId = idByAbsDir.get(absCurrent);
        continue;
      }

      const folder = await ensureFolder(event, { name: part, parentFolderId });
      parentFolderId = folder.folderId;
      idByAbsDir.set(absCurrent, parentFolderId);
      partsByAbsDir.set(absCurrent, [...builtParts]);
    }

    idByAbsDir.set(absDir, parentFolderId);
    partsByAbsDir.set(absDir, parts);
    return { folderId: parentFolderId, parts };
  }

  for (const dirPath of walkDirectories(rootDir)) {
    await ensureDir(dirPath);
  }

  return ensureDir;
}

async function uploadFolderStreaming(event, payload = {}) {
  const picked = await dialog.showOpenDialog({
    title: 'Upload folder',
    properties: ['openDirectory'],
  });

  if (picked.canceled || !picked.filePaths?.length) {
    return { ok: true, cancelled: true, files: [] };
  }

  const rootDir = picked.filePaths[0];
  const baseParentFolderId = cleanFolderId(payload.folderId || payload.parentFolderId || '');
  const ensureDir = await buildFolderTree(event, rootDir, baseParentFolderId);
  const files = [];

  for (const filePath of walkFiles(rootDir)) {
    const target = await ensureDir(path.dirname(filePath));
    const result = await invoke('p2p:uploadPath', event, {
      ...payload,
      filePath,
      path: filePath,
      folderId: target.folderId,
      parentFolderId: target.folderId,
      folderPath: folderPathLabel(target.parts),
    });

    if (result?.file) files.push(result.file);
    else if (result && !result.cancelled && result.hash) files.push(result);
  }

  const summaryHandler = ipcMain._invokeHandlers?.get?.('p2p:networkSummary');
  const summary = summaryHandler ? await summaryHandler(event, {}) : null;
  return { ok: true, cancelled: false, files, summary };
}

try { ipcMain.removeHandler('p2p:uploadFolder'); } catch {}
ipcMain.handle('p2p:uploadFolder', uploadFolderStreaming);
console.log('[stream-folder-upload] installed folder upload override using p2p:uploadPath streaming path');
