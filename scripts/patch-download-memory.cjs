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

const decryptLine = "  const plain = manifest.isEncrypted ? decryptPrivateBuffer(Buffer.concat(buffers), manifest, drivePasswordFromPayload(payload)) : Buffer.concat(buffers);";
const decryptSafe = "  let plain;\n  try {\n    plain = manifest.isEncrypted ? decryptPrivateBuffer(Buffer.concat(buffers), manifest, drivePasswordFromPayload(payload)) : Buffer.concat(buffers);\n  } catch (error) {\n    finishProgress('download', 'error', 'Drive Password does not match this encrypted file');\n    const reason = String(error?.message || error);\n    if (reason.includes('authenticate data') || reason.includes('Unsupported state')) {\n      throw new Error('Drive Password is wrong for this file, or the file was encrypted with a different wallet/password. Re-enter the exact Drive Password used during upload, or re-upload the file.');\n    }\n    throw error;\n  }";
if (s.includes(decryptLine)) {
  s = s.replace(decryptLine, decryptSafe);
  changed = true;
}

const oldReturn = "  finishProgress('download');\n  return { ok: true, file: manifest, bytes: Array.from(plain), progress: transferProgress.download };";
const newReturn = "  const suggestedName = path.basename(String(manifest.name || 'download.bin'));\n  const saveResult = await dialog.showSaveDialog(mainWindow, { defaultPath: suggestedName });\n  if (saveResult.canceled || !saveResult.filePath) {\n    finishProgress('download', 'cancelled');\n    return { ok: false, cancelled: true, file: manifest, progress: transferProgress.download };\n  }\n  fs.writeFileSync(saveResult.filePath, plain);\n  finishProgress('download');\n  return { ok: true, file: manifest, savedPath: saveResult.filePath, progress: transferProgress.download };";
if (s.includes(oldReturn)) {
  s = s.replace(oldReturn, newReturn);
  changed = true;
}

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-download-memory] patched download save path and decrypt errors');
} else {
  console.log('[patch-download-memory] no patch needed or target not found');
}
