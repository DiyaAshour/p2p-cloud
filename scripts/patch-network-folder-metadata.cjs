const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const preloadPath = path.join(root, 'electron', 'preload.cjs');
const appPath = path.join(root, 'client', 'src', 'NativeP2PApp.tsx');

function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function write(file, src) { fs.writeFileSync(file, src, 'utf8'); }
function warn(label) { console.warn('[patch-network-folder-metadata] skipped:', label); }
function replaceIfPresent(src, search, replacement, label) {
  if (!src.includes(search)) { warn(label); return src; }
  return src.replace(search, replacement);
}

const helperBlock = [
  "function walletManifests() { return walletState.connected ? manifests.filter(walletOwnsManifest).filter(isUsableManifest) : []; }",
  "function walletFileManifests() { return walletManifests().filter((m) => m.kind !== FOLDER_MANIFEST_KIND); }",
  "function walletFolderManifests() { return walletManifests().filter((m) => m.kind === FOLDER_MANIFEST_KIND); }",
  "function folderOwnerIdentity() { return typeof activeIdentity === 'function' ? activeIdentity() : activeWallet(); }",
  "function assertFolderIdentity() { if (typeof assertVerifiedIdentity === 'function') return assertVerifiedIdentity(); return assertVerifiedWallet(); }",
  "function folderIdFromName(name = '') { return crypto.createHash('sha256').update(folderOwnerIdentity() + ':folder:' + String(name || '').trim().toLowerCase() + ':' + Date.now() + ':' + crypto.randomBytes(8).toString('hex')).digest('hex'); }",
  "function sanitizeFolderName(name = '') { const clean = String(name || '').trim().replace(/[\\r\\n\\t]/g, ' ').replace(/\\s+/g, ' '); if (!clean) throw new Error('Folder name is required'); if (clean.length > 80) throw new Error('Folder name is too long'); if (['all files', 'uncategorized'].includes(clean.toLowerCase())) throw new Error('Reserved folder name'); return clean; }",
  "function findFolderById(folderId = '') { return walletFolderManifests().find((folder) => folder.folderId === String(folderId || '')); }",
  "function findFolderByName(name = '') { return walletFolderManifests().find((folder) => String(folder.name || '').toLowerCase() === String(name || '').toLowerCase()); }",
  "function assertFolderNotDescendant(folderId, parentFolderId) { let cursor = String(parentFolderId || ''); const seen = new Set(); while (cursor) { if (cursor === folderId) throw new Error('Cannot move folder inside itself or its child'); if (seen.has(cursor)) throw new Error('Folder tree cycle detected'); seen.add(cursor); const parent = findFolderById(cursor); cursor = parent?.parentFolderId || ''; } }",
  ""
].join('\n');

const folderHandlers = [
  "ipcMain.handle('p2p:listFolders', async () => {",
  "  if (!walletState.connected || !walletState.verified) return [];",
  "  await syncPull();",
  "  return walletFolderManifests().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));",
  "});",
  "",
  "ipcMain.handle('p2p:createFolder', async (_event, payload = {}) => {",
  "  assertFolderIdentity();",
  "  await syncPull();",
  "  const ownerWallet = folderOwnerIdentity();",
  "  const name = sanitizeFolderName(payload.name);",
  "  const parentFolderId = String(payload.parentFolderId || '');",
  "  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Parent folder not found');",
  "  if (walletFolderManifests().some((folder) => String(folder.parentFolderId || '') === parentFolderId && String(folder.name || '').toLowerCase() === name.toLowerCase())) throw new Error('Folder already exists here');",
  "  const folderId = folderIdFromName(name);",
  "  const folder = { kind: FOLDER_MANIFEST_KIND, id: ownerWallet + ':folder:' + folderId, hash: 'folder:' + folderId, rootHash: 'folder:' + folderId, folderId, name, parentFolderId, ownerWallet, ownerNodeId: ensureTransport({}).peerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), size: 0, storedSize: 0, totalChunks: 0, chunks: [], replicas: [], isEncrypted: false, visibility: 'private', isPublic: false, isFolder: true };",
  "  manifests.push(folder);",
  "  persistManifests();",
  "  await syncPush(folder);",
  "  await syncPull();",
  "  return { ok: true, folder, folders: walletFolderManifests() };",
  "});",
  "",
  "ipcMain.handle('p2p:renameFolder', async (_event, payload = {}) => {",
  "  assertFolderIdentity();",
  "  await syncPull();",
  "  const folderId = String(payload.folderId || '');",
  "  const name = sanitizeFolderName(payload.name);",
  "  const folder = findFolderById(folderId) || findFolderByName(payload.oldName || '');",
  "  if (!folder) throw new Error('Folder not found');",
  "  if (walletFolderManifests().some((candidate) => candidate.folderId !== folder.folderId && String(candidate.parentFolderId || '') === String(folder.parentFolderId || '') && String(candidate.name || '').toLowerCase() === name.toLowerCase())) throw new Error('Folder already exists here');",
  "  Object.assign(folder, { name, updatedAt: new Date().toISOString(), visibility: 'private', isPublic: false });",
  "  persistManifests();",
  "  await syncPush(folder);",
  "  await syncPull();",
  "  return { ok: true, folder, folders: walletFolderManifests() };",
  "});",
  "",
  "ipcMain.handle('p2p:moveFolder', async (_event, payload = {}) => {",
  "  assertFolderIdentity();",
  "  await syncPull();",
  "  const folderId = String(payload.folderId || '');",
  "  const parentFolderId = String(payload.parentFolderId || '');",
  "  const folder = findFolderById(folderId) || findFolderByName(payload.name || '');",
  "  if (!folder) throw new Error('Folder not found');",
  "  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Target folder not found');",
  "  assertFolderNotDescendant(folder.folderId, parentFolderId);",
  "  Object.assign(folder, { parentFolderId, updatedAt: new Date().toISOString(), visibility: 'private', isPublic: false });",
  "  persistManifests();",
  "  await syncPush(folder);",
  "  await syncPull();",
  "  return { ok: true, folder, folders: walletFolderManifests() };",
  "});",
  "",
  "ipcMain.handle('p2p:deleteFolder', async (_event, payload = {}) => {",
  "  assertFolderIdentity();",
  "  await syncPull();",
  "  const folder = findFolderById(String(payload.folderId || '')) || findFolderByName(payload.name || '');",
  "  if (!folder) throw new Error('Folder not found');",
  "  const removed = new Set([folder.folderId]);",
  "  let changed = true;",
  "  while (changed) {",
  "    changed = false;",
  "    for (const child of walletFolderManifests()) if (!removed.has(child.folderId) && removed.has(String(child.parentFolderId || ''))) { removed.add(child.folderId); changed = true; }",
  "  }",
  "  const changedFiles = [];",
  "  for (const file of walletFileManifests()) {",
  "    if (removed.has(String(file.folderId || ''))) {",
  "      file.folderId = '';",
  "      file.folderName = '';",
  "      file.folder = '';",
  "      file.updatedAt = new Date().toISOString();",
  "      changedFiles.push(file);",
  "    }",
  "  }",
  "  const removedFolders = walletFolderManifests().filter((candidate) => removed.has(candidate.folderId));",
  "  manifests = manifests.filter((m) => !(m.kind === FOLDER_MANIFEST_KIND && removed.has(m.folderId)));",
  "  persistManifests();",
  "  for (const file of changedFiles) await syncPush(file);",
  "  for (const removedFolder of removedFolders) await syncDelete(folderOwnerIdentity(), removedFolder.hash);",
  "  await syncPull();",
  "  return { ok: true, removed: removed.size, folders: walletFolderManifests() };",
  "});",
  "",
  "ipcMain.handle('p2p:moveFile', async (_event, payload = {}) => {",
  "  assertFolderIdentity();",
  "  await syncPull();",
  "  const manifest = findManifest(payload);",
  "  if (!manifest) throw new Error('File not found for this identity');",
  "  const folderId = String(payload.folderId || '');",
  "  const folder = folderId ? findFolderById(folderId) : (payload.folderName ? findFolderByName(payload.folderName) : null);",
  "  if (folderId && !folder) throw new Error('Target folder not found');",
  "  manifest.folderId = folder?.folderId || '';",
  "  manifest.folderName = folder?.name || String(payload.folderName || '');",
  "  manifest.folder = manifest.folderName;",
  "  manifest.updatedAt = new Date().toISOString();",
  "  persistManifests();",
  "  await syncPush(manifest);",
  "  await syncPull();",
  "  return { ok: true, file: manifest };",
  "});",
  ""
].join('\n');

let main = read(mainPath);
if (main) {
  if (!main.includes("const FOLDER_MANIFEST_KIND = 'folder';")) {
    main = main.replace("const WALLET_LOGIN_MAX_FUTURE_MS = 2 * 60 * 1000;\n", "const WALLET_LOGIN_MAX_FUTURE_MS = 2 * 60 * 1000;\nconst FOLDER_MANIFEST_KIND = 'folder';\n");
  }

  if (!main.includes('function walletFileManifests()')) {
    main = replaceIfPresent(main, "function walletManifests() { return walletState.connected ? manifests.filter(walletOwnsManifest).filter(isUsableManifest) : []; }\n", helperBlock, 'wallet manifest helper anchor');
  } else if (!main.includes('function folderOwnerIdentity()') || !main.includes('function findFolderByName')) {
    const start = main.indexOf('function walletManifests() {');
    const end = main.indexOf('function totalStoredBytesForWallet()', start);
    if (start !== -1 && end !== -1) main = main.slice(0, start) + helperBlock + main.slice(end);
    else warn('upgrade helper block');
  }

  main = main.replace("function totalStoredBytesForWallet() { return walletManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }", "function totalStoredBytesForWallet() { return walletFileManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }");
  main = main.replace("function findManifest(payload = {}) { const hash = String(payload.hash || ''); const rootHash = String(payload.rootHash || ''); return walletManifests().find((m) => m.hash === hash || m.rootHash === rootHash); }", "function findManifest(payload = {}) { const hash = String(payload.hash || ''); const rootHash = String(payload.rootHash || ''); return walletFileManifests().find((m) => m.hash === hash || m.rootHash === rootHash); }");
  main = main.replace("const own = walletManifests();\n  const underReplicatedChunks = countUnderReplicatedChunks(node, own, TARGET_REPLICAS);", "const own = walletFileManifests();\n  const underReplicatedChunks = countUnderReplicatedChunks(node, own, TARGET_REPLICAS);");
  main = main.replace("ipcMain.handle('p2p:repair', async () => { assertVerifiedWallet(); const node = ensureTransport({}); const own = walletManifests();", "ipcMain.handle('p2p:repair', async () => { assertFolderIdentity(); const node = ensureTransport({}); const own = walletFileManifests();");

  if (!main.includes('totalFolders: folders.length')) {
    main = main.replace(
      "  const own = walletManifests();\n  const connectedPeers = node.connectedPeerIds?.() || [];\n  return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, publicPeerUrl: publicPeerUrl(node), safetyPeerUrl: safetyPeerUrl(), connectedPeers: connectedPeers.length, peerCount: connectedPeers.length, peers: Array.from(node.peerInfo?.values?.() || []), targetReplicas: TARGET_REPLICAS, totalFiles: own.length, encryptedFiles: own.filter((f) => f.isEncrypted).length, publicFiles: own.filter((f) => !f.isEncrypted).length, totalBytes: own.reduce((s, f) => s + Number(f.size || 0), 0), totalChunks: own.reduce((s, f) => s + Number(f.chunks?.length || 0), 0), underReplicatedChunks: countUnderReplicatedChunks(node, own, TARGET_REPLICAS), transferProgress, transferSettings: { uploadConcurrency: UPLOAD_CONCURRENCY, downloadConcurrency: DOWNLOAD_CONCURRENCY }, autoRepair: lastAutoRepairStatus, wallet: walletSummary(), sync: lastSyncStatus };\n}",
      "  const own = walletFileManifests();\n  const folders = walletFolderManifests();\n  const connectedPeers = node.connectedPeerIds?.() || [];\n  return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, publicPeerUrl: publicPeerUrl(node), safetyPeerUrl: safetyPeerUrl(), connectedPeers: connectedPeers.length, peerCount: connectedPeers.length, peers: Array.from(node.peerInfo?.values?.() || []), targetReplicas: TARGET_REPLICAS, totalFiles: own.length, totalFolders: folders.length, encryptedFiles: own.filter((f) => f.isEncrypted).length, publicFiles: own.filter((f) => !f.isEncrypted).length, totalBytes: own.reduce((s, f) => s + Number(f.size || 0), 0), totalChunks: own.reduce((s, f) => s + Number(f.chunks?.length || 0), 0), underReplicatedChunks: countUnderReplicatedChunks(node, own, TARGET_REPLICAS), transferProgress, transferSettings: { uploadConcurrency: UPLOAD_CONCURRENCY, downloadConcurrency: DOWNLOAD_CONCURRENCY }, autoRepair: lastAutoRepairStatus, wallet: walletSummary(), sync: lastSyncStatus };\n}"
    );
  }

  if (!main.includes("const own = walletFileManifests(); if (!query) return own;")) {
    main = main.replace(
      "ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { if (!walletState.connected || !walletState.verified) return []; await syncPull(); const query = String(payload.query || '').trim().toLowerCase(); const own = walletManifests(); if (!query) return own; return own.filter((f) => [f.name, f.hash, f.rootHash, f.ownerWallet || ''].some((v) => String(v || '').toLowerCase().includes(query))); });",
      "ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { if (!walletState.connected || !walletState.verified) return []; await syncPull(); const query = String(payload.query || '').trim().toLowerCase(); const own = walletFileManifests(); if (!query) return own; return own.filter((f) => [f.name, f.hash, f.rootHash, f.ownerWallet || '', f.folderName || '', f.folder || ''].some((v) => String(v || '').toLowerCase().includes(query))); });"
    );
  }

  if (!main.includes("ipcMain.handle('p2p:listFolders'")) {
    if (!main.includes("ipcMain.handle('p2p:listFiles'")) warn('p2p:listFiles insertion point');
    else main = main.replace("ipcMain.handle('p2p:listFiles'", folderHandlers + "\nipcMain.handle('p2p:listFiles'");
  }

  if (!main.includes('folderId: targetFolderId')) {
    main = main.replace(
      "const manifest = { id: `${ownerWallet}:${storedHash}`, name: String(payload.name || 'file'), size: originalBuffer.length, storedSize: storedBuffer.length, hash: storedHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption: secured.encryption, mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream', chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: chunkResults };",
      "const targetFolderId = String(payload.folderId || '');\n  const targetFolder = targetFolderId ? findFolderById(targetFolderId) : (payload.folderName ? findFolderByName(payload.folderName) : null);\n  if (targetFolderId && !targetFolder) throw new Error('Target folder not found');\n  const manifest = { id: `${ownerWallet}:${storedHash}`, name: String(payload.name || 'file'), size: originalBuffer.length, storedSize: storedBuffer.length, hash: storedHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption: secured.encryption, mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream', folderId: targetFolder?.folderId || '', folderName: targetFolder?.name || String(payload.folderName || ''), folder: targetFolder?.name || String(payload.folderName || ''), chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: chunkResults };"
    );
  }

  if (!main.includes('folderId: String(payload.folderId ||')) {
    main = main.replace("      name: displayName,\n      folder,\n      size: stat.size,", "      name: displayName,\n      folder,\n      folderId: String(payload.folderId || ''),\n      folderName: String(payload.folderName || folder || ''),\n      size: stat.size,");
  }

  write(mainPath, main);
}

let preload = read(preloadPath);
if (preload) {
  for (const channel of ['p2p:upload', 'p2p:listFolders', 'p2p:createFolder', 'p2p:renameFolder', 'p2p:deleteFolder', 'p2p:moveFolder', 'p2p:moveFile']) {
    if (!preload.includes("'" + channel + "'")) preload = preload.replace("  'p2p:listFiles',\n", "  'p2p:listFiles',\n  '" + channel + "',\n");
  }
  write(preloadPath, preload);
}

let appSrc = read(appPath);
if (appSrc) {
  appSrc = appSrc.replace('bytes: await file.arrayBuffer() });', 'bytes: await file.arrayBuffer(), folderId: targetFolder, folderName: targetFolder ? folderPath(targetFolder) : "" });');
  write(appPath, appSrc);
}

console.log('[patch-network-folder-metadata] network-synced folder metadata enabled.');
