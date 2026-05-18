const fs = require('node:fs');

const p = 'client/src/ManifestFolderPanel.tsx';
if (!fs.existsSync(p)) {
  console.warn('[manifest-folder-panel-contract] ManifestFolderPanel.tsx not found');
  process.exit(0);
}

let s = fs.readFileSync(p, 'utf8');
const before = s;

s = s.replace(
  'function idOf(folder?: DriveFolder | null) {\n  return String(folder?.folderId || folder?.id || folder?.hash || "");\n}',
  'function idOf(folder?: DriveFolder | null) {\n  return String(folder?.folderId || "");\n}\n\nfunction itemIdOf(folder?: DriveFolder | null) {\n  return String(folder?.id || folder?.folderId || folder?.hash || folder?.rootHash || "");\n}'
);

s = s.replace(
  '      const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", {\n        name,\n        parentFolderId: activeFolderId || "",\n      });',
  '      const parentFolderId = activeFolderId && byId.has(activeFolderId) ? activeFolderId : "";\n      const payload = parentFolderId ? { name, parentFolderId } : { name };\n      const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", payload);'
);

s = s.replaceAll('folder.id || folder.folderId || folder.hash', 'itemIdOf(folder)');
s = s.replaceAll('target ? idOf(target) : null', 'target ? idOf(target) : null');

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
  console.log('[manifest-folder-panel-contract] enforced folderId-only parent contract');
} else {
  console.log('[manifest-folder-panel-contract] folderId-only parent contract already valid');
}
