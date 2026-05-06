const fs = require('node:fs');

const p = 'electron/main.js';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

const oldImport = "import { app, BrowserWindow, ipcMain, shell } from 'electron';";
const newImport = "import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';";
if (s.includes(oldImport)) {
  s = s.replace(oldImport, newImport);
  changed = true;
}

const oldReturn = "  const plain = manifest.isEncrypted ? decryptPrivateBuffer(Buffer.concat(buffers), manifest, drivePasswordFromPayload(payload)) : Buffer.concat(buffers);\n  finishProgress('download');\n  return { ok: true, file: manifest, bytes: Array.from(plain), progress: transferProgress.download };";
const newReturn = "  const plain = manifest.isEncrypted ? decryptPrivateBuffer(Buffer.concat(buffers), manifest, drivePasswordFromPayload(payload)) : Buffer.concat(buffers);\n  const suggestedName = path.basename(String(manifest.name || 'download.bin'));\n  const saveResult = await dialog.showSaveDialog(mainWindow, { defaultPath: suggestedName });\n  if (saveResult.canceled || !saveResult.filePath) {\n    finishProgress('download', 'cancelled');\n    return { ok: false, cancelled: true, file: manifest, progress: transferProgress.download };\n  }\n  fs.writeFileSync(saveResult.filePath, plain);\n  finishProgress('download');\n  return { ok: true, file: manifest, savedPath: saveResult.filePath, progress: transferProgress.download };";

if (s.includes(oldReturn)) {
  s = s.replace(oldReturn, newReturn);
  changed = true;
} else if (s.includes("bytes: Array.from(plain)")) {
  s = s.replace(
    /\s*finishProgress\('download'\);\s*return \{ ok: true, file: manifest, bytes: Array\.from\(plain\), progress: transferProgress\.download \};/,
    "\n  const suggestedName = path.basename(String(manifest.name || 'download.bin'));\n  const saveResult = await dialog.showSaveDialog(mainWindow, { defaultPath: suggestedName });\n  if (saveResult.canceled || !saveResult.filePath) {\n    finishProgress('download', 'cancelled');\n    return { ok: false, cancelled: true, file: manifest, progress: transferProgress.download };\n  }\n  fs.writeFileSync(saveResult.filePath, plain);\n  finishProgress('download');\n  return { ok: true, file: manifest, savedPath: saveResult.filePath, progress: transferProgress.download };"
  );
  changed = true;
}

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-download-memory] patched download to save on disk instead of returning bytes');
} else {
  console.log('[patch-download-memory] no patch needed or target not found');
}
