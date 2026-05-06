const fs = require('node:fs');

const p = 'electron/main.js';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

function replaceOnce(from, to) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  }
}

replaceOnce(
  "import { app, BrowserWindow, ipcMain, shell } from 'electron';",
  "import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';"
);

replaceOnce(
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {",
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta, chunkPosition) => {"
);

replaceOnce(
  "buffers[meta.index] = buffer;",
  "buffers[chunkPosition] = buffer;"
);

replaceOnce(
  "  const plain = manifest.isEncrypted ? decryptPrivateBuffer(Buffer.concat(buffers), manifest, drivePasswordFromPayload(payload)) : Buffer.concat(buffers);",
  "  const encryptedBuffer = Buffer.concat(buffers);\n  if (manifest.hash && hashBufferHex(encryptedBuffer) !== manifest.hash) {\n    finishProgress('download', 'error', 'Downloaded chunks do not match the file manifest');\n    throw new Error('Downloaded chunks do not match this file manifest. The manifest is stale/corrupted or chunks are from an older upload. Refresh files, repair, or re-upload this file.');\n  }\n\n  let plain;\n  try {\n    plain = manifest.isEncrypted ? decryptPrivateBuffer(encryptedBuffer, manifest, drivePasswordFromPayload(payload)) : encryptedBuffer;\n  } catch (error) {\n    finishProgress('download', 'error', 'Encrypted file authentication failed');\n    const reason = String(error?.message || error);\n    if (reason.includes('authenticate data') || reason.includes('Unsupported state')) {\n      throw new Error('Encrypted file authentication failed even though chunks were downloaded. This usually means stale encryption metadata or a file uploaded with an older key format. Refresh files, repair, or re-upload this file.');\n    }\n    throw error;\n  }"
);

replaceOnce(
  "  finishProgress('download');\n  return { ok: true, file: manifest, bytes: Array.from(plain), progress: transferProgress.download };",
  "  const suggestedName = path.basename(String(manifest.name || 'download.bin'));\n  const saveResult = await dialog.showSaveDialog(mainWindow, { defaultPath: suggestedName });\n  if (saveResult.canceled || !saveResult.filePath) {\n    finishProgress('download', 'cancelled');\n    return { ok: false, cancelled: true, file: manifest, progress: transferProgress.download };\n  }\n  fs.writeFileSync(saveResult.filePath, plain);\n  finishProgress('download');\n  return { ok: true, file: manifest, savedPath: saveResult.filePath, progress: transferProgress.download };"
);

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-download-memory] patched download ordering, manifest hash check, save path');
} else {
  console.log('[patch-download-memory] no patch needed or target not found');
}
