const fs = require('node:fs');
const path = require('node:path');

const p = path.join(process.cwd(), 'client', 'src', 'ManifestFolderPanel.tsx');
if (!fs.existsSync(p)) {
  console.warn('[folder-create-parent-fallback] ManifestFolderPanel.tsx not found');
  process.exit(0);
}

let s = fs.readFileSync(p, 'utf8');
const before = s;

const oldBlock = `      const parentFolderId = activeFolderId && byId.has(activeFolderId) ? activeFolderId : "";
      const payload = parentFolderId ? { name, parentFolderId } : { name };
      const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", payload);`;

const newBlock = `      const selectedByName = externalActiveFolderName && !["All Files", "All files", "Uncategorized"].includes(externalActiveFolderName)
        ? folders.find((folder) => folder.name === externalActiveFolderName)
        : null;
      const resolvedActiveFolderId = activeFolderId && byId.has(activeFolderId) ? activeFolderId : idOf(selectedByName);
      const parentFolderId = resolvedActiveFolderId && byId.has(resolvedActiveFolderId) ? resolvedActiveFolderId : "";
      const payload = parentFolderId ? { name, parentFolderId } : { name };
      console.info("[folders] createFolder payload", payload);
      const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", payload);`;

if (s.includes(oldBlock)) {
  s = s.replace(oldBlock, newBlock);
} else if (!s.includes('[folders] createFolder payload')) {
  console.warn('[folder-create-parent-fallback] createFolder parent block not found');
}

if (s !== before) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[folder-create-parent-fallback] nested folder creation now resolves active parent by id or name');
} else {
  console.log('[folder-create-parent-fallback] already patched or no matching block');
}
