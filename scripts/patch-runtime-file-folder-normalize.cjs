const fs = require('node:fs');
const path = require('node:path');

const runtimeFiles = [
  path.join(process.cwd(), 'electron', 'main.js'),
  path.join(process.cwd(), 'electron', 'main-stable.js'),
];

function findHandlerEnd(source, start) {
  let quote = null;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  let parens = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') parens += 1;
    if (ch === ')') {
      parens -= 1;
      if (parens === 0 && source[i + 1] === ';') return i + 2;
    }
  }
  return -1;
}

function replaceIpcHandler(source, channel, handler) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = source.indexOf(marker);
  if (start === -1) return source;
  const end = findHandlerEnd(source, start);
  if (end === -1) return source;
  return `${source.slice(0, start)}${handler}${source.slice(end)}`;
}

const listFilesHandler = String.raw`ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => {
  if (!walletState.connected || !walletState.verified) return [];
  await syncPull();
  const query = String(payload.query || '').trim().toLowerCase();
  const folders = typeof walletFolderManifests === 'function' ? walletFolderManifests() : walletManifests().filter((m) => m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:'));
  const files = typeof walletFileManifests === 'function' ? walletFileManifests() : walletManifests().filter((m) => !(m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:')));
  const folderById = new Map();
  const folderByName = new Map();
  for (const folder of folders) {
    const name = String(folder.name || '').trim();
    if (name) folderByName.set(name.toLowerCase(), folder);
    for (const id of [folder.folderId, folder.id, folder.hash, folder.rootHash].filter(Boolean)) folderById.set(String(id), folder);
  }
  const changed = [];
  for (const file of files) {
    const rawId = String(file.parentFolderId || file.folderId || '').trim();
    const rawName = String(file.folderName || file.folder || '').trim();
    const folder = (rawId && folderById.get(rawId)) || (rawName && folderByName.get(rawName.toLowerCase())) || null;
    const nextFolderId = folder ? String(folder.folderId || '') : '';
    const nextFolderName = folder ? String(folder.name || '') : '';
    if (String(file.folderId || '') !== nextFolderId || String(file.parentFolderId || '') !== nextFolderId || String(file.folderName || '') !== nextFolderName || String(file.folder || '') !== nextFolderName) {
      file.folderId = nextFolderId;
      file.parentFolderId = nextFolderId;
      file.folderName = nextFolderName;
      file.folder = nextFolderName;
      file.updatedAt = new Date().toISOString();
      changed.push(file);
    }
  }
  if (changed.length) {
    persistManifests();
    for (const file of changed) await syncPush(file);
    console.log('[p2p:listFiles] normalized stale folder labels', changed.length);
  }
  if (!query) return files;
  return files.filter((f) => [f.name, f.hash, f.rootHash, f.ownerWallet || '', f.folderName || '', f.folder || ''].some((v) => String(v || '').toLowerCase().includes(query)));
});`;

for (const file of runtimeFiles) {
  if (!fs.existsSync(file)) continue;
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  src = replaceIpcHandler(src, 'p2p:listFiles', listFilesHandler);
  if (src !== before) {
    fs.writeFileSync(file, src, 'utf8');
    console.log(`[runtime-file-folder-normalize] patched p2p:listFiles in ${file}`);
  } else {
    console.warn(`[runtime-file-folder-normalize] p2p:listFiles handler not replaced in ${file}`);
  }
}
