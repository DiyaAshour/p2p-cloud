const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const preloadPath = path.join(root, 'electron', 'preload.cjs');
const appPath = path.join(root, 'client', 'src', 'NativeP2PApp.tsx');

function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function write(file, src) { fs.writeFileSync(file, src, 'utf8'); }
function warn(label) { console.warn('[patch-network-folder-metadata] skipped:', label); }
function replaceOnce(src, search, replacement, label) {
  if (!src.includes(search)) { warn(label); return src; }
  return src.replace(search, replacement);
}
function replaceRegex(src, regex, replacement, label) {
  if (!regex.test(src)) { warn(label); return src; }
  return src.replace(regex, replacement);
}

let main = read(mainPath);
if (main) {
  if (!main.includes("const FOLDER_MANIFEST_KIND = 'folder';")) {
    main = main.replace(
      "const WALLET_LOGIN_MAX_FUTURE_MS = 2 * 60 * 1000;\n",
      "const WALLET_LOGIN_MAX_FUTURE_MS = 2 * 60 * 1000;\nconst FOLDER_MANIFEST_KIND = 'folder';\n"
    );
  }

  if (!main.includes('function walletFileManifests()')) {
    main = main.replace(
      "function walletManifests() { return walletState.connected ? manifests.filter(walletOwnsManifest).filter(isUsableManifest) : []; }\n",
      "function walletManifests() { return walletState.connected ? manifests.filter(walletOwnsManifest).filter(isUsableManifest) : []; }\nfunction walletFileManifests() { return walletManifests().filter((m) => m.kind !== FOLDER_MANIFEST_KIND); }\nfunction walletFolderManifests() { return walletManifests().filter((m) => m.kind === FOLDER_MANIFEST_KIND); }\nfunction folderIdFromName(name = '') { return crypto.createHash('sha256').update(`${activeWallet()}:folder:${String(name || '').trim().toLowerCase()}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`).digest('hex'); }\nfunction sanitizeFolderName(name = '') { const clean = String(name || '').trim().replace(/[\\r\\n\\t]/g, ' ').replace(/\\s+/g, ' '); if (!clean) throw new Error('Folder name is required'); if (clean.length > 80) throw new Error('Folder name is too long'); if (['all files', 'uncategorized'].includes(clean.toLowerCase())) throw new Error('Reserved folder name'); return clean; }\nfunction findFolderById(folderId = '') { return walletFolderManifests().find((folder) => folder.folderId === String(folderId || '')); }\nfunction assertFolderNotDescendant(folderId, parentFolderId) { let cursor = String(parentFolderId || ''); const seen = new Set(); while (cursor) { if (cursor === folderId) throw new Error('Cannot move folder inside itself or its child'); if (seen.has(cursor)) throw new Error('Folder tree cycle detected'); seen.add(cursor); const parent = findFolderById(cursor); cursor = parent?.parentFolderId || ''; } }\n"
    );
  }

  main = main.replace(
    "function totalStoredBytesForWallet() { return walletManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }",
    "function totalStoredBytesForWallet() { return walletFileManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }"
  );

  main = replaceOnce(
    main,
    "  const own = walletManifests();\n  const connectedPeers = node.connectedPeerIds?.() || [];\n  return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, publicPeerUrl: publicPeerUrl(node), safetyPeerUrl: safetyPeerUrl(), connectedPeers: connectedPeers.length, peerCount: connectedPeers.length, peers: Array.from(node.peerInfo?.values?.() || []), targetReplicas: TARGET_REPLICAS, totalFiles: own.length, encryptedFiles: own.filter((f) => f.isEncrypted).length, publicFiles: own.filter((f) => !f.isEncrypted).length, totalBytes: own.reduce((s, f) => s + Number(f.size || 0), 0), totalChunks: own.reduce((s, f) => s + Number(f.chunks?.length || 0), 0), underReplicatedChunks: countUnderReplicatedChunks(node, own, TARGET_REPLICAS), transferProgress, transferSettings: { uploadConcurrency: UPLOAD_CONCURRENCY, downloadConcurrency: DOWNLOAD_CONCURRENCY }, autoRepair: lastAutoRepairStatus, wallet: walletSummary(), sync: lastSyncStatus };\n}",
    "  const own = walletFileManifests();\n  const folders = walletFolderManifests();\n  const connectedPeers = node.connectedPeerIds?.() || [];\n  return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, publicPeerUrl: publicPeerUrl(node), safetyPeerUrl: safetyPeerUrl(), connectedPeers: connectedPeers.length, peerCount: connectedPeers.length, peers: Array.from(node.peerInfo?.values?.() || []), targetReplicas: TARGET_REPLICAS, totalFiles: own.length, totalFolders: folders.length, encryptedFiles: own.filter((f) => f.isEncrypted).length, publicFiles: own.filter((f) => !f.isEncrypted).length, totalBytes: own.reduce((s, f) => s + Number(f.size || 0), 0), totalChunks: own.reduce((s, f) => s + Number(f.chunks?.length || 0), 0), underReplicatedChunks: countUnderReplicatedChunks(node, own, TARGET_REPLICAS), transferProgress, transferSettings: { uploadConcurrency: UPLOAD_CONCURRENCY, downloadConcurrency: DOWNLOAD_CONCURRENCY }, autoRepair: lastAutoRepairStatus, wallet: walletSummary(), sync: lastSyncStatus };\n}",
    'networkSummary file/folder split'
  );

  main = replaceOnce(
    main,
    "ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { if (!walletState.connected || !walletState.verified) return []; await syncPull(); const query = String(payload.query || '').trim().toLowerCase(); const own = walletManifests(); if (!query) return own; return own.filter((f) => [f.name, f.hash, f.rootHash, f.ownerWallet || ''].some((v) => String(v || '').toLowerCase().includes(query))); });",
    "ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { if (!walletState.connected || !walletState.verified) return []; await syncPull(); const query = String(payload.query || '').trim().toLowerCase(); const own = walletFileManifests(); if (!query) return own; return own.filter((f) => [f.name, f.hash, f.rootHash, f.ownerWallet || '', f.folderName || ''].some((v) => String(v || '').toLowerCase().includes(query))); });",
    'listFiles file-only'
  );

  if (!main.includes("ipcMain.handle('p2p:listFolders'")) {
    const handlers = `
ipcMain.handle('p2p:listFolders', async () => {
  if (!walletState.connected || !walletState.verified) return [];
  await syncPull();
  return walletFolderManifests().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
});
ipcMain.handle('p2p:createFolder', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const ownerWallet = activeWallet();
  const name = sanitizeFolderName(payload.name);
  const parentFolderId = String(payload.parentFolderId || '');
  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Parent folder not found');
  if (walletFolderManifests().some((folder) => String(folder.parentFolderId || '') === parentFolderId && String(folder.name || '').toLowerCase() === name.toLowerCase())) throw new Error('Folder already exists here');
  const folderId = folderIdFromName(name);
  const folder = { kind: FOLDER_MANIFEST_KIND, id: `${ownerWallet}:folder:${folderId}`, hash: `folder:${folderId}`, rootHash: `folder:${folderId}`, folderId, name, parentFolderId, ownerWallet, ownerNodeId: ensureTransport({}).peerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), size: 0, chunks: [], replicas: [], isEncrypted: false, isFolder: true };
  manifests.push(folder);
  persistManifests();
  await syncPush(folder);
  await syncPull();
  return { ok: true, folder, folders: walletFolderManifests() };
});
ipcMain.handle('p2p:renameFolder', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const folderId = String(payload.folderId || '');
  const name = sanitizeFolderName(payload.name);
  const folder = findFolderById(folderId);
  if (!folder) throw new Error('Folder not found');
  if (walletFolderManifests().some((candidate) => candidate.folderId !== folderId && String(candidate.parentFolderId || '') === String(folder.parentFolderId || '') && String(candidate.name || '').toLowerCase() === name.toLowerCase())) throw new Error('Folder already exists here');
  Object.assign(folder, { name, updatedAt: new Date().toISOString() });
  persistManifests();
  await syncPush(folder);
  await syncPull();
  return { ok: true, folder, folders: walletFolderManifests() };
});
ipcMain.handle('p2p:moveFolder', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const folderId = String(payload.folderId || '');
  const parentFolderId = String(payload.parentFolderId || '');
  const folder = findFolderById(folderId);
  if (!folder) throw new Error('Folder not found');
  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Target folder not found');
  assertFolderNotDescendant(folderId, parentFolderId);
  if (walletFolderManifests().some((candidate) => candidate.folderId !== folderId && String(candidate.parentFolderId || '') === parentFolderId && String(candidate.name || '').toLowerCase() === String(folder.name || '').toLowerCase())) throw new Error('A folder with this name already exists in target');
  Object.assign(folder, { parentFolderId, updatedAt: new Date().toISOString() });
  persistManifests();
  await syncPush(folder);
  await syncPull();
  return { ok: true, folder, folders: walletFolderManifests() };
});
ipcMain.handle('p2p:deleteFolder', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const folderId = String(payload.folderId || '');
  const folder = findFolderById(folderId);
  if (!folder) throw new Error('Folder not found');
  const removed = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const child of walletFolderManifests()) {
      if (!removed.has(child.folderId) && removed.has(String(child.parentFolderId || ''))) { removed.add(child.folderId); changed = true; }
    }
  }
  const changedFiles = [];
  for (const file of walletFileManifests()) {
    if (removed.has(String(file.folderId || ''))) {
      file.folderId = '';
      file.folderName = '';
      file.updatedAt = new Date().toISOString();
      changedFiles.push(file);
    }
  }
  const removedFolders = walletFolderManifests().filter((candidate) => removed.has(candidate.folderId));
  manifests = manifests.filter((m) => !(m.kind === FOLDER_MANIFEST_KIND && removed.has(m.folderId)));
  persistManifests();
  for (const file of changedFiles) await syncPush(file);
  for (const removedFolder of removedFolders) await syncDelete(activeWallet(), removedFolder.hash);
  await syncPull();
  return { ok: true, removed: removed.size, folders: walletFolderManifests() };
});
ipcMain.handle('p2p:moveFile', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this wallet');
  const folderId = String(payload.folderId || '');
  const folder = folderId ? findFolderById(folderId) : null;
  if (folderId && !folder) throw new Error('Target folder not found');
  manifest.folderId = folderId;
  manifest.folderName = folder?.name || '';
  manifest.updatedAt = new Date().toISOString();
  persistManifests();
  await syncPush(manifest);
  await syncPull();
  return { ok: true, file: manifest };
});
`;
    main = main.replace("ipcMain.handle('p2p:listFiles'", `${handlers}\nipcMain.handle('p2p:listFiles'`);
  }

  main = replaceOnce(
    main,
    "const manifest = { id: `${ownerWallet}:${storedHash}`, name: String(payload.name || 'file'), size: originalBuffer.length, storedSize: storedBuffer.length, hash: storedHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption: secured.encryption, mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream', chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: chunkResults };",
    "const targetFolderId = String(payload.folderId || '');\n  const targetFolder = targetFolderId ? findFolderById(targetFolderId) : null;\n  if (targetFolderId && !targetFolder) throw new Error('Target folder not found');\n  const manifest = { id: `${ownerWallet}:${storedHash}`, name: String(payload.name || 'file'), size: originalBuffer.length, storedSize: storedBuffer.length, hash: storedHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption: secured.encryption, mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream', folderId: targetFolderId, folderName: targetFolder?.name || '', chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: chunkResults };",
    'upload folder metadata'
  );

  write(mainPath, main);
}

let preload = read(preloadPath);
if (preload) {
  for (const channel of ['p2p:listFolders', 'p2p:createFolder', 'p2p:renameFolder', 'p2p:deleteFolder', 'p2p:moveFolder', 'p2p:moveFile']) {
    if (!preload.includes(`'${channel}'`)) preload = preload.replace("  'p2p:listFiles',\n", `  'p2p:listFiles',\n  '${channel}',\n`);
  }
  write(preloadPath, preload);
}

let appSrc = read(appPath);
if (appSrc) {
  appSrc = appSrc.replace(
    'type P2PChannel = "p2p:start" | "p2p:listFiles" | "p2p:upload" | "p2p:download" | "p2p:delete"',
    'type P2PChannel = "p2p:start" | "p2p:listFiles" | "p2p:listFolders" | "p2p:createFolder" | "p2p:renameFolder" | "p2p:deleteFolder" | "p2p:moveFolder" | "p2p:moveFile" | "p2p:upload" | "p2p:download" | "p2p:delete"'
  );

  if (!appSrc.includes('type P2PFolder =')) {
    appSrc = appSrc.replace(
      'type P2PFile = { id: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; mimeType?: string; totalChunks: number; ownerNodeId: string; ownerWallet?: string; planId?: string; replicas: string[] };',
      'type P2PFile = { id: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; updatedAt?: string; isEncrypted: boolean; mimeType?: string; folderId?: string; folderName?: string; totalChunks: number; ownerNodeId: string; ownerWallet?: string; planId?: string; replicas: string[] };\ntype P2PFolder = { kind: "folder"; id: string; hash: string; folderId: string; name: string; parentFolderId?: string; ownerWallet?: string; createdAt?: string; updatedAt?: string };'
    );
  }

  appSrc = appSrc.replace(
    '  const [folderNames, setFolderNames] = useState<string[]>(() => safeJson<string[]>(FOLDERS_KEY, []));\n  const [fileFolders, setFileFolders] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FILE_FOLDERS_KEY, {}));\n  const [folderParents, setFolderParents] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FOLDER_PARENTS_KEY, {}));',
    '  const [folders, setFolders] = useState<P2PFolder[]>([]);\n  const [folderNames, setFolderNames] = useState<string[]>([]);\n  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});'
  );
  appSrc = appSrc.replace(
    '  const [folderNames, setFolderNames] = useState<string[]>(() => safeJson<string[]>(FOLDERS_KEY, []));\n  const [fileFolders, setFileFolders] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FILE_FOLDERS_KEY, {}));',
    '  const [folders, setFolders] = useState<P2PFolder[]>([]);\n  const [folderNames, setFolderNames] = useState<string[]>([]);\n  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});'
  );
  appSrc = appSrc.replace(/\n  const \[folderParents, setFolderParents\] = useState<Record<string, string>>\(\(\) => safeJson<Record<string, string>>\(FOLDER_PARENTS_KEY, \{\}\)\);/g, '');
  appSrc = appSrc.replace(/\n  useEffect\(\(\) => \{ localStorage\.setItem\((FOLDERS_KEY|FILE_FOLDERS_KEY|FOLDER_PARENTS_KEY), JSON\.stringify\([^)]+\)\); \}, \[[^\]]+\]\);/g, '');

  if (!appSrc.includes('const folderParents = useMemo(() => Object.fromEntries(folders.map')) {
    appSrc = appSrc.replace(
      '  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles]);',
      '  const folderParents = useMemo(() => Object.fromEntries(folders.map((folder) => [folder.folderId, folder.parentFolderId || ""])), [folders]);\n  const folderNamesById = useMemo(() => Object.fromEntries(folders.map((folder) => [folder.folderId, folder.name])), [folders]);\n  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles]);'
    );
  }

  appSrc = replaceRegex(appSrc, /const folderPath = \(folder: string\) => \{[\s\S]*?return chain\.join\(" \/ "\) \|\| folder;\n  \};/, 'const folderPath = (folder: string) => {\n    if (folder === ALL_FILES || folder === UNCATEGORIZED) return folder;\n    const chain: string[] = [];\n    const seen = new Set<string>();\n    let cursor = folder;\n    while (cursor && !seen.has(cursor)) {\n      seen.add(cursor);\n      chain.unshift(folderNamesById[cursor] || cursor);\n      cursor = folderParents[cursor] || "";\n    }\n    return chain.join(" / ") || folderNamesById[folder] || folder;\n  };', 'folderPath ids');

  appSrc = replaceRegex(appSrc, /const orderedFolders = useMemo\(\(\) => \{[\s\S]*?return result;\n  \}, \[folderNames, folderParents\]\);/, 'const orderedFolders = useMemo(() => {\n    const ids = folders.map((folder) => folder.folderId);\n    const childrenOf = (parent: string) => ids.filter((id) => (folderParents[id] || "") === parent).sort((a, b) => String(folderNamesById[a] || "").localeCompare(String(folderNamesById[b] || "")));\n    const result: string[] = [];\n    const walk = (parent: string) => {\n      for (const child of childrenOf(parent)) {\n        result.push(child);\n        walk(child);\n      }\n    };\n    walk("");\n    for (const orphan of ids.sort((a, b) => String(folderNamesById[a] || "").localeCompare(String(folderNamesById[b] || "")))) if (!result.includes(orphan)) result.push(orphan);\n    return result;\n  }, [folders, folderParents, folderNamesById]);', 'orderedFolders ids');

  appSrc = appSrc.replace(
    'const [nextSummary, nextFiles, nextWallet] = await Promise.all([bridge.invoke<P2PSummary>("p2p:networkSummary"), bridge.invoke<P2PFile[]>("p2p:listFiles", { query: search }), bridge.invoke<WalletState>("wallet:status")]);\n    setSummary(nextSummary); setFiles(Array.isArray(nextFiles) ? nextFiles : []); setWallet(nextWallet);',
    'const [nextSummary, nextFiles, nextFolders, nextWallet] = await Promise.all([bridge.invoke<P2PSummary>("p2p:networkSummary"), bridge.invoke<P2PFile[]>("p2p:listFiles", { query: search }), bridge.invoke<P2PFolder[]>("p2p:listFolders"), bridge.invoke<WalletState>("wallet:status")]);\n    setSummary(nextSummary); setFiles(Array.isArray(nextFiles) ? nextFiles : []); setFolders(Array.isArray(nextFolders) ? nextFolders : []); setFolderNames(Array.isArray(nextFolders) ? nextFolders.map((folder) => folder.folderId) : []); setFileFolders(Object.fromEntries((Array.isArray(nextFiles) ? nextFiles : []).map((file) => [file.hash, file.folderId || ""]))); setWallet(nextWallet);'
  );
  appSrc = appSrc.replace('const folder = fileFolders[file.hash] || UNCATEGORIZED;', 'const folder = file.folderId || fileFolders[file.hash] || UNCATEGORIZED;');

  appSrc = replaceRegex(appSrc, /const createFolder = \(\) => \{[\s\S]*?toast\.success\([^;]+\); \};/, 'const createFolder = () => runBusy(async () => { const name = newFolderName.trim(); if (!name || name === ALL_FILES || name === UNCATEGORIZED) return; const parentFolderId = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; await bridge.invoke("p2p:createFolder", { name, parentFolderId }); setNewFolderName(""); toast.success(`Folder created: ${name}`); await refreshAll(); });', 'createFolder network');
  appSrc = replaceRegex(appSrc, /const moveFileToFolder = \(file: P2PFile, folder: string\) => \{[\s\S]*?toast\.success\(`Moved \$\{file\.name\}`\); \};/, 'const moveFileToFolder = (file: P2PFile, folder: string) => runBusy(async () => { const folderId = folder === UNCATEGORIZED ? "" : folder; await bridge.invoke("p2p:moveFile", { hash: file.hash, folderId }); toast.success(`Moved ${file.name}`); await refreshAll(); });', 'moveFile network');
  appSrc = replaceRegex(appSrc, /const renameActiveFolder = \(\) => \{[\s\S]*?toast\.success\("Folder renamed"\);\n  \};/, 'const renameActiveFolder = () => runBusy(async () => { const name = renameFolderValue.trim(); if (!name || activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; } await bridge.invoke("p2p:renameFolder", { folderId: activeFolder, name }); setRenameFolderValue(""); toast.success("Folder renamed"); await refreshAll(); });', 'renameFolder network');
  appSrc = replaceRegex(appSrc, /const removeActiveFolder = \(\) => \{[\s\S]*?toast\.success\(`Removed \$\{removed\.size\} folder\(s\)`\);\n  \};/, 'const removeActiveFolder = () => runBusy(async () => { if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; } if (!confirm("Remove this folder and its subfolders? Files inside move to Uncategorized, not deleted.")) return; await bridge.invoke("p2p:deleteFolder", { folderId: activeFolder }); setActiveFolder(ALL_FILES); toast.success("Folder removed"); await refreshAll(); });', 'deleteFolder network');
  appSrc = replaceRegex(appSrc, /const moveActiveFolderToParent = \(targetParent: string\) => \{[\s\S]*?toast\.success\(targetParent && targetParent !== UNCATEGORIZED \? `Moved folder inside \$\{folderPath\(targetParent\)\}` : "Moved folder to root"\);\n  \};/, 'const moveActiveFolderToParent = (targetParent: string) => runBusy(async () => { if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; } const parentFolderId = targetParent === UNCATEGORIZED ? "" : targetParent; await bridge.invoke("p2p:moveFolder", { folderId: activeFolder, parentFolderId }); toast.success(parentFolderId ? `Moved folder inside ${folderPath(parentFolderId)}` : "Moved folder to root"); await refreshAll(); });', 'moveFolder network');

  appSrc = appSrc.replace('bytes: await file.arrayBuffer() });', 'bytes: await file.arrayBuffer(), folderId: targetFolder });');
  appSrc = appSrc.replaceAll('folderNames.map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)', 'orderedFolders.map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)');
  write(appPath, appSrc);
}

console.log('[patch-network-folder-metadata] network-synced folder metadata enabled.');
