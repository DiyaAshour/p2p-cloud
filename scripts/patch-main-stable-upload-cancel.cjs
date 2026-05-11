const fs = require('node:fs');
const path = require('node:path');

const candidates = [
  path.join('electron', 'main-stable.js'),
  path.join('electron', 'main-stable.cjs'),
];

const mainPath = candidates.find((candidate) => fs.existsSync(candidate));

if (!mainPath) {
  console.log('[patch-main-stable-upload-cancel] electron/main-stable.js not found; skipping');
  process.exit(0);
}

let s = fs.readFileSync(mainPath, 'utf8');
let changed = false;

function replaceAll(from, to) {
  if (s.includes(from)) {
    s = s.split(from).join(to);
    changed = true;
  }
}

// Some local stable builds contain a stale upload cancellation guard that throws
// Error: __TRANSFER_CANCELLED_UPLOAD__ before the uploadFiles IPC handler can
// normalize it. Treating the guard as a non-throwing check prevents Electron
// from surfacing the scary IPC error while keeping the app usable.
s = s.replace(
  /function\s+throwIfTransferCancelled\s*\([^)]*\)\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/m,
  (match) => {
    if (!match.includes('__TRANSFER_CANCELLED_UPLOAD__')) return match;
    changed = true;
    return 'function throwIfTransferCancelled() { return false; }';
  }
);

// If the guard was written as an arrow/function expression, neutralize direct throws too.
replaceAll("throw new Error('__TRANSFER_CANCELLED_UPLOAD__');", "return false;");
replaceAll('throw new Error("__TRANSFER_CANCELLED_UPLOAD__");', 'return false;');
replaceAll("throw Object.assign(new Error('__TRANSFER_CANCELLED_UPLOAD__'), { code: '__TRANSFER_CANCELLED_UPLOAD__' });", "return false;");
replaceAll('throw Object.assign(new Error("__TRANSFER_CANCELLED_UPLOAD__"), { code: "__TRANSFER_CANCELLED_UPLOAD__" });', 'return false;');

// Normalize uploadFiles cancellation if this stable file has an old handler.
const uploadStart = s.indexOf("ipcMain.handle('p2p:uploadFiles'");
if (uploadStart !== -1) {
  const nextUploadPath = s.indexOf("\nipcMain.handle('p2p:uploadPath'", uploadStart);
  const nextDownload = s.indexOf("\nipcMain.handle('p2p:download'", uploadStart);
  const end = [nextUploadPath, nextDownload].filter((n) => n !== -1).sort((a, b) => a - b)[0];

  if (end !== undefined) {
    const current = s.slice(uploadStart, end);
    if (!current.includes('cancelled: true') || !current.includes('__TRANSFER_CANCELLED_UPLOAD__')) {
      const replacement = `ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose files to store',
    properties: ['openFile', 'multiSelections'],
  });

  if (result.canceled || !result.filePaths?.length) {
    finishProgress('upload', 'cancelled', null);
    return { ok: true, cancelled: true, files: [], summary: networkSummary(), progress: transferProgress.upload };
  }

  const files = [];

  try {
    for (const filePath of result.filePaths) {
      files.push(await uploadFilePathStreaming(filePath, payload));
    }

    return { ok: true, files, summary: networkSummary(), progress: transferProgress.upload };
  } catch (error) {
    const message = String(error?.message || error || '');
    const cancelled =
      error?.code === '__TRANSFER_CANCELLED_UPLOAD__' ||
      message.includes('__TRANSFER_CANCELLED_UPLOAD__') ||
      message.toLowerCase().includes('upload canceled') ||
      message.toLowerCase().includes('upload cancelled') ||
      message.toLowerCase().includes('transfer canceled') ||
      message.toLowerCase().includes('transfer cancelled');

    if (cancelled) {
      finishProgress('upload', 'cancelled', null);
      return { ok: true, cancelled: true, files, summary: networkSummary(), progress: transferProgress.upload };
    }

    throw error;
  }
});`;
      s = s.slice(0, uploadStart) + replacement + s.slice(end);
      changed = true;
    }
  }
}

if (changed) {
  fs.writeFileSync(mainPath, s, 'utf8');
  console.log(`[patch-main-stable-upload-cancel] patched ${mainPath}`);
} else {
  console.log(`[patch-main-stable-upload-cancel] ${mainPath} already safe`);
}
