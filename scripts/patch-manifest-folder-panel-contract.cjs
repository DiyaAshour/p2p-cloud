const fs = require('node:fs');
const path = require('node:path');

const p = 'client/src/ManifestFolderPanel.tsx';
if (!fs.existsSync(p)) {
  console.warn('[manifest-folder-panel-contract] ManifestFolderPanel.tsx not found');
} else {
  let s = fs.readFileSync(p, 'utf8');
  const before = s;

  if (!s.includes('activeFolderName?: string;')) {
    s = s.replace('  enabled?: boolean;\n  onRefresh?: () => Promise<void> | void;', '  enabled?: boolean;\n  activeFolderName?: string;\n  onRefresh?: () => Promise<void> | void;');
  }

  s = s.replace(
    'export default function ManifestFolderPanel({ api, busy = false, enabled = true, onRefresh, onSelectFolder }: Props) {',
    'export default function ManifestFolderPanel({ api, busy = false, enabled = true, activeFolderName = "", onRefresh, onSelectFolder }: Props) {'
  );

  s = s.replace(
    'function idOf(folder?: DriveFolder | null) {\n  return String(folder?.folderId || folder?.id || folder?.hash || "");\n}',
    'function idOf(folder?: DriveFolder | null) {\n  return String(folder?.folderId || "");\n}\n\nfunction itemIdOf(folder?: DriveFolder | null) {\n  return String(folder?.id || folder?.folderId || folder?.hash || folder?.rootHash || "");\n}'
  );

  if (s.includes('itemIdOf(') && !s.includes('function itemIdOf(')) {
    const idOfBlock = /function idOf\(folder\?: DriveFolder \| null\) \{\r?\n  return String\([^\n]+\);\r?\n\}/;
    if (idOfBlock.test(s)) {
      s = s.replace(idOfBlock, (match) => `${match}\n\nfunction itemIdOf(folder?: DriveFolder | null) {\n  return String(folder?.id || folder?.folderId || folder?.hash || folder?.rootHash || "");\n}`);
    } else {
      console.warn('[manifest-folder-panel-contract] warning: itemIdOf is used but idOf block was not found');
    }
  }

  if (!s.includes('function extractItem(response: unknown): DriveFolder | null')) {
    const insertAfter = /function collectRemovedIds\(root: DriveFolder, folders: DriveFolder\[\]\) \{[\s\S]*?\n\}/;
    const helper = `function extractItem(response: unknown): DriveFolder | null {\n  if (!response || typeof response !== "object") return null;\n  if ("item" in response && response.item && typeof response.item === "object") return response.item as DriveFolder;\n  if ("folder" in response && response.folder && typeof response.folder === "object") return response.folder as DriveFolder;\n  return response as DriveFolder;\n}`;
    if (insertAfter.test(s)) s = s.replace(insertAfter, (match) => `${match}\n\n${helper}`);
  }

  if (!s.includes('const externalActiveFolderName = String(activeFolderName || "");')) {
    s = s.replace(
      '  const activeFolder = activeFolderId ? byId.get(activeFolderId) || null : null;\n',
      '  const activeFolder = activeFolderId ? byId.get(activeFolderId) || null : null;\n  const externalActiveFolderName = String(activeFolderName || "");\n\n  useEffect(() => {\n    if (!externalActiveFolderName || ["All Files", "All files", "Uncategorized"].includes(externalActiveFolderName)) {\n      if (activeFolderId) setActiveFolderId(ROOT_ID);\n      return;\n    }\n    const externalFolder = folders.find((folder) => folder.name === externalActiveFolderName);\n    const externalFolderId = idOf(externalFolder);\n    if (externalFolderId && externalFolderId !== activeFolderId) setActiveFolderId(externalFolderId);\n  }, [externalActiveFolderName, folders, activeFolderId]);\n'
    );
  }

  s = s.replace(
    '      const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", {\n        name,\n        parentFolderId: activeFolderId || "",\n      });',
    '      const parentFolderId = activeFolderId && byId.has(activeFolderId) ? activeFolderId : "";\n      const payload = parentFolderId ? { name, parentFolderId } : { name };\n      const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", payload);'
  );

  s = s.replaceAll('folder.id || folder.folderId || folder.hash', 'itemIdOf(folder)');

  s = s.replace(
    '      const item = await api.invoke<DriveFolder>("p2p:renameItem", { itemId: itemIdOf(folder), name });\n      setFolders((current) => current.map((candidate) => idOf(candidate) === idOf(folder) ? { ...candidate, ...item, name: item?.name || name } : candidate));',
    '      const response = await api.invoke<DriveFolder | { item?: DriveFolder; folder?: DriveFolder }>("p2p:renameItem", { itemId: itemIdOf(folder), name });\n      const item = extractItem(response) || { ...folder, name };\n      setFolders((current) => current.map((candidate) => idOf(candidate) === idOf(folder) ? { ...candidate, ...item, name: item.name || name } : candidate));\n      if (activeFolderId === idOf(folder)) onSelectFolder?.({ ...folder, ...item, name: item.name || name });'
  );

  if (!s.includes('const safeFolders = Array.isArray(next) ? next.filter((folder) => idOf(folder)) : [];')) {
    s = s.replace(
      '      const next = await api.invoke<DriveFolder[]>("p2p:listFolders");\n      setFolders(Array.isArray(next) ? next : []);',
      '      const next = await api.invoke<DriveFolder[]>("p2p:listFolders");\n      const safeFolders = Array.isArray(next) ? next.filter((folder) => idOf(folder)) : [];\n      setFolders(safeFolders);\n      if (activeFolderId && !safeFolders.some((folder) => idOf(folder) === activeFolderId)) {\n        setActiveFolderId(ROOT_ID);\n        onSelectFolder?.(null);\n      }'
    );
  }

  s = s.replace(
    '      if (Array.isArray(result?.folders)) setFolders(result.folders);',
    '      if (Array.isArray(result?.folders)) setFolders(result.folders.filter((folder) => idOf(folder)));'
  );

  if (s !== before) {
    fs.writeFileSync(p, s, 'utf8');
    console.log('[manifest-folder-panel-contract] enforced folderId/itemId/active-folder/rename contract');
  } else {
    console.log('[manifest-folder-panel-contract] folder panel contract already valid');
  }
}

const shellPath = path.join(process.cwd(), 'scripts', 'patch-live-folder-panel-shell.cjs');
if (fs.existsSync(shellPath)) {
  let shell = fs.readFileSync(shellPath, 'utf8');
  const beforeShell = shell;
  shell = shell.replace(
    '<ManifestFolderPanel api={api} busy={busy} enabled={view === "personal"} onRefresh={refresh} onSelectFolder={(folder) => setActiveFolder(folder?.name || ALL_FILES)} />',
    '<ManifestFolderPanel api={api} busy={busy} enabled={view === "personal"} activeFolderName={activeFolder} onRefresh={refresh} onSelectFolder={(folder) => setActiveFolder(folder?.name || ALL_FILES)} />'
  );
  if (shell !== beforeShell) {
    fs.writeFileSync(shellPath, shell, 'utf8');
    console.log('[manifest-folder-panel-contract] shell now passes activeFolderName');
  }
}

function normalizeParentExpression() {
  return "  const requestedParentFolderIdRaw = String(payload.parentFolderId ?? '').trim();\n  const requestedParentFolderId = ['', 'root', '/', 'null', 'undefined'].includes(requestedParentFolderIdRaw.toLowerCase()) ? '' : requestedParentFolderIdRaw;\n  const parentFolder = requestedParentFolderId ? findFolderById(requestedParentFolderId) : null;\n  if (requestedParentFolderId && !parentFolder) throw new Error('Parent folder not found');\n  const parentFolderId = parentFolder ? String(parentFolder.folderId || '') : '';";
}

function normalizeMoveParentExpression() {
  return "  const requestedParentFolderIdRaw = String(payload.parentFolderId ?? '').trim();\n  const requestedParentFolderId = ['', 'root', '/', 'null', 'undefined'].includes(requestedParentFolderIdRaw.toLowerCase()) ? '' : requestedParentFolderIdRaw;\n  const parentFolder = requestedParentFolderId ? findFolderById(requestedParentFolderId) : null;\n  const parentFolderId = parentFolder ? String(parentFolder.folderId || '') : '';\n  const folder = findFolderById(folderId) || findFolderByName(payload.name || '');";
}

function patchRuntimeFolderParentContract(src) {
  let next = src;

  next = next.replace(
    "function findFolderById(folderId = '') { return walletFolderManifests().find((folder) => folder.folderId === String(folderId || '')); }",
    "function findFolderById(folderId = '') { const id = String(folderId || '').trim(); if (!id) return null; return walletFolderManifests().find((folder) => String(folder.folderId || '') === id || String(folder.id || '') === id || String(folder.hash || '') === id || String(folder.rootHash || '') === id); }"
  );

  next = next.replace(
    "  const parentFolderId = String(payload.parentFolderId || '');\n  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Parent folder not found');",
    normalizeParentExpression()
  );

  next = next.replace(
    "  const parentFolderId = ['', 'root', '/', 'null', 'undefined'].includes(String(payload.parentFolderId ?? '').trim().toLowerCase()) ? '' : String(payload.parentFolderId || '').trim();\n  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Parent folder not found');",
    normalizeParentExpression()
  );

  next = next.replace(
    "  const requestedParentFolderIdRaw = String(payload.parentFolderId ?? '').trim();\n  const requestedParentFolderId = ['', 'root', '/', 'null', 'undefined'].includes(requestedParentFolderIdRaw.toLowerCase()) ? '' : requestedParentFolderIdRaw;\n  const parentFolder = requestedParentFolderId ? findFolderById(requestedParentFolderId) : null;\n  if (requestedParentFolderId && !parentFolder) throw new Error('Parent folder not found');\n  const parentFolderId = parentFolder ? String(parentFolder.folderId || '') : '';",
    normalizeParentExpression()
  );

  next = next.replace(
    "  const parentFolderId = String(payload.parentFolderId || '');\n  const folder = findFolderById(folderId) || findFolderByName(payload.name || '');",
    normalizeMoveParentExpression()
  );

  next = next.replace(
    "  const parentFolderId = ['', 'root', '/', 'null', 'undefined'].includes(String(payload.parentFolderId ?? '').trim().toLowerCase()) ? '' : String(payload.parentFolderId || '').trim();\n  const folder = findFolderById(folderId) || findFolderByName(payload.name || '');",
    normalizeMoveParentExpression()
  );

  next = next.replaceAll('await syncDelete(activeWallet(), item.hash);\n    await syncPull();\n    return { ok: true, deleted: 1 };', 'await syncDelete(folderOwnerIdentity(), item.hash || item.rootHash);\n    return { ok: true, deleted: 1 };');
  next = next.replaceAll('for (const removed of removedItems) await syncDelete(activeWallet(), removed.hash);\n  await syncPull();\n  return { ok: true, deleted: removedItems.length };', 'for (const removed of removedItems) await syncDelete(folderOwnerIdentity(), removed.hash || removed.rootHash);\n  return { ok: true, deleted: removedItems.length };');
  next = next.replaceAll('await syncDelete(activeIdentity(), item.hash);\n    await syncPull();\n    return { ok: true, deleted: 1 };', 'await syncDelete(folderOwnerIdentity(), item.hash || item.rootHash);\n    return { ok: true, deleted: 1 };');
  next = next.replaceAll('for (const removed of removedItems) await syncDelete(activeIdentity(), removed.hash);\n  await syncPull();\n  return { ok: true, deleted: removedItems.length };', 'for (const removed of removedItems) await syncDelete(folderOwnerIdentity(), removed.hash || removed.rootHash);\n  return { ok: true, deleted: removedItems.length };');

  return next;
}

for (const file of [path.join(process.cwd(), 'electron', 'main.js'), path.join(process.cwd(), 'electron', 'main-stable.js')]) {
  if (!fs.existsSync(file)) continue;
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  src = patchRuntimeFolderParentContract(src);
  if (src !== before) {
    fs.writeFileSync(file, src, 'utf8');
    console.log(`[manifest-folder-panel-contract] resolved folder parent/delete references in ${file}`);
  }
}
