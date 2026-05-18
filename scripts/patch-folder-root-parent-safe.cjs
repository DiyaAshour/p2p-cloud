const fs = require('node:fs');
const path = require('node:path');

const files = [
  path.join(process.cwd(), 'electron', 'main.js'),
  path.join(process.cwd(), 'electron', 'main-stable.js'),
];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let src = fs.readFileSync(file, 'utf8');
  const before = src;

  src = src.replace(
    "  const parentFolderId = String(payload.parentFolderId || '');\n  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Parent folder not found');",
    "  const parentFolderId = ['', 'root', '/', 'null', 'undefined'].includes(String(payload.parentFolderId ?? '').trim().toLowerCase()) ? '' : String(payload.parentFolderId || '').trim();\n  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Parent folder not found');"
  );

  src = src.replace(
    "  const parentFolderId = String(payload.parentFolderId || '');\n  const folder = findFolderById(folderId) || findFolderByName(payload.name || '');",
    "  const parentFolderId = ['', 'root', '/', 'null', 'undefined'].includes(String(payload.parentFolderId ?? '').trim().toLowerCase()) ? '' : String(payload.parentFolderId || '').trim();\n  const folder = findFolderById(folderId) || findFolderByName(payload.name || '');"
  );

  if (src !== before) {
    fs.writeFileSync(file, src, 'utf8');
    console.log(`[folder-root-parent-safe] patched ${file}`);
  }
}

console.log('[folder-root-parent-safe] root parent normalization complete');
