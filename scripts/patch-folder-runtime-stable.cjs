const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const stablePath = path.join(root, 'electron', 'main-stable.js');

function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function write(file, value) { fs.writeFileSync(file, value, 'utf8'); }
function hasCoreRuntime(source) { return source.includes("ipcMain.handle('p2p:start'") && source.includes("ipcMain.handle('p2p:listFiles'"); }
function hasNetworkFolders(source) { return source.includes("ipcMain.handle('p2p:listFolders'") && source.includes("ipcMain.handle('p2p:createFolder'") && source.includes("ipcMain.handle('p2p:moveFile'"); }
function hasDriveCompat(source) { return source.includes("ipcMain.handle('drive:getFolders'") && source.includes("ipcMain.handle('drive:saveFolders'"); }
function hasFolderHelpers(source) { return source.includes('function walletFileManifests()') && source.includes('function walletFolderManifests()') && source.includes('function assertFolderIdentity()'); }

const helperBlock = `function sanitizeFolderManifest(folder = {}) { Object.assign(folder, { kind: 'folder', isFolder: true, isEncrypted: false, visibility: 'private', isPublic: false, size: 0, storedSize: 0, totalChunks: 0, chunkSize: 0, chunks: [], encryption: null, replicas: Array.isArray(folder.replicas) ? folder.replicas : [] }); return folder; }
function walletFileManifests() { return walletManifests().filter((m) => m.kind !== FOLDER_MANIFEST_KIND && !m.isFolder); }
function walletFolderManifests() { return walletManifests().filter((m) => m.kind === FOLDER_MANIFEST_KIND || m.isFolder === true || String(m.hash || '').startsWith('folder:')).map(sanitizeFolderManifest); }
function folderOwnerIdentity() { return typeof activeIdentity === 'function' ? activeIdentity() : activeWallet(); }
function assertFolderIdentity() { if (typeof assertVerifiedIdentity === 'function') return assertVerifiedIdentity(); return assertVerifiedWallet(); }
function sanitizeFolderName(name = '') { const clean = String(name || '').trim().replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' '); if (!clean) throw new Error('Folder name is required'); if (clean.length > 80) throw new Error('Folder name is too long'); if (['all files', 'uncategorized'].includes(clean.toLowerCase())) throw new Error('Reserved folder name'); return clean; }
function folderIdFromName(name = '') { return crypto.createHash('sha256').update(folderOwnerIdentity() + ':folder:' + String(name || '').trim().toLowerCase() + ':' + Date.now() + ':' + crypto.randomBytes(8).toString('hex')).digest('hex'); }
function findFolderById(folderId = '') { return walletFolderManifests().find((folder) => folder.folderId === String(folderId || '')); }
function findFolderByName(name = '') { return walletFolderManifests().find((folder) => String(folder.name || '').toLowerCase() === String(name || '').toLowerCase()); }
function assertFolderNotDescendant(folderId, parentFolderId) { let cursor = String(parentFolderId || ''); const seen = new Set(); while (cursor) { if (cursor === folderId) throw new Error('Cannot move folder inside itself or its child'); if (seen.has(cursor)) throw new Error('Folder tree cycle detected'); seen.add(cursor); const parent = findFolderById(cursor); cursor = parent?.parentFolderId || ''; } }
`;

function patchFolderHelpers(source) {
  let next = source;

  if (!next.includes("const FOLDER_MANIFEST_KIND = 'folder';")) {
    next = next.replace(
      /const WALLET_LOGIN_MAX_FUTURE_MS = 2 \* 60 \* 1000;\r?\n/,
      (match) => `${match}const FOLDER_MANIFEST_KIND = 'folder';\n`
    );
  }

  if (next.includes('function walletFileManifests()')) {
    const start = next.indexOf('function walletFileManifests()');
    let end = next.indexOf('function totalStoredBytesForWallet()', start);
    if (end === -1) end = start;
    if (end > start) next = next.slice(0, start) + helperBlock + next.slice(end);
  } else {
    next = next.replace(
      /function walletManifests\(\) \{ return walletState\.connected \? manifests\.filter\(walletOwnsManifest\)\.filter\(isUsableManifest\) : \[\]; \}\r?\n/,
      (match) => `${match}${helperBlock}`
    );
  }

  // Fallback if the exact walletManifests anchor was missed.
  if (!next.includes('function walletFileManifests()') && next.includes('function totalStoredBytesForWallet()')) {
    next = next.replace(/function totalStoredBytesForWallet\(\)/, `${helperBlock}function totalStoredBytesForWallet()`);
  }

  // New and existing folder objects must be private in local runtime too, not only sync layer.
  next = next.replace(/isPublic: true/g, 'isPublic: false');
  next = next.replace(/visibility: 'public',\s*isPublic: false/g, "visibility: 'private', isPublic: false");
  next = next.replace(/kind: FOLDER_MANIFEST_KIND, id:/g, "kind: FOLDER_MANIFEST_KIND, isFolder: true, visibility: 'private', isPublic: false, id:");

  // Network summaries and quotas should count files only, not folder manifests.
  next = next.replace(/function totalStoredBytesForWallet\(\) \{ return walletManifests\(\)\.reduce\(/g, 'function totalStoredBytesForWallet() { return walletFileManifests().reduce(');
  next = next.replace(/const own = walletManifests\(\);\n  const underReplicatedChunks/g, 'const own = walletFileManifests();\n  const underReplicatedChunks');
  next = next.replace(/const own = walletManifests\(\); if \(!query\) return own;/g, 'const own = walletFileManifests(); if (!query) return own;');
  next = next.replace(/return walletManifests\(\)\.find\(\(m\) => m\.hash === hash \|\| m\.rootHash === rootHash\);/g, 'return walletFileManifests().find((m) => m.hash === hash || m.rootHash === rootHash);');

  return next;
}

let main = patchFolderHelpers(read(mainPath));
let stable = patchFolderHelpers(read(stablePath));

if (!main) {
  console.warn('[folder-runtime-stable] electron/main.js missing; cannot sync folder runtime');
  process.exit(0);
}
if (!hasCoreRuntime(main)) {
  console.warn('[folder-runtime-stable] main.js does not look like a complete Electron runtime; leaving main-stable unchanged');
  process.exit(0);
}

write(mainPath, main);

if (!hasFolderHelpers(main)) {
  console.error('[folder-runtime-stable] failed to install walletFileManifests helpers in main.js');
  process.exit(1);
}

// If main.js has the folder IPC handlers, it is the source of truth for main-stable.
if (hasNetworkFolders(main) || hasDriveCompat(main)) {
  stable = main;
}

stable = patchFolderHelpers(stable || main);
if (!hasFolderHelpers(stable)) {
  console.error('[folder-runtime-stable] failed to install walletFileManifests helpers in main-stable.js');
  process.exit(1);
}
write(stablePath, stable);

if (hasNetworkFolders(stable) || hasDriveCompat(stable)) {
  console.log('[folder-runtime-stable] synced network folder handlers, helpers, and private folder manifests into electron/main-stable.js');
} else {
  console.log('[folder-runtime-stable] installed folder helpers; network folder handlers not present yet');
}
