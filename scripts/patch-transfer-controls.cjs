const fs = require('node:fs');

const p = 'electron/main.js';
if (!fs.existsSync(p)) process.exit(0);
let s = fs.readFileSync(p, 'utf8');
const before = s;

function replaceAll(from, to) {
  if (s.includes(from)) s = s.split(from).join(to);
}

function insertBefore(marker, code) {
  if (!s.includes(marker) || s.includes(code.trim().split('\n')[0])) return;
  s = s.replace(marker, code + '\n' + marker);
}

function insertAfter(marker, code) {
  if (!s.includes(marker) || s.includes(code.trim().split('\n')[0])) return;
  s = s.replace(marker, marker + '\n' + code);
}

insertAfter(
  "let transferProgress = { upload: null, download: null };",
  `let transferControl = { upload: { paused: false, cancelled: false }, download: { paused: false, cancelled: false } };

function normalizeTransferType(type = 'upload') {
  return type === 'download' ? 'download' : 'upload';
}

function resetTransferControl(kind) {
  transferControl[kind] = { paused: false, cancelled: false };
}

async function waitForTransferControl(kind) {
  const type = normalizeTransferType(kind);
  while (transferControl[type]?.paused && !transferControl[type]?.cancelled) {
    updateProgress(type, { phase: 'paused' });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (transferControl[type]?.cancelled) throw new Error(type === 'upload' ? 'Upload cancelled' : 'Download cancelled');
}
`
);

// Ensure the pause helper exists even when older transfer-control patches were already installed.
insertBefore(
  'function normalizeTransferType',
  `function ensureTransferControlState() {
  if (!transferControl) transferControl = { upload: { paused: false, cancelled: false }, download: { paused: false, cancelled: false } };
  if (!transferControl.upload) transferControl.upload = { paused: false, cancelled: false };
  if (!transferControl.download) transferControl.download = { paused: false, cancelled: false };
}
`
);

insertBefore(
  'function resetTransferControl',
  `function bindTransferControlToReadStream(stream, kind) {
  const type = normalizeTransferType(kind);
  let waiting = false;
  stream.on('data', () => {
    ensureTransferControlState();
    if (transferControl[type]?.cancelled) {
      stream.destroy(new Error(type === 'upload' ? 'Upload cancelled' : 'Download cancelled'));
      return;
    }
    if (transferControl[type]?.paused && !waiting) {
      waiting = true;
      updateProgress(type, { phase: 'paused' });
      stream.pause();
      const timer = setInterval(() => {
        ensureTransferControlState();
        if (transferControl[type]?.cancelled) {
          clearInterval(timer);
          waiting = false;
          stream.destroy(new Error(type === 'upload' ? 'Upload cancelled' : 'Download cancelled'));
          return;
        }
        if (!transferControl[type]?.paused) {
          clearInterval(timer);
          waiting = false;
          updateProgress(type, { phase: 'running' });
          stream.resume();
        }
      }, 250);
      timer.unref?.();
    }
  });
}
`
);

replaceAll(
  "  const now = Date.now();\n  transferProgress[kind] = {",
  "  resetTransferControl(kind);\n  const now = Date.now();\n  transferProgress[kind] = {"
);
replaceAll(
  "  resetTransferControl(kind);\n  resetTransferControl(kind);\n  const now = Date.now();",
  "  resetTransferControl(kind);\n  const now = Date.now();"
);

replaceAll(
  "    error: null,\n  };",
  "    error: null,\n    paused: false,\n    cancellable: true,\n  };"
);
replaceAll(
  "    paused: false,\n    cancellable: true,\n    paused: false,\n    cancellable: true,",
  "    paused: false,\n    cancellable: true,"
);

replaceAll(
  "    phase,\n    transferredBytes,",
  "    phase: transferControl[kind]?.paused ? 'paused' : phase,\n    transferredBytes,"
);
replaceAll(
  "    phase: transferControl[kind]?.paused ? 'paused' : phase,\n    phase: transferControl[kind]?.paused ? 'paused' : phase,",
  "    phase: transferControl[kind]?.paused ? 'paused' : phase,"
);

replaceAll(
  "    error,\n  };",
  "    error,\n    paused: Boolean(transferControl[kind]?.paused),\n    cancellable: true,\n  };"
);
replaceAll(
  "    paused: Boolean(transferControl[kind]?.paused),\n    cancellable: true,\n    paused: Boolean(transferControl[kind]?.paused),\n    cancellable: true,",
  "    paused: Boolean(transferControl[kind]?.paused),\n    cancellable: true,"
);

// Make pause/cancel responsive during every disk/encryption stream.
replaceAll(
  "const input = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES });\n        const output = fs.createWriteStream(tempPath);",
  "const input = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES });\n        bindTransferControlToReadStream(input, 'upload');\n        const output = fs.createWriteStream(tempPath);"
);
replaceAll(
  "const input = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES });\n        bindTransferControlToReadStream(input, 'upload');\n        bindTransferControlToReadStream(input, 'upload');\n        const output = fs.createWriteStream(tempPath);",
  "const input = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES });\n        bindTransferControlToReadStream(input, 'upload');\n        const output = fs.createWriteStream(tempPath);"
);

// Check pause/cancel before each chunk operation.
replaceAll(
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      const chunkPayload",
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      await waitForTransferControl('upload');\n      const chunkPayload"
);
replaceAll(
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      await waitForTransferControl('upload');\n      await waitForTransferControl('upload');\n      const chunkPayload",
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      await waitForTransferControl('upload');\n      const chunkPayload"
);
replaceAll(
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      const local",
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      await waitForTransferControl('download');\n      const local"
);
replaceAll(
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      await waitForTransferControl('download');\n      await waitForTransferControl('download');\n      const local",
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      await waitForTransferControl('download');\n      const local"
);

const handlerMarker = "ipcMain.handle('electron:diagnostics'";
if (s.includes(handlerMarker) && !s.includes("ipcMain.handle('p2p:pauseTransfer'")) {
  const idx = s.indexOf(handlerMarker);
  const controls = `ipcMain.handle('p2p:pauseTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  ensureTransferControlState();
  transferControl[type].paused = true;
  transferControl[type].cancelled = false;
  updateProgress(type, { phase: 'paused' });
  return { ok: true, type, progress: transferProgress[type] };
});

ipcMain.handle('p2p:resumeTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  ensureTransferControlState();
  transferControl[type].paused = false;
  updateProgress(type, { phase: 'running' });
  return { ok: true, type, progress: transferProgress[type] };
});

ipcMain.handle('p2p:cancelTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  ensureTransferControlState();
  transferControl[type].cancelled = true;
  transferControl[type].paused = false;
  finishProgress(type, 'error', type === 'upload' ? 'Upload cancelled' : 'Download cancelled');
  return { ok: true, type, progress: transferProgress[type] };
});

`;
  s = s.slice(0, idx) + controls + s.slice(idx);
}

// Upgrade old handlers in place.
s = s.replace(/ipcMain\.handle\('p2p:pauseTransfer',[\s\S]*?\n\}\);\n\nipcMain\.handle\('p2p:resumeTransfer'/, `ipcMain.handle('p2p:pauseTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  ensureTransferControlState();
  transferControl[type].paused = true;
  transferControl[type].cancelled = false;
  updateProgress(type, { phase: 'paused' });
  return { ok: true, type, progress: transferProgress[type] };
});

ipcMain.handle('p2p:resumeTransfer'`);
s = s.replace(/ipcMain\.handle\('p2p:resumeTransfer',[\s\S]*?\n\}\);\n\nipcMain\.handle\('p2p:cancelTransfer'/, `ipcMain.handle('p2p:resumeTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  ensureTransferControlState();
  transferControl[type].paused = false;
  updateProgress(type, { phase: 'running' });
  return { ok: true, type, progress: transferProgress[type] };
});

ipcMain.handle('p2p:cancelTransfer'`);
s = s.replace(/ipcMain\.handle\('p2p:cancelTransfer',[\s\S]*?\n\}\);/, `ipcMain.handle('p2p:cancelTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  ensureTransferControlState();
  transferControl[type].cancelled = true;
  transferControl[type].paused = false;
  finishProgress(type, 'error', type === 'upload' ? 'Upload cancelled' : 'Download cancelled');
  return { ok: true, type, progress: transferProgress[type] };
});`);

if (s !== before) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-transfer-controls] installed responsive pause/resume/cancel controls');
} else {
  console.log('[patch-transfer-controls] transfer controls already installed');
}
