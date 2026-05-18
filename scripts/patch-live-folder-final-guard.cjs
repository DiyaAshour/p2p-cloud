const fs = require('node:fs');

const file = 'client/src/NativeP2PAppLive.tsx';
if (!fs.existsSync(file)) {
  console.warn('[patch-live-folder-final-guard] NativeP2PAppLive not found');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
const before = s;

// This guard used to force an old local createFolder implementation.
// The live UI now uses manifest-backed p2p:createFolder plus folder action IPCs.
// Keep this script safe and non-fatal so older patch order cannot break the new UI.

// Remove obsolete drive folder channels from renderer types when present.
s = s.replace(/  \| "drive:getFolders"\r?\n/g, '');
s = s.replace(/  \| "drive:saveFolders"\r?\n/g, '');

// Neutralize legacy drive save calls if an older patch injected them.
s = s.replace(
  /api\.invoke\("drive:saveFolders"\s+as\s+Channel,\s*\{\s*folders:\s*foldersPayload,\s*fileFolders:\s*nextFolders\s*\}\)/g,
  'Promise.resolve({ ok: true })'
);
s = s.replace(
  /api\.invoke\("drive:saveFolders",\s*\{\s*folders:\s*foldersPayload,\s*fileFolders:\s*nextFolders\s*\}\)/g,
  'Promise.resolve({ ok: true })'
);

// Keep useful manifest/file folder IPC channels available to TypeScript variants.
const channelAnchor = '  | "p2p:downloadToPath"\n';
for (const channel of ['p2p:updateFile', 'p2p:listFolders', 'p2p:createFolder', 'p2p:renameItem', 'p2p:moveItem', 'p2p:deleteItem']) {
  const line = `  | "${channel}"\n`;
  if (!s.includes(line) && s.includes(channelAnchor)) s = s.replace(channelAnchor, channelAnchor + line);
}

// Best-effort display repair. Do not fail if the UI shape differs.
s = s.replace(/const folder = cf\?\.folder \|\| fileFolders\[file\.hash\] \|\| UNCATEGORIZED;/g, 'const folder = cf?.folder || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;');
s = s.replace(/const folder = cf\?\.folder \|\| fileFolders\[file\.rootHash\] \|\| fileFolders\[file\.hash\] \|\| UNCATEGORIZED;/g, 'const folder = cf?.folder || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;');

// Best-effort personal file move repair for old local-only variants.
s = s.replace(
  /else setFileFolders\(\(current\) => \(\{ \.\.\.current, \[file\.hash\]: nextFolder \}\)\);/g,
  `else {
                setFileFolders((current) => ({ ...current, [file.hash]: nextFolder, ...(file.rootHash ? { [file.rootHash]: nextFolder } : {}) }));
                void api.invoke("p2p:updateFile", { hash: file.hash, rootHash: file.rootHash, patch: { folder: nextFolder } })
                  .then(refresh)
                  .catch((error) => toast.error(err(error)));
              }`
);

if (s.includes('api.invoke("drive:saveFolders"')) {
  console.warn('[patch-live-folder-final-guard] legacy drive:saveFolders reference remains outside guarded patterns; continuing because network folder UI owns folder persistence');
}
if (!s.includes('p2p:updateFile')) {
  console.warn('[patch-live-folder-final-guard] p2p:updateFile channel not found in UI; continuing because bridge type may be string-based');
}

if (s !== before) fs.writeFileSync(file, s, 'utf8');
console.log(s !== before ? '[patch-live-folder-final-guard] safe guard applied for network folder UI' : '[patch-live-folder-final-guard] already safe for network folder UI');
